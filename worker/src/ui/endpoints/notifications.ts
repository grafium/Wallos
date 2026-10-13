import { Hono, type Context } from "hono";
import type { AppBindings } from "../../env";
import { emailConfigured, EmailNotConfigured } from "../../lib/email";
import { checkOutboundUrl } from "../../lib/outbound";
import { base64urlDecode } from "../../lib/webpush";
import { channelSchema, MASK, SECRET_FIELDS, sendToChannel, type ChannelMessage, type ChannelName } from "../../notifications/channels";
import { testMessage } from "../../notifications/reminders";
import { resolveLanguage, translator, type Translate } from "../i18n";

/*
  endpoints/notifications/*.php: the settings page's notification section.

  PHP Wallos kept one table per channel; the Worker stores every channel as a
  row of notification_channels (user_id, channel, enabled, config JSON) and
  sends through notifications/channels.ts. These endpoints translate the
  field names scripts/notifications.js posts into the channel config names
  and answer {success, message} like the PHP files did.

  Field names that differ from the Worker config:
    discord     url -> webhook_url, bot_avatar -> bot_avatar_url
    gotify      gotify_url -> url
    telegram    (test) bottoken -> bot_token, chatid -> chat_id
    webhook     webhook_url (save) / url (test) -> url,
                customheaders (test) -> headers, requestmethod (test) -> request_method
    email       otheremails -> other_emails; the SMTP fields are accepted and
                ignored: the Worker sends every e-mail through the instance's
                Resend sender (RESEND_API_KEY / EMAIL_FROM).
  ignore_ssl (gotify, ntfy, webhook) is accepted and ignored: a Worker cannot
  turn off certificate verification.

  Secret fields come back from the settings page as "********" when it shows
  them masked; such a value keeps the stored secret, on save and on test.
*/

type Ctx = Context<AppBindings>;
type Body = Record<string, unknown>;
type Config = Record<string, unknown>;

export const routes = new Hono<AppBindings>();

const str = (value: unknown): string => (value === undefined || value === null ? "" : String(value)).trim();
const flag = (value: unknown): number => (value === true || value === 1 || value === "1" || value === "true" || value === "on" ? 1 : 0);

function tr(c: Ctx): Translate {
  return translator(resolveLanguage(c.get("user").language));
}

async function readJson(c: Ctx): Promise<Body> {
  try {
    const body: unknown = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Body) : {};
  } catch {
    return {};
  }
}

const answer = (c: Ctx, success: boolean, message: string, extra: Body = {}) => c.json({ success, message, ...extra });

async function storedChannel(c: Ctx, channel: ChannelName): Promise<{ enabled: number; config: Config } | null> {
  const row = await c.env.DB.prepare("SELECT enabled, config FROM notification_channels WHERE user_id = ? AND channel = ?")
    .bind(c.get("user").id, channel)
    .first<{ enabled: number; config: string }>();
  if (!row) return null;
  let config: Config = {};
  try {
    config = JSON.parse(row.config || "{}") as Config;
  } catch {
    config = {};
  }
  return { enabled: row.enabled, config };
}

async function saveChannel(c: Ctx, channel: ChannelName, enabled: number, config: Config) {
  await c.env.DB.prepare(
    "INSERT OR REPLACE INTO notification_channels (user_id, channel, enabled, config, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)",
  )
    .bind(c.get("user").id, channel, enabled, JSON.stringify(config))
    .run();
}

/** "********" in a secret field keeps the stored value. */
function mergeSecrets(channel: ChannelName, incoming: Config, stored: Config | undefined): Config {
  const merged = { ...incoming };
  for (const field of SECRET_FIELDS[channel] ?? []) {
    if (merged[field] === MASK) merged[field] = stored?.[field] ?? "";
  }
  return merged;
}

/** The test text in the user's language, as PHP's test endpoints sent it. */
function translatedTestMessage(t: Translate, email: string): ChannelMessage {
  const text = t("test_notification");
  return { ...testMessage(email), title: t("wallos_notification"), text, textWithoutName: text };
}

interface ChannelEndpoint {
  channel: ChannelName;
  /** Fields of the posted body that must not be empty (PHP's fill_mandatory_fields check). */
  required: string[];
  /** Posted body -> Worker channel config. */
  config: (body: Body, stored: Config | undefined) => Config;
  /** Config fields holding a URL, checked like PHP's scheme + SSRF validation. */
  urls?: string[];
}

/** Checks, merges and validates a posted channel config; returns the config or the error answer. */
function prepare(c: Ctx, t: Translate, spec: ChannelEndpoint, body: Body, stored: Config | undefined): { config: Config } | { error: Response } {
  if (spec.required.some((field) => str(body[field]) === "")) {
    return { error: answer(c, false, t("fill_mandatory_fields")) };
  }
  const merged = mergeSecrets(spec.channel, spec.config(body, stored), stored);
  for (const field of spec.urls ?? []) {
    const value = str(merged[field]);
    let url: URL | null = null;
    try {
      url = new URL(value);
    } catch {
      url = null;
    }
    if (!url || (url.protocol !== "http:" && url.protocol !== "https:")) return { error: answer(c, false, t("error")) };
    const check = checkOutboundUrl(value);
    if (!check.ok) return { error: answer(c, false, check.reason) };
  }
  const parsed = channelSchema(spec.channel).safeParse(merged);
  if (!parsed.success) {
    const detail = parsed.error.issues.map((issue) => `${issue.path.join(".") || spec.channel}: ${issue.message}`).join("; ");
    return { error: answer(c, false, `${t("error")}: ${detail}`) };
  }
  return { config: parsed.data as Config };
}

function saveEndpoint(path: string, spec: ChannelEndpoint) {
  routes.post(`/endpoints/notifications/${path}`, async (c) => {
    const t = tr(c);
    const body = await readJson(c);
    const stored = await storedChannel(c, spec.channel);
    const prepared = prepare(c, t, spec, body, stored?.config);
    if ("error" in prepared) return prepared.error;
    const enabled = flag(body.enabled);
    if (enabled && spec.channel === "email" && !emailConfigured(c.env)) {
      return answer(c, false, new EmailNotConfigured().message);
    }
    try {
      await saveChannel(c, spec.channel, enabled, prepared.config);
    } catch {
      return answer(c, false, t("error_saving_notifications"));
    }
    return answer(c, true, t("notifications_settings_saved"));
  });
}

function testEndpoint(path: string, spec: ChannelEndpoint, precheck?: (body: Body) => boolean) {
  routes.post(`/endpoints/notifications/${path}`, async (c) => {
    const t = tr(c);
    const body = await readJson(c);
    if (precheck && !precheck(body)) return answer(c, false, t("fill_mandatory_fields"));
    const stored = await storedChannel(c, spec.channel);
    const prepared = prepare(c, t, spec, body, stored?.config);
    if ("error" in prepared) return prepared.error;
    const user = c.get("user");
    try {
      await sendToChannel(spec.channel, prepared.config, translatedTestMessage(t, user.email), { env: c.env, db: c.env.DB, userId: user.id });
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      const prefix = spec.channel === "email" ? t("email_error") : t("notification_failed");
      return answer(c, false, `${prefix}: ${detail}`);
    }
    return answer(c, true, t("notification_sent_successfuly"));
  });
}

// --- channels ------------------------------------------------------------------------------

const discord: ChannelEndpoint = {
  channel: "discord",
  required: ["url"],
  config: (b) => ({ webhook_url: str(b.url), bot_username: str(b.bot_username), bot_avatar_url: str(b.bot_avatar) }),
  urls: ["webhook_url"],
};
saveEndpoint("savediscordnotifications.php", discord);
testEndpoint("testdiscordnotifications.php", discord);

const email: ChannelEndpoint = {
  channel: "email",
  required: [],
  config: (b) => ({ other_emails: str(b.otheremails ?? b.other_emails) }),
};
saveEndpoint("saveemailnotifications.php", email);
// PHP's test mailed only the account's own address; so does this one.
testEndpoint("testemailnotifications.php", { ...email, config: () => ({ other_emails: "" }) });

const gotify: ChannelEndpoint = {
  channel: "gotify",
  required: ["gotify_url", "token"],
  config: (b) => ({ url: str(b.gotify_url), token: str(b.token) }),
  urls: ["url"],
};
saveEndpoint("savegotifynotifications.php", gotify);
testEndpoint("testgotifynotifications.php", gotify);

saveEndpoint("savetelegramnotifications.php", {
  channel: "telegram",
  required: ["bot_token", "chat_id"],
  config: (b) => ({ bot_token: str(b.bot_token), chat_id: str(b.chat_id) }),
});
testEndpoint("testtelegramnotifications.php", {
  channel: "telegram",
  required: ["bottoken", "chatid"],
  config: (b) => ({ bot_token: str(b.bottoken), chat_id: str(b.chatid) }),
});

const pushover: ChannelEndpoint = {
  channel: "pushover",
  required: ["user_key", "token"],
  config: (b) => ({ user_key: str(b.user_key), token: str(b.token) }),
};
saveEndpoint("savepushovernotifications.php", pushover);
testEndpoint("testpushovernotifications.php", pushover);

const ntfy: ChannelEndpoint = {
  channel: "ntfy",
  required: ["host", "topic"],
  config: (b) => ({ host: str(b.host), topic: str(b.topic), headers: str(b.headers) }),
  urls: ["host"],
};
saveEndpoint("saventfynotifications.php", ntfy);
testEndpoint("testntfynotifications.php", ntfy);

saveEndpoint("savewebhooknotifications.php", {
  channel: "webhook",
  required: ["webhook_url"],
  // The page's save button does not post the request method (PHP did not store it
  // either); the stored one, else POST, is kept unless one is sent.
  config: (b, stored) => ({
    url: str(b.webhook_url),
    request_method: str(b.request_method ?? b.requestmethod).toUpperCase() || str(stored?.request_method) || "POST",
    headers: str(b.headers),
    payload: str(b.payload),
    cancelation_payload: str(b.cancelation_payload),
  }),
  urls: ["url"],
});
testEndpoint("testwebhooknotifications.php", {
  channel: "webhook",
  required: ["requestmethod", "url", "payload"],
  config: (b) => ({
    url: str(b.url),
    request_method: str(b.requestmethod).toUpperCase(),
    headers: str(b.customheaders ?? b.headers),
    payload: str(b.payload),
    cancelation_payload: str(b.cancelation_payload),
  }),
  urls: ["url"],
});

saveEndpoint("savemattermostnotifications.php", {
  channel: "mattermost",
  required: ["webhook_url"],
  config: (b) => ({ webhook_url: str(b.webhook_url), bot_username: str(b.bot_username), bot_icon_emoji: str(b.bot_icon_emoji) }),
  urls: ["webhook_url"],
});
testEndpoint("testmattermostnotifications.php", {
  channel: "mattermost",
  required: ["webhook_url", "bot_username", "bot_icon_emoji"],
  config: (b) => ({ webhook_url: str(b.webhook_url), bot_username: str(b.bot_username), bot_icon_emoji: str(b.bot_icon_emoji) }),
  urls: ["webhook_url"],
});

const pushplus: ChannelEndpoint = { channel: "pushplus", required: ["token"], config: (b) => ({ token: str(b.token) }) };
saveEndpoint("savepushplusnotifications.php", pushplus);
testEndpoint("testpushplusnotifications.php", pushplus);

const serverchan: ChannelEndpoint = { channel: "serverchan", required: ["sendkey"], config: (b) => ({ sendkey: str(b.sendkey) }) };
saveEndpoint("saveserverchannotifications.php", serverchan);
// PHP's ServerChan test also refused to run while the channel's checkbox was off.
testEndpoint("testserverchannotifications.php", serverchan, (b) => flag(b.enabled) === 1);

// --- general settings ---------------------------------------------------------------------

routes.post("/endpoints/notifications/savenotificationsettings.php", async (c) => {
  const t = tr(c);
  const body = await readJson(c);
  if (str(body.days) === "") return answer(c, false, t("fill_mandatory_fields"));
  const days = Number(str(body.days));
  if (!Number.isInteger(days) || days < 0 || days > 366) return answer(c, false, t("error"));
  const periodSummary = flag(body.period_summary_at_period_start);
  try {
    await c.env.DB.prepare("INSERT OR REPLACE INTO notification_settings (user_id, days, period_summary_at_period_start) VALUES (?, ?, ?)")
      .bind(c.get("user").id, days, periodSummary)
      .run();
  } catch {
    return answer(c, false, t("error_saving_notifications"));
  }
  return answer(c, true, t("notifications_settings_saved"));
});

// --- web push ---------------------------------------------------------------------------------

routes.post("/endpoints/notifications/savenotificationspush.php", async (c) => {
  const t = tr(c);
  const body = await readJson(c);
  const stored = await storedChannel(c, "push");
  try {
    await saveChannel(c, "push", flag(body.enabled), stored?.config ?? {});
  } catch {
    return answer(c, false, t("error_saving_notifications"));
  }
  return answer(c, true, t("notifications_settings_saved"));
});

function byteLength(value: string): number {
  try {
    return base64urlDecode(value).length;
  } catch {
    return -1;
  }
}

routes.post("/endpoints/notifications/savepushsubscription.php", async (c) => {
  const t = tr(c);
  const body = await readJson(c);
  const keys = (body.keys && typeof body.keys === "object" ? body.keys : {}) as Body;
  const endpoint = str(body.endpoint);
  const p256dh = str(keys.p256dh);
  const auth = str(keys.auth);
  const userAgent = (c.req.header("user-agent") ?? "").slice(0, 255);

  if (!endpoint || !p256dh || !auth) return answer(c, false, t("fill_mandatory_fields"));
  let url: URL | null = null;
  try {
    url = new URL(endpoint);
  } catch {
    url = null;
  }
  if (!url || url.protocol !== "https:" || !url.hostname) return answer(c, false, t("error"));
  // A real subscription has a 65-byte P-256 point and a 16-byte auth secret.
  if (byteLength(p256dh) !== 65 || byteLength(auth) !== 16) return answer(c, false, t("error"));
  const check = checkOutboundUrl(endpoint);
  if (!check.ok) return answer(c, false, check.reason);

  const userId = c.get("user").id;
  try {
    const existing = await c.env.DB.prepare("SELECT id FROM push_subscriptions WHERE user_id = ? AND endpoint = ?")
      .bind(userId, endpoint)
      .first<{ id: number }>();
    let id: number;
    if (existing) {
      id = existing.id;
      await c.env.DB.prepare("UPDATE push_subscriptions SET p256dh = ?, auth = ?, user_agent = ? WHERE id = ?").bind(p256dh, auth, userAgent, id).run();
    } else {
      const result = await c.env.DB.prepare("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) VALUES (?, ?, ?, ?, ?)")
        .bind(userId, endpoint, p256dh, auth, userAgent)
        .run();
      id = Number(result.meta.last_row_id);
    }
    return answer(c, true, t("notifications_settings_saved"), {
      subscription: { id, user_agent: userAgent || t("unknown_device"), is_new: !existing },
    });
  } catch {
    return answer(c, false, t("error_saving_notifications"));
  }
});

routes.post("/endpoints/notifications/removepushsubscription.php", async (c) => {
  const t = tr(c);
  const body = await readJson(c);
  const id = Math.trunc(Number(body.id ?? 0)) || 0;
  const endpoint = str(body.endpoint);
  const userId = c.get("user").id;
  let statement: D1PreparedStatement;
  if (id > 0) statement = c.env.DB.prepare("DELETE FROM push_subscriptions WHERE id = ? AND user_id = ?").bind(id, userId);
  else if (endpoint !== "") statement = c.env.DB.prepare("DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?").bind(endpoint, userId);
  else return answer(c, false, t("fill_mandatory_fields"));
  try {
    await statement.run();
  } catch {
    return answer(c, false, t("error_saving_notifications"));
  }
  return answer(c, true, t("notifications_settings_saved"));
});

/** Sends a test push to every registered device, like PHP: success when at least one got it. */
routes.post("/endpoints/notifications/testpushnotifications.php", async (c) => {
  const t = tr(c);
  const user = c.get("user");
  const devices = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?").bind(user.id).first<{ n: number }>();
  if (!devices?.n) return answer(c, false, t("no_devices_registered"));
  try {
    await sendToChannel("push", {}, translatedTestMessage(t, user.email), { env: c.env, db: c.env.DB, userId: user.id });
  } catch {
    return answer(c, false, t("notification_failed"));
  }
  return answer(c, true, t("notification_sent_successfuly"));
});
