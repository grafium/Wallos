import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { beforeAll, describe, expect, it } from "vitest";
import worker from "../src/index";
import { activeBudgetPeriod } from "../src/services/budget";

type Json = Record<string, any>;

async function call(path: string, init: RequestInit & { token?: string; json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  const body = init.json === undefined ? init.body : JSON.stringify(init.json);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://wallos.test${path}`, { ...init, headers, body }), env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: response.status, headers: response.headers, body: (await response.json()) as Json };
}

async function login(username: string, password = "correct horse") {
  const res = await call("/api/auth/login", { method: "POST", json: { username, password } });
  expect(res.status).toBe(200);
  return res.body.token as string;
}

let counter = 0;
async function register(prefix = "user") {
  await env.DB.prepare("UPDATE admin SET registrations_open = 1, max_users = 0").run();
  const username = `${prefix}${++counter}`;
  const res = await call("/api/auth/register", {
    method: "POST",
    json: { username, email: `${username}@example.com`, password: "correct horse", main_currency: "EUR" },
  });
  expect(res.status).toBe(201);
  const token = await login(username);
  const key = await call("/api/me/api-key", { token });
  return { username, id: res.body.user_id as number, token, apiKey: key.body.api_key as string };
}

let admin: Awaited<ReturnType<typeof register>>;

beforeAll(async () => {
  // Start from an empty instance so the first account is user 1, the admin.
  await env.DB.prepare("DELETE FROM user").run();
  admin = await register("admin");
  expect(admin.id).toBe(1);
});

describe("activeBudgetPeriod", () => {
  it("anchors monthly periods on the anchor's day, clamped to short months", () => {
    expect(activeBudgetPeriod("2024-05-20", "monthly", "2024-01-15")).toMatchObject({ start: "2024-05-15", end: "2024-06-14", label: "May 15 - Jun 14" });
    expect(activeBudgetPeriod("2024-05-10", "monthly", "2024-01-15")).toMatchObject({ start: "2024-04-15", end: "2024-05-14" });
    expect(activeBudgetPeriod("2024-02-29", "monthly", "2024-01-31")).toMatchObject({ start: "2024-02-29", end: "2024-03-30" });
    expect(activeBudgetPeriod("2024-12-20", "monthly", "2024-01-15")).toMatchObject({ end: "2025-01-14", label: "Dec 15, 2024 - Jan 14, 2025" });
  });

  it("repeats weekly and fortnightly periods from the anchor, also before it", () => {
    expect(activeBudgetPeriod("2024-05-20", "weekly", "2024-05-01")).toMatchObject({ start: "2024-05-15", end: "2024-05-21" });
    expect(activeBudgetPeriod("2024-05-20", "fortnightly", "2024-05-01")).toMatchObject({ start: "2024-05-15", end: "2024-05-28" });
    expect(activeBudgetPeriod("2024-04-30", "weekly", "2024-05-01")).toMatchObject({ start: "2024-04-24", end: "2024-04-30" });
  });

  it("falls back to monthly for unknown types", () => {
    expect(activeBudgetPeriod("2024-05-20", "daily", "2024-05-01").type).toBe("monthly");
  });
});

describe("profile", () => {
  it("updates profile fields and only accepts the user's own currencies as main currency", async () => {
    const user = await register();
    const other = await register();
    const currencies = (await call("/api/currencies", { token: user.token })).body.currencies as Json[];
    const huf = currencies.find((c) => c.code === "HUF")!.id;
    const foreign = (await call("/api/currencies", { token: other.token })).body.currencies[0].id;

    const updated = await call("/api/me", { method: "PATCH", token: user.token, json: { firstname: "Ádám", language: "hu", main_currency: huf } });
    expect(updated.status).toBe(200);
    expect(updated.body.user).toMatchObject({ firstname: "Ádám", language: "hu", main_currency: huf });

    expect((await call("/api/me", { method: "PATCH", token: user.token, json: { main_currency: foreign } })).status).toBe(400);
    expect((await call("/api/me", { method: "PATCH", token: user.token, json: { language: "xx" } })).status).toBe(400);
  });
});

describe("settings", () => {
  it("saves settings, custom colours and CSS", async () => {
    const user = await register();
    const res = await call("/api/me/settings", {
      method: "PATCH",
      token: user.token,
      json: { dark_theme: 1, color_theme: "custom", upcoming_payments_limit: 10, square_icons: true, main_color: "#112233", accent_color: "#445566", hover_color: "#778899", css: "body{}" },
    });
    expect(res.status).toBe(200);
    expect(res.body.settings).toMatchObject({
      dark_theme: 1,
      color_theme: "custom",
      upcoming_payments_limit: 10,
      square_icons: 1,
      custom_colors: { main_color: "#112233", accent_color: "#445566", hover_color: "#778899" },
      custom_css: { css: "body{}" },
    });
  });

  it("rejects invalid values and partial colour sets", async () => {
    const user = await register();
    const bad = await call("/api/me/settings", { method: "PATCH", token: user.token, json: { dark_theme: 5, upcoming_payments_limit: 7, main_color: "blue" } });
    expect(bad.status).toBe(400);
    expect([...new Set(bad.body.errors.map((e: Json) => e.field))].sort()).toEqual(["dark_theme", "main_color", "upcoming_payments_limit"]);
    const partial = await call("/api/me/settings", { method: "PATCH", token: user.token, json: { main_color: "#000000" } });
    expect(partial.status).toBe(400);
  });
});

describe("budget", () => {
  it("stores the budget and projects the active period", async () => {
    const user = await register();
    const today = new Date().toISOString().slice(0, 10);
    const set = await call("/api/me/budget", {
      method: "PATCH",
      token: user.token,
      json: { monthly_budget: 100, period_budget: 20, budget_period_type: "weekly", budget_period_anchor_date: today },
    });
    expect(set.body.budget).toMatchObject({ budget: 100, period_budget: 20, budget_period_type: "weekly", budget_period_anchor_date: today });

    // Weekly 15 due today, a manual one due today, a yearly one outside the week.
    await call("/api/subscriptions", { method: "POST", token: user.token, json: { name: "Weekly", price: 15, cycle: 2, next_payment: today } });
    await call("/api/subscriptions", { method: "POST", token: user.token, json: { name: "Manual", price: 10, auto_renew: 0, next_payment: today } });
    await call("/api/subscriptions", { method: "POST", token: user.token, json: { name: "Paused", price: 99, cycle: 2, inactive: 1, next_payment: today } });

    const res = await call(`/api/stats/period-budget?reference_date=${today}`, { token: user.token });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({
      title: "period_budget",
      period_budget: 20,
      amount_needed_this_period: 25,
      amount_needed_full_period: 25,
      amount_remaining_this_period: 0,
      amount_over_budget: 5,
      is_over_budget: true,
      period_start: today,
      currency_code: "EUR",
    });

    expect((await call("/api/me/budget", { method: "PATCH", token: user.token, json: {} })).status).toBe(400);
  });
});

describe("password change", () => {
  it("requires the current password, then signs out other sessions", async () => {
    const user = await register();
    const otherSession = await login(user.username);

    const wrong = await call("/api/me/password", { method: "POST", token: user.token, json: { current_password: "nope", new_password: "new password!" } });
    expect(wrong.status).toBe(400);
    expect((await call("/api/me/password", { method: "POST", token: user.apiKey, json: { current_password: "correct horse", new_password: "new password!" } })).status).toBe(403);

    const changed = await call("/api/me/password", { method: "POST", token: user.token, json: { current_password: "correct horse", new_password: "new password!" } });
    expect(changed.status).toBe(200);
    expect((await call("/api/me", { token: user.token })).status).toBe(200);
    expect((await call("/api/me", { token: otherSession })).status).toBe(401);

    expect((await call("/api/auth/login", { method: "POST", json: { username: user.username, password: "correct horse" } })).status).toBe(401);
    await login(user.username, "new password!");
  });
});

describe("export", () => {
  it("exports the user's data without secrets", async () => {
    const user = await register();
    await call("/api/subscriptions", { method: "POST", token: user.token, json: { name: "Exported", price: 3 } });
    const res = await call("/api/me/export", { token: user.token });
    expect(res.status).toBe(200);
    expect(res.headers.get("content-disposition")).toMatch(/attachment; filename="wallos-export-/);
    expect(res.body).toMatchObject({ format: "wallos-worker-export", format_version: 1, user: { username: user.username } });
    expect(res.body.subscriptions.map((s: Json) => s.name)).toEqual(["Exported"]);
    expect(res.body.categories).toHaveLength(17);
    expect(JSON.stringify(res.body)).not.toMatch(/pbkdf2|api_key/);
  });
});

describe("admin", () => {
  it("is limited to user 1", async () => {
    const user = await register();
    expect((await call("/api/admin/users", { token: user.token })).status).toBe(403);
    expect((await call("/api/admin/settings", { token: user.token })).status).toBe(403);
    expect((await call(`/api/admin/get_admin_settings.php?api_key=${user.apiKey}`)).status).toBe(403);
  });

  it("changes instance settings", async () => {
    const res = await call("/api/admin/settings", { method: "PATCH", token: admin.token, json: { registrations_open: false, max_users: 5, server_url: "https://wallos.example.com" } });
    expect(res.status).toBe(200);
    expect(res.body.admin_settings).toMatchObject({ registrations_open: 0, max_users: 5, server_url: "https://wallos.example.com" });
    expect((await call("/api/admin/settings", { method: "PATCH", token: admin.token, json: { server_url: "ftp://x" } })).status).toBe(400);
  });

  it("adds users even when registration is closed, lists and deletes them", async () => {
    await env.DB.prepare("UPDATE admin SET registrations_open = 0").run();
    const added = await call("/api/admin/users", { method: "POST", token: admin.token, json: { username: "invited", email: "invited@example.com", password: "correct horse" } });
    expect(added.status).toBe(201);
    const invitedId = added.body.user_id;
    const invited = await login("invited");
    await call("/api/subscriptions", { method: "POST", token: invited, json: { name: "Doomed", price: 1 } });

    expect((await call("/api/admin/users", { method: "POST", token: admin.token, json: { username: "other", email: "invited@example.com", password: "correct horse" } })).status).toBe(409);

    const list = await call("/api/admin/users", { token: admin.token });
    expect(list.body.users.find((u: Json) => u.id === invitedId)).toMatchObject({ username: "invited", subscriptions: 1, is_admin: false });

    expect((await call(`/api/admin/users/${invitedId}`, { method: "DELETE", token: admin.token })).status).toBe(200);
    expect((await call("/api/me", { token: invited })).status).toBe(401);
    const left = await env.DB.prepare("SELECT (SELECT COUNT(*) FROM subscriptions WHERE user_id = ?1) + (SELECT COUNT(*) FROM categories WHERE user_id = ?1) AS n").bind(invitedId).first<{ n: number }>();
    expect(left!.n).toBe(0);

    expect((await call("/api/admin/users/1", { method: "DELETE", token: admin.token })).status).toBe(409);
  });
});

describe("PHP-compatible account endpoints", () => {
  it("serves user, settings, budget and admin endpoints", async () => {
    const user = await register();
    const form = (data: Record<string, string>) => ({
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams(data).toString(),
    });

    const me = await call(`/api/users/get_user.php?api_key=${user.apiKey}`);
    expect(me.body.user).toMatchObject({ username: user.username, password: "********", api_key: "********" });

    const set = await call("/api/settings/set_settings.php", form({ api_key: user.apiKey, dark_theme: "2", color_theme: "red", mobile_nav: "1" }));
    expect(set.body).toMatchObject({ success: true, title: "Settings updated" });
    const settings = await call(`/api/settings/get_settings.php?api_key=${user.apiKey}`);
    expect(settings.body.settings).toMatchObject({ dark_theme: 2, color_theme: "red", mobile_nav: 1 });

    const budget = await call("/api/users/set_budget.php", form({ api_key: user.apiKey, budget: "250", budget_period_type: "monthly" }));
    expect(budget.body).toMatchObject({ success: true, title: "Updated" });
    const period = await call(`/api/subscriptions/get_period_budget.php?api_key=${user.apiKey}&reference_date=2024-05-20`);
    expect(period.body).toMatchObject({ title: "period_budget", budget_period_type: "monthly", reference_date: "2024-05-20" });

    const adminSettings = await call(`/api/admin/get_admin_settings.php?api_key=${admin.apiKey}`);
    expect(adminSettings.body.admin_settings).toHaveProperty("registrations_open");
    const saved = await call("/api/admin/set_admin_settings.php", form({ api_key: admin.apiKey, max_users: "7" }));
    expect(saved.body.admin_settings.max_users).toBe(7);
  });
});
