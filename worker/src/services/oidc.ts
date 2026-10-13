import type { Env } from "../env";
import { randomToken, sha256Hex } from "../lib/crypto";
import { checkOutboundUrl } from "../lib/outbound";
import { registerSchema } from "../lib/schemas";
import { resolveLanguage } from "../ui/i18n";
import { registerUser } from "./accounts";

/*
  OIDC / OAuth single sign-on (includes/oidc_settings.php and includes/oidc/).

  The settings live in oauth_settings (one row) and admin.oidc_oauth_enabled,
  and every field can be pinned by a Worker variable with PHP's environment
  variable name (OIDC_ENABLED, OIDC_CLIENT_ID, OIDC_CLIENT_SECRET as a secret,
  OIDC_ISSUER for discovery, ...). Pinned fields are read-only in the admin UI.

  The login is the authorization-code flow PHP used, plus PKCE (S256): the
  provider redirects back to the configured redirect URL (normally the
  Wallos address itself) with ?code&state; the code is exchanged at the token
  endpoint, and the userinfo endpoint names the user. An account is found by
  its stored subject, else by a verified e-mail address (which links the
  subject to it), else created when automatic creation is on.
*/

export interface OidcSettings {
  name: string;
  client_id: string;
  client_secret: string;
  authorization_url: string;
  token_url: string;
  user_info_url: string;
  redirect_url: string;
  logout_url: string;
  user_identifier_field: string;
  scopes: string;
  auth_style: string;
  auto_create_user: number;
  password_login_disabled: number;
  require_email_verified: number;
}

export const OIDC_DEFAULTS: OidcSettings = {
  name: "",
  client_id: "",
  client_secret: "",
  authorization_url: "",
  token_url: "",
  user_info_url: "",
  redirect_url: "",
  logout_url: "",
  user_identifier_field: "sub",
  scopes: "openid email profile",
  auth_style: "auto",
  auto_create_user: 0,
  password_login_disabled: 0,
  require_email_verified: 1,
};

const TEXT_FIELDS = ["name", "client_id", "client_secret", "authorization_url", "token_url", "user_info_url", "redirect_url", "logout_url", "user_identifier_field", "scopes", "auth_style"] as const;
const FLAG_FIELDS = ["auto_create_user", "password_login_disabled", "require_email_verified"] as const;

/** What the admin page and the API show instead of a stored client secret. */
export const SECRET_MASK = "********";

export interface OidcConfiguration {
  enabled: number;
  settings: OidcSettings;
  /** Field (or "enabled") -> name of the variable that pins it. */
  managedFields: Record<string, string>;
  notes: string[];
  isConfigured: boolean;
}

function parseBoolean(value: string): number | null {
  const v = value.trim().toLowerCase();
  if (["1", "true", "yes", "on"].includes(v)) return 1;
  if (["0", "false", "no", "off"].includes(v)) return 0;
  return null;
}

const discoveryCache = new Map<string, { document: Record<string, unknown>; expires: number }>();

async function discover(issuer: string): Promise<[Record<string, unknown> | null, string | null]> {
  const base = issuer.trim().replace(/\/+$/, "");
  const url = `${base}/.well-known/openid-configuration`;
  const cached = discoveryCache.get(url);
  if (cached && cached.expires > Date.now()) return [cached.document, null];
  const check = checkOutboundUrl(url);
  if (!check.ok) return [null, `OIDC discovery failed for ${url}: ${check.reason}`];
  try {
    const response = await fetch(check.url, { headers: { accept: "application/json" }, signal: AbortSignal.timeout(10_000) });
    if (!response.ok) return [null, `OIDC discovery failed for ${url}: HTTP ${response.status}`];
    const document = (await response.json()) as unknown;
    if (!document || typeof document !== "object") return [null, `OIDC discovery returned invalid JSON for ${url}.`];
    discoveryCache.set(url, { document: document as Record<string, unknown>, expires: Date.now() + 3_600_000 });
    return [document as Record<string, unknown>, null];
  } catch (error) {
    return [null, `OIDC discovery failed for ${url}: ${error instanceof Error ? error.message : String(error)}`];
  }
}

/** For tests: forget cached discovery documents. */
export function clearOidcDiscoveryCache() {
  discoveryCache.clear();
}

export async function storedOidcSettings(db: D1Database): Promise<OidcSettings> {
  const row = await db.prepare("SELECT * FROM oauth_settings WHERE id = 1").first<Record<string, unknown>>();
  const settings: OidcSettings = { ...OIDC_DEFAULTS };
  if (row) {
    for (const field of TEXT_FIELDS) if (row[field] !== null && row[field] !== undefined) settings[field] = String(row[field]);
    for (const field of FLAG_FIELDS) if (row[field] !== null && row[field] !== undefined) settings[field] = Number(row[field]) ? 1 : 0;
  }
  return settings;
}

/** wallos_get_effective_oidc_configuration(): stored settings with the variables applied. */
export async function oidcConfiguration(env: Env): Promise<OidcConfiguration> {
  const settings = await storedOidcSettings(env.DB);
  const admin = await env.DB.prepare("SELECT oidc_oauth_enabled FROM admin WHERE id = 1").first<{ oidc_oauth_enabled: number | null }>();
  let enabled = Number(admin?.oidc_oauth_enabled ?? 0) ? 1 : 0;
  const managedFields: Record<string, string> = {};
  const notes: string[] = [];
  const variable = (name: string) => {
    const value = env[`OIDC_${name}`];
    return typeof value === "string" ? value : null;
  };

  for (const [field, name] of [["enabled", "ENABLED"], ["auto_create_user", "AUTO_CREATE_USER"], ["password_login_disabled", "DISABLE_PASSWORD_LOGIN"], ["require_email_verified", "REQUIRE_EMAIL_VERIFIED"]] as const) {
    const raw = variable(name);
    if (raw === null) continue;
    const parsed = parseBoolean(raw);
    if (parsed === null) {
      notes.push(`Ignoring invalid boolean value in OIDC_${name}.`);
      continue;
    }
    if (field === "enabled") enabled = parsed;
    else settings[field] = parsed;
    managedFields[field] = `OIDC_${name}`;
  }

  const secret = variable("CLIENT_SECRET");
  if (secret !== null) {
    settings.client_secret = secret;
    managedFields.client_secret = "OIDC_CLIENT_SECRET";
  }

  const issuer = variable("ISSUER");
  if (issuer !== null) {
    managedFields.issuer = "OIDC_ISSUER";
    for (const field of ["authorization_url", "token_url", "user_info_url"] as const) {
      settings[field] = "";
      managedFields[field] = "OIDC_ISSUER";
    }
    if (issuer.trim()) {
      const [document, error] = await discover(issuer);
      if (error) notes.push(error);
      if (document) {
        const map = { authorization_url: "authorization_endpoint", token_url: "token_endpoint", user_info_url: "userinfo_endpoint" } as const;
        for (const [field, key] of Object.entries(map) as [keyof typeof map, string][]) {
          if (typeof document[key] === "string") settings[field] = document[key] as string;
        }
      }
    } else {
      notes.push("Ignoring empty OIDC_ISSUER value.");
    }
  }

  const textVariables: [keyof OidcSettings, string][] = [
    ["name", "PROVIDER_NAME"],
    ["client_id", "CLIENT_ID"],
    ["authorization_url", "AUTH_URL"],
    ["token_url", "TOKEN_URL"],
    ["user_info_url", "USERINFO_URL"],
    ["redirect_url", "REDIRECT_URL"],
    ["logout_url", "LOGOUT_URL"],
    ["user_identifier_field", "USER_IDENTIFIER"],
    ["scopes", "SCOPES"],
  ];
  for (const [field, name] of textVariables) {
    const value = variable(name);
    if (value === null) continue;
    (settings[field] as string) = value;
    managedFields[field] = `OIDC_${name}`;
  }

  // client_secret is not required: public clients use an empty one.
  const required = ["client_id", "authorization_url", "token_url", "user_info_url", "redirect_url", "user_identifier_field"] as const;
  const missing = required.filter((field) => !settings[field].trim());
  const isConfigured = missing.length === 0;
  if (enabled && !isConfigured) {
    notes.push(`OIDC is enabled but the login button is hidden because required fields are empty: ${missing.join(", ")}.`);
  }
  return { enabled, settings, managedFields, notes, isConfigured };
}

export const oidcActive = (config: OidcConfiguration) => config.enabled === 1 && config.isConfigured;

/** SSO-only: OIDC is usable and the admin turned password logins off. */
export async function passwordLoginDisabled(env: Env): Promise<boolean> {
  const config = await oidcConfiguration(env);
  return oidcActive(config) && config.settings.password_login_disabled === 1;
}

/** The settings with the client secret masked, for display. */
export function maskedSettings(settings: OidcSettings): OidcSettings {
  return { ...settings, client_secret: settings.client_secret ? SECRET_MASK : "" };
}

export class OidcSettingsError extends Error {}

function checkEndpoint(label: string, value: string, browser: boolean) {
  if (!value) return;
  if (browser) {
    let url: URL | null = null;
    try {
      url = new URL(value);
    } catch {
      url = null;
    }
    if (!url || (url.protocol !== "https:" && url.protocol !== "http:")) throw new OidcSettingsError(`${label} must be an http(s) URL.`);
    return;
  }
  const check = checkOutboundUrl(value);
  if (!check.ok) throw new OidcSettingsError(`Security Error: ${label} must not target link-local or loopback addresses. ${check.reason}`);
}

/**
 * saveoidcsettings.php / set_oidc_settings.php: stores the submitted fields
 * that no variable pins. A client secret equal to the mask keeps the stored one.
 * Returns true when something was submitted.
 */
export async function saveOidcSettings(env: Env, submitted: Partial<Record<keyof OidcSettings, unknown>>): Promise<boolean> {
  const { managedFields } = await oidcConfiguration(env);
  const settings = await storedOidcSettings(env.DB);
  let changed = false;
  for (const field of TEXT_FIELDS) {
    const value = submitted[field];
    if (value === undefined || value === null || managedFields[field]) continue;
    const text = String(value).trim().slice(0, 2048);
    if (field === "client_secret" && text === SECRET_MASK) continue;
    settings[field] = text;
    changed = true;
  }
  for (const field of FLAG_FIELDS) {
    const value = submitted[field];
    if (value === undefined || value === null || value === "" || managedFields[field]) continue;
    settings[field] = Number(value) === 1 || value === true ? 1 : 0;
    changed = true;
  }
  if (!changed) return false;
  if (!["auto", "header", "params"].includes(settings.auth_style)) settings.auth_style = "auto";

  checkEndpoint("Token URL", settings.token_url, false);
  checkEndpoint("User Info URL", settings.user_info_url, false);
  checkEndpoint("Auth URL", settings.authorization_url, true);
  checkEndpoint("Logout URL", settings.logout_url, true);
  checkEndpoint("Redirect URL", settings.redirect_url, true);

  const columns = [...TEXT_FIELDS, ...FLAG_FIELDS];
  await env.DB.prepare(
    `INSERT INTO oauth_settings (id, ${columns.join(", ")}, updated_at) VALUES (1, ${columns.map(() => "?").join(", ")}, CURRENT_TIMESTAMP)
     ON CONFLICT (id) DO UPDATE SET ${columns.map((c) => `${c} = excluded.${c}`).join(", ")}, updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(...columns.map((c) => settings[c]))
    .run();
  return true;
}

/** enableoidc.php. Returns an error message when OIDC_ENABLED pins the switch. */
export async function setOidcEnabled(env: Env, enabled: boolean): Promise<string | null> {
  if (env.OIDC_ENABLED !== undefined) return "OIDC enablement is managed by the OIDC_ENABLED environment variable.";
  await env.DB.prepare("UPDATE admin SET oidc_oauth_enabled = ? WHERE id = 1").bind(enabled ? 1 : 0).run();
  return null;
}

// --- the login ---------------------------------------------------------------------------

const base64url = (bytes: Uint8Array) => btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

/** The provider URL to send the browser to, with the state and PKCE verifier to keep. */
export async function authorizationRequest(config: OidcConfiguration): Promise<{ url: string; state: string; codeVerifier: string }> {
  const state = randomToken(16);
  const codeVerifier = base64url(crypto.getRandomValues(new Uint8Array(32)));
  const challenge = base64url(new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(codeVerifier))));
  const params = new URLSearchParams({
    response_type: "code",
    client_id: config.settings.client_id,
    redirect_uri: config.settings.redirect_url,
    scope: config.settings.scopes,
    state,
    code_challenge: challenge,
    code_challenge_method: "S256",
  });
  const base = config.settings.authorization_url.replace(/\?+$/, "");
  return { url: `${base}${base.includes("?") ? "&" : "?"}${params}`, state, codeVerifier };
}

export type OidcError = "oidc_user_not_found" | "oidc_invalid_state" | "oidc_email_not_verified" | "oidc_invalid_config";
export type OidcResult = { ok: true; userId: number } | { ok: false; error: OidcError } | { ok: false; fatal: string };

/** Exchanges the code and finds, links or creates the account (handle_oidc_callback.php). */
export async function completeOidcLogin(env: Env, code: string, codeVerifier: string): Promise<OidcResult> {
  const config = await oidcConfiguration(env);
  if (!oidcActive(config)) return { ok: false, error: "oidc_user_not_found" };
  const s = config.settings;

  const tokenCheck = checkOutboundUrl(s.token_url);
  const userInfoCheck = checkOutboundUrl(s.user_info_url);
  if (!tokenCheck.ok || !userInfoCheck.ok) return { ok: false, error: "oidc_invalid_config" };

  const form = new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: s.redirect_url, client_id: s.client_id, code_verifier: codeVerifier });
  const headers: Record<string, string> = { "content-type": "application/x-www-form-urlencoded", accept: "application/json" };
  if (s.auth_style === "header") {
    headers.authorization = `Basic ${btoa(`${encodeURIComponent(s.client_id)}:${encodeURIComponent(s.client_secret)}`)}`;
  } else {
    form.set("client_secret", s.client_secret);
  }

  let accessToken: string;
  try {
    const response = await fetch(tokenCheck.url, { method: "POST", headers, body: form.toString(), redirect: "manual", signal: AbortSignal.timeout(10_000) });
    const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!data || typeof data.access_token !== "string") {
      console.error(`[Wallos OIDC] Token exchange failed for ${tokenCheck.url.host}: HTTP ${response.status}`);
      return { ok: false, fatal: "OIDC token exchange failed. Check the Worker logs for details." };
    }
    accessToken = data.access_token;
  } catch (error) {
    console.error(`[Wallos OIDC] Token exchange failed for ${tokenCheck.url.host}`, error);
    return { ok: false, fatal: "OIDC token exchange failed. Check the Worker logs for details." };
  }

  let userInfo: Record<string, unknown>;
  try {
    const response = await fetch(userInfoCheck.url, {
      headers: { authorization: `Bearer ${accessToken}`, accept: "application/json" },
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
    const data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
    if (!data || data[s.user_identifier_field] === undefined || data[s.user_identifier_field] === null || data[s.user_identifier_field] === "") {
      console.error(`[Wallos OIDC] User info fetch failed for ${userInfoCheck.url.host}: HTTP ${response.status}`);
      return { ok: false, fatal: "Failed to fetch OIDC user info. Check the Worker logs for details." };
    }
    userInfo = data;
  } catch (error) {
    console.error(`[Wallos OIDC] User info fetch failed for ${userInfoCheck.url.host}`, error);
    return { ok: false, fatal: "Failed to fetch OIDC user info. Check the Worker logs for details." };
  }

  const subject = String(userInfo[s.user_identifier_field]);
  const bySubject = await env.DB.prepare("SELECT id FROM user WHERE oidc_sub = ?").bind(subject).first<{ id: number }>();
  if (bySubject) return { ok: true, userId: bySubject.id };

  const email = typeof userInfo.email === "string" ? userInfo.email.trim() : "";
  if (!email) return { ok: false, error: "oidc_user_not_found" };
  // Linking or creating by e-mail needs a verified address, so an unverified
  // claim at a permissive provider cannot take over a local account.
  if (s.require_email_verified && userInfo.email_verified !== true) return { ok: false, error: "oidc_email_not_verified" };

  const byEmail = await env.DB.prepare("SELECT id FROM user WHERE email = ? COLLATE NOCASE AND (oidc_sub IS NULL OR oidc_sub = '') ORDER BY id LIMIT 1")
    .bind(email)
    .first<{ id: number }>();
  if (byEmail) {
    await env.DB.prepare("UPDATE user SET oidc_sub = ? WHERE id = ?").bind(subject, byEmail.id).run();
    return { ok: true, userId: byEmail.id };
  }

  if (!s.auto_create_user) return { ok: false, error: "oidc_user_not_found" };
  const created = await createOidcUser(env.DB, userInfo, email, subject);
  return created === null ? { ok: false, error: "oidc_user_not_found" } : { ok: true, userId: created };
}

function usernameBase(userInfo: Record<string, unknown>, email: string): string {
  const preferred = typeof userInfo.preferred_username === "string" ? userInfo.preferred_username : "";
  const cleaned = (value: string) => value.normalize("NFKC").replace(/[^\p{L}\p{N}._@-]/gu, "").slice(0, 56);
  const candidate = cleaned(preferred) || cleaned(email.split("@")[0]!.toLowerCase());
  return candidate.length >= 2 ? candidate : `user${candidate}`;
}

/** oidc_create_user.php: a new account with the defaults, a random password and the provider's name and locale. */
async function createOidcUser(db: D1Database, userInfo: Record<string, unknown>, email: string, subject: string): Promise<number | null> {
  const base = usernameBase(userInfo, email);
  let username = base;
  for (let attempt = 1; await db.prepare("SELECT 1 FROM user WHERE username = ?").bind(username).first(); attempt++) username = `${base}${attempt}`;

  const [firstname = "", lastname = ""] = (typeof userInfo.name === "string" ? userInfo.name.trim() : "").split(/\s+(.*)/s);
  const parsed = registerSchema.safeParse({
    username,
    email,
    password: randomToken(16),
    main_currency: "EUR",
    language: resolveLanguage(typeof userInfo.locale === "string" ? userInfo.locale : null),
    firstname: firstname.slice(0, 100),
    lastname: lastname.slice(0, 100),
  });
  if (!parsed.success) {
    console.error("[Wallos OIDC] Cannot create an account from the provider's claims", parsed.error.issues);
    return null;
  }
  const userId = await registerUser(db, parsed.data);
  await db.prepare("UPDATE user SET oidc_sub = ? WHERE id = ?").bind(subject, userId).run();
  return userId;
}

/** Where to send the browser after logging out of an OIDC session, or null. */
export async function oidcLogoutUrl(env: Env): Promise<string | null> {
  const { settings } = await oidcConfiguration(env);
  if (!settings.logout_url) return null;
  const check = checkOutboundUrl(settings.logout_url);
  if (!check.ok) return null;
  const url = new URL(check.url);
  if (settings.redirect_url) url.searchParams.set("post_logout_redirect_uri", settings.redirect_url);
  return url.toString();
}

export const stateMatches = async (expected: unknown, received: string) =>
  typeof expected === "string" && expected.length > 0 && (await sha256Hex(expected)) === (await sha256Hex(received));
