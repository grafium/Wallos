import type { Context, MiddlewareHandler } from "hono";
import { getCookie } from "hono/cookie";
import type { AppBindings } from "../env";
import { ADMIN_USER_ID } from "../env";
import { userFromSession } from "../lib/auth";
import { WORKER_VERSION } from "../version";
import { localeFromHeader, type CurrencyInfo } from "./format";
import { LANGUAGES, resolveLanguage, translator, type Translate } from "./i18n";
import { clearSessionCookie, csrfToken, hasValidCsrf, sessionTokenFromCookie } from "./session";

/*
  What every page and endpoint of the web interface knows about the request:
  the signed-in user, their settings (with the derived values PHP's
  includes/getsettings.php added), language, CSRF token and theme.
*/

export type UiCtx = Context<AppBindings>;

export interface UiUser {
  id: number;
  username: string;
  email: string;
  firstname: string;
  lastname: string;
  avatar: string;
  main_currency: number | null;
  language: string;
  budget: number;
  totp_enabled: number;
  timezone: string;
}

export interface UiSettings {
  dark_theme: number;
  monthly_price: number;
  convert_currency: number;
  remove_background: number;
  color_theme: string;
  hide_disabled: number;
  disabled_to_bottom: number;
  show_original_price: number;
  mobile_nav: number;
  show_subscription_progress: number;
  week_starts_sunday: number;
  upcoming_payments_limit: number;
  square_icons: number;
}

export interface Ui {
  user: UiUser;
  isAdmin: boolean;
  lang: string;
  dir: "ltr" | "rtl";
  t: Translate;
  /** Locale for numbers, from Accept-Language like PHP's CurrencyFormatter. */
  locale: string;
  csrf: string;
  settings: UiSettings;
  /** "light", "dark" or "automatic" (resolved from the inUseTheme cookie when known). */
  theme: string;
  updateThemeSettings: boolean;
  colorTheme: string;
  customCss: string;
  customColors: { main_color: string; accent_color: string; hover_color: string } | null;
  version: string;
}

const DEFAULT_SETTINGS: UiSettings = {
  dark_theme: 2,
  monthly_price: 0,
  convert_currency: 0,
  remove_background: 0,
  color_theme: "blue",
  hide_disabled: 0,
  disabled_to_bottom: 0,
  show_original_price: 0,
  mobile_nav: 0,
  show_subscription_progress: 0,
  week_starts_sunday: 0,
  upcoming_payments_limit: 3,
  square_icons: 0,
};

export async function loadUi(c: UiCtx): Promise<Ui> {
  const userId = c.get("user").id;
  const [user, settings, colors, css] = await c.env.DB.batch<Record<string, unknown>>([
    c.env.DB.prepare(
      "SELECT id, username, email, firstname, lastname, avatar, main_currency, language, budget, totp_enabled, timezone FROM user WHERE id = ?",
    ).bind(userId),
    c.env.DB.prepare("SELECT * FROM settings WHERE user_id = ?").bind(userId),
    c.env.DB.prepare("SELECT main_color, accent_color, hover_color FROM custom_colors WHERE user_id = ?").bind(userId),
    c.env.DB.prepare("SELECT css FROM custom_css_style WHERE user_id = ?").bind(userId),
  ]);
  const u = user!.results[0] as unknown as UiUser;
  const s = { ...DEFAULT_SETTINGS, ...((settings?.results[0] as Partial<UiSettings> | undefined) ?? {}) };
  const lang = resolveLanguage(u.language);

  const themeValue = ["light", "dark", "automatic"][s.dark_theme] ?? "automatic";
  const inUse = getCookie(c, "inUseTheme");
  const theme = s.dark_theme === 2 && (inUse === "light" || inUse === "dark") ? inUse : themeValue;

  return {
    user: { ...u, avatar: u.avatar || "images/avatars/0.svg", firstname: u.firstname ?? "", lastname: u.lastname ?? "" },
    isAdmin: u.id === ADMIN_USER_ID,
    lang,
    dir: LANGUAGES[lang]?.dir ?? "ltr",
    t: translator(lang),
    locale: localeFromHeader(c.req.header("accept-language")),
    csrf: await csrfToken(c.get("sessionToken")!),
    settings: s,
    theme,
    updateThemeSettings: themeValue === "automatic",
    colorTheme: s.color_theme || "blue",
    customCss: (css?.results[0]?.css as string | undefined) ?? "",
    customColors: (colors?.results[0] as Ui["customColors"]) ?? null,
    version: WORKER_VERSION,
  };
}

/** The user's currencies keyed by id, as most PHP pages loaded them via getdbkeys.php. */
export async function loadCurrencies(c: UiCtx): Promise<Map<number, CurrencyInfo>> {
  const rows = await c.env.DB.prepare("SELECT id, name, symbol, code, rate FROM currencies WHERE user_id = ? ORDER BY id")
    .bind(c.get("user").id)
    .all<CurrencyInfo>();
  return new Map(rows.results.map((r) => [r.id, r]));
}

async function sessionUser(c: UiCtx) {
  const token = sessionTokenFromCookie(c);
  if (!token) return null;
  const user = await userFromSession(c.env.DB, token);
  return user ? { user, token } : null;
}

/** Pages: a signed-in session, else off to the login (or, on a fresh instance, registration) page. */
export const uiPage: MiddlewareHandler<AppBindings> = async (c, next) => {
  const session = await sessionUser(c);
  if (!session) {
    if (sessionTokenFromCookie(c)) clearSessionCookie(c);
    const users = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM user").first<{ n: number }>();
    return c.redirect(users?.n ? "login.php" : "registration.php");
  }
  c.set("user", session.user);
  c.set("authMethod", "session");
  c.set("sessionToken", session.token);
  return next();
};

/**
 * The endpoints/*.php the interface's scripts call: a session, and the CSRF
 * token on anything but GET. Failures answer like includes/validate_endpoint.php.
 */
export const uiEndpoint: MiddlewareHandler<AppBindings> = async (c, next) => {
  const session = await sessionUser(c);
  const t = translator(resolveLanguage(getCookie(c, "language")));
  if (!session) return c.json({ success: false, message: t("session_expired") });
  if (c.req.method !== "GET" && c.req.method !== "HEAD") {
    const type = c.req.header("content-type") ?? "";
    const body = type.includes("form") ? ((await c.req.parseBody()) as Record<string, unknown>) : undefined;
    if (!(await hasValidCsrf(c, session.token, body))) return c.json({ success: false, message: "Invalid CSRF token" });
  }
  c.set("user", session.user);
  c.set("authMethod", "session");
  c.set("sessionToken", session.token);
  return next();
};
