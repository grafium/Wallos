import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import worker from "../src/index";
import { hashPassword } from "../src/lib/crypto";

type Json = Record<string, any>;

async function call(path: string, init: RequestInit & { token?: string; json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  let body = init.body;
  if (init.json !== undefined) {
    headers.set("content-type", "application/json");
    body = JSON.stringify(init.json);
  }
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://wallos.test${path}`, { ...init, headers, body }), env, ctx);
  await waitOnExecutionContext(ctx);
  return { status: response.status, body: (await response.json()) as Json };
}

let counter = 0;

/** Registers a fresh account (opening registrations if needed) and logs in. */
async function newUser(prefix = "user") {
  await env.DB.prepare("UPDATE admin SET registrations_open = 1").run();
  const username = `${prefix}${++counter}${Math.random().toString(36).slice(2, 7)}`;
  const reg = await call("/api/auth/register", {
    method: "POST",
    json: { username, email: `${username}@example.com`, password: "correct horse", main_currency: "EUR" },
  });
  expect(reg.status).toBe(201);
  const login = await call("/api/auth/login", { method: "POST", json: { username, password: "correct horse" } });
  expect(login.status).toBe(200);
  const me = await call("/api/me", { token: login.body.token });
  const key = await call("/api/me/api-key", { token: login.body.token });
  return { username, userId: reg.body.user_id as number, token: login.body.token as string, apiKey: key.body.api_key as string, me: me.body };
}

async function lookups(token: string) {
  const [currencies, categories, household, methods] = await Promise.all([
    call("/api/currencies", { token }),
    call("/api/categories", { token }),
    call("/api/household", { token }),
    call("/api/payment-methods", { token }),
  ]);
  return {
    mainCurrency: currencies.body.main_currency as number,
    currency: (code: string) => currencies.body.currencies.find((c: Json) => c.code === code).id as number,
    categories: categories.body.categories as Json[],
    household: household.body.household as Json[],
    paymentMethods: methods.body.payment_methods as Json[],
  };
}

describe("health", () => {
  it("reports the database as available after migrations", async () => {
    const res = await call("/api/health");
    expect(res.status).toBe(200);
    expect(res.body.database).toBe("ok");
  });
});

describe("registration and login", () => {
  it("seeds a new account with the Wallos defaults", async () => {
    const user = await newUser();
    const data = await lookups(user.token);
    expect(data.categories).toHaveLength(17);
    expect(data.categories[0]!.name).toBe("No category");
    expect(data.paymentMethods[0]!.name).toBe("PayPal");
    expect(data.household.map((m) => m.name)).toEqual([user.username]);
    expect(data.mainCurrency).toBe(data.currency("EUR"));
    expect(user.me.settings.user_id).toBe(user.userId);
  });

  it("rejects duplicate usernames case-insensitively", async () => {
    const user = await newUser();
    const res = await call("/api/auth/register", {
      method: "POST",
      json: { username: user.username.toUpperCase(), email: "x@example.com", password: "correct horse" },
    });
    expect(res.status).toBe(409);
  });

  it("refuses registration when the admin closed it", async () => {
    await newUser(); // guarantees an admin exists
    await env.DB.prepare("UPDATE admin SET registrations_open = 0").run();
    const res = await call("/api/auth/register", {
      method: "POST",
      json: { username: "latecomer", email: "late@example.com", password: "correct horse" },
    });
    expect(res.status).toBe(403);
  });

  it("rejects a wrong password and unknown users the same way", async () => {
    const user = await newUser();
    const wrong = await call("/api/auth/login", { method: "POST", json: { username: user.username, password: "nope nope" } });
    const unknown = await call("/api/auth/login", { method: "POST", json: { username: "ghost", password: "nope nope" } });
    expect(wrong.status).toBe(401);
    expect(unknown.status).toBe(401);
    expect(wrong.body.title).toBe(unknown.body.title);
  });

  it("accepts a bcrypt hash imported from PHP Wallos and upgrades it", async () => {
    const user = await newUser();
    // password_hash('correct horse', PASSWORD_BCRYPT, ['cost' => 4])
    const phpHash = "$2y$04$eiwnTVCAUekqWSSDxaRkJeXdBubbUEPF21.0kyuBI553sT4ufUd4W";
    await env.DB.prepare("UPDATE user SET password = ? WHERE id = ?").bind(phpHash, user.userId).run();

    const login = await call("/api/auth/login", { method: "POST", json: { username: user.username, password: "correct horse" } });
    expect(login.status).toBe(200);
    const stored = await env.DB.prepare("SELECT password FROM user WHERE id = ?").bind(user.userId).first<{ password: string }>();
    expect(stored!.password.startsWith("pbkdf2_sha256$")).toBe(true);
  });

  it("logs out and invalidates the session token", async () => {
    const user = await newUser();
    expect((await call("/api/auth/logout", { method: "POST", token: user.token })).status).toBe(200);
    expect((await call("/api/me", { token: user.token })).status).toBe(401);
  });

  it("does not let the API key read or rotate itself", async () => {
    const user = await newUser();
    expect((await call("/api/me/api-key", { method: "POST", token: user.apiKey })).status).toBe(403);
    expect((await call("/api/me/api-key", { token: user.apiKey })).status).toBe(403);
  });

  it("requires credentials", async () => {
    expect((await call("/api/subscriptions")).status).toBe(401);
    expect((await call("/api/subscriptions", { token: "bogus" })).status).toBe(401);
  });
});

describe("subscriptions", () => {
  it("creates with defaults, reads, updates, clones and deletes", async () => {
    const user = await newUser();
    const created = await call("/api/subscriptions", {
      method: "POST",
      token: user.token,
      json: { name: "Netflix", price: "15.99", next_payment: "2030-01-15" },
    });
    expect(created.status).toBe(201);
    const sub = created.body.subscription;
    expect(sub).toMatchObject({ name: "Netflix", price: 15.99, cycle: 3, frequency: 1, auto_renew: 1, category_name: "No category" });
    expect(sub.payer_user_name).toBe(user.username);
    expect(sub.payment_method_name).toBe("PayPal");
    expect(sub.currency_code).toBe("EUR");

    const updated = await call(`/api/subscriptions/${sub.id}`, {
      method: "PATCH",
      token: user.token,
      json: { price: 17.99, notes: "Premium", inactive: true },
    });
    expect(updated.status).toBe(200);
    expect(updated.body.subscription).toMatchObject({ price: 17.99, notes: "Premium", inactive: 1, name: "Netflix" });

    const clone = await call(`/api/subscriptions/${sub.id}/clone`, { method: "POST", token: user.token });
    expect(clone.status).toBe(201);

    const list = await call("/api/subscriptions", { token: user.token });
    expect(list.body.subscriptions).toHaveLength(2);

    expect((await call(`/api/subscriptions/${sub.id}`, { method: "DELETE", token: user.token })).status).toBe(200);
    expect((await call(`/api/subscriptions/${sub.id}`, { token: user.token })).status).toBe(404);
  });

  it("validates input", async () => {
    const user = await newUser();
    const res = await call("/api/subscriptions", {
      method: "POST",
      token: user.token,
      json: { name: "", price: -1, next_payment: "2024-02-30", cycle: 9 },
    });
    expect(res.status).toBe(400);
    expect(res.body.errors.map((e: Json) => e.field).sort()).toEqual(["cycle", "name", "next_payment", "price"]);
  });

  it("isolates users from each other's data", async () => {
    const alice = await newUser("alice");
    const bob = await newUser("bob");
    const bobData = await lookups(bob.token);

    const own = await call("/api/subscriptions", { method: "POST", token: alice.token, json: { name: "Mine", price: 1 } });
    const id = own.body.subscriptionId;

    expect((await call(`/api/subscriptions/${id}`, { token: bob.token })).status).toBe(404);
    expect((await call(`/api/subscriptions/${id}`, { method: "PATCH", token: bob.token, json: { price: 0 } })).status).toBe(404);
    expect((await call(`/api/subscriptions/${id}`, { method: "DELETE", token: bob.token })).status).toBe(404);

    // Alice may not point her subscription at Bob's category or currency.
    const foreign = await call("/api/subscriptions", {
      method: "POST",
      token: alice.token,
      json: { name: "Sneaky", price: 1, category_id: bobData.categories[1]!.id, currency_id: bobData.mainCurrency },
    });
    expect(foreign.status).toBe(400);
    expect(foreign.body.fields.sort()).toEqual(["category_id", "currency_id"]);
  });

  it("filters, sorts and converts currencies like the PHP API", async () => {
    const user = await newUser();
    const data = await lookups(user.token);
    const usd = data.currency("USD");
    await call(`/api/currencies/${usd}`, { method: "PATCH", token: user.token, json: { rate: 1.25 } });

    const music = data.categories.find((c) => c.name === "Music")!.id;
    for (const sub of [
      { name: "b-Spotify", price: 10, category_id: music, next_payment: "2030-03-01" },
      { name: "A-Cloud", price: 12.5, currency_id: usd, next_payment: "2030-01-01" },
      { name: "c-Old", price: 99, inactive: 1, next_payment: "2029-01-01" },
    ]) {
      await call("/api/subscriptions", { method: "POST", token: user.token, json: sub });
    }

    const byDate = await call("/api/subscriptions", { token: user.token });
    expect(byDate.body.subscriptions.map((s: Json) => s.name)).toEqual(["c-Old", "A-Cloud", "b-Spotify"]);

    const byName = await call("/api/subscriptions?sort=alphanumeric&disabled_to_bottom=true", { token: user.token });
    expect(byName.body.subscriptions.map((s: Json) => s.name)).toEqual(["A-Cloud", "b-Spotify", "c-Old"]);

    const byPrice = await call("/api/subscriptions?sort=price", { token: user.token });
    expect(byPrice.body.subscriptions.map((s: Json) => s.name)).toEqual(["c-Old", "A-Cloud", "b-Spotify"]);

    const active = await call(`/api/subscriptions?state=0&category=${music}`, { token: user.token });
    expect(active.body.subscriptions.map((s: Json) => s.name)).toEqual(["b-Spotify"]);

    const converted = await call("/api/subscriptions?convert_currency=true", { token: user.token });
    expect(converted.body.subscriptions.find((s: Json) => s.name === "A-Cloud").price).toBe(10);
  });

  it("renews only subscriptions without automatic renewal", async () => {
    const user = await newUser();
    const auto = await call("/api/subscriptions", { method: "POST", token: user.token, json: { name: "Auto", price: 1 } });
    expect((await call(`/api/subscriptions/${auto.body.subscriptionId}/renew`, { method: "POST", token: user.token })).status).toBe(409);

    const manual = await call("/api/subscriptions", {
      method: "POST",
      token: user.token,
      json: { name: "Manual", price: 1, auto_renew: false, next_payment: "2099-05-10", cycle: 4 },
    });
    const renewed = await call(`/api/subscriptions/${manual.body.subscriptionId}/renew`, { method: "POST", token: user.token });
    expect(renewed.status).toBe(200);
    expect(renewed.body.next_payment).toBe("2100-05-10");
  });
});

describe("lookups", () => {
  it("refuses to delete rows in use, the main currency and the household owner", async () => {
    const user = await newUser();
    const data = await lookups(user.token);
    const category = data.categories[2]!.id;
    const sub = await call("/api/subscriptions", { method: "POST", token: user.token, json: { name: "X", price: 1, category_id: category } });

    expect((await call(`/api/categories/${category}`, { method: "DELETE", token: user.token })).status).toBe(409);
    expect((await call(`/api/currencies/${data.mainCurrency}`, { method: "DELETE", token: user.token })).status).toBe(409);
    expect((await call(`/api/household/${data.household[0]!.id}`, { method: "DELETE", token: user.token })).status).toBe(409);

    await call(`/api/subscriptions/${sub.body.subscriptionId}`, { method: "DELETE", token: user.token });
    expect((await call(`/api/categories/${category}`, { method: "DELETE", token: user.token })).status).toBe(200);
  });

  it("creates and renames entries", async () => {
    const user = await newUser();
    const member = await call("/api/household", { method: "POST", token: user.token, json: { name: "Anna", email: "anna@example.com" } });
    expect(member.status).toBe(201);
    const renamed = await call(`/api/household/${member.body.item.id}`, { method: "PATCH", token: user.token, json: { name: "Anna K." } });
    expect(renamed.body.item).toMatchObject({ name: "Anna K.", email: "anna@example.com", in_use: false });
  });
});

describe("statistics", () => {
  it("computes the cost of a calendar month in the main currency", async () => {
    const user = await newUser();
    const data = await lookups(user.token);
    const usd = data.currency("USD");
    await call(`/api/currencies/${usd}`, { method: "PATCH", token: user.token, json: { rate: 2 } });

    for (const sub of [
      { name: "Weekly", price: 1, cycle: 2, next_payment: "2024-05-01" }, // 5 payments in May 2024
      { name: "Monthly USD", price: 20, currency_id: usd, next_payment: "2024-07-15" }, // 10 EUR
      { name: "Yearly", price: 100, cycle: 4, next_payment: "2025-05-20" }, // falls in May
      { name: "Paused", price: 1000, inactive: 1, next_payment: "2024-05-02" },
    ]) {
      await call("/api/subscriptions", { method: "POST", token: user.token, json: sub });
    }

    const res = await call("/api/stats/monthly-cost?month=5&year=2024", { token: user.token });
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ title: "May 2024", monthly_cost: "115.00", currency_code: "EUR", localized_monthly_cost: "€115.00" });

    const summary = await call("/api/stats/summary", { token: user.token });
    expect(summary.body).toMatchObject({ active_subscriptions: 3, inactive_subscriptions: 1 });
    expect(summary.body.monthly_cost).toBeCloseTo(4.35 + 10 + 100 / 12, 2);
  });
});

describe("PHP Wallos API compatibility", () => {
  it("serves the .php endpoints with api_key as a parameter", async () => {
    const user = await newUser();
    const add = new URLSearchParams({ api_key: user.apiKey, action: "add", name: "Legacy", price: "5", currency_id: "", cycle: "3", frequency: "1", next_payment: "2030-02-02", notifications: "1" });
    const added = await call("/api/subscriptions/set_subscriptions.php", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: add.toString(),
    });
    expect(added.status).toBe(201);
    expect(added.body.success).toBe(true);
    const id = added.body.subscriptionId;

    const list = await call(`/api/subscriptions/get_subscriptions.php?api_key=${user.apiKey}`);
    expect(list.body).toMatchObject({ success: true, title: "subscriptions", notes: [] });
    expect(list.body.subscriptions[0]).toMatchObject({ id, name: "Legacy", notify: 1 });

    const edit = new URLSearchParams({ apiKey: user.apiKey, action: "edit", id: String(id), price: "6" });
    const edited = await call("/api/subscriptions/set_subscriptions.php", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: edit.toString(),
    });
    expect(edited.body.subscription.price).toBe(6);

    const one = await call(`/api/subscriptions/get_subscription.php?api_key=${user.apiKey}&id=${id}`);
    expect(one.body.subscription.name).toBe("Legacy");

    const cost = await call(`/api/subscriptions/get_monthly_cost.php?api_key=${user.apiKey}&month=2&year=2030`);
    expect(cost.body.monthly_cost).toBe("6.00");

    const categories = await call(`/api/categories/get_categories.php?api_key=${user.apiKey}`);
    expect(categories.body.categories[0]).toMatchObject({ name: "No category", in_use: true });

    const version = await call(`/api/status/version.php?api_key=${user.apiKey}`);
    expect(version.body.version).toMatch(/^v\d+\.\d+\.\d+$/);
  });
});

describe("scheduled jobs", () => {
  it("rolls overdue auto-renewing subscriptions forward", async () => {
    const user = await newUser();
    const today = new Date().toISOString().slice(0, 10);
    const overdue = await call("/api/subscriptions", { method: "POST", token: user.token, json: { name: "Overdue", price: 1, cycle: 1, frequency: 1, next_payment: "2020-01-01" } });
    const manual = await call("/api/subscriptions", { method: "POST", token: user.token, json: { name: "Manual", price: 1, auto_renew: 0, next_payment: "2020-01-01" } });

    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: "0 1 * * *", scheduledTime: Date.now() }), env, ctx);
    await waitOnExecutionContext(ctx);

    expect((await call(`/api/subscriptions/${overdue.body.subscriptionId}`, { token: user.token })).body.subscription.next_payment).toBe(today);
    expect((await call(`/api/subscriptions/${manual.body.subscriptionId}`, { token: user.token })).body.subscription.next_payment).toBe("2020-01-01");
  });

  it("purges expired sessions", async () => {
    const user = await newUser();
    await env.DB.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00.000Z' WHERE user_id = ?").bind(user.userId).run();
    expect((await call("/api/me", { token: user.token })).status).toBe(401);

    const ctx = createExecutionContext();
    await worker.scheduled(createScheduledController({ cron: "0 1 * * *", scheduledTime: Date.now() }), env, ctx);
    await waitOnExecutionContext(ctx);
    const left = await env.DB.prepare("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?").bind(user.userId).first<{ n: number }>();
    expect(left!.n).toBe(0);
  });
});

describe("password hashing", () => {
  it("produces unique salted PBKDF2 hashes", async () => {
    const [a, b] = await Promise.all([hashPassword("same"), hashPassword("same")]);
    expect(a).not.toBe(b);
    expect(a.split("$")).toHaveLength(4);
  });
});
