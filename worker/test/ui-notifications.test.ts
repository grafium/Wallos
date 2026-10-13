import { env } from "cloudflare:workers";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { base64urlEncode } from "../src/lib/webpush";
import { browserSession, endpoint, raw, type Browser } from "./ui-helpers";

/*
  endpoints/notifications/*, endpoints/ai/* and endpoints/db/* as the
  settings and admin pages' scripts call them. Outbound requests are
  intercepted.
*/

interface Outbound {
  url: string;
  method: string;
  headers: Headers;
  body: string;
}

let outbound: Outbound[] = [];
let respond: (request: Outbound) => Response;

beforeEach(() => {
  outbound = [];
  respond = (r) => (r.url.startsWith("https://api.resend.com/") ? Response.json({ id: "email_1" }) : new Response("{}", { status: 200 }));
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const body = init?.body;
    const request: Outbound = {
      url: String(input instanceof Request ? input.url : input),
      method: init?.method ?? "GET",
      headers: new Headers(init?.headers),
      body: typeof body === "string" ? body : body instanceof URLSearchParams ? body.toString() : "",
    };
    outbound.push(request);
    return respond(request);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

const post = (browser: Browser, name: string, json: unknown = {}) => endpoint(browser, `/endpoints/notifications/${name}.php`, { json });

async function storedChannel(userId: number, channel: string) {
  const row = await env.DB.prepare("SELECT enabled, config FROM notification_channels WHERE user_id = ? AND channel = ?")
    .bind(userId, channel)
    .first<{ enabled: number; config: string }>();
  return row ? { enabled: row.enabled, config: JSON.parse(row.config) as Record<string, unknown> } : null;
}

async function browserKeys() {
  const pair = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
  return {
    p256dh: base64urlEncode((await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer),
    auth: base64urlEncode(crypto.getRandomValues(new Uint8Array(16))),
  };
}

const SAVED = "Notification settings saved successfully.";
const SENT = "Notification sent successfully";
const MANDATORY = "Please fill all mandatory fields";

describe("notification endpoints: access", () => {
  it("requires a session and the CSRF token", async () => {
    const browser = await browserSession("ncsrf");
    const without = await endpoint(browser, "/endpoints/notifications/savenotificationsettings.php", { json: { days: 3 }, csrf: false });
    expect(without.json).toEqual({ success: false, message: "Invalid CSRF token" });
    const anonymous = await raw("/endpoints/notifications/savenotificationsettings.php", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ days: 3 }),
    });
    expect(((await anonymous.json()) as Record<string, unknown>).success).toBe(false);
    expect(await env.DB.prepare("SELECT days FROM notification_settings WHERE user_id = ?").bind(browser.userId).first("days")).not.toBe(3);
  });
});

describe("notification endpoints: saving channels", () => {
  it("saves Discord with PHP's field names mapped to the channel config", async () => {
    const browser = await browserSession("ndisc");
    const res = await post(browser, "savediscordnotifications", { enabled: 1, url: "https://discord.example.com/hook", bot_username: "Wallos", bot_avatar: "https://x.example.com/a.png" });
    expect(res.json).toEqual({ success: true, message: SAVED });
    expect(await storedChannel(browser.userId, "discord")).toEqual({
      enabled: 1,
      config: { webhook_url: "https://discord.example.com/hook", bot_username: "Wallos", bot_avatar_url: "https://x.example.com/a.png" },
    });
  });

  it("answers PHP's messages for missing fields, bad URLs and private hosts", async () => {
    const browser = await browserSession("nval");
    expect((await post(browser, "savediscordnotifications", { enabled: 1, url: "" })).json).toEqual({ success: false, message: MANDATORY });
    expect((await post(browser, "savegotifynotifications", { enabled: 1, gotify_url: "https://g.example.com" })).json!.message).toBe(MANDATORY);
    expect((await post(browser, "savewebhooknotifications", { enabled: 1, webhook_url: "ftp://example.com" })).json).toEqual({ success: false, message: "Error" });
    const privateHost = await post(browser, "saventfynotifications", { enabled: 1, host: "http://192.168.1.10", topic: "t" });
    expect(privateHost.json!.success).toBe(false);
    expect(privateHost.json!.message).toMatch(/Private IP/);
    expect(await storedChannel(browser.userId, "ntfy")).toBeNull();
  });

  it("saves every channel's fields", async () => {
    const browser = await browserSession("nall");
    const cases: [string, Record<string, unknown>, string, Record<string, unknown>][] = [
      ["savegotifynotifications", { enabled: 1, gotify_url: "https://gotify.example.com", token: "tok", ignore_ssl: 1 }, "gotify", { url: "https://gotify.example.com", token: "tok" }],
      ["savetelegramnotifications", { enabled: 1, bot_token: "123:abc", chat_id: "42" }, "telegram", { bot_token: "123:abc", chat_id: "42" }],
      ["savepushovernotifications", { enabled: 0, user_key: "u", token: "t" }, "pushover", { user_key: "u", token: "t" }],
      ["saventfynotifications", { enabled: 1, host: "https://ntfy.sh", topic: "wallos", headers: '{"X-A":"1"}', ignore_ssl: 0 }, "ntfy", { host: "https://ntfy.sh", topic: "wallos", headers: '{"X-A":"1"}' }],
      ["savemattermostnotifications", { enabled: 1, webhook_url: "https://mm.example.com/hooks/x", bot_username: "bot", bot_icon_emoji: ":bell:" }, "mattermost", { webhook_url: "https://mm.example.com/hooks/x", bot_username: "bot", bot_icon_emoji: ":bell:" }],
      ["savepushplusnotifications", { enabled: 1, token: "pp" }, "pushplus", { token: "pp" }],
      ["saveserverchannotifications", { enabled: 1, sendkey: "SCT1" }, "serverchan", { sendkey: "SCT1" }],
      ["saveemailnotifications", { enabled: 1, smtpaddress: "smtp.example.com", smtpport: "587", encryption: "tls", smtpusername: "u", smtppassword: "p", fromemail: "f@example.com", otheremails: "a@example.com;b@example.com" }, "email", { other_emails: "a@example.com;b@example.com" }],
    ];
    for (const [name, body, channel, config] of cases) {
      const res = await post(browser, name, body);
      expect(res.json, name).toEqual({ success: true, message: SAVED });
      expect(await storedChannel(browser.userId, channel), name).toEqual({ enabled: body.enabled, config });
    }
    const badEmails = await post(browser, "saveemailnotifications", { enabled: 1, otheremails: "not an address" });
    expect(badEmails.json!.success).toBe(false);
    expect(badEmails.json!.message).toMatch(/^Error: /);
  });

  it("keeps the webhook's request method, which the page does not post", async () => {
    const browser = await browserSession("nhook");
    const body = { enabled: 1, webhook_url: "https://hook.example.com", headers: '["X-Token: abc"]', payload: '{"n":"{{subscription_name}}"}', cancelation_payload: "", ignore_ssl: 0 };
    await post(browser, "savewebhooknotifications", body);
    expect((await storedChannel(browser.userId, "webhook"))!.config.request_method).toBe("POST");
    await env.DB.prepare("UPDATE notification_channels SET config = json_set(config, '$.request_method', 'PUT') WHERE user_id = ? AND channel = 'webhook'").bind(browser.userId).run();
    await post(browser, "savewebhooknotifications", body);
    expect(await storedChannel(browser.userId, "webhook")).toEqual({
      enabled: 1,
      config: { url: "https://hook.example.com", request_method: "PUT", headers: '["X-Token: abc"]', payload: '{"n":"{{subscription_name}}"}', cancelation_payload: "" },
    });
  });

  it("keeps a masked secret and never reveals another user's", async () => {
    const alice = await browserSession("nmaska");
    const bob = await browserSession("nmaskb");
    await post(alice, "savegotifynotifications", { enabled: 1, gotify_url: "https://gotify.example.com", token: "alice-secret" });
    await post(alice, "savegotifynotifications", { enabled: 1, gotify_url: "https://gotify2.example.com", token: "********" });
    expect((await storedChannel(alice.userId, "gotify"))!.config).toEqual({ url: "https://gotify2.example.com", token: "alice-secret" });

    // Testing with the mask uses the stored secret.
    expect((await post(alice, "testgotifynotifications", { gotify_url: "https://gotify2.example.com", token: "********" })).json).toEqual({ success: true, message: SENT });
    expect(outbound.at(-1)!.url).toBe("https://gotify2.example.com/message?token=alice-secret");

    // Bob has nothing stored: the mask is not a token, and Alice's is never used.
    const bobTest = await post(bob, "testgotifynotifications", { gotify_url: "https://gotify2.example.com", token: "********" });
    expect(bobTest.json!.success).toBe(false);
    expect(outbound.filter((r) => r.url.includes("alice-secret"))).toHaveLength(1);
    expect(await storedChannel(bob.userId, "gotify")).toBeNull();
  });

  it("answers in the user's language", async () => {
    const browser = await browserSession("nhu", { language: "hu" });
    expect((await post(browser, "savepushplusnotifications", { enabled: 1, token: "" })).json!.message).toBe("Kérjük, töltsön ki minden kötelező mezőt");
    expect((await post(browser, "savepushplusnotifications", { enabled: 1, token: "x" })).json!.message).toBe("Értesítési beállítások sikeresen mentve.");
  });
});

describe("notification endpoints: test messages", () => {
  it("sends a test through each channel with the posted settings", async () => {
    const browser = await browserSession("ntest");
    respond = (r) => {
      if (r.url.startsWith("https://api.resend.com/")) return Response.json({ id: "email_1" });
      if (r.url.startsWith("https://www.pushplus.plus/")) return Response.json({ code: 200 });
      return new Response("{}", { status: 200 });
    };
    const text = "This is a test notification. If you're seeing this, the configuration is correct.";

    const cases: [string, Record<string, unknown>, (r: Outbound) => void][] = [
      ["testdiscordnotifications", { enabled: 1, url: "https://discord.example.com/hook", bot_username: "W", bot_avatar: "" }, (r) => {
        expect(r.url).toBe("https://discord.example.com/hook");
        expect(JSON.parse(r.body)).toEqual({ content: text, username: "W" });
      }],
      ["testgotifynotifications", { enabled: 1, gotify_url: "https://gotify.example.com/", token: "tk", ignore_ssl: 0 }, (r) => {
        expect(r.url).toBe("https://gotify.example.com/message?token=tk");
      }],
      ["testtelegramnotifications", { enabled: 1, bottoken: "123:abc", chatid: "42" }, (r) => {
        expect(r.url).toBe("https://api.telegram.org/bot123:abc/sendMessage");
        expect(JSON.parse(r.body)).toEqual({ chat_id: "42", text });
      }],
      ["testpushovernotifications", { enabled: 1, user_key: "uk", token: "tk" }, (r) => {
        expect(r.url).toBe("https://api.pushover.net/1/messages.json");
        expect(new URLSearchParams(r.body).get("user")).toBe("uk");
      }],
      ["testntfynotifications", { host: "https://ntfy.sh/", topic: "wallos", headers: '{"Authorization":"Bearer x"}', ignore_ssl: 0 }, (r) => {
        expect(r.url).toBe("https://ntfy.sh/wallos");
        expect(r.headers.get("authorization")).toBe("Bearer x");
        expect(r.body).toBe(text);
      }],
      ["testwebhooknotifications", { enabled: 1, requestmethod: "PUT", url: "https://hook.example.com/in", customheaders: '["X-Token: abc"]', payload: '{"name":"{{subscription_name}}"}', cancelation_payload: "", ignore_ssl: 0 }, (r) => {
        expect(r.url).toBe("https://hook.example.com/in");
        expect(r.method).toBe("PUT");
        expect(r.headers.get("x-token")).toBe("abc");
        expect(JSON.parse(r.body)).toEqual({ name: "Wallos test" });
      }],
      ["testmattermostnotifications", { enabled: 1, webhook_url: "https://mm.example.com/hooks/x", bot_username: "bot", bot_icon_emoji: ":bell:" }, (r) => {
        expect(JSON.parse(r.body)).toEqual({ username: "bot", icon_emoji: ":bell:", text });
      }],
      ["testpushplusnotifications", { enabled: 1, token: "pp" }, (r) => {
        expect(r.url).toBe("https://www.pushplus.plus/send");
        expect(JSON.parse(r.body).token).toBe("pp");
      }],
      ["testserverchannotifications", { enabled: 1, sendkey: "SCTabc" }, (r) => {
        expect(r.url).toBe("https://sctapi.ftqq.com/SCTabc.send");
      }],
      ["testemailnotifications", { smtpaddress: "smtp.example.com", smtpport: "587", encryption: "tls", smtpusername: "", smtppassword: "", fromemail: "" }, (r) => {
        expect(r.url).toBe("https://api.resend.com/emails");
        const mail = JSON.parse(r.body);
        expect(mail.to).toEqual([`${browser.username}@example.com`]);
        expect(mail.subject).toBe("Wallos Notification");
        expect(mail.text).toBe(text);
      }],
    ];
    for (const [name, body, check] of cases) {
      const before = outbound.length;
      const res = await post(browser, name, body);
      expect(res.json, name).toEqual({ success: true, message: SENT });
      expect(outbound.length, name).toBe(before + 1);
      check(outbound.at(-1)!);
    }
    // Tests never save anything.
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM notification_channels WHERE user_id = ?").bind(browser.userId).first("n")).toBe(0);
  });

  it("checks the required test fields like PHP", async () => {
    const browser = await browserSession("ntreq");
    expect((await post(browser, "testtelegramnotifications", { bot_token: "1:a", chat_id: "2" })).json!.message).toBe(MANDATORY);
    expect((await post(browser, "testmattermostnotifications", { webhook_url: "https://mm.example.com/x", bot_username: "", bot_icon_emoji: "" })).json!.message).toBe(MANDATORY);
    expect((await post(browser, "testwebhooknotifications", { requestmethod: "POST", url: "https://h.example.com", payload: "" })).json!.message).toBe(MANDATORY);
    expect((await post(browser, "testserverchannotifications", { enabled: 0, sendkey: "SCT" })).json!.message).toBe(MANDATORY);
    expect((await post(browser, "testdiscordnotifications", { url: "http://localhost/hook" })).json!.success).toBe(false);
    expect(outbound).toHaveLength(0);
  });

  it("reports a failed send", async () => {
    const browser = await browserSession("ntfail");
    respond = () => new Response("nope", { status: 500 });
    const res = await post(browser, "testdiscordnotifications", { url: "https://discord.example.com/hook" });
    expect(res.json!.success).toBe(false);
    expect(res.json!.message).toMatch(/^Notification failed: HTTP 500/);

    respond = () => Response.json({ message: "bad key" }, { status: 401 });
    const mail = await post(browser, "testemailnotifications", {});
    expect(mail.json!.success).toBe(false);
    expect(mail.json!.message).toMatch(/^Error sending email: Resend answered 401/);
  });
});

describe("notification endpoints: general settings", () => {
  it("saves the days and the period summary", async () => {
    const browser = await browserSession("nset");
    expect((await post(browser, "savenotificationsettings", { days: "" })).json).toEqual({ success: false, message: MANDATORY });
    expect((await post(browser, "savenotificationsettings", { days: "abc" })).json).toEqual({ success: false, message: "Error" });
    expect((await post(browser, "savenotificationsettings", { days: "3", period_summary_at_period_start: 1 })).json).toEqual({ success: true, message: SAVED });
    expect(await env.DB.prepare("SELECT days, period_summary_at_period_start AS p FROM notification_settings WHERE user_id = ?").bind(browser.userId).first()).toEqual({ days: 3, p: 1 });
    await post(browser, "savenotificationsettings", { days: 7, period_summary_at_period_start: 0 });
    expect(await env.DB.prepare("SELECT days, period_summary_at_period_start AS p FROM notification_settings WHERE user_id = ?").bind(browser.userId).first()).toEqual({ days: 7, p: 0 });
  });
});

describe("notification endpoints: web push", () => {
  it("enables the channel, registers devices and removes them", async () => {
    const alice = await browserSession("npusha");
    const bob = await browserSession("npushb");

    expect((await post(alice, "savenotificationspush", { enabled: 1 })).json).toEqual({ success: true, message: SAVED });
    expect(await storedChannel(alice.userId, "push")).toEqual({ enabled: 1, config: {} });
    await post(alice, "savenotificationspush", { enabled: 0 });
    expect((await storedChannel(alice.userId, "push"))!.enabled).toBe(0);

    expect((await post(alice, "testpushnotifications")).json).toEqual({ success: false, message: "No devices registered yet." });

    const keys = await browserKeys();
    const subscription = { endpoint: "https://push.example.com/device-1", keys };
    const first = await endpoint(alice, "/endpoints/notifications/savepushsubscription.php", { json: subscription });
    expect(first.json!.success).toBe(true);
    expect(first.json!.message).toBe(SAVED);
    expect(first.json!.subscription).toMatchObject({ is_new: true });
    const id = first.json!.subscription.id as number;
    expect(id).toBeGreaterThan(0);
    const again = await post(alice, "savepushsubscription", subscription);
    expect(again.json!.subscription).toMatchObject({ id, is_new: false });

    expect((await post(alice, "savepushsubscription", { endpoint: "https://push.example.com/x" })).json!.message).toBe(MANDATORY);
    expect((await post(alice, "savepushsubscription", { endpoint: "http://push.example.com/x", keys })).json!.message).toBe("Error");
    expect((await post(alice, "savepushsubscription", { endpoint: "https://push.example.com/x", keys: { p256dh: "abc", auth: "def" } })).json!.message).toBe("Error");

    // A test push reaches the registered device.
    respond = () => new Response(null, { status: 201 });
    expect((await post(alice, "testpushnotifications")).json).toEqual({ success: true, message: SENT });
    expect(outbound.at(-1)!.url).toBe("https://push.example.com/device-1");

    // Bob cannot remove Alice's device, by id or by endpoint.
    expect((await post(bob, "removepushsubscription", { id })).json!.success).toBe(true);
    expect((await post(bob, "removepushsubscription", { endpoint: subscription.endpoint })).json!.success).toBe(true);
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?").bind(alice.userId).first("n")).toBe(1);

    expect((await post(alice, "removepushsubscription", {})).json!.message).toBe(MANDATORY);
    expect((await post(alice, "removepushsubscription", { id })).json).toEqual({ success: true, message: SAVED });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?").bind(alice.userId).first("n")).toBe(0);

    await post(alice, "savepushsubscription", subscription);
    await post(alice, "removepushsubscription", { endpoint: subscription.endpoint });
    expect(await env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?").bind(alice.userId).first("n")).toBe(0);
  });

  it("reports a push that no device accepted", async () => {
    const browser = await browserSession("npushf");
    await post(browser, "savepushsubscription", { endpoint: "https://push.example.com/broken", keys: await browserKeys() });
    respond = () => new Response("err", { status: 500 });
    expect((await post(browser, "testpushnotifications")).json).toEqual({ success: false, message: "Notification failed" });
  });
});

/** Reads the single stored entry of the zip the backup returns. */
function unzipSingle(bytes: Uint8Array): { name: string; content: string } {
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  expect(view.getUint32(0, true)).toBe(0x04034b50);
  expect(view.getUint16(8, true)).toBe(0); // stored
  const size = view.getUint32(18, true);
  const nameLength = view.getUint16(26, true);
  const name = new TextDecoder().decode(bytes.subarray(30, 30 + nameLength));
  const content = new TextDecoder().decode(bytes.subarray(30 + nameLength, 30 + nameLength + size));
  expect(view.getUint32(bytes.length - 22, true)).toBe(0x06054b50);
  return { name, content };
}

describe("database endpoints", () => {
  it("backs up the user's own data as JSON inside the zip admin.js expects", async () => {
    const alice = await browserSession("dba");
    const bob = await browserSession("dbb");
    await endpoint(alice, "/api/subscriptions", { json: { name: "Alice's Netflix", price: 9.99 } });
    await endpoint(bob, "/api/subscriptions", { json: { name: "Bob's Spotify", price: 5 } });

    const response = await raw("/endpoints/db/backup.php", { method: "POST", headers: { cookie: alice.cookie, "x-csrf-token": alice.csrf } });
    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("application/zip");
    expect(response.headers.get("content-disposition")).toMatch(/^attachment; filename="Wallos-Backup-\d{8}-\d{6}\.zip"$/);
    const { name, content } = unzipSingle(new Uint8Array(await response.arrayBuffer()));
    expect(name).toBe("wallos-export.json");
    const data = JSON.parse(content);
    expect(data.format).toBe("wallos-worker-export");
    expect(data.user.username).toBe(alice.username);
    expect(data.user.password).toBeUndefined();
    expect(data.user.api_key).toBeUndefined();
    expect(data.subscriptions.map((s: { name: string }) => s.name)).toEqual(["Alice's Netflix"]);
    expect(Array.isArray(data.currencies)).toBe(true);

    // The same document as GET /api/me/export.
    const api = (await (await raw("/api/me/export", { headers: { authorization: `Bearer ${alice.token}` } })).json()) as Record<string, unknown>;
    expect(Object.keys(data).sort()).toEqual(Object.keys(api).sort());

    const withoutCsrf = await endpoint(alice, "/endpoints/db/backup.php", { method: "POST", csrf: false });
    expect(withoutCsrf.json).toEqual({ success: false, message: "Invalid CSRF token" });
  });

  it("points restore, import and migrate to the importer", async () => {
    const browser = await browserSession("dbr");
    const form = new FormData();
    form.append("file", new File([new Uint8Array([1, 2, 3])], "backup.zip", { type: "application/zip" }));
    const restore = await endpoint(browser, "/endpoints/db/restore.php", { form });
    expect(restore.json!.success).toBe(false);
    expect(restore.json!.message).toContain("node scripts/import-wallos.ts");
    expect((await endpoint(browser, "/endpoints/db/import.php", { form })).json!.message).toContain("import-wallos.ts");
    expect((await endpoint(browser, "/endpoints/db/migrate.php")).json!.success).toBe(false);
  });
});
