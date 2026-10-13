import { Hono } from "hono";
import type { AppBindings } from "../../env";
import { isValidDate } from "../../lib/dates";
import { sniffImageType } from "../../lib/image";
import { imageFromBody, setSubscriptionLogo, storeLogoImage } from "../../routes/uploads";
import { deleteLogosIfUnused, UploadError } from "../../services/files";
import { SearchError, searchLogos, type LogoResult } from "../../services/logo-search";
import {
  cloneSubscription,
  createSubscription,
  deleteSubscription,
  findSubscription,
  ReferenceError,
  renewSubscription,
  updateSubscription,
  type SubscriptionRow,
} from "../../services/subscriptions";
import type { CreateSubscriptionInput, UpdateSubscriptionInput } from "../../lib/schemas";
import { loadUi, type UiCtx } from "../context";
import { translator, resolveLanguage, type Translate } from "../i18n";
import { loadLookups, printItems, querySubscriptions, reorder, sorting, SubscriptionList } from "../pages/subscriptions";
import { getCookie } from "hono/cookie";
import { html } from "hono/html";

/*
  The endpoints/*.php the subscriptions and calendar pages call:
  endpoints/subscription/{add,get,delete,clone,renew,exportcalendar,getcalendar}.php,
  endpoints/subscriptions/{get,export}.php and endpoints/logos/*.php. Requests
  and answers keep the PHP shapes, because scripts/subscriptions.js,
  calendar.js and subscription-details.js are unchanged. Session and CSRF are
  checked by uiEndpoint in ui/app.ts.
*/

export const routes = new Hono<AppBindings>();

/** Translations for endpoints that do not need the whole page context. */
async function endpointTranslator(c: UiCtx): Promise<Translate> {
  const row = await c.env.DB.prepare("SELECT language FROM user WHERE id = ?").bind(c.get("user").id).first<{ language: string | null }>();
  return translator(resolveLanguage(row?.language ?? getCookie(c, "language")));
}

/** The JSON body of a script's fetch(); {} when it is missing or malformed. */
async function jsonBody(c: UiCtx): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? body : {};
  } catch {
    return {};
  }
}

function idOf(value: unknown): number | null {
  const id = typeof value === "number" ? value : typeof value === "string" && /^\s*\d+\s*$/.test(value) ? Number(value) : NaN;
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}

// --- markdown notes (includes/markdown.php) ------------------------------------------

const escapeHtml = (value: string) =>
  value.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#039;");

const SAFE_LINK = /^(https?:\/\/|ftps?:\/\/|mailto:|tel:|data:image\/(png|gif|jpeg);base64,|irc:|ircs:|git:|ssh:|news:|steam:)/i;

/** Like Parsedown's safe mode: a link to an unlisted scheme is made relative by encoding its colon. */
function safeHref(url: string): string {
  if (SAFE_LINK.test(url)) return url;
  const colon = url.indexOf(":");
  if (colon === -1) return url;
  const slash = url.indexOf("/");
  return slash !== -1 && slash < colon ? url : url.replace(/:/g, "%3A");
}

/** Bold, italic, strikethrough, code, links and bare URLs, on text that is not escaped yet. */
function inlineMarkdown(text: string): string {
  const tokens: string[] = [];
  const keep = (htmlText: string) => `\u0000${tokens.push(htmlText) - 1}\u0000`;
  let s = text.replace(/\u0000/g, "");
  s = s.replace(/`([^`]+)`/g, (_, code: string) => keep(`<code>${escapeHtml(code)}</code>`));
  s = s.replace(/\[([^\]]+)\]\(\s*((?:[^()\s]|\([^()\s]*\))+)(?:\s+"[^"]*")?\s*\)/g, (_, label: string, url: string) =>
    keep(`<a href="${escapeHtml(safeHref(url))}">${emphasis(escapeHtml(label))}</a>`),
  );
  s = s.replace(/\bhttps?:\/\/[^\s<\u0000]+[^\s<\u0000.,;:!?)]/gi, (url) => keep(`<a href="${escapeHtml(url)}">${escapeHtml(url)}</a>`));
  s = emphasis(escapeHtml(s));
  return s.replace(/\u0000(\d+)\u0000/g, (_, i: string) => tokens[Number(i)] ?? "");
}

function emphasis(s: string): string {
  return s
    .replace(/\*\*(?=\S)(.+?)\*\*/g, "<strong>$1</strong>")
    .replace(/(^|[^\w])__(?=\S)(.+?)__(?!\w)/g, "$1<strong>$2</strong>")
    .replace(/\*(?=\S)(.+?)\*/g, "<em>$1</em>")
    .replace(/(^|[^\w])_(?=\S)(.+?)_(?!\w)/g, "$1<em>$2</em>")
    .replace(/~~(?=\S)(.+?)~~/g, "<del>$1</del>");
}

/**
 * render_notes_markdown(): the Markdown subset the notes toolbar writes
 * (paragraphs with line breaks, headings, lists, emphasis, links), as safe
 * HTML - every piece of text is escaped and links are scheme-checked.
 */
export function renderNotesMarkdown(source: string | null | undefined): string {
  const lines = String(source ?? "").replace(/\r\n?/g, "\n").split("\n");
  const blocks: string[] = [];
  let paragraph: string[] = [];
  let list: { type: "ul" | "ol"; items: string[] } | null = null;
  const flush = () => {
    if (paragraph.length) blocks.push(`<p>${paragraph.map(inlineMarkdown).join("<br />\n")}</p>`);
    if (list) blocks.push(`<${list.type}>\n${list.items.map((i) => `<li>${inlineMarkdown(i)}</li>`).join("\n")}\n</${list.type}>`);
    paragraph = [];
    list = null;
  };
  for (const line of lines) {
    const heading = /^(#{1,6})\s+(.*?)\s*#*\s*$/.exec(line);
    const bullet = /^\s{0,3}[-*+]\s+(.*)$/.exec(line);
    const numbered = /^\s{0,3}\d+[.)]\s+(.*)$/.exec(line);
    if (line.trim() === "") flush();
    else if (heading) {
      flush();
      blocks.push(`<h${heading[1]!.length}>${inlineMarkdown(heading[2]!)}</h${heading[1]!.length}>`);
    } else if (bullet || numbered) {
      const type = bullet ? "ul" : "ol";
      if (paragraph.length || (list && (list as { type: string }).type !== type)) flush();
      list ??= { type, items: [] };
      list.items.push((bullet ?? numbered)![1]!);
    } else if (list && /^\s+\S/.test(line)) {
      const items = (list as { items: string[] }).items;
      items[items.length - 1] += ` ${line.trim()}`;
    } else {
      if (list) flush();
      paragraph.push(line.trim());
    }
  }
  flush();
  return blocks.join("\n");
}

// --- iCalendar (includes/ical_helper.php) ---------------------------------------------

export function icalEscape(value: unknown): string {
  return String(value ?? "")
    .replace(/\\/g, "\\\\")
    .replace(/\r\n|\r|\n/g, "\\n")
    .replace(/,/g, "\\,")
    .replace(/;/g, "\\;");
}

/** Folds a content line at 75 octets, on character boundaries. */
export function icalFold(line: string): string {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;
  let folded = "";
  let length = 0;
  for (const char of line) {
    const size = encoder.encode(char).length;
    if (length + size > 75) {
      folded += "\r\n ";
      length = 0;
    }
    folded += char;
    length += size;
  }
  return folded;
}

/** PHP number_format($value, 2). */
const numberFormat = (value: number) => new Intl.NumberFormat("en-US", { minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(value);

const icalDate = (date: string | null) => (date ?? "").replace(/-/g, "");
const dtstamp = (now = new Date()) => now.toISOString().replace(/[-:]/g, "").replace(/\.\d+/, "");

interface EventDetails {
  row: SubscriptionRow;
  currencySymbol: string;
  price: number;
  category: string;
  paymentMethod: string;
  payer: string;
  trigger: number;
  /** exportcalendar.php put an empty line before the notes; the feed did not. */
  blankBeforeNotes: boolean;
}

function vevent(e: EventDetails): string {
  const description =
    `Price: ${e.currencySymbol}${numberFormat(e.price)}\\nCategory: ${icalEscape(e.category)}\\nPayment Method: ${icalEscape(e.paymentMethod)}` +
    `\\nPayer: ${icalEscape(e.payer)}\\n${e.blankBeforeNotes ? "\\n" : ""}Notes: ${icalEscape(e.row.notes)}`;
  return [
    "BEGIN:VEVENT",
    `UID:wallos-subscription-${e.row.id}@wallos`,
    `DTSTAMP:${dtstamp()}`,
    icalFold(`SUMMARY:${icalEscape(e.row.name)}`),
    icalFold(`DESCRIPTION:${description}`),
    `DTSTART;VALUE=DATE:${icalDate(e.row.next_payment)}`,
    `DTEND;VALUE=DATE:${icalDate(e.row.next_payment)}`,
    icalFold(`LOCATION:${icalEscape(e.row.url ?? "")}`),
    "STATUS:CONFIRMED",
    "TRANSP:OPAQUE",
    "BEGIN:VALARM",
    "ACTION:DISPLAY",
    "DESCRIPTION:Reminder",
    `TRIGGER:-P${e.trigger}D`,
    "END:VALARM",
    "END:VEVENT",
  ].join("\n");
}

interface NameLookups {
  categories: Map<number, string>;
  members: Map<number, string>;
  methods: Map<number, string>;
  currencies: Map<number, { symbol: string; rate: number }>;
  defaultDays: number;
}

async function nameLookups(db: D1Database, userId: number): Promise<NameLookups> {
  const [categories, members, methods, currencies, notification] = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT id, name FROM categories WHERE user_id = ?").bind(userId),
    db.prepare("SELECT id, name FROM household WHERE user_id = ?").bind(userId),
    db.prepare("SELECT id, name FROM payment_methods WHERE user_id = ?").bind(userId),
    db.prepare("SELECT id, symbol, rate FROM currencies WHERE user_id = ?").bind(userId),
    db.prepare("SELECT days FROM notification_settings WHERE user_id = ?").bind(userId),
  ]);
  const names = (rows: Record<string, unknown>[] | undefined) => new Map((rows ?? []).map((r) => [r.id as number, String(r.name ?? "")]));
  return {
    categories: names(categories?.results),
    members: names(members?.results),
    methods: names(methods?.results),
    currencies: new Map((currencies?.results ?? []).map((r) => [r.id as number, { symbol: String(r.symbol ?? ""), rate: Number(r.rate) }])),
    defaultDays: Number(notification?.results[0]?.days ?? 1),
  };
}

/** Reminder days of a subscription: its own, or the notification default for -1. */
const triggerDays = (row: SubscriptionRow, lookups: NameLookups) =>
  row.notify_days_before === -1 ? lookups.defaultDays : row.notify_days_before || 1;

/**
 * api/subscriptions/get_ical_feed.php: every active subscription as one
 * calendar. Exported for the API routes (it authenticates with the API key).
 */
export async function icalFeed(db: D1Database, user: { id: number; main_currency: number | null }, convertCurrency: boolean): Promise<string> {
  const lookups = await nameLookups(db, user.id);
  const [rows, lastUpdate] = await Promise.all([
    db.prepare("SELECT * FROM subscriptions WHERE user_id = ? AND inactive = 0 ORDER BY next_payment ASC").bind(user.id).all<SubscriptionRow>(),
    db.prepare("SELECT date FROM last_exchange_update WHERE user_id = ?").bind(user.id).first<{ date: string }>(),
  ]);
  const canConvert = Boolean(lastUpdate?.date);
  let ics = "BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Wallos//iCalendar//EN\nNAME:Wallos\nX-WR-CALNAME:Wallos\n";
  for (const row of rows.results) {
    let price = Number(row.price);
    let currencyId = row.currency_id;
    if (convertCurrency && canConvert && row.currency_id !== user.main_currency) {
      const rate = lookups.currencies.get(row.currency_id ?? -1)?.rate;
      price = rate ? price / rate : price;
      currencyId = user.main_currency;
    }
    ics +=
      vevent({
        row,
        currencySymbol: lookups.currencies.get(currencyId ?? -1)?.symbol ?? "",
        price,
        category: lookups.categories.get(row.category_id ?? -1) ?? "No category",
        paymentMethod: lookups.methods.get(row.payment_method_id ?? -1) ?? "Unknown payment method",
        payer: lookups.members.get(row.payer_user_id ?? -1) ?? "Unknown member",
        trigger: triggerDays(row, lookups),
        blankBeforeNotes: false,
      }) + "\n";
  }
  return `${ics}END:VCALENDAR\n`;
}

// --- endpoints/subscriptions/get.php: the list as a fragment ----------------------------

routes.get("/endpoints/subscriptions/get.php", async (c) => {
  const ui = await loadUi(c);
  const { t } = ui;
  const lookups = await loadLookups(c);
  const query = c.req.query();
  const sort = sorting(c);
  const rows = await querySubscriptions(
    c,
    {
      member: query.members,
      category: query.categories,
      payment: query.payments,
      state: query.state,
      renewalType: query.renewalType,
      notifications: query.notifications,
    },
    sort,
    Boolean(ui.settings.disabled_to_bottom),
  );
  const items = reorder(printItems(rows, ui, lookups, ui.user.main_currency), sort.sortOrder, ui, lookups);
  const empty =
    rows.length === 0
      ? html`
    <div class="no-matching-subscriptions">
      <p>
        ${t("no_matching_subscriptions")}
      </p>
      <button class="button" onClick="clearFilters()">
        <span clasS="fa-solid fa-minus-circle"></span>
        ${t("clear_filters")}
      </button>
      <img src="images/siteimages/empty.png" alt="${t("empty_page")}" />
    </div>
    `
      : "";
  return c.html(html`${SubscriptionList({ items, sort: sort.sort, ui, lookups })}${empty}`);
});

// --- endpoints/subscriptions/export.php ------------------------------------------------

routes.get("/endpoints/subscriptions/export.php", async (c) => {
  const userId = c.get("user").id;
  const db = c.env.DB;
  const lookups = await nameLookups(db, userId);
  const rows = await db.prepare("SELECT * FROM subscriptions WHERE user_id = ?").bind(userId).all<SubscriptionRow>();
  const cycleNames: Record<number, string> = { 1: "Daily", 2: "Weekly", 3: "Monthly", 4: "Yearly", 5: "One-time" };
  const plural: Record<string, string> = { Daily: "Days", Weekly: "Weeks", Monthly: "Months", Yearly: "Years" };
  const noCommas = (value: string | null | undefined) => String(value ?? "").replace(/,/g, " ");
  const subscriptions = rows.results.map((row) => {
    const cycle = cycleNames[row.cycle ?? 0] ?? "";
    return {
      Name: noCommas(row.name),
      "Payment Cycle": row.frequency === 1 ? cycle : `Every ${row.frequency} ${plural[cycle] ?? ""}`,
      "Next Payment": row.next_payment,
      Renewal: row.auto_renew ? "Automatic" : "Manual",
      Category: noCommas(lookups.categories.get(row.category_id ?? -1)),
      "Payment Method": noCommas(lookups.methods.get(row.payment_method_id ?? -1)),
      "Paid By": noCommas(lookups.members.get(row.payer_user_id ?? -1)),
      Price: `${lookups.currencies.get(row.currency_id ?? -1)?.symbol ?? ""}${row.price}`,
      Notes: noCommas(row.notes),
      URL: row.url,
      State: row.inactive ? "Disabled" : "Enabled",
      Notifications: row.notify ? "Enabled" : "Disabled",
      "Cancellation Date": row.cancellation_date,
      Active: row.inactive ? "No" : "Yes",
    };
  });
  return c.json({ success: true, subscriptions });
});

// --- endpoints/subscription/get.php --------------------------------------------------------

routes.get("/endpoints/subscription/get.php", async (c) => {
  const t = await endpointTranslator(c);
  const id = idOf(c.req.query("id"));
  const row = id ? await findSubscription(c.env.DB, c.get("user").id, id) : null;
  if (!row) return c.text(t("error"));
  return c.json({
    id: row.id,
    name: row.name ?? "",
    logo: row.logo,
    logo_text_color: row.logo_text_color,
    logo_variant: row.logo_variant,
    price: row.price,
    currency_id: row.currency_id,
    auto_renew: row.auto_renew,
    start_date: row.start_date,
    next_payment: row.next_payment,
    frequency: row.frequency,
    cycle: row.cycle,
    notes: row.notes ?? "",
    notes_html: renderNotesMarkdown(row.notes),
    payment_method_id: row.payment_method_id,
    payer_user_id: row.payer_user_id,
    category_id: row.category_id,
    notify: row.notify,
    inactive: row.inactive,
    url: row.url ?? "",
    notify_days_before: row.notify_days_before,
    cancellation_date: row.cancellation_date,
    replacement_subscription_id: row.replacement_subscription_id,
  });
});

// --- endpoints/subscription/add.php: add and edit ----------------------------------------------

const FOREIGN_MESSAGES: Record<string, string> = {
  currency_id: "The specified currency does not exist or does not belong to you.",
  category_id: "The specified category does not exist or does not belong to you.",
  payer_user_id: "The specified household member does not exist or does not belong to you.",
  payment_method_id: "The specified payment method does not exist or does not belong to you.",
};

routes.post("/endpoints/subscription/add.php", async (c) => {
  const t = await endpointTranslator(c);
  const user = c.get("user");
  const db = c.env.DB;
  const type = c.req.header("content-type") ?? "";
  const body: Record<string, unknown> = type.includes("form") ? ((await c.req.parseBody()) as Record<string, unknown>) : await jsonBody(c);
  const field = (name: string) => (typeof body[name] === "string" ? (body[name] as string) : typeof body[name] === "number" ? String(body[name]) : undefined);
  const checked = (name: string) => body[name] !== undefined && body[name] !== null && body[name] !== false && body[name] !== "0" && body[name] !== 0;
  const error = (message: string) => c.json({ status: "Error", message });

  const editId = field("id")?.trim() ? idOf(field("id")) : null;
  const isEdit = Boolean(field("id")?.trim());
  const name = (field("name") ?? "").trim();
  const price = Number(field("price") ?? "");
  const cycle = Number(field("cycle") ?? "3");
  const frequency = Number(field("frequency") ?? "1");
  const nextPayment = (field("next_payment") ?? "").trim();
  const startDate = (field("start_date") ?? "").trim();
  const cancellationDate = (field("cancellation_date") ?? "").trim();
  if (
    !name ||
    !Number.isFinite(price) ||
    field("price")?.trim() === "" ||
    !Number.isInteger(cycle) ||
    cycle < 1 ||
    cycle > 5 ||
    !Number.isInteger(frequency) ||
    frequency < 1 ||
    frequency > 366 ||
    !isValidDate(nextPayment) ||
    (startDate !== "" && !isValidDate(startDate)) ||
    (cancellationDate !== "" && !isValidDate(cancellationDate)) ||
    (isEdit && editId === null)
  ) {
    return error(t("fill_all_fields"));
  }

  const currencyId = idOf(field("currency_id"));
  if (currencyId === null) return error(FOREIGN_MESSAGES.currency_id!);
  const optionalId = (name: string) => {
    const value = field(name);
    return value === undefined || value.trim() === "" ? undefined : (idOf(value) ?? -1);
  };
  const bit = (on: boolean): 0 | 1 => (on ? 1 : 0);
  const inactive = bit(checked("inactive"));
  let replacement = inactive ? idOf(field("replacement_subscription_id")) : null;
  if (replacement !== null && (replacement === editId || !(await findSubscription(db, user.id, replacement)))) replacement = null;
  const notifyDays = field("notify_days_before");
  const notifyDaysBefore = notifyDays !== undefined && /^-?\d+$/.test(notifyDays.trim()) ? Math.max(-1, Math.min(366, Number(notifyDays))) : undefined;

  // The logo: a picked web image (logo-url) or an uploaded file; read before saving, stored after.
  let logoBytes: Uint8Array | null = null;
  let logoWarning = "";
  const fromUrl = (field("logo-url") ?? "").trim() !== "";
  const file = body.logo;
  if (!fromUrl && file instanceof File && file.size > 0) {
    const head = new Uint8Array(await file.slice(0, 64).arrayBuffer());
    if (!sniffImageType(head)) return c.text(t("fill_all_fields"));
  }
  try {
    logoBytes = await imageFromBody(fromUrl ? { "logo-url": field("logo-url") } : { logo: file instanceof File && file.size > 0 ? file : undefined }, "logo", ["logo-url"]);
  } catch (e) {
    if (!(e instanceof UploadError)) throw e;
    logoWarning = fromUrl ? `${t("error_fetching_image")}: ${e.message}` : t("error_saving_logo");
  }

  const fields = {
    name,
    price,
    currency_id: currencyId,
    next_payment: nextPayment,
    cycle,
    frequency,
    auto_renew: bit(checked("auto_renew")),
    start_date: startDate || null,
    payment_method_id: optionalId("payment_method_id"),
    payer_user_id: optionalId("payer_user_id"),
    category_id: optionalId("category_id"),
    notes: (field("notes") ?? "").trim(),
    url: (field("url") ?? "").trim(),
    notify: bit(checked("notifications")),
    inactive,
    cancellation_date: cancellationDate || null,
    replacement_subscription_id: replacement,
  };

  let id: number;
  try {
    if (isEdit) {
      id = editId!;
      const input: UpdateSubscriptionInput = { ...fields, ...(notifyDaysBefore !== undefined ? { notify_days_before: notifyDaysBefore } : {}) };
      if (!(await updateSubscription(db, user, id, input))) return error(t("error"));
    } else {
      const input: CreateSubscriptionInput = { ...fields, logo: "", notify_days_before: notifyDaysBefore ?? -1 };
      id = await createSubscription(db, user, input);
    }
  } catch (e) {
    if (e instanceof ReferenceError) return error(FOREIGN_MESSAGES[e.fields[0] ?? ""] ?? t("error"));
    throw e;
  }

  if (logoBytes) {
    try {
      const logo = await storeLogoImage(c.env, user.id, logoBytes, "logo", name);
      await setSubscriptionLogo(c.env, user.id, id, logo);
    } catch (e) {
      if (!(e instanceof UploadError)) throw e;
      logoWarning = t("error_saving_logo");
    }
  }

  return c.json({
    status: "Success",
    message: t(isEdit ? "subscription_updated_successfuly" : "subscription_added_successfuly"),
    ...(logoWarning ? { logo_warning: logoWarning } : {}),
  });
});

// --- delete, clone, renew -----------------------------------------------------------------------

routes.post("/endpoints/subscription/delete.php", async (c) => {
  const t = await endpointTranslator(c);
  const userId = c.get("user").id;
  const id = idOf((await jsonBody(c)).id);
  const before = id ? await findSubscription(c.env.DB, userId, id) : null;
  if (!id || !before || !(await deleteSubscription(c.env.DB, userId, id))) {
    return c.json({ success: false, message: t("error_deleting_subscription") });
  }
  await c.env.DB.prepare("UPDATE subscriptions SET replacement_subscription_id = NULL WHERE replacement_subscription_id = ? AND user_id = ?").bind(id, userId).run();
  await deleteLogosIfUnused(c.env, [before.logo, before.logo_variant]);
  return c.json({ success: true, message: t("subscription_deleted") });
});

routes.post("/endpoints/subscription/clone.php", async (c) => {
  const t = await endpointTranslator(c);
  const id = idOf((await jsonBody(c)).id);
  const newId = id ? await cloneSubscription(c.env.DB, c.get("user").id, id) : null;
  if (newId === null) return c.json({ success: false, message: t("error") });
  return c.json({ success: true, message: t("success"), id: newId });
});

routes.post("/endpoints/subscription/renew.php", async (c) => {
  const t = await endpointTranslator(c);
  const raw = (await jsonBody(c)).id;
  const id = idOf(raw);
  const result = id ? await renewSubscription(c.env.DB, c.get("user").id, id) : null;
  if (!result?.ok) return c.json({ success: false, message: t("error") });
  return c.json({ success: true, message: t("success"), id: raw });
});

// --- calendar export and details --------------------------------------------------------------------

routes.post("/endpoints/subscription/exportcalendar.php", async (c) => {
  const userId = c.get("user").id;
  const id = idOf((await jsonBody(c)).id);
  const row = id ? await findSubscription(c.env.DB, userId, id) : null;
  if (!row) return c.json({ success: false, message: "Subscription not found" });
  const lookups = await nameLookups(c.env.DB, userId);
  const event = vevent({
    row,
    currencySymbol: lookups.currencies.get(row.currency_id ?? -1)?.symbol ?? "",
    price: Number(row.price),
    category: lookups.categories.get(row.category_id ?? -1) ?? "",
    paymentMethod: lookups.methods.get(row.payment_method_id ?? -1) ?? "",
    payer: lookups.members.get(row.payer_user_id ?? -1) ?? "",
    trigger: triggerDays(row, lookups),
    blankBeforeNotes: true,
  });
  const ics = `BEGIN:VCALENDAR\nVERSION:2.0\nPRODID:-//Your Organization//Your Application//EN\nCALSCALE:GREGORIAN\nMETHOD:PUBLISH\n${event}\nEND:VCALENDAR`;
  return c.json({ success: true, ics, name: row.name });
});

routes.post("/endpoints/subscription/getcalendar.php", async (c) => {
  const userId = c.get("user").id;
  const id = idOf((await jsonBody(c)).id);
  const row = id ? await findSubscription(c.env.DB, userId, id) : null;
  if (!row) return c.json({ success: false, message: "Subscription not found" });
  const lookups = await nameLookups(c.env.DB, userId);
  return c.json({
    success: true,
    data: {
      ...row,
      payer_user: lookups.members.get(row.payer_user_id ?? -1) ?? null,
      category: lookups.categories.get(row.category_id ?? -1) ?? null,
      payment_method: lookups.methods.get(row.payment_method_id ?? -1) ?? null,
      currency: lookups.currencies.get(row.currency_id ?? -1)?.symbol ?? null,
      price: numberFormat(Number(row.price)),
    },
  });
});

// --- logo search (endpoints/logos/*.php) ------------------------------------------------------------

routes.get("/endpoints/logos/search.php", async (c) => {
  const term = c.req.query("search");
  if (term === undefined) return c.json({ error: "Invalid request." });
  const source = c.req.query("source") ?? "all";
  const engine = source === "duckduckgo" || source === "brave" ? source : "all";
  // The PHP "all" chain is DuckDuckGo, then Brave.
  let results: LogoResult[];
  if (engine === "all") {
    results = await searchLogos(term, "duckduckgo", null);
    if (!results.length) results = await searchLogos(term, "brave", null);
  } else results = await searchLogos(term, engine, null);
  if (results.length) return c.json({ results });
  if (engine === "brave") return c.json({ error: "Brave returned no results or rate-limited the request. Try again in a minute." });
  if (engine === "duckduckgo") return c.json({ error: "DuckDuckGo returned no results or rate-limited the request." });
  return c.json({ error: "Failed to fetch images from both DuckDuckGo and Brave." });
});

routes.get("/endpoints/logos/google_search.php", async (c) => {
  const term = (c.req.query("search") ?? "").trim();
  if (!term) return c.json({ error: "Invalid request." });
  const row = await c.env.DB.prepare("SELECT api_key FROM google_search WHERE user_id = ?").bind(c.get("user").id).first<{ api_key: string }>();
  if (!row?.api_key) return c.json({ error: "Google search is not configured." });
  try {
    return c.json({ results: await searchLogos(term, "google", row.api_key) });
  } catch (e) {
    if (e instanceof SearchError) return c.json({ error: e.message });
    throw e;
  }
});

// icon_search.php queries one catalogue per section; the service only offers both merged, so the
// per-catalogue filtering lives here (indexes cached for a day, like the PHP temp-file cache).
async function iconIndex<T>(name: string, url: string): Promise<T | null> {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const key = new Request(`https://wallos-cache.invalid/${encodeURIComponent(`icon-index:${name}`)}`);
  const hit = await cache?.match(key).catch(() => undefined);
  if (hit) return (await hit.json().catch(() => null)) as T | null;
  try {
    const response = await fetch(url, { headers: { "user-agent": "Wallos" }, signal: AbortSignal.timeout(20_000) });
    if (!response.ok) return null;
    const data = (await response.json()) as T;
    await cache
      ?.put(key, new Response(JSON.stringify(data), { headers: { "content-type": "application/json", "cache-control": "max-age=86400" } }))
      .catch(() => undefined);
    return data;
  } catch {
    return null;
  }
}

const iconResult = (url: string): LogoResult => ({ thumbnail: url, image: url, width: null, height: null });

async function selfhstIcons(term: string): Promise<LogoResult[]> {
  const index = await iconIndex<{ Name?: string; Reference?: string; PNG?: string }[]>("selfhst", "https://cdn.jsdelivr.net/gh/selfhst/icons/index.json");
  const needle = term.toLowerCase();
  return (Array.isArray(index) ? index : [])
    .filter((icon) => icon.Reference && icon.PNG === "Yes" && ((icon.Name ?? "").toLowerCase().includes(needle) || icon.Reference.toLowerCase().includes(needle)))
    .map((icon) => iconResult(`https://cdn.jsdelivr.net/gh/selfhst/icons/png/${icon.Reference}.png`));
}

async function dashboardIcons(term: string): Promise<LogoResult[]> {
  const index = await iconIndex<{ png?: string[] }>("dashboard-icons", "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/tree.json");
  const needle = term.toLowerCase();
  return (Array.isArray(index?.png) ? index.png : [])
    .filter((file) => {
      const slug = file.replace(/\.png$/, "");
      return !/-(light|dark)$/.test(slug) && slug.toLowerCase().includes(needle);
    })
    .map((file) => iconResult(`https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/${file}`));
}

routes.get("/endpoints/logos/icon_search.php", async (c) => {
  const term = (c.req.query("search") ?? "").trim();
  if (!term) return c.json({ error: "Invalid request." });
  const source = c.req.query("source") ?? "all";
  let results =
    source === "selfhst"
      ? await selfhstIcons(term)
      : source === "dashboardicons"
        ? await dashboardIcons(term)
        : [...(await selfhstIcons(term)), ...(await dashboardIcons(term))];
  // Shorter (closer) matches first, without duplicates.
  results.sort((a, b) => a.image.length - b.image.length);
  const seen = new Set<string>();
  results = results.filter((r) => !seen.has(r.image) && Boolean(seen.add(r.image))).slice(0, 24);
  return c.json({ results });
});
