import { Hono, type Context } from "hono";
import type { AppBindings } from "../../env";
import { ADMIN_USER_ID } from "../../env";
import { readBody } from "../../lib/http";
import { refreshUserRates } from "../../services/exchange-rates";
import { deleteLogosIfUnused, deleteUserAccount, fetchImage, MAX_UPLOAD_BYTES, UploadError } from "../../services/files";
import { searchLogos } from "../../services/logo-search";
import { updateSettings } from "../../services/settings";
import { storeLogoImage } from "../../routes/uploads";
import { resolveLanguage, translator, type Translate } from "../i18n";
import { loadPaymentMethods, PaymentMethods } from "../pages/settings-payments";

/*
  The endpoints settings.php's scripts (settings.js, theme.js) and profile.js
  call: categories, household, currencies and exchange rates, payment
  methods, the settings/* toggles and account deletion. Requests and answers
  are PHP's - mostly {success, message} with HTTP 200 - since the scripts
  are unchanged. Session and CSRF were checked by uiEndpoint.

  Names are stored as typed (PHP stored them HTML-escaped); every page
  escapes on output.
*/

export const routes = new Hono<AppBindings>();

type Ctx = Context<AppBindings>;

const tr = (c: Ctx): Translate => translator(resolveLanguage(c.get("user").language));
const done = (c: Ctx, message: string, extra: Record<string, unknown> = {}) => c.json({ success: true, message, ...extra });
const failed = (c: Ctx, message: string) => c.json({ success: false, message });

/** A form field as a trimmed string ("" when absent or a file). */
const field = (body: Record<string, unknown>, key: string) => (typeof body[key] === "string" ? (body[key] as string).trim() : "");

/** A positive integer id, else null. */
function id(value: unknown): number | null {
  const text = typeof value === "number" ? String(value) : typeof value === "string" ? value.trim() : "";
  if (!/^\d+$/.test(text)) return null;
  const n = Number(text);
  return Number.isSafeInteger(n) && n > 0 ? n : null;
}

const MAX_NAME = 255;

// --- categories ---------------------------------------------------------------------

/** The account's "No category": its first category, which PHP kept as id 1. */
const firstCategory = (c: Ctx) =>
  c.env.DB.prepare("SELECT MIN(id) AS id FROM categories WHERE user_id = ?").bind(c.get("user").id).first<{ id: number | null }>();

routes.post("/endpoints/categories/category.php", async (c) => {
  const t = tr(c);
  const db = c.env.DB;
  const userId = c.get("user").id;
  const body = await readBody(c);

  switch (field(body, "action")) {
    case "add": {
      const row = await db
        .prepare(`INSERT INTO categories (name, "order", user_id) VALUES ('Category', (SELECT COALESCE(MAX("order"), 0) + 1 FROM categories WHERE user_id = ?1), ?1) RETURNING id`)
        .bind(userId)
        .first<{ id: number }>();
      return row ? c.json({ success: true, categoryId: row.id }) : failed(c, t("failed_add_category"));
    }
    case "edit": {
      const categoryId = id(body.categoryId);
      const name = field(body, "name");
      if (categoryId === null || name === "") return failed(c, t("fill_all_fields"));
      if (name.length > MAX_NAME) return failed(c, t("failed_edit_category"));
      const result = await db.prepare("UPDATE categories SET name = ? WHERE id = ? AND user_id = ?").bind(name, categoryId, userId).run();
      return result.meta.changes > 0 ? done(c, t("category_saved")) : failed(c, t("failed_edit_category"));
    }
    case "delete": {
      const categoryId = id(body.categoryId);
      if (categoryId === null || categoryId === (await firstCategory(c))?.id) return failed(c, t("failed_remove_category"));
      const used = await db.prepare("SELECT 1 FROM subscriptions WHERE category_id = ? AND user_id = ? LIMIT 1").bind(categoryId, userId).first();
      if (used) return failed(c, t("category_in_use"));
      const result = await db.prepare("DELETE FROM categories WHERE id = ? AND user_id = ?").bind(categoryId, userId).run();
      return result.meta.changes > 0 ? done(c, t("category_removed")) : failed(c, t("failed_remove_category"));
    }
    case "sort": {
      const ids = ([] as unknown[]).concat(body["categoryIds[]"] ?? body.categoryIds ?? []).map(id).filter((v): v is number => v !== null);
      // Starts at 2, as in PHP, so "No category" stays first.
      if (ids.length > 0) {
        await db.batch(ids.map((categoryId, i) => db.prepare('UPDATE categories SET "order" = ? WHERE id = ? AND user_id = ?').bind(i + 2, categoryId, userId)));
      }
      return done(c, t("sort_order_saved"));
    }
    default:
      return failed(c, t("error"));
  }
});

// --- household -----------------------------------------------------------------------

routes.post("/endpoints/household/household.php", async (c) => {
  const t = tr(c);
  const db = c.env.DB;
  const userId = c.get("user").id;
  const body = await readBody(c);

  switch (field(body, "action")) {
    case "add": {
      const row = await db.prepare("INSERT INTO household (name, user_id) VALUES ('Member', ?) RETURNING id").bind(userId).first<{ id: number }>();
      return row ? c.json({ success: true, householdId: row.id }) : failed(c, t("failed_add_household"));
    }
    case "edit": {
      const memberId = id(body.memberId);
      const name = field(body, "name");
      const email = field(body, "email");
      if (memberId === null || name === "") return failed(c, t("fill_all_fields"));
      if (name.length > MAX_NAME || email.length > MAX_NAME) return failed(c, t("failed_edit_household"));
      const result = await db.prepare("UPDATE household SET name = ?, email = ? WHERE id = ? AND user_id = ?").bind(name, email, memberId, userId).run();
      return result.meta.changes > 0 ? done(c, t("member_saved")) : failed(c, t("failed_edit_household"));
    }
    case "delete": {
      const memberId = id(body.memberId);
      const owner = await db.prepare("SELECT MIN(id) AS id FROM household WHERE user_id = ?").bind(userId).first<{ id: number | null }>();
      // The first member is the account owner (PHP's id 1).
      if (memberId === null || memberId === owner?.id) return failed(c, t("failed_remove_household"));
      const used = await db.prepare("SELECT 1 FROM subscriptions WHERE payer_user_id = ? AND user_id = ? LIMIT 1").bind(memberId, userId).first();
      if (used) return failed(c, t("household_in_use"));
      const result = await db.prepare("DELETE FROM household WHERE id = ? AND user_id = ?").bind(memberId, userId).run();
      return result.meta.changes > 0 ? done(c, t("member_removed")) : failed(c, t("failed_remove_household"));
    }
    default:
      return c.text(t("error"));
  }
});

// --- currencies and exchange rates --------------------------------------------------------

routes.post("/endpoints/currency/currency.php", async (c) => {
  const t = tr(c);
  const db = c.env.DB;
  const userId = c.get("user").id;
  const body = await readBody(c);

  switch (field(body, "action")) {
    case "add": {
      const row = await db
        .prepare("INSERT INTO currencies (name, symbol, code, rate, user_id) VALUES ('Currency', '$', 'CODE', 1, ?) RETURNING id")
        .bind(userId)
        .first<{ id: number }>();
      return row ? c.json({ success: true, currencyId: row.id }) : c.text(t("error_adding_currency"));
    }
    case "edit": {
      const currencyId = id(body.currencyId);
      const name = field(body, "name");
      const symbol = field(body, "symbol");
      const code = field(body, "code");
      if (currencyId === null || name === "" || symbol === "") return failed(c, t("fields_missing"));
      if (name.length > MAX_NAME || symbol.length > MAX_NAME || code.length > MAX_NAME) return failed(c, t("failed_to_store_currency"));
      // The code of the main currency or of one in use is shown disabled, so the browser does not send it.
      const sql = code
        ? "UPDATE currencies SET name = ?, symbol = ?, code = ? WHERE id = ? AND user_id = ?"
        : "UPDATE currencies SET name = ?, symbol = ? WHERE id = ? AND user_id = ?";
      const values = code ? [name, symbol, code, currencyId, userId] : [name, symbol, currencyId, userId];
      const result = await db.prepare(sql).bind(...values).run();
      return result.meta.changes > 0 ? done(c, `${name} ${t("currency_saved")}`) : failed(c, t("failed_to_store_currency"));
    }
    case "delete": {
      const currencyId = id(body.currencyId);
      if (currencyId === null) return failed(c, t("fields_missing"));
      const used = await db.prepare("SELECT 1 FROM subscriptions WHERE currency_id = ? AND user_id = ? LIMIT 1").bind(currencyId, userId).first();
      if (used) return failed(c, t("currency_in_use"));
      const main = await db.prepare("SELECT main_currency FROM user WHERE id = ?").bind(userId).first<{ main_currency: number | null }>();
      if (main?.main_currency === currencyId) return failed(c, t("currency_is_main"));
      const result = await db.prepare("DELETE FROM currencies WHERE id = ? AND user_id = ?").bind(currencyId, userId).run();
      return result.meta.changes > 0 ? done(c, t("currency_removed")) : failed(c, t("failed_to_remove_currency"));
    }
    default:
      return failed(c, t("error"));
  }
});

/** Asks Fixer or APILayer whether a key works (fixer_api_key.php). */
async function fixerKeyWorks(provider: 0 | 1, apiKey: string): Promise<boolean> {
  try {
    const response =
      provider === 1
        ? await fetch("https://api.apilayer.com/fixer/latest?base=USD&symbols=EUR", { headers: { apikey: apiKey }, signal: AbortSignal.timeout(15_000) })
        : // Fixer's free plan only serves plain http.
          await fetch(`http://data.fixer.io/api/latest?access_key=${encodeURIComponent(apiKey)}`, { signal: AbortSignal.timeout(15_000) });
    const data = (await response.json().catch(() => null)) as { success?: unknown } | null;
    return data?.success === true || data?.success === 1;
  } catch {
    return false;
  }
}

routes.post("/endpoints/currency/fixer_api_key.php", async (c) => {
  const t = tr(c);
  const db = c.env.DB;
  const userId = c.get("user").id;
  const body = await readBody(c);
  const apiKey = field(body, "api_key");
  const provider = Number(field(body, "provider") || "0");

  // Frankfurter needs no key; the stored key stays for switching back.
  if (provider === 2) {
    await db
      .prepare("INSERT INTO fixer (user_id, provider, api_key) VALUES (?, 2, '') ON CONFLICT(user_id) DO UPDATE SET provider = excluded.provider")
      .bind(userId)
      .run();
    return done(c, t("currency_provider_saved"));
  }
  if ((provider !== 0 && provider !== 1) || apiKey === "" || apiKey.length > 255) return failed(c, t("invalid_api_key"));
  if (!(await fixerKeyWorks(provider, apiKey))) return failed(c, t("invalid_api_key"));
  await db.prepare("INSERT OR REPLACE INTO fixer (user_id, provider, api_key) VALUES (?, ?, ?)").bind(userId, provider, apiKey).run();
  return done(c, t("api_key_saved"));
});

/** Plain-text answers, as update_exchange.php printed them. */
routes.post("/endpoints/currency/update_exchange.php", async (c) => {
  const body = await readBody(c);
  const force = body.force === "true" || body.force === true;
  const result = await refreshUserRates(c.env.DB, c.get("user").id, { force });
  switch (result.status) {
    case "updated":
      return c.text(`Rates updated successfully!${result.held.length ? ` Not priced, so left unchanged: ${result.held.join(", ")}.` : ""}`);
    case "skipped":
      if (result.reason === "fresh") return c.text("Rates are current, no need to update.");
      if (result.reason === "manual") return c.text("Exchange rates update skipped. No fixer.io api key provided");
      return c.text("Exchange rates update failed. The main currency is not set.");
    case "failed":
      return c.text(`Exchange rates update failed. The currency provider returned no rates. ${result.error}`);
  }
});

// --- payment methods --------------------------------------------------------------------

routes.post("/endpoints/payments/add.php", async (c) => {
  const t = tr(c);
  const db = c.env.DB;
  const userId = c.get("user").id;
  const body = await readBody(c);
  const name = field(body, "paymentname");
  const iconUrl = field(body, "icon-url");
  const file = body.paymenticon instanceof File && body.paymenticon.size > 0 ? body.paymenticon : null;

  if (name === "" || (iconUrl === "" && !file)) return failed(c, t("fill_all_fields"));
  if (name.length > MAX_NAME) return failed(c, t("fill_all_fields"));

  let icon: string;
  try {
    let bytes: Uint8Array;
    if (iconUrl !== "") {
      bytes = await fetchImage(iconUrl);
    } else {
      if (file!.size > MAX_UPLOAD_BYTES) return failed(c, t("fill_all_fields"));
      bytes = new Uint8Array(await file!.arrayBuffer());
    }
    icon = (await storeLogoImage(c.env, userId, bytes, "icon", name)).name;
  } catch (error) {
    if (!(error instanceof UploadError)) throw error;
    // PHP answered a file that is no image with "fill all fields", a failed download with the reason.
    return failed(c, iconUrl !== "" ? error.message : t("fill_all_fields"));
  }

  await db
    .prepare(
      `INSERT INTO payment_methods (name, icon, enabled, "order", user_id)
       VALUES (?1, ?2, 1, (SELECT COALESCE(MAX("order"), 0) + 1 FROM payment_methods WHERE user_id = ?3), ?3)`,
    )
    .bind(name, icon, userId)
    .run();
  return done(c, t("payment_method_added_successfuly"));
});

/** The payment method tiles as HTML, which settings.js puts into #payments-list. */
routes.get("/endpoints/payments/get.php", async (c) => {
  const payments = await loadPaymentMethods(c.env.DB, c.get("user").id);
  return c.html(PaymentMethods({ t: tr(c), payments, reloaded: true }));
});

routes.post("/endpoints/payments/delete.php", async (c) => {
  const t = tr(c);
  const db = c.env.DB;
  const userId = c.get("user").id;
  const body = await readBody(c);
  const paymentId = id(body.id ?? c.req.query("id"));
  if (paymentId === null) return failed(c, t("error"));
  const used = await db.prepare("SELECT 1 FROM subscriptions WHERE payment_method_id = ? AND user_id = ? LIMIT 1").bind(paymentId, userId).first();
  if (used) return failed(c, t("payment_in_use"));
  const row = await db.prepare("DELETE FROM payment_methods WHERE id = ? AND user_id = ? RETURNING icon").bind(paymentId, userId).first<{ icon: string | null }>();
  if (!row) return failed(c, t("error"));
  await deleteLogosIfUnused(c.env, [row.icon]);
  return done(c, t("payment_method_removed"));
});

routes.post("/endpoints/payments/rename.php", async (c) => {
  const t = tr(c);
  const body = await readBody(c);
  const paymentId = id(body.paymentId);
  const name = field(body, "name");
  if (paymentId === null || name === "" || name.length > MAX_NAME) return failed(c, t("fields_missing"));
  const result = await c.env.DB.prepare("UPDATE payment_methods SET name = ? WHERE id = ? AND user_id = ?").bind(name, paymentId, c.get("user").id).run();
  return result.meta.changes > 0 ? done(c, t("payment_renamed")) : failed(c, t("payment_not_renamed"));
});

routes.post("/endpoints/payments/sort.php", async (c) => {
  const t = tr(c);
  const db = c.env.DB;
  const userId = c.get("user").id;
  const body = await readBody(c);
  const ids = ([] as unknown[]).concat(body["paymentMethodIds[]"] ?? body.paymentMethodIds ?? []).map(id).filter((v): v is number => v !== null);
  if (ids.length > 0) {
    await db.batch(ids.map((paymentId, i) => db.prepare('UPDATE payment_methods SET "order" = ? WHERE id = ? AND user_id = ?').bind(i + 1, paymentId, userId)));
  }
  return done(c, t("sort_order_saved"));
});

routes.post("/endpoints/payments/toggle.php", async (c) => {
  const t = tr(c);
  const db = c.env.DB;
  const userId = c.get("user").id;
  const body = await readBody(c);
  const paymentId = id(body.paymentId);
  const enabledRaw = typeof body.enabled === "string" || typeof body.enabled === "number" || typeof body.enabled === "boolean" ? String(body.enabled) : null;
  if (paymentId === null || enabledRaw === null) return failed(c, t("fields_missing"));
  const used = await db.prepare("SELECT 1 FROM subscriptions WHERE payment_method_id = ? AND user_id = ? LIMIT 1").bind(paymentId, userId).first();
  if (used) return failed(c, t("payment_in_use"));
  const enabled = ["1", "true"].includes(enabledRaw.trim().toLowerCase()) ? 1 : 0;
  const result = await db.prepare("UPDATE payment_methods SET enabled = ? WHERE id = ? AND user_id = ?").bind(enabled, paymentId, userId).run();
  return result.meta.changes > 0 ? done(c, t(enabled ? "enabled" : "disabled")) : failed(c, t("failed_update_payment"));
});

/** Web image search for a payment icon: DuckDuckGo, then Brave (payments/search.php). */
routes.get("/endpoints/payments/search.php", async (c) => {
  const term = (c.req.query("search") ?? "").trim();
  if (!term) return c.json({ error: "Invalid request." });
  try {
    for (const source of ["duckduckgo", "brave"] as const) {
      const results = await searchLogos(term.slice(0, 100), source, null);
      if (results.length > 0) return c.json({ imageUrls: results.map((r) => r.image) });
    }
  } catch (error) {
    console.warn("payment icon search failed", error);
  }
  return c.json({ error: "Failed to fetch images from DuckDuckGo and Brave." });
});

// --- settings/* ------------------------------------------------------------------------------

/** JSON body of the settings/* endpoints. */
async function jsonBody(c: Ctx): Promise<Record<string, unknown>> {
  return readBody(c);
}

const BOOLEAN_SETTINGS = {
  monthly_price: "monthly_price",
  convert_currency: "convert_currency",
  remove_background: "remove_background",
  hide_disabled: "hide_disabled",
  disabled_to_bottom: "disabled_to_bottom",
  show_original_price: "show_original_price",
  mobile_navigation: "mobile_nav",
  subscription_progress: "show_subscription_progress",
  week_starts_sunday: "week_starts_sunday",
} as const;

for (const [endpoint, column] of Object.entries(BOOLEAN_SETTINGS)) {
  routes.post(`/endpoints/settings/${endpoint}.php`, async (c) => {
    const t = tr(c);
    const value = (await jsonBody(c)).value;
    if (typeof value !== "boolean") return failed(c, t("error"));
    await updateSettings(c.env.DB, c.get("user").id, { [column]: value ? 1 : 0 });
    return done(c, t("success"));
  });
}

routes.post("/endpoints/settings/upcoming_payments_limit.php", async (c) => {
  const t = tr(c);
  const value = (await jsonBody(c)).value;
  const limit = typeof value === "number" ? value : typeof value === "string" && /^\d+$/.test(value) ? Number(value) : null;
  if (limit === null || ![3, 5, 10, 20].includes(limit)) return failed(c, t("error"));
  await updateSettings(c.env.DB, c.get("user").id, { upcoming_payments_limit: limit });
  return done(c, t("success"));
});

routes.post("/endpoints/settings/theme.php", async (c) => {
  const t = tr(c);
  const value = (await jsonBody(c)).theme;
  // theme.js sends 0/1/2 (as string or number); its older switchTheme() a boolean for dark.
  const theme = typeof value === "boolean" ? Number(value) : typeof value === "number" || (typeof value === "string" && /^\d$/.test(value)) ? Number(value) : NaN;
  if (!Number.isInteger(theme) || theme < 0 || theme > 2) return failed(c, t("error"));
  await updateSettings(c.env.DB, c.get("user").id, { dark_theme: theme });
  return done(c, t("success"));
});

routes.post("/endpoints/settings/colortheme.php", async (c) => {
  const t = tr(c);
  const color = (await jsonBody(c)).color;
  if (color !== "blue" && color !== "red" && color !== "green" && color !== "yellow" && color !== "purple") return failed(c, t("error"));
  await updateSettings(c.env.DB, c.get("user").id, { color_theme: color });
  return done(c, t("success"));
});

routes.post("/endpoints/settings/customtheme.php", async (c) => {
  const t = tr(c);
  const body = await jsonBody(c);
  const colors = [body.mainColor, body.accentColor, body.hoverColor];
  if (!colors.every((v) => typeof v === "string" && /^#[0-9A-Fa-f]{6}$/.test(v))) return failed(c, t("error"));
  const [main, accent, hover] = colors as string[];
  if (main === accent) return failed(c, t("main_accent_color_error"));
  await updateSettings(c.env.DB, c.get("user").id, { main_color: main, accent_color: accent, hover_color: hover });
  return done(c, t("success"));
});

routes.post("/endpoints/settings/resettheme.php", async (c) => {
  await c.env.DB.prepare("DELETE FROM custom_colors WHERE user_id = ?").bind(c.get("user").id).run();
  return done(c, tr(c)("success"));
});

routes.post("/endpoints/settings/customcss.php", async (c) => {
  const t = tr(c);
  const css = (await jsonBody(c)).customCss;
  if (typeof css !== "string" || css.length > 50_000) return failed(c, t("error"));
  await updateSettings(c.env.DB, c.get("user").id, { css });
  return done(c, t("success"));
});

/** Checks a SerpAPI key without spending a search; returns the account data or null. */
async function serpApiAccount(apiKey: string): Promise<Record<string, unknown> | null> {
  try {
    const response = await fetch(`https://serpapi.com/account?api_key=${encodeURIComponent(apiKey)}`, {
      headers: { "user-agent": "Wallos" },
      signal: AbortSignal.timeout(20_000),
    });
    const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    return response.status === 200 && data && typeof data === "object" && !("error" in data) ? data : null;
  } catch {
    return null;
  }
}

routes.post("/endpoints/settings/google_search.php", async (c) => {
  const t = tr(c);
  const db = c.env.DB;
  const userId = c.get("user").id;
  const apiKey = field(await readBody(c), "api_key");
  if (apiKey === "") {
    // An empty field clears the key and disables the Google section of the logo search.
    await db.prepare("DELETE FROM google_search WHERE user_id = ?").bind(userId).run();
    return done(c, t("success"));
  }
  if (apiKey.length > 255 || !(await serpApiAccount(apiKey))) return failed(c, t("invalid_api_key"));
  await db.prepare("INSERT OR REPLACE INTO google_search (user_id, api_key) VALUES (?, ?)").bind(userId, apiKey).run();
  return done(c, t("api_key_saved"));
});

routes.get("/endpoints/settings/google_search_usage.php", async (c) => {
  const row = await c.env.DB.prepare("SELECT api_key FROM google_search WHERE user_id = ?").bind(c.get("user").id).first<{ api_key: string }>();
  if (!row?.api_key) return c.json({ success: false });
  const data = await serpApiAccount(row.api_key);
  if (!data) return c.json({ success: false });
  const int = (v: unknown) => Math.trunc(Number(v ?? 0)) || 0;
  return c.json({ success: true, used: int(data.this_month_usage), total: int(data.searches_per_month), left: int(data.plan_searches_left) });
});

/**
 * APILayer's monthly quota. PHP captured it from response headers into extra
 * columns of `fixer`, which the Worker's schema does not have, so like PHP
 * without those columns this reports nothing and the usage bar stays hidden.
 */
routes.get("/endpoints/settings/fixer_usage.php", (c) => c.json({ success: false }));

/**
 * profile.js: the signed-in user deletes their own account. Every per-user
 * table cascades from user(id) (sessions included); files nothing else uses go too.
 */
routes.post("/endpoints/settings/deleteaccount.php", async (c) => {
  const t = tr(c);
  const userId = c.get("user").id;
  const requested = id((await jsonBody(c)).userId);
  if (requested === null || requested === ADMIN_USER_ID || requested !== userId) return failed(c, t("error"));

  await deleteUserAccount(c.env, userId);
  return done(c, t("success"));
});
