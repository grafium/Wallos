import { createExecutionContext, createScheduledController, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { base64urlEncode } from "../src/lib/webpush";

type Json = Record<string, any>;

// --- helpers -------------------------------------------------------------------

async function call(path: string, init: RequestInit & { token?: string; json?: unknown } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  const body = init.json === undefined ? init.body : JSON.stringify(init.json);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://wallos.test${path}`, { ...init, headers, body }), env, ctx);
  await waitOnExecutionContext(ctx);
  const text = await response.text();
  let parsed: Json;
  try {
    parsed = JSON.parse(text);
  } catch {
    parsed = { html: text };
  }
  return { status: response.status, body: parsed };
}

async function cron(iso: string) {
  const ctx = createExecutionContext();
  await worker.scheduled(createScheduledController({ cron: "0 * * * *", scheduledTime: Date.parse(iso) }), env, ctx);
  await waitOnExecutionContext(ctx);
}

interface Outbound {
  url: string;
  method: string;
  headers: Headers;
  body: string;
  bytes: Uint8Array | null;
}

let outbound: Outbound[] = [];
let respond: (request: Outbound) => Response = () => new Response("{}", { status: 200 });

beforeEach(() => {
  outbound = [];
  respond = (r) => (r.url.startsWith("https://api.resend.com/") ? Response.json({ id: "email_1" }) : new Response("{}", { status: 200 }));
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const raw = init?.body;
    const bytes = raw instanceof Uint8Array ? raw : null;
    const request: Outbound = {
      url: String(input instanceof Request ? input.url : input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof raw === "string" ? raw : raw instanceof URLSearchParams ? raw.toString() : "",
      bytes,
    };
    outbound.push(request);
    return respond(request);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const sentTo = (prefix: string) => outbound.filter((r) => r.url.startsWith(prefix));
const emails = () => sentTo("https://api.resend.com/emails").map((r) => JSON.parse(r.body));

let counter = 0;
async function register(prefix = "user", extra: Record<string, unknown> = {}) {
  await env.DB.prepare("UPDATE admin SET registrations_open = 1").run();
  const username = `${prefix}${++counter}`;
  const res = await call("/api/auth/register", {
    method: "POST",
    json: { username, email: `${username}@example.com`, password: "correct horse", main_currency: "EUR", ...extra },
  });
  expect(res.status).toBe(201);
  return { username, id: res.body.user_id as number, email: `${username}@example.com`, registration: res.body };
}

async function login(username: string, password = "correct horse") {
  const res = await call("/api/auth/login", { method: "POST", json: { username, password } });
  return { status: res.status, token: res.body.token as string, body: res.body };
}

async function newUser(prefix = "user") {
  const user = await register(prefix);
  const { token } = await login(user.username);
  return { ...user, token };
}

let adminToken: string;

beforeAll(async () => {
  await env.DB.prepare("DELETE FROM user").run();
  await env.DB.prepare("UPDATE admin SET require_email_verification = 0").run();
  const admin = await register("admin");
  expect(admin.id).toBe(1);
  adminToken = (await login(admin.username)).token;
});

// --- channels ----------------------------------------------------------------------

describe("notification channels", () => {
  it("validates, stores and masks channel settings", async () => {
    const user = await newUser();
    const bad = await call("/api/notifications/channels/gotify", { method: "PUT", token: user.token, json: { enabled: true, url: "http://192.168.1.5", token: "" } });
    expect(bad.status).toBe(400);
    expect(bad.body.errors.map((e: Json) => e.field).sort()).toEqual(["token", "url"]);

    const saved = await call("/api/notifications/channels/gotify", { method: "PUT", token: user.token, json: { enabled: true, url: "https://gotify.example.com", token: "s3cret" } });
    expect(saved.body).toMatchObject({ enabled: 1, config: { url: "https://gotify.example.com", token: "********" } });

    // Sending the mask back keeps the stored secret.
    await call("/api/notifications/channels/gotify", { method: "PUT", token: user.token, json: { enabled: true, url: "https://gotify2.example.com", token: "********" } });
    const row = await env.DB.prepare("SELECT config FROM notification_channels WHERE user_id = ? AND channel = 'gotify'").bind(user.id).first<{ config: string }>();
    expect(JSON.parse(row!.config)).toEqual({ url: "https://gotify2.example.com", token: "s3cret" });

    expect((await call("/api/notifications/channels/carrier-pigeon", { method: "PUT", token: user.token, json: {} })).status).toBe(404);
  });

  it("sends test messages in the formats of PHP Wallos", async () => {
    const user = await newUser();
    const send = (channel: string, json: Json) => call(`/api/notifications/channels/${channel}/test`, { method: "POST", token: user.token, json });

    expect((await send("discord", { webhook_url: "https://discord.com/api/webhooks/1/x", bot_username: "Wallos" })).status).toBe(200);
    expect(JSON.parse(outbound.at(-1)!.body)).toEqual({ content: "Wallos test notification: this channel works.\n", username: "Wallos" });

    await send("telegram", { bot_token: "123:abc", chat_id: "42" });
    expect(outbound.at(-1)!.url).toBe("https://api.telegram.org/bot123:abc/sendMessage");

    await send("pushover", { user_key: "u", token: "t" });
    expect(outbound.at(-1)!.body).toBe("token=t&user=u&message=Wallos+test+notification%3A+this+channel+works.%0A");

    await send("ntfy", { host: "https://ntfy.sh/", topic: "wallos", headers: '{"Priority":"high"}' });
    expect(outbound.at(-1)).toMatchObject({ url: "https://ntfy.sh/wallos" });
    expect(outbound.at(-1)!.headers.get("priority")).toBe("high");

    await send("gotify", { url: "https://gotify.example.com/", token: "a b" });
    expect(outbound.at(-1)!.url).toBe("https://gotify.example.com/message?token=a%20b");

    await send("serverchan", { sendkey: "sctp123tabc" });
    expect(outbound.at(-1)!.url).toBe("https://123.push.ft07.com/send/sctp123tabc.send");

    await send("webhook", { url: "https://hooks.example.com/x", headers: "X-Token: abc", payload: '{"n":"{{subscription_name}}","notes":"{{subscription_notes}}","d":{{days_until}}}' });
    expect(outbound.at(-1)!.headers.get("x-token")).toBe("abc");
    expect(JSON.parse(outbound.at(-1)!.body)).toEqual({ n: "Wallos test", notes: "This is a test notification.", d: 1 });

    await send("email", { other_emails: "a@example.com; b@example.com" });
    expect(emails().at(-1)).toMatchObject({ from: "Wallos <wallos@example.com>", to: [user.email], cc: ["a@example.com", "b@example.com"], subject: "Wallos Notification" });
    expect(outbound.at(-1)!.headers.get("authorization")).toBe("Bearer re_test_key");
  });

  it("reports a failing channel instead of pretending", async () => {
    const user = await newUser();
    respond = () => new Response('{"ok":false,"description":"chat not found"}', { status: 400 });
    const res = await call("/api/notifications/channels/telegram/test", { method: "POST", token: user.token, json: { bot_token: "1:a", chat_id: "x" } });
    expect(res.status).toBe(502);
    expect(res.body.message).toMatch(/HTTP 400.*chat not found/);
  });
});

// --- reminders ------------------------------------------------------------------------

describe("payment and cancellation reminders", () => {
  // 2030-06-10 07:00 UTC is 09:00 in Budapest (CEST).
  const BUDAPEST_9AM = "2030-06-10T07:00:00Z";

  async function budapestUser() {
    const user = await newUser("bp");
    await call("/api/me", { method: "PATCH", token: user.token, json: { timezone: "Europe/Budapest" } });
    await call("/api/notifications/channels/discord", { method: "PUT", token: user.token, json: { enabled: true, webhook_url: `https://discord.com/api/webhooks/${user.id}/x` } });
    return user;
  }

  it("reminds at 09:00 local time, per household member, once per day", async () => {
    const user = await budapestUser();
    await call("/api/notifications/settings", { method: "PATCH", token: user.token, json: { days: 3 } });
    const anna = await call("/api/household", { method: "POST", token: user.token, json: { name: "Anna" } });
    for (const sub of [
      { name: "Netflix", price: 15.99, next_payment: "2030-06-13", notify: 1 },
      { name: "Gym", price: 30, next_payment: "2030-06-11", notify: 1, notify_days_before: 1, payer_user_id: anna.body.item.id },
      { name: "Silent", price: 5, next_payment: "2030-06-13", notify: 0 },
      { name: "Later", price: 5, next_payment: "2030-06-20", notify: 1 },
    ]) {
      expect((await call("/api/subscriptions", { method: "POST", token: user.token, json: sub })).status).toBe(201);
    }

    await cron("2030-06-10T06:00:00Z"); // 08:00 in Budapest: not yet
    expect(sentTo(`https://discord.com/api/webhooks/${user.id}/`)).toHaveLength(0);

    await cron(BUDAPEST_9AM);
    const messages = sentTo(`https://discord.com/api/webhooks/${user.id}/`).map((r) => JSON.parse(r.body).content);
    expect(messages).toEqual([
      `${user.username}, the following subscriptions are up for renewal:\nNetflix for €15.99 (In 3 days)\n`,
      "Anna, the following subscriptions are up for renewal:\nGym for €30.00 (Tomorrow)\n",
    ]);

    await cron(BUDAPEST_9AM); // the same hour again
    expect(sentTo(`https://discord.com/api/webhooks/${user.id}/`)).toHaveLength(2);

    const log = await env.DB.prepare("SELECT kind, local_date, result FROM notification_log WHERE user_id = ?").bind(user.id).all();
    expect(log.results).toEqual([{ kind: "payment", local_date: "2030-06-10", result: '{"discord":"ok"}' }]);
  });

  it("sends cancellation reminders at 08:00 local time", async () => {
    const user = await budapestUser();
    await call("/api/subscriptions", { method: "POST", token: user.token, json: { name: "Trial", price: 9.99, next_payment: "2030-07-01", cancellation_date: "2030-06-10" } });
    await call("/api/subscriptions", { method: "POST", token: user.token, json: { name: "Once", price: 50, cycle: 5, next_payment: "2030-07-01", cancellation_date: "2030-06-10" } });

    await cron("2030-06-10T06:00:00Z");
    const messages = sentTo(`https://discord.com/api/webhooks/${user.id}/`).map((r) => JSON.parse(r.body).content);
    expect(messages).toEqual([`${user.username}, the following subscriptions are up for cancellation:\nTrial for 9.99€\n`]);
  });

  it("fills webhook templates per subscription and e-mails the payer", async () => {
    const user = await newUser("hook");
    await call("/api/notifications/channels/webhook", {
      method: "PUT",
      token: user.token,
      json: { enabled: true, url: "https://hooks.example.com/w", payload: '{"name":"{{subscription_name}}","price":"{{subscription_price}}","date":"{{subscription_date}}","notes":"{{subscription_notes}}"}' },
    });
    await call("/api/notifications/channels/email", { method: "PUT", token: user.token, json: { enabled: true } });
    await call("/api/subscriptions", { method: "POST", token: user.token, json: { name: 'Say "hi"', price: 2, next_payment: "2030-06-11", notify: 1, notes: 'He said "hi"\nbye' } });

    await cron("2030-06-10T09:00:00Z"); // UTC user
    expect(JSON.parse(sentTo("https://hooks.example.com/w")[0]!.body)).toEqual({ name: 'Say "hi"', price: "€2.00", date: "2030-06-11", notes: 'He said "hi"\nbye' });
    expect(emails().find((e) => e.to[0] === user.email)).toMatchObject({ subject: "Wallos Notification", text: 'The following subscriptions are up for renewal:\nSay "hi" for €2.00 (Tomorrow)\n' });
  });

  it("previews what would be sent", async () => {
    const user = await newUser("preview");
    await call("/api/subscriptions", { method: "POST", token: user.token, json: { name: "Box", price: 1, next_payment: "2031-01-02", notify: 1 } });
    const res = await call("/api/notifications/preview?kind=payment&date=2031-01-01", { token: user.token });
    expect(res.body.messages).toEqual([
      expect.objectContaining({ recipient_email: user.email, text: `${user.username}, the following subscriptions are up for renewal:\nBox for €1.00 (Tomorrow)\n` }),
    ]);
  });
});

// --- web push ----------------------------------------------------------------------------

describe("web push", () => {
  async function browserKeys() {
    const ua = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    return {
      p256dh: base64urlEncode((await crypto.subtle.exportKey("raw", ua.publicKey)) as ArrayBuffer),
      auth: base64urlEncode(crypto.getRandomValues(new Uint8Array(16))),
    };
  }

  it("registers devices, sends encrypted pushes and prunes dead subscriptions", async () => {
    const user = await newUser("push");
    const key = await call("/api/notifications/push/public-key", { token: user.token });
    expect(key.body.public_key).toMatch(/^[A-Za-z0-9_-]{87}$/);

    for (const endpoint of ["https://push.example.com/alive", "https://push.example.com/gone"]) {
      const res = await call("/api/notifications/push/subscriptions", { method: "POST", token: user.token, json: { endpoint, keys: await browserKeys() } });
      expect(res.status).toBe(201);
    }
    expect((await call("/api/notifications/push/subscriptions", { method: "POST", token: user.token, json: { endpoint: "http://x", keys: { p256dh: "a", auth: "b" } } })).status).toBe(400);

    respond = (r) => new Response("", { status: r.url.endsWith("/gone") ? 410 : 201 });
    const res = await call("/api/notifications/channels/push/test", { method: "POST", token: user.token, json: {} });
    expect(res.status).toBe(200);

    const alive = sentTo("https://push.example.com/alive")[0]!;
    expect(alive.headers.get("content-encoding")).toBe("aes128gcm");
    expect(alive.headers.get("ttl")).toBe("2419200");
    expect(alive.headers.get("authorization")).toMatch(new RegExp(`^vapid t=[\\w-]+\\.[\\w-]+\\.[\\w-]+, k=${key.body.public_key}$`));
    expect(alive.bytes!.length).toBeGreaterThan(86);

    const left = await env.DB.prepare("SELECT endpoint FROM push_subscriptions WHERE user_id = ?").bind(user.id).all();
    expect(left.results).toEqual([{ endpoint: "https://push.example.com/alive" }]);
  });
});

// --- exchange rates ------------------------------------------------------------------------

describe("exchange rates", () => {
  it("refreshes from Frankfurter in the main currency, retrying without refused codes", async () => {
    const user = await newUser("fx");
    await call("/api/currencies", { method: "POST", token: user.token, json: { name: "Bitcoin", symbol: "₿", code: "BTC" } });
    let attempt = 0;
    respond = (r) => {
      if (!r.url.startsWith("https://api.frankfurter.dev/v2/rates")) return new Response("{}");
      attempt++;
      if (attempt === 1) return Response.json({ status: 422, message: "invalid currency: BTC,RUB" }, { status: 422 });
      expect(r.url).not.toMatch(/BTC|RUB/);
      return Response.json([
        { date: "2026-10-13", base: "EUR", quote: "USD", rate: 1.1 },
        { date: "2026-10-13", base: "EUR", quote: "HUF", rate: 400 },
      ]);
    };

    const settings = await call("/api/exchange-rates", { token: user.token });
    expect(settings.body).toMatchObject({ provider: 2, provider_name: "Frankfurter" });

    const res = await call("/api/exchange-rates/refresh", { method: "POST", token: user.token });
    expect(res.status).toBe(200);
    expect(res.body.held).toEqual(expect.arrayContaining(["BTC", "RUB"]));
    expect(sentTo("https://api.frankfurter.dev/")[0]!.url).toMatch(/base=EUR/);

    const currencies = (await call("/api/currencies", { token: user.token })).body.currencies as Json[];
    expect(currencies.find((c) => c.code === "USD")!.rate).toBe(1.1);
    expect(currencies.find((c) => c.code === "HUF")!.rate).toBe(400);
    expect(currencies.find((c) => c.code === "EUR")!.rate).toBe(1);
  });

  it("converts Fixer's EUR rates into the main currency and runs once a day", async () => {
    const user = await newUser("fixer");
    const currencies = (await call("/api/currencies", { token: user.token })).body.currencies as Json[];
    await call("/api/me", { method: "PATCH", token: user.token, json: { main_currency: currencies.find((c) => c.code === "HUF")!.id } });

    expect((await call("/api/exchange-rates", { method: "PUT", token: user.token, json: { provider: 0 } })).status).toBe(400);
    const saved = await call("/api/exchange-rates", { method: "PUT", token: user.token, json: { provider: 0, api_key: "fixer-key" } });
    expect(saved.body).toMatchObject({ provider: 0, api_key: "********" });

    respond = (r) =>
      r.url.startsWith("http://data.fixer.io/") ? Response.json({ success: true, base: "EUR", rates: { EUR: 1, HUF: 400, USD: 1.1 } }) : new Response("{}");
    await cron("2030-06-10T02:00:00Z");
    expect(sentTo("http://data.fixer.io/")[0]!.url).toMatch(/access_key=fixer-key/);

    const after = (await call("/api/currencies", { token: user.token })).body.currencies as Json[];
    expect(after.find((c) => c.code === "HUF")!.rate).toBe(1);
    expect(after.find((c) => c.code === "EUR")!.rate).toBe(0.0025);
    expect(after.find((c) => c.code === "USD")!.rate).toBeCloseTo(0.00275, 8);

    // A second run on the same day leaves the provider alone.
    outbound = [];
    await cron("2030-06-10T02:00:00Z");
    expect(sentTo("http://data.fixer.io/")).toHaveLength(0);
  });

  it("serves the PHP fixer endpoints", async () => {
    const user = await newUser("legacyfx");
    const apiKey = (await call("/api/me/api-key", { token: user.token })).body.api_key;
    const set = await call("/api/fixer/set_fixer.php", {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({ api_key: apiKey, fixer_api_key: "k", provider: "1" }).toString(),
    });
    expect(set.body).toMatchObject({ success: true, title: "Fixer settings updated" });
    const get = await call(`/api/fixer/get_fixer.php?api_key=${apiKey}`);
    expect(get.body.fixer).toEqual({ api_key: "********", provider: 1, provider_name: "APILayer.com" });

    const notifications = await call(`/api/notifications/get_notification_settings.php?api_key=${apiKey}`);
    expect(notifications.body.notification_settings).toEqual({ days: 1 });
  });
});

// --- e-mail flows ------------------------------------------------------------------------------

describe("password reset", () => {
  it("e-mails a one-hour link that sets a new password and signs out everywhere", async () => {
    const user = await newUser("reset");
    const res = await call("/api/auth/password-reset", { method: "POST", json: { email: user.email } });
    expect(res.status).toBe(200);
    const mail = emails().find((e) => e.to[0] === user.email)!;
    expect(mail.subject).toBe("Wallos: reset your password");
    const link = new URL(/https?:\/\/\S+/.exec(mail.text)![0]);
    expect(link.pathname).toBe("/reset-password");
    const token = link.searchParams.get("token")!;

    // A second request within five minutes sends nothing new.
    await call("/api/auth/password-reset", { method: "POST", json: { email: user.email } });
    expect(emails().filter((e) => e.to[0] === user.email)).toHaveLength(1);

    // Unknown addresses get the same answer and no e-mail.
    const unknown = await call("/api/auth/password-reset", { method: "POST", json: { email: "nobody@example.com" } });
    expect(unknown.body.message).toBe(res.body.message);

    const page = await call(`/reset-password?email=${encodeURIComponent(user.email)}&token=${token}`);
    expect(page.body.html).toContain("Choose a new password");

    const wrong = await call("/api/auth/password-reset/confirm", { method: "POST", json: { email: user.email, token: "0".repeat(64), password: "brand new pass" } });
    expect(wrong.status).toBe(400);
    const ok = await call("/api/auth/password-reset/confirm", { method: "POST", json: { email: user.email, token, password: "brand new pass" } });
    expect(ok.status).toBe(200);

    expect((await call("/api/me", { token: user.token })).status).toBe(401);
    expect((await login(user.username)).status).toBe(401);
    expect((await login(user.username, "brand new pass")).status).toBe(200);
    // The token is spent.
    expect((await call("/api/auth/password-reset/confirm", { method: "POST", json: { email: user.email, token, password: "again again" } })).status).toBe(400);
  });

  it("rejects expired links", async () => {
    const user = await newUser("expired");
    await call("/api/auth/password-reset", { method: "POST", json: { email: user.email } });
    const token = new URL(/https?:\/\/\S+/.exec(emails().at(-1)!.text)![0]).searchParams.get("token")!;
    await env.DB.prepare("UPDATE password_resets SET created_at = datetime('now', '-61 minutes') WHERE user_id = ?").bind(user.id).run();
    expect((await call("/api/auth/password-reset/confirm", { method: "POST", json: { email: user.email, token, password: "brand new pass" } })).status).toBe(400);
  });
});

describe("e-mail verification", () => {
  it("holds new accounts back until the e-mailed link is opened", async () => {
    const enable = await call("/api/admin/settings", { method: "PATCH", token: adminToken, json: { require_email_verification: true, server_url: "https://wallos.example.com" } });
    expect(enable.status).toBe(200);
    try {
      const user = await register("verify");
      expect(user.registration.email_verification_required).toBe(true);
      expect((await login(user.username)).status).toBe(403);

      const mail = emails().find((e) => e.to[0] === user.email)!;
      const link = new URL(/https?:\/\/\S+/.exec(mail.text)![0]);
      expect(link.origin + link.pathname).toBe("https://wallos.example.com/verify-email");

      const bad = await call(`/verify-email?email=${encodeURIComponent(user.email)}&token=${"0".repeat(64)}`);
      expect(bad.status).toBe(400);
      const good = await call(link.pathname + link.search);
      expect(good.status).toBe(200);
      expect(good.body.html).toContain("E-mail confirmed");
      expect((await login(user.username)).status).toBe(200);
    } finally {
      await env.DB.prepare("UPDATE admin SET require_email_verification = 0, server_url = NULL").run();
    }
  });
});
