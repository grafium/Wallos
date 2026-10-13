import { Hono, type Context } from "hono";
import type { AppBindings } from "../../env";
import { ADMIN_USER_ID } from "../../env";
import { getSettings } from "../../services/settings";
import { WORKER_VERSION } from "../../version";

/*
  endpoints/db/*.php: backup, restore, import, migrate.

  The Worker has no SQLite file to zip up or swap out. Backup downloads the
  account's data as the JSON document of GET /api/me/export, packed in a zip
  (Wallos-Backup-<date>.zip containing wallos-export.json) because
  scripts/admin.js only accepts an application/zip answer as a successful
  backup. Restoring a PHP Wallos database is done with the importer CLI, so
  restore/import/migrate explain that instead.
*/

type Ctx = Context<AppBindings>;

export const routes = new Hono<AppBindings>();

export const IMPORTER_MESSAGE =
  "This Wallos runs on Cloudflare Workers and has no database file to restore. Move a PHP Wallos database (wallos.db or a backup zip) with the importer: node scripts/import-wallos.ts";

// Same columns and document as GET /api/me/export (src/routes/me.ts).
const PROFILE_COLUMNS = `id, username, email, firstname, lastname, main_currency, language, avatar, budget,
  budget_period_type, budget_period_anchor_date, period_budget, totp_enabled, timezone, created_at`;
const EXPORT_TABLES = ["categories", "household", "payment_methods", "currencies", "subscriptions"] as const;

export async function exportDocument(db: D1Database, userId: number) {
  const [profile, ...results] = await db.batch<Record<string, unknown>>([
    db.prepare(`SELECT ${PROFILE_COLUMNS} FROM user WHERE id = ?`).bind(userId),
    ...EXPORT_TABLES.map((table) => db.prepare(`SELECT * FROM ${table} WHERE user_id = ? ORDER BY id`).bind(userId)),
  ]);
  const data = Object.fromEntries(EXPORT_TABLES.map((table, i) => [table, results[i]?.results ?? []]));
  return {
    success: true,
    title: "export",
    format: "wallos-worker-export",
    format_version: 1,
    worker_version: WORKER_VERSION,
    exported_at: new Date().toISOString(),
    user: { ...(profile?.results[0] ?? {}), is_admin: userId === ADMIN_USER_ID },
    settings: await getSettings(db, userId),
    ...data,
  };
}

// --- a minimal zip writer (one stored, uncompressed entry) --------------------------------------

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let n = 0; n < 256; n++) {
    let c = n;
    for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    table[n] = c >>> 0;
  }
  return table;
})();

function crc32(bytes: Uint8Array): number {
  let crc = 0xffffffff;
  for (const byte of bytes) crc = CRC_TABLE[(crc ^ byte) & 0xff]! ^ (crc >>> 8);
  return (crc ^ 0xffffffff) >>> 0;
}

export function zipSingleFile(name: string, content: Uint8Array, date = new Date()): Uint8Array {
  const nameBytes = new TextEncoder().encode(name);
  const crc = crc32(content);
  const dosTime = (date.getUTCHours() << 11) | (date.getUTCMinutes() << 5) | Math.floor(date.getUTCSeconds() / 2);
  const dosDate = ((date.getUTCFullYear() - 1980) << 9) | ((date.getUTCMonth() + 1) << 5) | date.getUTCDate();

  const local = new DataView(new ArrayBuffer(30));
  local.setUint32(0, 0x04034b50, true);
  local.setUint16(4, 20, true); // version needed
  local.setUint16(6, 0x0800, true); // UTF-8 names
  local.setUint16(8, 0, true); // stored
  local.setUint16(10, dosTime, true);
  local.setUint16(12, dosDate, true);
  local.setUint32(14, crc, true);
  local.setUint32(18, content.length, true);
  local.setUint32(22, content.length, true);
  local.setUint16(26, nameBytes.length, true);
  local.setUint16(28, 0, true);

  const central = new DataView(new ArrayBuffer(46));
  central.setUint32(0, 0x02014b50, true);
  central.setUint16(4, 20, true); // version made by
  central.setUint16(6, 20, true);
  central.setUint16(8, 0x0800, true);
  central.setUint16(10, 0, true);
  central.setUint16(12, dosTime, true);
  central.setUint16(14, dosDate, true);
  central.setUint32(16, crc, true);
  central.setUint32(20, content.length, true);
  central.setUint32(24, content.length, true);
  central.setUint16(28, nameBytes.length, true);
  // extra, comment, disk, internal attrs, external attrs: 0
  central.setUint32(42, 0, true); // offset of the local header

  const centralOffset = 30 + nameBytes.length + content.length;
  const centralSize = 46 + nameBytes.length;
  const end = new DataView(new ArrayBuffer(22));
  end.setUint32(0, 0x06054b50, true);
  end.setUint16(8, 1, true);
  end.setUint16(10, 1, true);
  end.setUint32(12, centralSize, true);
  end.setUint32(16, centralOffset, true);

  const out = new Uint8Array(centralOffset + centralSize + 22);
  let offset = 0;
  for (const part of [new Uint8Array(local.buffer), nameBytes, content, new Uint8Array(central.buffer), nameBytes, new Uint8Array(end.buffer)]) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// --- endpoints ------------------------------------------------------------------------------------

async function backup(c: Ctx) {
  const now = new Date();
  const document = await exportDocument(c.env.DB, c.get("user").id);
  const zip = zipSingleFile("wallos-export.json", new TextEncoder().encode(JSON.stringify(document, null, 2)), now);
  const stamp = now.toISOString().replace(/[-:]/g, "").replace("T", "-").slice(0, 15);
  return new Response(zip, {
    headers: {
      "content-type": "application/zip",
      "content-disposition": `attachment; filename="Wallos-Backup-${stamp}.zip"`,
      "cache-control": "no-store",
    },
  });
}

routes.post("/endpoints/db/backup.php", backup);
routes.get("/endpoints/db/backup.php", backup);

for (const name of ["restore", "import", "migrate"]) {
  routes.on(["GET", "POST"], `/endpoints/db/${name}.php`, (c) => c.json({ success: false, message: IMPORTER_MESSAGE }));
}
