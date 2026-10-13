import type { Env } from "../env";
import { hashPassword, randomToken, sha256Hex } from "../lib/crypto";
import { emailConfigured, escapeHtml, sendEmail } from "../lib/email";

/*
  E-mail verification and password reset, ported from verifyemail.php,
  passwordreset.php and the two cron jobs that mailed their links every two
  minutes. Here the e-mail goes out at once, so no polling job is needed.

  Tokens are 32 random bytes; only their SHA-256 is stored. A reset link is
  valid for an hour (as in PHP), a verification link for seven days - after
  that a new one can be requested.
*/

export const RESET_TTL_MINUTES = 60;
export const VERIFY_TTL_DAYS = 7;
/** A new reset e-mail for the same account at most this often. */
const RESET_THROTTLE_MINUTES = 5;

/** Base URL for links: the admin's server_url, else APP_URL, else the request's origin. */
export async function publicBaseUrl(env: Env, requestUrl?: string): Promise<string> {
  const admin = await env.DB.prepare("SELECT server_url FROM admin WHERE id = 1").first<{ server_url: string | null }>();
  const base = admin?.server_url || env.APP_URL || (requestUrl ? new URL(requestUrl).origin : "");
  return base.replace(/\/+$/, "");
}

function sqliteTime(date: Date): string {
  return date.toISOString().replace("T", " ").slice(0, 19);
}

function linkEmail(title: string, intro: string, link: string, label: string, outro: string) {
  const text = `${intro}\n\n${link}\n\n${outro}\n`;
  const html = `<p>${escapeHtml(intro)}</p><p><a href="${escapeHtml(link)}">${escapeHtml(label)}</a></p><p style="color:#666">${escapeHtml(outro)}</p>`;
  return { subject: title, text, html };
}

// --- verification -------------------------------------------------------------

/**
 * Whether new accounts must verify their address. Verification without a way
 * to send the e-mail would lock every new user out, so it needs e-mail set up.
 */
export async function verificationRequired(env: Env): Promise<boolean> {
  if (!emailConfigured(env)) return false;
  const admin = await env.DB.prepare("SELECT require_email_verification FROM admin WHERE id = 1").first<{ require_email_verification: number }>();
  return Boolean(admin?.require_email_verification);
}

export async function sendVerificationEmail(env: Env, userId: number, email: string, baseUrl: string): Promise<void> {
  const token = randomToken(32);
  await env.DB.prepare("INSERT OR REPLACE INTO email_verification (user_id, email, token_hash, created_at) VALUES (?, ?, ?, ?)")
    .bind(userId, email, await sha256Hex(token), sqliteTime(new Date()))
    .run();
  const link = `${baseUrl}/verifyemail.php?email=${encodeURIComponent(email)}&token=${token}`;
  await sendEmail(env, {
    to: email,
    ...linkEmail(
      "Wallos: confirm your e-mail address",
      "Welcome to Wallos! Please confirm your e-mail address to activate your account:",
      link,
      "Confirm e-mail address",
      `The link is valid for ${VERIFY_TTL_DAYS} days.`,
    ),
  });
}

export async function isUnverified(db: D1Database, userId: number): Promise<boolean> {
  return Boolean(await db.prepare("SELECT 1 FROM email_verification WHERE user_id = ?").bind(userId).first());
}

export async function verifyEmail(db: D1Database, email: string, token: string): Promise<boolean> {
  const cutoff = sqliteTime(new Date(Date.now() - VERIFY_TTL_DAYS * 86_400_000));
  const result = await db
    .prepare("DELETE FROM email_verification WHERE email = ? AND token_hash = ? AND created_at > ?")
    .bind(email, await sha256Hex(token), cutoff)
    .run();
  return result.meta.changes > 0;
}

// --- password reset -------------------------------------------------------------

/**
 * Sends a reset link to every account with this address. Unknown addresses are
 * not revealed: the caller answers the same either way.
 */
export async function requestPasswordReset(env: Env, email: string, baseUrl: string): Promise<number> {
  const users = await env.DB.prepare("SELECT id, username, email FROM user WHERE email = ? COLLATE NOCASE").bind(email).all<{
    id: number;
    username: string;
    email: string;
  }>();
  const throttle = sqliteTime(new Date(Date.now() - RESET_THROTTLE_MINUTES * 60_000));
  let sent = 0;

  for (const user of users.results) {
    const recent = await env.DB.prepare("SELECT 1 FROM password_resets WHERE user_id = ? AND created_at > ?").bind(user.id, throttle).first();
    if (recent) continue;

    const token = randomToken(32);
    await env.DB.prepare("INSERT OR REPLACE INTO password_resets (user_id, email, token_hash, created_at) VALUES (?, ?, ?, ?)")
      .bind(user.id, user.email, await sha256Hex(token), sqliteTime(new Date()))
      .run();
    const link = `${baseUrl}/passwordreset.php?email=${encodeURIComponent(user.email)}&token=${token}`;
    await sendEmail(env, {
      to: user.email,
      ...linkEmail(
        "Wallos: reset your password",
        `Someone asked to reset the password of the Wallos account "${user.username}". If it was you, choose a new password here:`,
        link,
        "Reset password",
        `The link is valid for ${RESET_TTL_MINUTES} minutes. If you did not ask for this, ignore this e-mail.`,
      ),
    });
    sent++;
  }
  return sent;
}

/** Sets the new password, spends the token and signs the account out everywhere. */
export async function resetPassword(db: D1Database, email: string, token: string, newPassword: string): Promise<boolean> {
  const cutoff = sqliteTime(new Date(Date.now() - RESET_TTL_MINUTES * 60_000));
  const row = await db
    .prepare("SELECT user_id FROM password_resets WHERE email = ? COLLATE NOCASE AND token_hash = ? AND created_at > ?")
    .bind(email, await sha256Hex(token), cutoff)
    .first<{ user_id: number }>();
  if (!row) return false;

  await db.batch([
    db.prepare("UPDATE user SET password = ? WHERE id = ?").bind(await hashPassword(newPassword), row.user_id),
    db.prepare("DELETE FROM password_resets WHERE user_id = ?").bind(row.user_id),
    db.prepare("DELETE FROM sessions WHERE user_id = ?").bind(row.user_id),
    // Proving control of the address also verifies it.
    db.prepare("DELETE FROM email_verification WHERE user_id = ?").bind(row.user_id),
  ]);
  return true;
}

export async function purgeExpiredResets(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM password_resets WHERE created_at <= ?").bind(sqliteTime(new Date(Date.now() - RESET_TTL_MINUTES * 60_000))).run();
}
