import type { Context } from "hono";
import type { Env } from "../env";
import { randomToken, sha256Hex } from "../lib/crypto";

/*
  Login throttling and the short-lived steps of a login.

  Throttling (PHP Wallos had none on the password step): failed logins are
  counted per client address and per address + username in D1. Ten failures
  for one username from one address, or thirty from one address, within 15
  minutes block further attempts from there for 15 minutes. Counting per
  address keeps a stranger from locking somebody else out of their account;
  the password hashing (PBKDF2, 100k rounds) makes guessing across many
  addresses slow anyway. When the optional LOGIN_RATE_LIMITER binding
  (Workers Rate Limiting) is configured it is checked too, before D1.
*/

const WINDOW_SECONDS = 15 * 60;
const LOCK_SECONDS = 15 * 60;
const MAX_PER_USER = 10;
const MAX_PER_ADDRESS = 30;

const nowSeconds = () => Math.floor(Date.now() / 1000);

export function clientAddress(c: Context): string {
  return c.req.header("cf-connecting-ip") ?? c.req.header("x-real-ip") ?? "unknown";
}

function keys(address: string, username: string) {
  return { address: `addr:${address}`, user: `user:${address}:${username.trim().toLowerCase().slice(0, 64)}` };
}

/** True when this address (and username) may try to log in now. */
export async function loginAllowed(env: Env, address: string, username: string): Promise<boolean> {
  if (env.LOGIN_RATE_LIMITER) {
    const { success } = await env.LOGIN_RATE_LIMITER.limit({ key: address });
    if (!success) return false;
  }
  const k = keys(address, username);
  const rows = await env.DB.prepare("SELECT key, locked_until FROM login_attempts WHERE key IN (?, ?)").bind(k.address, k.user).all<{ key: string; locked_until: number }>();
  const now = nowSeconds();
  return !rows.results.some((row) => row.locked_until > now);
}

async function countFailure(db: D1Database, key: string, limit: number, now: number) {
  // A new window starts when the old one is over; the lock is set when the window's count reaches the limit.
  await db
    .prepare(
      `INSERT INTO login_attempts (key, failures, window_start, locked_until) VALUES (?1, 1, ?2, 0)
       ON CONFLICT (key) DO UPDATE SET
         failures = CASE WHEN window_start <= ?2 - ?3 THEN 1 ELSE failures + 1 END,
         window_start = CASE WHEN window_start <= ?2 - ?3 THEN ?2 ELSE window_start END,
         locked_until = CASE WHEN window_start > ?2 - ?3 AND failures + 1 >= ?4 THEN ?2 + ?5 ELSE locked_until END`,
    )
    .bind(key, now, WINDOW_SECONDS, limit, LOCK_SECONDS)
    .run();
}

export async function recordLoginFailure(env: Env, address: string, username: string): Promise<void> {
  const k = keys(address, username);
  const now = nowSeconds();
  await countFailure(env.DB, k.user, MAX_PER_USER, now);
  await countFailure(env.DB, k.address, MAX_PER_ADDRESS, now);
}

/**
 * Clears the per-username counter after a successful login. The per-address
 * counter is left to expire, so logging into one's own account does not reset
 * the budget for guessing others'.
 */
export async function recordLoginSuccess(env: Env, address: string, username: string): Promise<void> {
  await env.DB.prepare("DELETE FROM login_attempts WHERE key = ?").bind(keys(address, username).user).run();
}

// --- pending login steps ---------------------------------------------------------------

export type FlowKind = "totp" | "oidc";

/** Stores a login step; returns the token for the cookie. */
export async function startFlow(db: D1Database, kind: FlowKind, userId: number | null, data: Record<string, unknown>, ttlSeconds: number): Promise<string> {
  const token = randomToken(32);
  await db
    .prepare("INSERT INTO auth_flows (id, kind, user_id, data, expires_at) VALUES (?, ?, ?, ?, ?)")
    .bind(await sha256Hex(token), kind, userId, JSON.stringify(data), nowSeconds() + ttlSeconds)
    .run();
  return token;
}

export interface Flow {
  userId: number | null;
  data: Record<string, unknown>;
}

/** Reads a live login step of the given kind. */
export async function readFlow(db: D1Database, kind: FlowKind, token: string | null | undefined): Promise<Flow | null> {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return null;
  const row = await db
    .prepare("SELECT user_id, data FROM auth_flows WHERE id = ? AND kind = ? AND expires_at > ?")
    .bind(await sha256Hex(token), kind, nowSeconds())
    .first<{ user_id: number | null; data: string }>();
  if (!row) return null;
  try {
    return { userId: row.user_id, data: JSON.parse(row.data) as Record<string, unknown> };
  } catch {
    return { userId: row.user_id, data: {} };
  }
}

/** Removes a login step; true when this call removed it (each step can be completed once). */
export async function endFlow(db: D1Database, token: string | null | undefined): Promise<boolean> {
  if (!token || !/^[0-9a-f]{64}$/.test(token)) return false;
  const result = await db.prepare("DELETE FROM auth_flows WHERE id = ?").bind(await sha256Hex(token)).run();
  return result.meta.changes === 1;
}

/** Hourly-safe cleanup of expired steps and stale counters. */
export async function purgeLoginState(db: D1Database): Promise<void> {
  const now = nowSeconds();
  await db.batch([
    db.prepare("DELETE FROM auth_flows WHERE expires_at <= ?").bind(now),
    db.prepare("DELETE FROM login_attempts WHERE locked_until <= ?1 AND window_start <= ?1 - ?2").bind(now, WINDOW_SECONDS),
  ]);
}
