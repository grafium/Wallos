import { randomToken, sha256Hex } from "../lib/crypto";
import { isValidTotpSecret, matchTotp, timeStep } from "../lib/totp";

/*
  Two-factor authentication: endpoints/user/enable_totp.php,
  disable_totp.php and the code check of totp.php.

  As in PHP: ten single-use backup codes (20 hex characters); five wrong
  codes in a row lock the second step for 30 seconds, counted per account so
  repeating the password step does not reset it; an accepted code's time step
  is recorded so the same code cannot be used twice. Unlike PHP the backup
  codes are stored as SHA-256 hashes, and every multi-row change runs in one
  D1 batch (a transaction), so totp_enabled and the totp row always agree.
*/

export const MAX_TOTP_ATTEMPTS = 5;
export const TOTP_LOCKOUT_SECONDS = 30;
const BACKUP_CODES = 10;

interface TotpRow {
  totp_secret: string;
  backup_codes: string;
  last_totp_used: number | null;
  failed_attempts: number | null;
  lockout_until: number | null;
}

const nowSeconds = () => Math.floor(Date.now() / 1000);

export const normalizeBackupCode = (code: string) => code.trim().toLowerCase();
export const hashBackupCode = (code: string) => sha256Hex(`wallos-backup:${normalizeBackupCode(code)}`);

function parseHashes(json: string): string[] {
  try {
    const value = JSON.parse(json);
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === "string") : [];
  } catch {
    return [];
  }
}

async function totpRow(db: D1Database, userId: number): Promise<TotpRow | null> {
  return db
    .prepare("SELECT totp_secret, backup_codes, last_totp_used, failed_attempts, lockout_until FROM totp WHERE user_id = ?")
    .bind(userId)
    .first<TotpRow>();
}

export async function totpEnabled(db: D1Database, userId: number): Promise<boolean> {
  const row = await db.prepare("SELECT totp_enabled FROM user WHERE id = ?").bind(userId).first<{ totp_enabled: number | null }>();
  return Number(row?.totp_enabled ?? 0) === 1;
}

/** Strikes a backup code off; true only when this call removed it (compare-and-swap on the list). */
async function consumeBackupCode(db: D1Database, userId: number, row: TotpRow, code: string): Promise<boolean> {
  if (!/^[0-9a-f]{20}$/i.test(code.trim())) return false;
  const hashes = parseHashes(row.backup_codes);
  const hash = await hashBackupCode(code);
  const index = hashes.indexOf(hash);
  if (index < 0) return false;
  const remaining = [...hashes.slice(0, index), ...hashes.slice(index + 1)];
  const result = await db
    .prepare("UPDATE totp SET backup_codes = ? WHERE user_id = ? AND backup_codes = ?")
    .bind(JSON.stringify(remaining), userId, row.backup_codes)
    .run();
  return result.meta.changes === 1;
}

export type EnableResult = { ok: true; backupCodes: string[] } | { ok: false; reason: "already_enabled" | "invalid_secret" | "invalid_code" };

/** Verifies a code for a freshly generated secret and switches 2FA on (enable_totp.php, action "verify"). */
export async function enableTotp(db: D1Database, userId: number, secret: string, code: string): Promise<EnableResult> {
  if (await totpEnabled(db, userId)) return { ok: false, reason: "already_enabled" };
  const normalizedSecret = secret.replace(/\s/g, "").toUpperCase();
  if (!isValidTotpSecret(normalizedSecret)) return { ok: false, reason: "invalid_secret" };
  const step = await matchTotp(normalizedSecret, code);
  if (step === null) return { ok: false, reason: "invalid_code" };

  const backupCodes = Array.from({ length: BACKUP_CODES }, () => randomToken(10));
  const hashes = await Promise.all(backupCodes.map(hashBackupCode));
  await db.batch([
    db.prepare("DELETE FROM totp WHERE user_id = ?").bind(userId),
    // The code just verified counts as used, so it cannot be replayed as the first login code.
    db
      .prepare("INSERT INTO totp (user_id, totp_secret, backup_codes, last_totp_used, failed_attempts, lockout_until) VALUES (?, ?, ?, ?, 0, 0)")
      .bind(userId, normalizedSecret, JSON.stringify(hashes), Math.max(step, timeStep(nowSeconds()))),
    db.prepare("UPDATE user SET totp_enabled = 1 WHERE id = ?").bind(userId),
  ]);
  return { ok: true, backupCodes };
}

export type DisableResult = { ok: true } | { ok: false; reason: "not_enabled" | "invalid_code" };

/** Switches 2FA off after a current code or an unused backup code (disable_totp.php). */
export async function disableTotp(db: D1Database, userId: number, code: string): Promise<DisableResult> {
  const row = await totpRow(db, userId);
  if (!(await totpEnabled(db, userId)) || !row) {
    // Repair a half-enabled account rather than leave it in a state no credential can open.
    await db.batch([db.prepare("UPDATE user SET totp_enabled = 0 WHERE id = ?").bind(userId), db.prepare("DELETE FROM totp WHERE user_id = ?").bind(userId)]);
    return { ok: false, reason: "not_enabled" };
  }
  const valid = (await matchTotp(row.totp_secret, code)) !== null || parseHashes(row.backup_codes).includes(await hashBackupCode(code));
  if (!valid) return { ok: false, reason: "invalid_code" };
  await db.batch([db.prepare("UPDATE user SET totp_enabled = 0 WHERE id = ?").bind(userId), db.prepare("DELETE FROM totp WHERE user_id = ?").bind(userId)]);
  return { ok: true };
}

export type LoginCheck = { ok: true; usedBackupCode: boolean } | { ok: false; locked: boolean };

/** The second login step (totp.php): TOTP code or backup code, with lockout and replay protection. */
export async function verifyTotpLogin(db: D1Database, userId: number, code: string): Promise<LoginCheck> {
  const row = await totpRow(db, userId);
  if (!row) return { ok: false, locked: false };
  const now = nowSeconds();
  if (Number(row.lockout_until ?? 0) > now) return { ok: false, locked: true };

  // Legacy PHP installs stored a unix timestamp here instead of a time step.
  let lastStep = Number(row.last_totp_used ?? 0);
  if (lastStep > timeStep(now)) lastStep = Math.floor(lastStep / 30);

  let ok = false;
  let usedBackupCode = false;
  const step = await matchTotp(row.totp_secret, code, now);
  if (step !== null && step > lastStep) {
    // Only the request that moves the step forward wins; a concurrent replay changes nothing.
    const result = await db
      .prepare("UPDATE totp SET last_totp_used = ?1 WHERE user_id = ?2 AND (last_totp_used IS NULL OR last_totp_used < ?1 OR last_totp_used > ?3)")
      .bind(step, userId, timeStep(now) + 1)
      .run();
    ok = result.meta.changes === 1;
  } else if (step === null) {
    ok = await consumeBackupCode(db, userId, row, code);
    usedBackupCode = ok;
  }

  if (ok) {
    await db.prepare("UPDATE totp SET failed_attempts = 0, lockout_until = 0 WHERE user_id = ?").bind(userId).run();
    return { ok: true, usedBackupCode };
  }

  const failed = await db
    .prepare("UPDATE totp SET failed_attempts = COALESCE(failed_attempts, 0) + 1 WHERE user_id = ? RETURNING failed_attempts")
    .bind(userId)
    .first<{ failed_attempts: number }>();
  if ((failed?.failed_attempts ?? 0) >= MAX_TOTP_ATTEMPTS) {
    // Trip the lockout and start a fresh window once it expires.
    await db.prepare("UPDATE totp SET failed_attempts = 0, lockout_until = ? WHERE user_id = ?").bind(now + TOTP_LOCKOUT_SECONDS, userId).run();
    return { ok: false, locked: true };
  }
  return { ok: false, locked: false };
}

/** How many unused backup codes an account has left. */
export async function remainingBackupCodes(db: D1Database, userId: number): Promise<number> {
  const row = await db.prepare("SELECT backup_codes FROM totp WHERE user_id = ?").bind(userId).first<{ backup_codes: string }>();
  return row ? parseHashes(row.backup_codes).length : 0;
}
