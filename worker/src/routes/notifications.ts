import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppBindings } from "../env";
import { emailConfigured } from "../lib/email";
import { fail, ok, readBody, validationFailed } from "../lib/http";
import { date } from "../lib/schemas";
import { base64urlDecode, getVapidKeys } from "../lib/webpush";
import { CHANNELS, channelSchema, isChannel, MASK, SECRET_FIELDS, sendToChannel, type ChannelName } from "../notifications/channels";
import { buildReminders, localDateTime, testMessage } from "../notifications/reminders";

type Ctx = Context<AppBindings>;

interface StoredChannel {
  channel: string;
  enabled: number;
  config: string;
}

function mask(channel: ChannelName, config: Record<string, unknown>): Record<string, unknown> {
  const masked = { ...config };
  for (const field of SECRET_FIELDS[channel] ?? []) {
    if (masked[field]) masked[field] = MASK;
  }
  return masked;
}

async function storedChannels(c: Ctx): Promise<Map<string, { enabled: number; config: Record<string, unknown> }>> {
  const rows = await c.env.DB.prepare("SELECT channel, enabled, config FROM notification_channels WHERE user_id = ?")
    .bind(c.get("user").id)
    .all<StoredChannel>();
  return new Map(rows.results.map((r) => [r.channel, { enabled: r.enabled, config: JSON.parse(r.config || "{}") }]));
}

async function notificationSettings(c: Ctx) {
  const row = await c.env.DB.prepare("SELECT days, period_summary_at_period_start FROM notification_settings WHERE user_id = ?")
    .bind(c.get("user").id)
    .first<{ days: number; period_summary_at_period_start: number }>();
  return row ?? { days: 1, period_summary_at_period_start: 0 };
}

/** api/notifications/get_notification_settings.php: {days, <channel>_notifications: {...}} */
export async function legacyNotificationSettings(c: Ctx) {
  const settings = await notificationSettings(c);
  const channels = await storedChannels(c);
  const out: Record<string, unknown> = { days: settings.days };
  for (const [channel, stored] of channels) {
    if (isChannel(channel)) out[`${channel}_notifications`] = { enabled: stored.enabled, ...mask(channel, stored.config) };
  }
  return ok(c, "notification_settings", { notification_settings: out, notes: [] });
}

/** Incoming config with "********" replaced by the stored secret. */
function mergeSecrets(channel: ChannelName, incoming: Record<string, unknown>, stored: Record<string, unknown> | undefined) {
  const merged = { ...incoming };
  for (const field of SECRET_FIELDS[channel] ?? []) {
    if (merged[field] === MASK) merged[field] = stored?.[field] ?? "";
  }
  return merged;
}

const settingsSchema = z
  .object({
    days: z.coerce.number().int().min(0).max(90),
    period_summary_at_period_start: z.union([z.boolean(), z.coerce.number().int().min(0).max(1)]).transform(Number),
  })
  .partial();

const pushSubscriptionSchema = z.object({
  endpoint: z.url().max(2048).refine((v) => v.startsWith("https://"), "Push endpoints are https URLs"),
  keys: z.object({
    p256dh: z.string().refine((v) => { try { return base64urlDecode(v).length === 65; } catch { return false; } }, "Expected a 65-byte P-256 key"),
    auth: z.string().refine((v) => { try { return base64urlDecode(v).length === 16; } catch { return false; } }, "Expected a 16-byte auth secret"),
  }),
});

export const notificationRoutes = new Hono<AppBindings>();

notificationRoutes.get("/", async (c) => {
  const channels = await storedChannels(c);
  const view: Record<string, unknown> = {};
  for (const channel of CHANNELS) {
    const stored = channels.get(channel);
    view[channel] = { enabled: stored?.enabled ?? 0, config: stored ? mask(channel, stored.config) : {} };
  }
  return ok(c, "notifications", {
    settings: await notificationSettings(c),
    channels: view,
    email_configured: emailConfigured(c.env),
    timezone: c.get("user").timezone ?? "UTC",
  });
});

notificationRoutes.patch("/settings", async (c) => {
  const parsed = settingsSchema.safeParse(await readBody(c));
  if (!parsed.success) return validationFailed(c, parsed.error);
  const current = await notificationSettings(c);
  const next = { ...current, ...Object.fromEntries(Object.entries(parsed.data).filter(([, v]) => v !== undefined)) };
  await c.env.DB.prepare("INSERT OR REPLACE INTO notification_settings (user_id, days, period_summary_at_period_start) VALUES (?, ?, ?)")
    .bind(c.get("user").id, next.days, next.period_summary_at_period_start)
    .run();
  return ok(c, "Notification settings saved", { settings: next });
});

notificationRoutes.put("/channels/:channel", async (c) => {
  const channel = c.req.param("channel");
  if (!isChannel(channel)) return fail(c, 404, "Unknown channel", `Channels: ${CHANNELS.join(", ")}.`);
  const body = await readBody(c);
  const enabled = body.enabled === true || body.enabled === 1 || body.enabled === "1" || body.enabled === "true";
  const { enabled: _ignored, ...incoming } = body;

  const stored = (await storedChannels(c)).get(channel);
  const merged = mergeSecrets(channel, incoming, stored?.config);
  const hasConfig = Object.keys(incoming).length > 0;
  let config: Record<string, unknown> = stored?.config ?? {};

  if (hasConfig || enabled) {
    const parsed = channelSchema(channel).safeParse(hasConfig ? merged : config);
    if (!parsed.success) return validationFailed(c, parsed.error);
    config = parsed.data as Record<string, unknown>;
  }
  if (enabled && channel === "email" && !emailConfigured(c.env)) {
    return fail(c, 400, "E-mail not configured", "The administrator has to set RESEND_API_KEY and EMAIL_FROM first.");
  }

  await c.env.DB.prepare(
    "INSERT OR REPLACE INTO notification_channels (user_id, channel, enabled, config, updated_at) VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)",
  )
    .bind(c.get("user").id, channel, enabled ? 1 : 0, JSON.stringify(config))
    .run();
  return ok(c, "Notification channel saved", { channel, enabled: enabled ? 1 : 0, config: mask(channel, config) });
});

notificationRoutes.delete("/channels/:channel", async (c) => {
  const channel = c.req.param("channel");
  await c.env.DB.prepare("DELETE FROM notification_channels WHERE user_id = ? AND channel = ?").bind(c.get("user").id, channel).run();
  return ok(c, "Notification channel removed", { channel });
});

/** Sends a test message, with the stored settings or with settings passed in the body (not saved). */
notificationRoutes.post("/channels/:channel/test", async (c) => {
  const channel = c.req.param("channel");
  if (!isChannel(channel)) return fail(c, 404, "Unknown channel", `Channels: ${CHANNELS.join(", ")}.`);
  const body = await readBody(c);
  const { enabled: _ignored, ...incoming } = body;
  const stored = (await storedChannels(c)).get(channel);
  const config = Object.keys(incoming).length > 0 ? mergeSecrets(channel, incoming, stored?.config) : (stored?.config ?? {});

  const parsed = channelSchema(channel).safeParse(config);
  if (!parsed.success) return validationFailed(c, parsed.error);
  try {
    await sendToChannel(channel, parsed.data, testMessage(c.get("user").email), { env: c.env, db: c.env.DB, userId: c.get("user").id });
  } catch (error) {
    return fail(c, 502, "Notification failed", error instanceof Error ? error.message : String(error));
  }
  return ok(c, "Notification sent", { channel });
});

/** What the reminder job would send today (or on ?date=), without sending it. */
notificationRoutes.get("/preview", async (c) => {
  const kind = c.req.query("kind") === "cancellation" ? "cancellation" : "payment";
  const user = c.get("user");
  const parsedDate = date.safeParse(c.req.query("date") ?? localDateTime(user.timezone, new Date()).date);
  if (!parsedDate.success) return validationFailed(c, parsedDate.error);
  const messages = await buildReminders(c.env.DB, user, kind, parsedDate.data);
  return ok(c, "preview", {
    kind,
    date: parsedDate.data,
    messages: messages.map(({ title, text, recipientName, recipientEmail, items }) => ({ title, text, recipient_name: recipientName, recipient_email: recipientEmail, items })),
  });
});

notificationRoutes.get("/push/public-key", async (c) => ok(c, "vapid", { public_key: (await getVapidKeys(c.env.DB)).publicKey }));

notificationRoutes.post("/push/subscriptions", async (c) => {
  const parsed = pushSubscriptionSchema.safeParse(await readBody(c));
  if (!parsed.success) return validationFailed(c, parsed.error);
  await c.env.DB.prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(user_id, endpoint) DO UPDATE SET p256dh = excluded.p256dh, auth = excluded.auth, user_agent = excluded.user_agent`,
  )
    .bind(c.get("user").id, parsed.data.endpoint, parsed.data.keys.p256dh, parsed.data.keys.auth, (c.req.header("user-agent") ?? "").slice(0, 255))
    .run();
  return ok(c, "Push subscription saved", {}, 201);
});

notificationRoutes.delete("/push/subscriptions", async (c) => {
  const body = await readBody(c);
  const endpoint = typeof body.endpoint === "string" ? body.endpoint : "";
  const result = await c.env.DB.prepare("DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?").bind(c.get("user").id, endpoint).run();
  return result.meta.changes > 0 ? ok(c, "Push subscription removed", {}) : fail(c, 404, "Not found");
});
