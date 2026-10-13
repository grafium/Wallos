import type { Context, MiddlewareHandler } from "hono";
import { hasValidCsrf, sessionTokenFromCookie } from "../ui/session";
import type { AppBindings, AuthUser } from "../env";
import { sha256Hex } from "./crypto";
import { fail } from "./http";

/*
  Authentication.

  Two credentials are accepted:
    * a session token from POST /api/auth/login, sent as "Authorization: Bearer";
    * the account's API key, which is how the PHP Wallos API authenticates.
      It may arrive as a Bearer token, an X-API-Key header, or - for
      compatibility with existing Wallos API clients - an api_key / apiKey
      query or form parameter.
    * the web interface's session cookie (src/ui/session.ts); requests
      that change something then also need the CSRF token.
*/

const USER_FIELDS = ["id", "username", "email", "main_currency", "language", "budget", "timezone"];
const USER_COLUMNS = USER_FIELDS.join(", ");
const USER_COLUMNS_U = USER_FIELDS.map((f) => `u.${f}`).join(", ");

async function extractCredential(c: Context<AppBindings>): Promise<string | null> {
  const header = c.req.header("authorization");
  if (header?.toLowerCase().startsWith("bearer ")) {
    return header.slice(7).trim() || null;
  }
  const apiKeyHeader = c.req.header("x-api-key");
  if (apiKeyHeader) return apiKeyHeader.trim();

  const fromQuery = c.req.query("api_key") ?? c.req.query("apiKey");
  if (fromQuery) return fromQuery;

  const type = c.req.header("content-type") ?? "";
  if (c.req.method === "POST" && type.includes("form")) {
    const body = await c.req.parseBody();
    const fromForm = body.api_key ?? body.apiKey;
    if (typeof fromForm === "string" && fromForm) return fromForm;
  }
  return null;
}

export async function userFromSession(db: D1Database, token: string): Promise<AuthUser | null> {
  const id = await sha256Hex(token);
  return db
    .prepare(
      `SELECT ${USER_COLUMNS_U}
         FROM sessions s JOIN user u ON u.id = s.user_id
        WHERE s.id = ? AND s.expires_at > ?`,
    )
    .bind(id, new Date().toISOString())
    .first<AuthUser>();
}

async function userFromApiKey(db: D1Database, apiKey: string): Promise<AuthUser | null> {
  return db.prepare(`SELECT ${USER_COLUMNS} FROM user WHERE api_key = ?`).bind(apiKey).first<AuthUser>();
}

export const requireAuth: MiddlewareHandler<AppBindings> = async (c, next) => {
  const credential = await extractCredential(c);
  const cookieToken = credential ? null : sessionTokenFromCookie(c);
  if (cookieToken) {
    const user = await userFromSession(c.env.DB, cookieToken);
    if (!user) return fail(c, 401, "Session expired", "Log in again.");
    if (!["GET", "HEAD", "OPTIONS"].includes(c.req.method)) {
      const type = c.req.header("content-type") ?? "";
      const body = type.includes("form") ? ((await c.req.parseBody()) as Record<string, unknown>) : undefined;
      if (!(await hasValidCsrf(c, cookieToken, body))) return fail(c, 403, "Invalid CSRF token");
    }
    c.set("user", user);
    c.set("authMethod", "session");
    c.set("sessionToken", cookieToken);
    return next();
  }
  if (!credential) {
    return fail(c, 401, "Missing parameters", "An API key or session token is required.");
  }

  const sessionUser = await userFromSession(c.env.DB, credential);
  if (sessionUser) {
    c.set("user", sessionUser);
    c.set("authMethod", "session");
    c.set("sessionToken", credential);
    return next();
  }

  const apiKeyUser = await userFromApiKey(c.env.DB, credential);
  if (apiKeyUser) {
    c.set("user", apiKeyUser);
    c.set("authMethod", "api_key");
    return next();
  }

  return fail(c, 401, "Invalid API key", "The API key or session token is not valid.");
};

export async function createSession(env: AppBindings["Bindings"], userId: number, token: string, userAgent: string, options: { viaOidc?: boolean } = {}) {
  const ttlDays = Number(env.SESSION_TTL_DAYS ?? "30") || 30;
  const expiresAt = new Date(Date.now() + ttlDays * 86_400_000).toISOString();
  await env.DB.prepare("INSERT INTO sessions (id, user_id, expires_at, user_agent, via_oidc) VALUES (?, ?, ?, ?, ?)")
    .bind(await sha256Hex(token), userId, expiresAt, userAgent.slice(0, 255), options.viaOidc ? 1 : 0)
    .run();
  return expiresAt;
}
