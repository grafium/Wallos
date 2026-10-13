import type { Context } from "hono";
import { deleteCookie, getCookie, setCookie } from "hono/cookie";
import { sha256Hex } from "../lib/crypto";

/*
  Browser sessions for the web interface.

  The login page puts the same session token the API hands out into an
  HttpOnly cookie. Requests that authenticate with that cookie and change
  something must also carry the CSRF token (X-CSRF-Token header or a
  csrf_token field), which the page embeds as window.csrfToken - exactly how
  PHP Wallos' scripts already send it. The CSRF token is derived from the
  session token, so nothing extra is stored.
*/

export const SESSION_COOKIE = "wallos_session";

export function sessionTokenFromCookie(c: Context): string | null {
  const value = getCookie(c, SESSION_COOKIE);
  return value && /^[0-9a-f]{64}$/.test(value) ? value : null;
}

export function csrfToken(sessionToken: string): Promise<string> {
  return sha256Hex(`wallos-csrf:${sessionToken}`);
}

export function setSessionCookie(c: Context, token: string, expiresAt: string, persistent: boolean) {
  setCookie(c, SESSION_COOKIE, token, {
    path: "/",
    httpOnly: true,
    sameSite: "Lax",
    secure: new URL(c.req.url).protocol === "https:",
    // Without "remember me" the cookie ends with the browser session; the server-side session still expires.
    ...(persistent ? { expires: new Date(expiresAt) } : {}),
  });
}

export function clearSessionCookie(c: Context) {
  deleteCookie(c, SESSION_COOKIE, { path: "/" });
}

/** True when the request carries the CSRF token belonging to `sessionToken`. */
export async function hasValidCsrf(c: Context, sessionToken: string, body?: Record<string, unknown>): Promise<boolean> {
  const sent = c.req.header("x-csrf-token") ?? (typeof body?.csrf_token === "string" ? body.csrf_token : "");
  if (!sent) return false;
  const expected = await csrfToken(sessionToken);
  if (sent.length !== expected.length) return false;
  const encoder = new TextEncoder();
  return crypto.subtle.timingSafeEqual(encoder.encode(sent), encoder.encode(expected));
}
