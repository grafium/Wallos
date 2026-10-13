import { env } from "cloudflare:workers";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runScheduled } from "../src/cron";
import { BACKUP_PREFIX, BACKUP_RETENTION, createBackup, dumpDatabase } from "../src/services/backup";
import { browserSession, endpoint, getPage, raw, type Browser, type Json } from "./ui-helpers";

/*
  Phase 8: instance backups (SQL dump of D1 into R2).
*/

/** Splits a dump into statements: a statement ends with ";" at the end of a line, outside quotes. */
function statements(sql: string): string[] {
  const out: string[] = [];
  let current = "";
  let quotes = 0;
  for (const line of sql.split("\n")) {
    if (!current && (line.startsWith("--") || line.startsWith("PRAGMA") || !line.trim())) continue;
    current += (current ? "\n" : "") + line;
    quotes += (line.match(/'/g) ?? []).length;
    if (quotes % 2 === 0 && line.endsWith(";")) {
      out.push(current);
      current = "";
      quotes = 0;
    }
  }
  return out;
}

async function gunzip(body: ArrayBuffer): Promise<string> {
  return new Response(new Blob([body]).stream().pipeThrough(new DecompressionStream("gzip"))).text();
}

async function api(browser: Browser, path: string, method = "GET") {
  return raw(path, { method, headers: { authorization: `Bearer ${browser.token}` } });
}

afterEach(() => vi.restoreAllMocks());

describe("instance backups", () => {
  it("dumps every table as INSERT OR REPLACE and brings the data back after a loss", async () => {
    await env.DB.prepare("DELETE FROM user").run();
    const admin = await browserSession("backupadmin");
    const created = await raw("/api/subscriptions", {
      method: "POST",
      headers: { authorization: `Bearer ${admin.token}`, "content-type": "application/json" },
      body: JSON.stringify({ name: "It's \"quoted\"\nand multi-line", price: 9.99, notes: "line one\nline two; with semicolon;" }),
    });
    expect(created.status).toBe(201);

    const dump = await dumpDatabase(env.DB);
    expect(dump.sql).toContain("PRAGMA defer_foreign_keys = true;");
    expect(dump.sql).toContain('INSERT OR REPLACE INTO "user"');
    expect(dump.sql).toContain("'It''s \"quoted\"\nand multi-line'");
    expect(dump.sql).not.toMatch(/INTO "(sessions|auth_flows|login_attempts|d1_migrations)"/);
    // Parents come before the tables that refer to them.
    expect(dump.sql.indexOf('INTO "user"')).toBeLessThan(dump.sql.indexOf('INTO "subscriptions"'));

    const before = await env.DB.prepare("SELECT name, price, notes FROM subscriptions WHERE user_id = ?").bind(admin.userId).all();
    await env.DB.prepare("DELETE FROM user").run(); // cascades to everything per user
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM subscriptions").first("n")).toBe(0);

    await env.DB.batch(statements(dump.sql).map((s) => env.DB.prepare(s)));
    expect((await env.DB.prepare("SELECT name, price, notes FROM subscriptions WHERE user_id = ?").bind(admin.userId).all()).results).toEqual(before.results);
    // Sessions were not part of it: the old token is gone, the password still works.
    expect((await api(admin, "/api/me")).status).toBe(401);
    const login = await raw("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: admin.username, password: "correct horse" }) });
    expect(login.status).toBe(200);
  });

  it("stores gzipped dumps in R2 on Sundays at 04:00 UTC and keeps the last eight", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));
    for (const day of [1, 2, 3, 4, 5, 6, 7, 8, 9, 10]) {
      await env.FILES.put(`${BACKUP_PREFIX}wallos-2025-01-${String(day).padStart(2, "0")}.sql.gz`, "old");
    }
    await runScheduled(env, Date.UTC(2026, 9, 17, 4)); // Saturday: nothing
    expect(await env.FILES.head(`${BACKUP_PREFIX}wallos-2026-10-17.sql.gz`)).toBeNull();
    await runScheduled(env, Date.UTC(2026, 9, 18, 4)); // Sunday
    const object = await env.FILES.get(`${BACKUP_PREFIX}wallos-2026-10-18.sql.gz`);
    expect(object).not.toBeNull();
    expect(await gunzip(await object!.arrayBuffer())).toContain('INSERT OR REPLACE INTO "user"');

    const listed = await env.FILES.list({ prefix: BACKUP_PREFIX });
    expect(listed.objects).toHaveLength(BACKUP_RETENTION);
    expect(listed.objects.map((o) => o.key)).toContain(`${BACKUP_PREFIX}wallos-2026-10-18.sql.gz`);
    expect(listed.objects.map((o) => o.key)).not.toContain(`${BACKUP_PREFIX}wallos-2025-01-01.sql.gz`);
  });

  it("is listed, made and downloaded by the administrator only", async () => {
    await env.DB.prepare("DELETE FROM user").run();
    const admin = await browserSession("bkadmin");
    const other = await browserSession("bkother");
    expect(admin.userId).toBe(1);

    const made = await endpoint(admin, "/api/admin/backups", { method: "POST" }); // the admin page's button: cookie + CSRF
    expect(made.status).toBe(201);
    const name = made.json!.backup.name as string;
    expect(name).toMatch(/^wallos-\d{4}-\d{2}-\d{2}T\d{4}Z\.sql\.gz$/);

    const list = (await (await api(admin, "/api/admin/backups")).json()) as Json;
    expect(list.backups.map((b: Json) => b.name)).toContain(name);
    expect((await api(other, "/api/admin/backups")).status).toBe(403);

    const download = await api(admin, `/api/admin/backups/${name}`);
    expect(download.headers.get("content-disposition")).toBe(`attachment; filename="${name}"`);
    expect(await gunzip(await download.arrayBuffer())).toContain("-- Wallos (Cloudflare Worker) backup");
    expect((await api(admin, "/api/admin/backups/..%2Fimages%2Fsecret.sql.gz")).status).toBe(404);
    expect((await api(other, `/api/admin/backups/${name}`)).status).toBe(403);
    // Nothing under backups/ is reachable as a public file.
    expect((await raw(`/backups/${name}`)).status).not.toBe(200);

    const page = await getPage(admin, "/admin.php");
    expect(page.html).toContain(`href="api/admin/backups/${name}"`);
  });

  it("names on-demand backups by the minute", async () => {
    const backup = await createBackup(env, { now: new Date(Date.UTC(2026, 9, 13, 21, 5)) });
    expect(backup.name).toBe("wallos-2026-10-13T2105Z.sql.gz");
    expect(backup.rows).toBeGreaterThan(0);
  });
});
