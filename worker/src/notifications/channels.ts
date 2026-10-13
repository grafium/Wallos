import { z } from "zod";
import type { Env } from "../env";
import { sendEmail } from "../lib/email";
import { checkOutboundUrl, outboundFetch, OutboundError, parseHeaders } from "../lib/outbound";
import { getVapidKeys, sendWebPush } from "../lib/webpush";

/*
  Notification channels, ported from the per-channel blocks of
  endpoints/cronjobs/sendnotifications.php and sendcancellationnotifications.php.

  Every channel has a config schema (stored as JSON in notification_channels),
  the names of its secret fields (masked when read back), and a send().
  Message texts and request formats follow PHP Wallos, so receivers that
  parse them - webhook consumers above all - see the same thing.
*/

export interface ReminderItem {
  name: string;
  formatted_price: string;
  currency: string;
  category: string;
  payer: string;
  date: string;
  days: number;
  url: string;
  notes: string;
}

export interface ChannelMessage {
  kind: "payment" | "cancellation" | "test";
  title: string;
  /** Full text, starting with the payer's name where PHP did. */
  text: string;
  /** The same text without the name (PHP's e-mail body). */
  textWithoutName: string;
  /** Household member the message is about, "" when unknown. */
  recipientName: string;
  /** Where the e-mail channel sends: the member's address, else the account's. */
  recipientEmail: string;
  items: ReminderItem[];
  /** The account-wide "days before" setting, for the webhook's {{days_until}}. */
  defaultDays: number;
}

export interface ChannelContext {
  env: Env;
  db: D1Database;
  userId: number;
}

const httpUrl = z
  .string()
  .trim()
  .max(2048)
  .superRefine((value, ctx) => {
    const check = checkOutboundUrl(value);
    if (!check.ok) ctx.addIssue({ code: "custom", message: check.reason });
  });

const optionalText = (max = 255) => z.string().trim().max(max).optional().default("");

const schemas = {
  email: z.object({
    // Extra recipients, separated by ";" as in PHP Wallos.
    other_emails: z
      .string()
      .trim()
      .max(2000)
      .optional()
      .default("")
      .refine((v) => v.split(";").map((e) => e.trim()).filter(Boolean).every((e) => z.email().safeParse(e).success), "Expected e-mail addresses separated by ;"),
  }),
  discord: z.object({ webhook_url: httpUrl, bot_username: optionalText(), bot_avatar_url: optionalText(2048) }),
  gotify: z.object({ url: httpUrl, token: z.string().trim().min(1).max(255) }),
  telegram: z.object({ bot_token: z.string().trim().min(1).max(255), chat_id: z.string().trim().min(1).max(255) }),
  pushover: z.object({ user_key: z.string().trim().min(1).max(255), token: z.string().trim().min(1).max(255) }),
  ntfy: z.object({ host: httpUrl, topic: z.string().trim().min(1).max(255), headers: optionalText(4000) }),
  webhook: z.object({
    url: httpUrl,
    request_method: z.enum(["POST", "PUT", "PATCH", "GET", "DELETE"]).optional().default("POST"),
    headers: optionalText(4000),
    payload: optionalText(20_000),
    cancelation_payload: optionalText(20_000),
  }),
  mattermost: z.object({ webhook_url: httpUrl, bot_username: optionalText(), bot_icon_emoji: optionalText() }),
  pushplus: z.object({ token: z.string().trim().min(1).max(255) }),
  serverchan: z.object({ sendkey: z.string().trim().min(1).max(255) }),
  push: z.object({}),
} as const;

export type ChannelName = keyof typeof schemas;
export const CHANNELS = Object.keys(schemas) as ChannelName[];
export type ChannelConfig<C extends ChannelName> = z.infer<(typeof schemas)[C]>;

export function isChannel(value: string): value is ChannelName {
  return value in schemas;
}

export function channelSchema<C extends ChannelName>(channel: C) {
  return schemas[channel];
}

/** Fields never echoed back in full; sending "********" on update keeps the stored value. */
export const SECRET_FIELDS: Partial<Record<ChannelName, string[]>> = {
  gotify: ["token"],
  telegram: ["bot_token"],
  pushover: ["token"],
  ntfy: ["headers"],
  webhook: ["headers"],
  pushplus: ["token"],
  serverchan: ["sendkey"],
};

export const MASK = "********";

const json = (body: unknown): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/json" },
  body: JSON.stringify(body),
});

const form = (body: Record<string, string>): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded" },
  body: new URLSearchParams(body).toString(),
});

/** Escapes a value for a JSON string field of a template, like PHP's webhookJsonEscape(). */
function jsonEscape(value: string): string {
  return JSON.stringify(value).slice(1, -1);
}

/**
 * Fills the {{placeholders}} of a webhook template. Every value is JSON-escaped:
 * PHP escaped only the notes, so a subscription named `Say "hi"` produced a
 * body the receiver could not parse.
 */
function fillWebhookTemplate(template: string, item: ReminderItem, defaultDays: number): string {
  const values: Record<string, string> = {
    days_until: String(defaultDays),
    subscription_name: item.name,
    subscription_price: item.formatted_price,
    subscription_currency: item.currency,
    subscription_category: item.category,
    subscription_payer: item.payer,
    subscription_date: item.date,
    subscription_days_until_payment: String(item.days),
    subscription_url: item.url,
    subscription_notes: item.notes,
  };
  return template.replace(/\{\{(\w+)\}\}/g, (match, key: string) => (key in values ? jsonEscape(values[key]!) : match));
}

type Sender<C extends ChannelName> = (config: ChannelConfig<C>, message: ChannelMessage, ctx: ChannelContext) => Promise<void>;

const senders: { [C in ChannelName]: Sender<C> } = {
  async email(config, message, ctx) {
    const cc = [...new Set(config.other_emails.split(";").map((e) => e.trim()).filter((e) => e && e !== message.recipientEmail))];
    await sendEmail(ctx.env, { to: message.recipientEmail, cc, subject: message.title, text: message.textWithoutName });
  },

  async discord(config, message) {
    await outboundFetch(
      config.webhook_url,
      json({
        content: message.text,
        ...(config.bot_username ? { username: config.bot_username } : {}),
        ...(config.bot_avatar_url ? { avatar_url: config.bot_avatar_url } : {}),
      }),
    );
  },

  async gotify(config, message) {
    const url = `${config.url.replace(/\/+$/, "")}/message?token=${encodeURIComponent(config.token)}`;
    await outboundFetch(url, json({ message: message.text, priority: 5 }));
  },

  async telegram(config, message) {
    await outboundFetch(`https://api.telegram.org/bot${config.bot_token}/sendMessage`, json({ chat_id: config.chat_id, text: message.text }));
  },

  async pushover(config, message) {
    await outboundFetch("https://api.pushover.net/1/messages.json", form({ token: config.token, user: config.user_key, message: message.text }));
  },

  async ntfy(config, message) {
    await outboundFetch(`${config.host.replace(/\/+$/, "")}/${config.topic}`, {
      method: "POST",
      headers: { "content-type": "text/plain; charset=utf-8", ...parseHeaders(config.headers) },
      body: message.text,
    });
  },

  async webhook(config, message) {
    const template = message.kind === "cancellation" ? config.cancelation_payload : config.payload;
    // PHP sent cancellation webhooks only when a cancellation payload was set.
    if (message.kind === "cancellation" && !template) return;
    const items = message.items.length ? message.items : [];
    for (const item of items) {
      await outboundFetch(config.url, {
        method: config.request_method,
        headers: parseHeaders(config.headers),
        ...(config.request_method === "GET" ? {} : { body: fillWebhookTemplate(template, item, message.defaultDays) }),
      });
    }
  },

  async mattermost(config, message) {
    await outboundFetch(config.webhook_url, json({ username: config.bot_username, icon_emoji: config.bot_icon_emoji, text: message.text }));
  },

  async pushplus(config, message) {
    const response = await outboundFetch(
      "https://www.pushplus.plus/send",
      json({ token: config.token, title: "订阅续期提醒 - Wallos", content: message.text, template: "json" }),
    );
    const body = (await response.json().catch(() => ({}))) as { code?: number; msg?: string };
    if (body.code !== 200) throw new OutboundError(`PushPlus: ${body.msg ?? "unknown error"}`);
  },

  async serverchan(config, message) {
    const sendkey = config.sendkey;
    const url = sendkey.startsWith("sctp")
      ? `https://${/^sctp(\d+)t/.exec(sendkey)?.[1] ?? ""}.push.ft07.com/send/${sendkey}.send`
      : `https://sctapi.ftqq.com/${sendkey}.send`;
    await outboundFetch(url, form({ text: message.title, desp: message.text }));
  },

  async push(_config, message, ctx) {
    const subscriptions = await ctx.db
      .prepare("SELECT id, endpoint, p256dh, auth FROM push_subscriptions WHERE user_id = ?")
      .bind(ctx.userId)
      .all<{ id: number; endpoint: string; p256dh: string; auth: string }>();
    if (subscriptions.results.length === 0) throw new OutboundError("No device is registered for push notifications.");

    const keys = await getVapidKeys(ctx.db);
    const sender = /<([^>]+)>/.exec(ctx.env.EMAIL_FROM ?? "")?.[1] ?? ctx.env.EMAIL_FROM ?? "";
    const subject = `mailto:${sender.includes("@") ? sender : "wallos@wallosapp.com"}`;
    const payload = JSON.stringify({ title: message.title, body: message.text });

    const failures: string[] = [];
    for (const subscription of subscriptions.results) {
      const result = await sendWebPush(subscription, payload, keys, subject);
      if (result.gone) {
        await ctx.db.prepare("DELETE FROM push_subscriptions WHERE id = ?").bind(subscription.id).run();
      } else if (!result.ok) {
        failures.push(result.error ?? `HTTP ${result.status}`);
      }
    }
    if (failures.length === subscriptions.results.length && failures.length > 0) {
      throw new OutboundError(`Push failed: ${failures[0]}`);
    }
  },
};

/** Parses a stored config and sends; throws with a readable message on failure. */
export async function sendToChannel(channel: ChannelName, rawConfig: unknown, message: ChannelMessage, ctx: ChannelContext): Promise<void> {
  const parsed = schemas[channel].safeParse(rawConfig);
  if (!parsed.success) throw new OutboundError(`The ${channel} settings are incomplete or invalid.`);
  await (senders[channel] as Sender<ChannelName>)(parsed.data as never, message, ctx);
}
