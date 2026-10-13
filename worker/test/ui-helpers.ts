import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import worker from "../src/index";
import { sha256Hex } from "../src/lib/crypto";

/*
  Helpers for tests of the web interface: a browser-like session (cookie +
  CSRF token) and requests that return the HTML or JSON the scripts see.
*/

export interface Browser {
  username: string;
  userId: number;
  token: string;
  csrf: string;
  cookie: string;
}

export type Json = Record<string, any>;

let counter = 0;

/** Registers an account (opening registrations if needed) and signs it in like a browser. */
export async function browserSession(prefix = "ui", extra: Record<string, unknown> = {}): Promise<Browser> {
  await env.DB.prepare("UPDATE admin SET registrations_open = 1, require_email_verification = 0").run();
  const username = `${prefix}${++counter}${Math.random().toString(36).slice(2, 6)}`;
  const reg = await raw("/api/auth/register", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, email: `${username}@example.com`, password: "correct horse", main_currency: "EUR", ...extra }),
  });
  const userId = ((await reg.json()) as Json).user_id as number;
  const login = await raw("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ username, password: "correct horse" }),
  });
  const token = ((await login.json()) as Json).token as string;
  return { username, userId, token, csrf: await sha256Hex(`wallos-csrf:${token}`), cookie: `wallos_session=${token}` };
}

/** A request straight to the Worker. */
export async function raw(path: string, init: RequestInit = {}, environment: object = env): Promise<Response> {
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://wallos.test${path.startsWith("/") ? path : `/${path}`}`, { redirect: "manual", ...init }), environment as typeof env, ctx);
  await waitOnExecutionContext(ctx);
  return response;
}

/** GET a page as the signed-in browser; returns status, location and HTML. */
export async function getPage(browser: Browser | null, path: string, headers: Record<string, string> = {}) {
  const response = await raw(path, { headers: { ...(browser ? { cookie: browser.cookie } : {}), "accept-language": "en-US", ...headers } });
  return { status: response.status, location: response.headers.get("location"), headers: response.headers, html: await response.text() };
}

/**
 * Calls an endpoints/*.php the way the scripts do: JSON body (or FormData) with
 * the X-CSRF-Token header, or a GET with query parameters.
 */
export async function endpoint(browser: Browser, path: string, options: { method?: string; json?: unknown; form?: FormData | Record<string, string>; csrf?: boolean } = {}) {
  const headers: Record<string, string> = { cookie: browser.cookie };
  if (options.csrf !== false) headers["x-csrf-token"] = browser.csrf;
  let body: BodyInit | undefined;
  if (options.json !== undefined) {
    headers["content-type"] = "application/json";
    body = JSON.stringify(options.json);
  } else if (options.form) {
    if (options.form instanceof FormData) body = options.form;
    else {
      headers["content-type"] = "application/x-www-form-urlencoded";
      body = new URLSearchParams(options.form).toString();
    }
  }
  const method = options.method ?? (body === undefined ? "GET" : "POST");
  const response = await raw(path, { method, headers, body });
  const text = await response.text();
  let json: Json | null = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  return { status: response.status, json, text, headers: response.headers };
}
