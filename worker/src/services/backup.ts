import type { Env } from "../env";

/*
  Instance backups: a gzipped SQL dump of the whole D1 database in the R2
  bucket under backups/ (never served publicly; see src/routes/uploads.ts).

  Restore onto a freshly migrated database:
    gunzip wallos-<date>.sql.gz
    npx wrangler d1 execute DB --remote --file wallos-<date>.sql

  Every row is written as INSERT OR REPLACE, so the reference rows the
  migrations create (admin id 1, ...) are overwritten rather than clashing.
  Login state (sessions, pending login steps, throttle counters) and the
  notification log are left out; after a restore everybody logs in again.

  D1 also keeps 30 days of point-in-time history (Time Travel), which is the
  quicker way back from a mistake; these dumps are the copy that survives the
  database itself and can be kept or moved anywhere.
*/

export const BACKUP_PREFIX = "backups/";
export const BACKUP_RETENTION = 8;
const SKIPPED_TABLES = new Set(["sessions", "auth_flows", "login_attempts", "notification_log", "d1_migrations", "sqlite_sequence"]);
export const BACKUP_NAME = /^wallos-\d{4}-\d{2}-\d{2}(T\d{4}Z)?\.sql\.gz$/;

function literal(value: unknown): string {
  if (value === null || value === undefined) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  if (typeof value === "bigint") return value.toString();
  if (typeof value === "boolean") return value ? "1" : "0";
  if (value instanceof ArrayBuffer || ArrayBuffer.isView(value)) {
    const bytes = value instanceof ArrayBuffer ? new Uint8Array(value) : new Uint8Array(value.buffer, value.byteOffset, value.byteLength);
    return `X'${[...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")}'`;
  }
  if (Array.isArray(value)) return literal(new Uint8Array(value as number[]));
  return `'${String(value).replace(/'/g, "''")}'`;
}

const ident = (name: string) => `"${name.replace(/"/g, '""')}"`;

/** The tables to dump, in creation order (parents before the tables that refer to them). */
async function tables(db: D1Database): Promise<string[]> {
  const rows = await db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' AND name NOT LIKE '_cf_%' ORDER BY rowid")
    .all<{ name: string }>();
  return rows.results.map((r) => r.name).filter((name) => !SKIPPED_TABLES.has(name));
}

/** The whole database as SQL text. */
export async function dumpDatabase(db: D1Database, now = new Date()): Promise<{ sql: string; rows: number; tables: number }> {
  const lines = [
    `-- Wallos (Cloudflare Worker) backup, ${now.toISOString()}`,
    "-- Restore onto a freshly migrated database: npx wrangler d1 execute DB --remote --file <this file>",
    "PRAGMA defer_foreign_keys = true;",
  ];
  let rowCount = 0;
  const names = await tables(db);
  for (const table of names) {
    const result = await db.prepare(`SELECT * FROM ${ident(table)}`).raw<unknown[]>({ columnNames: true });
    const [columns, ...rows] = result as [string[], ...unknown[][]];
    if (!columns || rows.length === 0) continue;
    lines.push(`-- ${table}: ${rows.length} rows`);
    const head = `INSERT OR REPLACE INTO ${ident(table)} (${columns.map(ident).join(", ")}) VALUES`;
    for (const row of rows) lines.push(`${head} (${row.map(literal).join(", ")});`);
    rowCount += rows.length;
  }
  return { sql: `${lines.join("\n")}\n`, rows: rowCount, tables: names.length };
}

async function gzip(text: string): Promise<Uint8Array> {
  const stream = new Blob([text]).stream().pipeThrough(new CompressionStream("gzip"));
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

export interface BackupInfo {
  name: string;
  size: number;
  uploaded: string;
}

export async function listBackups(env: Env): Promise<BackupInfo[]> {
  const found: BackupInfo[] = [];
  let cursor: string | undefined;
  do {
    const page = await env.FILES.list({ prefix: BACKUP_PREFIX, cursor });
    for (const object of page.objects) {
      const name = object.key.slice(BACKUP_PREFIX.length);
      if (BACKUP_NAME.test(name)) found.push({ name, size: object.size, uploaded: object.uploaded.toISOString() });
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return found.sort((a, b) => b.name.localeCompare(a.name));
}

/**
 * Writes a backup now and removes the oldest beyond the retention. Scheduled
 * backups are named by day; ones made on demand also carry the time.
 */
export async function createBackup(env: Env, options: { now?: Date; scheduled?: boolean } = {}): Promise<BackupInfo & { rows: number; deleted: string[] }> {
  const now = options.now ?? new Date();
  const iso = now.toISOString();
  const name = options.scheduled ? `wallos-${iso.slice(0, 10)}.sql.gz` : `wallos-${iso.slice(0, 10)}T${iso.slice(11, 13)}${iso.slice(14, 16)}Z.sql.gz`;
  const dump = await dumpDatabase(env.DB, now);
  const body = await gzip(dump.sql);
  await env.FILES.put(BACKUP_PREFIX + name, body, {
    httpMetadata: { contentType: "application/gzip", contentDisposition: `attachment; filename="${name}"` },
    customMetadata: { rows: String(dump.rows), tables: String(dump.tables) },
  });
  const all = await listBackups(env);
  const deleted = all.slice(BACKUP_RETENTION).map((b) => b.name);
  for (const old of deleted) await env.FILES.delete(BACKUP_PREFIX + old);
  return { name, size: body.byteLength, uploaded: iso, rows: dump.rows, deleted };
}

export async function getBackup(env: Env, name: string): Promise<R2ObjectBody | null> {
  if (!BACKUP_NAME.test(name)) return null;
  return env.FILES.get(BACKUP_PREFIX + name);
}
