import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { buildImport, decodeHtml, type SourceTables } from "../src/import/wallos-import";
import fixture from "./fixtures/php-wallos.json";

/*
  The fixture is a real PHP Wallos database (scripts/fixtures/create-php-wallos-db.php):
  run through all PHP migrations, text saved with PHP's validate(), passwords
  hashed with password_hash(), plus the usual damage - duplicate settings,
  orphaned rows, text rates, a clashing username, a dangling replacement.
*/

type Json = Record<string, any>;

async function call(path: string, init: RequestInit & { token?: string; json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  const body = init.json === undefined ? init.body : JSON.stringify(init.json);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://wallos.test${path}`, { ...init, headers, body }), env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: response.status, body: (await response.json()) as Json };
}

async function login(username: string, password: string) {
  const res = await call("/api/auth/login", { method: "POST", json: { username, password } });
  expect(res.status).toBe(200);
  return res.body.token as string;
}

const result = buildImport(fixture as unknown as SourceTables, { replace: true });

beforeAll(async () => {
  await env.DB.batch(result.statements.map((statement) => env.DB.prepare(statement)));
});

describe("decodeHtml", () => {
  it("reverses htmlspecialchars exactly once", () => {
    expect(decodeHtml("Tom &amp; Jerry&#039;s &lt;Plus&gt; &quot;x&quot;")).toBe(`Tom & Jerry's <Plus> "x"`);
    expect(decodeHtml("&amp;lt;")).toBe("&lt;");
    expect(decodeHtml("AT&T")).toBe("AT&T");
  });
});

describe("import report", () => {
  it("counts what was imported, skipped and left for later phases", () => {
    const { report } = result;
    expect(report.imported).toMatchObject({ user: 3, subscriptions: 8, household: 3, admin: 1, settings: 1, custom_colors: 1 });
    expect(report.skipped).toMatchObject({ settings: 2, subscriptions: 1 });
    expect(report.notImported).toEqual({ email_notifications: { rows: 1, phase: "3" } });
    expect(report.files).toEqual({ logos: ["1700000000-netflix.png"], avatars: ["images/uploads/logos/avatars/me.png"] });
    expect(report.warnings.join("\n")).toMatch(/renamed to "BOB_3"/);
    expect(report.warnings.join("\n")).toMatch(/replacement subscription 999/);
  });
});

describe("imported data", () => {
  it("lets users log in with their PHP bcrypt passwords and upgrades the hash", async () => {
    await login("admin", "admin-pass");
    await login("bob", "bob-pass");
    await login("BOB_3", "bob2-pass");
    const row = await env.DB.prepare("SELECT password FROM user WHERE id = 1").first<{ password: string }>();
    expect(row!.password.startsWith("pbkdf2_sha256$")).toBe(true);
  });

  it("keeps API keys working, except a duplicated one", async () => {
    const list = await call(`/api/subscriptions/get_subscriptions.php?api_key=${"a".repeat(64)}`);
    expect(list.status).toBe(200);
    const bob = await env.DB.prepare("SELECT api_key FROM user WHERE id = 2").first<{ api_key: string | null }>();
    expect(bob!.api_key).toBeNull();
  });

  it("decodes escaped text but leaves notes as stored", async () => {
    const token = await login("admin", "admin-pass");
    const subs = (await call("/api/subscriptions", { token })).body.subscriptions as Json[];
    const tom = subs.find((s) => s.id === 2)!;
    expect(tom.name).toBe("Tom & Jerry's <Plus>");
    expect(tom.notes).toBe("Fish & chips **bold**");
    expect(subs.find((s) => s.id === 1)!.url).toBe("https://netflix.com/?a=1&b=2");

    const me = (await call("/api/me", { token })).body.user;
    expect(me).toMatchObject({ firstname: "Zoë & Co", lastname: "O'Brien" });

    const household = (await call("/api/household", { token })).body.household as Json[];
    expect(household.map((m) => m.name)).toContain('Anna "Panni" <K>');
  });

  it("repairs dates, rates, replacements and orphans", async () => {
    const token = await login("admin", "admin-pass");
    const subs = (await call("/api/subscriptions", { token })).body.subscriptions as Json[];
    expect(subs.map((s) => s.id).sort()).toEqual([1, 2, 3, 4, 5, 6, 7]); // 8 was orphaned, 9 is bob's
    expect(subs.find((s) => s.id === 4)).toMatchObject({ next_payment: null, start_date: null, replacement_subscription_id: 5 });
    expect(subs.find((s) => s.id === 6)!.replacement_subscription_id).toBeNull();

    const currencies = (await call("/api/currencies", { token })).body.currencies as Json[];
    expect(currencies.find((c) => c.code === "USD")!.rate).toBe(1.085);
    expect(currencies.find((c) => c.code === "GBP")!.rate).toBe(1);
  });

  it("keeps the last settings row and the custom colours", async () => {
    const token = await login("admin", "admin-pass");
    const settings = (await call("/api/me", { token })).body.settings;
    expect(settings).toMatchObject({ color_theme: "green", dark_theme: 1, disabled_to_bottom: 1 });
    const colors = await env.DB.prepare("SELECT main_color FROM custom_colors WHERE user_id = 1").first<{ main_color: string }>();
    expect(colors!.main_color).toBe("#112233");
  });

  it("gives every user a usable main currency", async () => {
    const bob = await login("bob", "bob-pass");
    const created = await call("/api/subscriptions", { method: "POST", token: bob, json: { name: "New", price: 1 } });
    expect(created.status).toBe(201);
    expect(created.body.subscription.currency_code).toBe("HUF");
  });

  it("computes the same month as PHP once currencies are converted and one-time payments counted once", async () => {
    const token = await login("admin", "admin-pass");
    // PHP reports 352.84: it skips conversion until rates are fetched (10.85 USD
    // instead of 10 EUR). Netflix 15.99 + Tom 10 + New gym 25 + Course 300 + Sneaky 1.
    const may = await call("/api/stats/monthly-cost?month=5&year=2024", { token });
    expect(may.body.monthly_cost).toBe("351.99");
    // PHP repeats the one-time "Course" every month (352.84 again); it is paid once.
    const june = await call("/api/stats/monthly-cost?month=6&year=2024", { token });
    expect(june.body.monthly_cost).toBe("51.99");
  });

  it("imports the admin settings", async () => {
    const admin = await env.DB.prepare("SELECT registrations_open, max_users FROM admin WHERE id = 1").first();
    expect(admin).toEqual({ registrations_open: 1, max_users: 10 });
  });
});
