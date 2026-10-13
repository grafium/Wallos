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
    expect(report.notImported).toEqual({});
    expect(report.imported).toMatchObject({ notification_settings: 1, notification_channels: 5, push_subscriptions: 1, fixer: 1, last_exchange_update: 1 });
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

  it("folds the per-channel PHP tables into notification channels", async () => {
    const token = await login("admin", "admin-pass");
    const res = await call("/api/notifications", { token });
    expect(res.body.settings).toEqual({ days: 3, period_summary_at_period_start: 0 });
    expect(res.body.channels.email).toEqual({ enabled: 1, config: { other_emails: "cc@example.com" } });
    expect(res.body.channels.discord).toEqual({ enabled: 1, config: { webhook_url: "https://discord.com/api/webhooks/1/abc", bot_username: "Wallos" } });
    expect(res.body.channels.webhook.config).toMatchObject({ url: "https://hooks.example.com/wallos", headers: "********", payload: '{"name":"{{subscription_name}}"}' });
    expect(res.body.channels.push.enabled).toBe(1);

    const rates = await call("/api/exchange-rates", { token });
    expect(rates.body).toMatchObject({ provider: 2, provider_name: "Frankfurter", last_update: "2026-10-12" });

    const bob = await login("bob", "bob-pass");
    expect((await call("/api/exchange-rates", { token: bob })).body.provider).toBe("manual");
    expect((await call("/api/notifications", { token: bob })).body.channels.telegram).toMatchObject({ enabled: 0, config: { chat_id: "42", bot_token: "********" } });
  });

  it("imports the admin settings", async () => {
    const admin = await env.DB.prepare("SELECT registrations_open, max_users FROM admin WHERE id = 1").first();
    expect(admin).toEqual({ registrations_open: 1, max_users: 10 });
  });
});

describe("two-factor and OIDC data", () => {
  const passwordHash = (fixture as unknown as SourceTables).user!.find((u) => u.username === "bob")!.password;
  const user = (id: number, extra: Record<string, unknown> = {}) => ({ id, username: `tfa${id}`, email: `tfa${id}@example.com`, password: passwordHash, totp_enabled: 0, ...extra });
  const secret = "JBSWY3DPEHPK3PXPJBSWY3DPEHPK3PXP";
  const source: SourceTables = {
    user: [user(50, { totp_enabled: 1 }), user(51, { totp_enabled: 1 }), user(52, { oidc_sub: "same" }), user(53, { oidc_sub: "same" })],
    totp: [{ user_id: 50, totp_secret: secret, backup_codes: JSON.stringify(["abcdef0123456789abcd", "0123456789abcdef0123"]), last_totp_used: 1_700_000_000 }],
    oauth_settings: [
      {
        id: 1,
        name: "Authentik",
        client_id: "cid",
        client_secret: "a&amp;b",
        authorization_url: "https://idp.example.com/auth?x=1&y=2",
        token_url: "https://idp.example.com/token",
        user_info_url: "https://idp.example.com/me",
        redirect_url: "https://wallos.example.com/",
        user_identifier_field: "sub",
        scopes: "openid email profile",
        auth_style: "auto",
        auto_create_user: 1,
        password_login_disabled: 0,
        require_email_verified: null,
      },
    ],
  };
  const imported = buildImport(source);

  it("imports enrolments with hashed backup codes, and repairs the impossible ones", async () => {
    expect(imported.report.notImported).toEqual({});
    expect(imported.report.imported).toMatchObject({ user: 4, totp: 1, oauth_settings: 1 });
    expect(imported.report.warnings.join("\n")).toMatch(/User 51 .* without a usable secret; it was switched off/);
    expect(imported.report.warnings.join("\n")).toMatch(/User 53 .* shared an OIDC subject/);
    expect(imported.statements.join("\n")).not.toContain("abcdef0123456789abcd");
    await env.DB.batch(imported.statements.map((statement) => env.DB.prepare(statement)));

    const flags = await env.DB.prepare("SELECT id, totp_enabled, oidc_sub FROM user WHERE id >= 50 ORDER BY id").all();
    expect(flags.results).toEqual([
      { id: 50, totp_enabled: 1, oidc_sub: null },
      { id: 51, totp_enabled: 0, oidc_sub: null },
      { id: 52, totp_enabled: 0, oidc_sub: "same" },
      { id: 53, totp_enabled: 0, oidc_sub: null },
    ]);

    // The old PHP backup code still opens the account, once.
    const first = await call("/api/auth/login", { method: "POST", json: { username: "tfa50", password: "bob-pass" } });
    expect(first.body.two_factor_required).toBe(true);
    const withCode = await call("/api/auth/login", { method: "POST", json: { username: "tfa50", password: "bob-pass", totp_code: "ABCDEF0123456789ABCD" } });
    expect(withCode.status).toBe(200);
    expect((await call("/api/auth/login", { method: "POST", json: { username: "tfa50", password: "bob-pass", totp_code: "abcdef0123456789abcd" } })).status).toBe(401);
    expect((await call("/api/auth/login", { method: "POST", json: { username: "tfa51", password: "bob-pass" } })).status).toBe(200);
  });

  it("keeps the provider settings as PHP saved them", async () => {
    const row = await env.DB.prepare("SELECT client_secret, authorization_url, auto_create_user, require_email_verified FROM oauth_settings WHERE id = 1").first();
    expect(row).toEqual({ client_secret: "a&amp;b", authorization_url: "https://idp.example.com/auth?x=1&y=2", auto_create_user: 1, require_email_verified: 1 });
  });
});

describe("history and AI data", () => {
  const passwordHash = (fixture as unknown as SourceTables).user!.find((u) => u.username === "bob")!.password;
  const source: SourceTables = {
    user: [{ id: 60, username: "hist60", email: "hist60@example.com", password: passwordHash }, { id: 61, username: "hist61", email: "hist61@example.com", password: passwordHash }],
    total_yearly_cost: [
      { id: 1, user_id: 60, date: "2025-01-06", cost: 1200, currency: "1" },
      { id: 2, user_id: 60, date: "2025-01-06", cost: 1300, currency: "1" },
      { id: 3, user_id: 60, date: "not a date", cost: 1, currency: "1" },
      { id: 4, user_id: 99, date: "2025-01-06", cost: 1, currency: "1" },
    ],
    ai_settings: [
      { id: 1, user_id: 60, type: "ollama", enabled: 1, api_key: "", model: "llama3", url: "http://192.168.1.10:11434", run_schedule: "weekly", last_successful_run: "2025-01-06 03:30:00" },
      { id: 2, user_id: 60, type: "chatgpt", enabled: 1, api_key: "sk", model: "gpt", url: "", run_schedule: "monthly" },
      { id: 3, user_id: 61, type: "gemini", enabled: 1, api_key: "g", model: "", url: "", run_schedule: "sometimes" },
    ],
    ai_recommendations: [
      { id: 1, user_id: 60, type: "subscription", title: "Cancel &amp; save", description: "Because.", savings: "5 EUR/month" },
      { id: 2, user_id: 60, type: "subscription", title: "", description: "No title" },
    ],
  };
  const imported = buildImport(source);

  it("keeps one point per day, the first AI settings row, and the recommendations", async () => {
    expect(imported.report.notImported).toEqual({});
    expect(imported.report.imported).toMatchObject({ total_yearly_cost: 1, ai_settings: 2, ai_recommendations: 1 });
    expect(imported.report.skipped).toMatchObject({ total_yearly_cost: 3, ai_settings: 1, ai_recommendations: 1 });
    expect(imported.report.warnings.join("\n")).toMatch(/User 60's AI provider \(http:\/\/192\.168\.1\.10:11434\) is on a private network/);
    await env.DB.batch(imported.statements.map((statement) => env.DB.prepare(statement)));

    expect((await env.DB.prepare("SELECT date, cost FROM total_yearly_cost WHERE user_id = 60").all()).results).toEqual([{ date: "2025-01-06", cost: 1300 }]);
    const ai = await env.DB.prepare("SELECT user_id, type, enabled, run_schedule FROM ai_settings WHERE user_id IN (60, 61) ORDER BY user_id").all();
    expect(ai.results).toEqual([
      { user_id: 60, type: "ollama", enabled: 1, run_schedule: "weekly" },
      { user_id: 61, type: "gemini", enabled: 0, run_schedule: "manual" }, // no model: cannot run
    ]);
    expect(await env.DB.prepare("SELECT title FROM ai_recommendations WHERE user_id = 60").first("title")).toBe("Cancel & save");
  });
});
