import type { Env } from "../env";
import { diffDays } from "../lib/dates";
import { formatMoney } from "../lib/pricing";
import { periodBudget } from "../services/budget";
import { isChannel, sendToChannel, type ChannelMessage, type ChannelName, type ReminderItem } from "./channels";

/*
  Payment and cancellation reminders, ported from
  endpoints/cronjobs/sendnotifications.php and sendcancellationnotifications.php.

  PHP ran both once a day in the container's timezone (09:00 and 08:00). Here
  the cron fires hourly and each account is handled when it is 09:00 / 08:00
  in the account's own timezone. notification_log records each (user, kind,
  local date) so a repeated or overlapping run never sends twice.
*/

export type ReminderKind = "payment" | "cancellation";

export const REMINDER_HOUR: Record<ReminderKind, number> = { payment: 9, cancellation: 8 };

const TITLE = "Wallos Notification";

/** The user's local date and hour at `now`; unknown timezones fall back to UTC. */
export function localDateTime(timezone: string | null | undefined, now: Date): { date: string; hour: number } {
  const parts = (tz: string) =>
    Object.fromEntries(
      new Intl.DateTimeFormat("en-CA", { timeZone: tz, year: "numeric", month: "2-digit", day: "2-digit", hour: "2-digit", hourCycle: "h23" })
        .formatToParts(now)
        .map((p) => [p.type, p.value]),
    );
  let p: Record<string, string>;
  try {
    p = parts(timezone || "UTC");
  } catch {
    p = parts("UTC");
  }
  return { date: `${p.year}-${p.month}-${p.day}`, hour: Number(p.hour) };
}

function daysText(days: number): string {
  if (days === 0) return "Today";
  if (days === 1) return "Tomorrow";
  return `In ${days} days`;
}

function formatPrice(price: number, code: string, symbol: string): string {
  const formatted = formatMoney(price, code);
  return formatted.includes(code) ? formatted.replace(code, `${symbol} `).replace(/\s+/g, " ").trim() : formatted;
}

interface Lookups {
  currencies: Map<number, { name: string; code: string; symbol: string }>;
  household: Map<number, { name: string; email: string }>;
  householdOrder: number[];
  categories: Map<number, string>;
}

async function loadLookups(db: D1Database, userId: number): Promise<Lookups> {
  const [currencies, household, categories] = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT id, name, code, symbol FROM currencies WHERE user_id = ?").bind(userId),
    db.prepare("SELECT id, name, email FROM household WHERE user_id = ? ORDER BY id").bind(userId),
    db.prepare("SELECT id, name FROM categories WHERE user_id = ?").bind(userId),
  ]);
  return {
    currencies: new Map((currencies?.results ?? []).map((r) => [r.id as number, { name: r.name as string, code: r.code as string, symbol: r.symbol as string }])),
    household: new Map((household?.results ?? []).map((r) => [r.id as number, { name: r.name as string, email: (r.email as string) ?? "" }])),
    householdOrder: (household?.results ?? []).map((r) => r.id as number),
    categories: new Map((categories?.results ?? []).map((r) => [r.id as number, r.name as string])),
  };
}

interface Account {
  id: number;
  username: string;
  email: string;
  main_currency: number | null;
}

function paymentText(name: string, items: ReminderItem[], summary: string, includeSummary: boolean): string {
  if (items.length === 0) return includeSummary ? `${name ? `${name}, ` : ""}${summary}\n` : "";
  let text = name ? `${name}, the following subscriptions are up for renewal:\n` : "The following subscriptions are up for renewal:\n";
  for (const item of items) text += `${item.name} for ${item.formatted_price} (${daysText(item.days)})\n`;
  if (includeSummary) text += `\n${summary}\n`;
  return text;
}

function cancellationText(name: string, items: ReminderItem[]): string {
  let text = name ? `${name}, the following subscriptions are up for cancellation:\n` : "The following subscriptions are up for cancellation:\n";
  for (const item of items) text += `${item.name} for ${item.formatted_price}\n`;
  return text;
}

/** The messages one account should get for `localDate`, one per household member concerned. */
export async function buildReminders(db: D1Database, account: Account, kind: ReminderKind, localDate: string): Promise<ChannelMessage[]> {
  const lookups = await loadLookups(db, account.id);
  const settings = await db
    .prepare("SELECT days, period_summary_at_period_start FROM notification_settings WHERE user_id = ?")
    .bind(account.id)
    .first<{ days: number; period_summary_at_period_start: number }>();
  const defaultDays = settings?.days ?? 1;

  const byPayer = new Map<number, ReminderItem[]>();
  const add = (payer: number, item: ReminderItem) => {
    if (!byPayer.has(payer)) byPayer.set(payer, []);
    byPayer.get(payer)!.push(item);
  };

  const rows = await db
    .prepare(
      kind === "payment"
        ? `SELECT * FROM subscriptions WHERE user_id = ? AND notify = 1 AND inactive = 0 AND next_payment IS NOT NULL ORDER BY payer_user_id, id`
        : `SELECT * FROM subscriptions WHERE user_id = ? AND inactive = 0 AND cancellation_date = ? AND cycle != 5 ORDER BY payer_user_id, id`,
    )
    .bind(...(kind === "payment" ? [account.id] : [account.id, localDate]))
    .all<Record<string, any>>();

  for (const row of rows.results) {
    const currency = lookups.currencies.get(row.currency_id) ?? { name: "", code: "EUR", symbol: "" };
    let days = 0;
    let formatted: string;
    if (kind === "payment") {
      days = row.notify_days_before === null || row.notify_days_before === -1 ? defaultDays : row.notify_days_before;
      if (diffDays(localDate, row.next_payment) !== days || row.next_payment < localDate) continue;
      formatted = formatPrice(row.price, currency.code, currency.symbol);
    } else {
      // PHP printed cancellation prices as "9.99€".
      formatted = `${row.price}${currency.symbol}`;
    }
    add(row.payer_user_id ?? 0, {
      name: row.name,
      formatted_price: formatted,
      currency: currency.name,
      category: lookups.categories.get(row.category_id) ?? "",
      payer: lookups.household.get(row.payer_user_id)?.name ?? "",
      date: row.next_payment ?? "",
      days,
      url: row.url ?? "",
      notes: row.notes ?? "",
    });
  }

  // Budget-period summary on the first day of each period, if asked for.
  let summary = "";
  let includeSummary = false;
  if (kind === "payment" && settings?.period_summary_at_period_start) {
    const budget = await periodBudget(db, { id: account.id, username: account.username, email: account.email, main_currency: account.main_currency, language: null, budget: null }, localDate);
    if (budget.period_start === localDate) {
      includeSummary = true;
      const code = budget.currency_code ?? "USD";
      const symbol = budget.currency_symbol ?? "$";
      summary = `Amount for Pay Period: ${formatPrice(budget.amount_needed_this_period, code, symbol)}`;
      if (budget.period_budget > 0) summary += ` | Remaining: ${formatPrice(budget.amount_remaining_this_period, code, symbol)}`;
      if (byPayer.size === 0 && lookups.householdOrder[0] !== undefined) byPayer.set(lookups.householdOrder[0], []);
    }
  }

  const messages: ChannelMessage[] = [];
  for (const [payer, items] of byPayer) {
    const member = lookups.household.get(payer);
    const name = member?.name ?? "";
    const text = kind === "payment" ? paymentText(name, items, summary, includeSummary) : cancellationText(name, items);
    if (!text) continue;
    messages.push({
      kind,
      title: TITLE,
      text,
      textWithoutName: kind === "payment" ? paymentText("", items, summary, includeSummary) : cancellationText("", items),
      recipientName: name,
      recipientEmail: member?.email || account.email,
      items,
      defaultDays,
    });
  }
  return messages;
}

export interface EnabledChannel {
  channel: ChannelName;
  config: unknown;
}

export async function enabledChannels(db: D1Database, userId: number): Promise<EnabledChannel[]> {
  const rows = await db
    .prepare("SELECT channel, config FROM notification_channels WHERE user_id = ? AND enabled = 1")
    .bind(userId)
    .all<{ channel: string; config: string }>();
  return rows.results
    .filter((r) => isChannel(r.channel))
    .map((r) => ({ channel: r.channel as ChannelName, config: JSON.parse(r.config || "{}") }));
}

/** Sends every message to every channel; one failing channel does not stop the others. */
export async function deliver(env: Env, db: D1Database, userId: number, channels: EnabledChannel[], messages: ChannelMessage[]) {
  const results: Record<string, string> = {};
  for (const { channel, config } of channels) {
    try {
      for (const message of messages) await sendToChannel(channel, config, message, { env, db, userId });
      results[channel] = "ok";
    } catch (error) {
      results[channel] = error instanceof Error ? error.message : String(error);
    }
  }
  return results;
}

export interface ReminderRunSummary {
  checked: number;
  notified: number;
  results: Record<number, Record<string, string>>;
}

/**
 * One cron tick: every account with an enabled channel whose local hour is
 * the reminder hour gets its reminders, once per local day.
 */
export async function runReminders(env: Env, kind: ReminderKind, now: Date): Promise<ReminderRunSummary> {
  const accounts = await env.DB.prepare(
    `SELECT id, username, email, main_currency, timezone FROM user u
      WHERE EXISTS (SELECT 1 FROM notification_channels c WHERE c.user_id = u.id AND c.enabled = 1)`,
  ).all<Account & { timezone: string }>();

  const summary: ReminderRunSummary = { checked: 0, notified: 0, results: {} };
  for (const account of accounts.results) {
    const local = localDateTime(account.timezone, now);
    if (local.hour !== REMINDER_HOUR[kind]) continue;
    summary.checked++;

    const messages = await buildReminders(env.DB, account, kind, local.date);
    if (messages.length === 0) continue;

    // Claim the day before sending, so an overlapping run backs off.
    const claim = await env.DB.prepare("INSERT OR IGNORE INTO notification_log (user_id, kind, local_date) VALUES (?, ?, ?)")
      .bind(account.id, kind, local.date)
      .run();
    if (claim.meta.changes === 0) continue;

    const results = await deliver(env, env.DB, account.id, await enabledChannels(env.DB, account.id), messages);
    await env.DB.prepare("UPDATE notification_log SET result = ? WHERE user_id = ? AND kind = ? AND local_date = ?")
      .bind(JSON.stringify(results), account.id, kind, local.date)
      .run();
    summary.notified++;
    summary.results[account.id] = results;
  }
  return summary;
}

/** The message a "test" button sends, with one sample subscription for webhook templates. */
export function testMessage(recipientEmail: string): ChannelMessage {
  const item: ReminderItem = {
    name: "Wallos test",
    formatted_price: "€9.99",
    currency: "Euro",
    category: "Test",
    payer: "",
    date: new Date().toISOString().slice(0, 10),
    days: 1,
    url: "https://github.com/ellite/Wallos",
    notes: "This is a test notification.",
  };
  const text = "Wallos test notification: this channel works.\n";
  return { kind: "test", title: TITLE, text, textWithoutName: text, recipientName: "", recipientEmail, items: [item], defaultDays: 1 };
}
