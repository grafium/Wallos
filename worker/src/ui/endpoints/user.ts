import { Hono } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { z } from "zod";
import type { AppBindings } from "../../env";
import { hashPassword, randomToken, sha256Hex } from "../../lib/crypto";
import { isValidDate, todayUtc } from "../../lib/dates";
import { sniffImageType } from "../../lib/image";
import { LANGUAGES as PROFILE_LANGUAGES } from "../../lib/schemas";
import { BUDGET_PERIOD_TYPES } from "../../services/budget";
import { refreshUserRates } from "../../services/exchange-rates";
import { AVATAR_DIR, deleteAvatarIfUnused, MAX_UPLOAD_BYTES, processImage, storeAvatar, UploadError } from "../../services/files";
import { generateTotpSecret, otpauthUrl } from "../../lib/totp";
import { disableTotp, enableTotp, totpEnabled } from "../../services/two-factor";
import type { UiCtx } from "../context";
import { resolveLanguage, translator, type Translate } from "../i18n";

/*
  endpoints/user/*.php, called by scripts/profile.js and scripts/settings.js.
  Answers have PHP's shape: HTTP 200 with {success, message, ...}.
*/

export const routes = new Hono<AppBindings>();

/** The signed-in user's translations (PHP endpoints translated into the user's language). */
export function userT(c: UiCtx): Translate {
  return translator(resolveLanguage(c.get("user").language));
}

async function jsonBody(c: UiCtx): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** PHP's (float) cast, floored at 0 like max(0, ...). */
function amount(value: unknown): number {
  const number = typeof value === "number" ? value : parseFloat(String(value ?? ""));
  return Number.isFinite(number) ? Math.max(0, number) : 0;
}

const isSet = (value: unknown) => value !== undefined && value !== null;
const field = (body: Record<string, unknown>, name: string) => (typeof body[name] === "string" ? (body[name] as string) : undefined);

const BUILT_IN_AVATAR = /^images\/avatars\/\d+\.svg$/;
const emailSchema = z.email().max(255);
const LANGUAGE_CODES = new Set<string>(PROFILE_LANGUAGES);

// --- save_user.php ------------------------------------------------------------------

async function saveUser(c: UiCtx) {
  const t = userT(c);
  const user = c.get("user");
  const db = c.env.DB;
  const fail = (message: string) => c.json({ success: false, message });

  const body = (await c.req.parseBody()) as Record<string, unknown>;
  const firstname = field(body, "firstname");
  const lastname = field(body, "lastname");
  const email = field(body, "email")?.trim();
  const avatarField = field(body, "avatar")?.trim();
  const mainCurrency = field(body, "main_currency");
  const language = field(body, "language");
  if (firstname === undefined || lastname === undefined || !email || !avatarField || !mainCurrency || !language) {
    return fail(t("fill_all_fields"));
  }
  if (firstname.trim().length > 100 || lastname.trim().length > 100 || !emailSchema.safeParse(email).success || !LANGUAGE_CODES.has(language)) {
    return fail(t("error_updating_user_data"));
  }

  const current = await db
    .prepare("SELECT email, avatar, main_currency FROM user WHERE id = ?")
    .bind(user.id)
    .first<{ email: string; avatar: string | null; main_currency: number | null }>();
  if (!current) return fail(t("error_updating_user_data"));

  if (current.email !== email) {
    const other = await db.prepare("SELECT 1 FROM user WHERE email = ? AND id != ?").bind(email, user.id).first();
    if (other) return fail(t("email_exists"));
  }

  const currencyId = Number(mainCurrency);
  const owned = Number.isInteger(currencyId) ? await db.prepare("SELECT 1 FROM currencies WHERE id = ? AND user_id = ?").bind(currencyId, user.id).first() : null;
  if (!owned) return fail(t("error_updating_user_data"));

  // A built-in avatar, or the upload the account already has; never another account's file.
  let avatar = avatarField;
  if (!BUILT_IN_AVATAR.test(avatar) && avatar !== current.avatar) return fail(t("error_updating_user_data"));

  const password = field(body, "password") ?? "";
  if (password !== "") {
    const confirm = field(body, "confirm_password");
    if (confirm === undefined || password !== confirm) return fail(t("passwords_dont_match"));
    // The Worker's minimum everywhere else (registration, POST /api/me/password).
    if (password.length < 8 || password.length > 256) return fail("The password must be between 8 and 256 characters long.");
  }

  const upload = body.profile_pic;
  if (upload instanceof File && upload.name !== "" && upload.size > 0) {
    if (upload.size > MAX_UPLOAD_BYTES) return fail(`Images may be at most ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
    const bytes = new Uint8Array(await upload.arrayBuffer());
    if (!sniffImageType(bytes)) return fail(t("fill_all_fields"));
    try {
      avatar = await storeAvatar(c.env, await processImage(c.env, bytes, "avatar"), user.username);
    } catch (error) {
      if (error instanceof UploadError) return fail(error.message);
      throw error;
    }
  }

  const statements = [
    db
      .prepare("UPDATE user SET avatar = ?, firstname = ?, lastname = ?, email = ?, main_currency = ?, language = ? WHERE id = ?")
      .bind(avatar, firstname.trim(), lastname.trim(), email, currencyId, language, user.id),
  ];
  if (password !== "") {
    // A new password signs out every other session, as POST /api/me/password does.
    statements.push(db.prepare("UPDATE user SET password = ? WHERE id = ?").bind(await hashPassword(password), user.id));
    statements.push(db.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").bind(user.id, await sha256Hex(c.get("sessionToken")!)));
  }
  await db.batch(statements);

  if (current.avatar && current.avatar !== avatar) await deleteAvatarIfUnused(c.env, current.avatar);
  // Rates are relative to the main currency, so a new one needs fresh rates.
  if (currencyId !== current.main_currency) await refreshUserRates(db, user.id, { force: true });

  const oldLanguage = getCookie(c, "language") ?? "en";
  setCookie(c, "language", language, { path: "/", maxAge: 30 * 24 * 60 * 60, sameSite: "Lax" });

  return c.json({ success: true, message: t("user_details_saved"), reload: oldLanguage !== language });
}

routes.post("/endpoints/user/save_user.php", saveUser);
// The form's own action in profile.php (scripts/profile.js posts to save_user.php instead).
routes.post("/endpoints/user/saveuser.php", saveUser);

// --- delete_avatar.php ----------------------------------------------------------------

routes.post("/endpoints/user/delete_avatar.php", async (c) => {
  const t = userT(c);
  const input = await jsonBody(c);
  if (!isSet(input.avatar)) return c.json({ success: false, message: t("error") });

  // Uploaded avatars live only as long as an account uses them, so the only
  // upload this account owns is its current avatar, which is in use.
  const path = AVATAR_DIR + String(input.avatar);
  const current = await c.env.DB.prepare("SELECT avatar FROM user WHERE id = ?").bind(c.get("user").id).first<{ avatar: string | null }>();
  if (current?.avatar !== path) {
    return c.json({ success: false, message: "Security Error: You do not have permission to delete this file." });
  }
  return c.json({ success: false, message: "Avatar in use" });
});

// --- budget.php ------------------------------------------------------------------------

routes.post("/endpoints/user/budget.php", async (c) => {
  const t = userT(c);
  const data = await jsonBody(c);
  const sets: string[] = [];
  const values: unknown[] = [];

  if (isSet(data.budget) && !isSet(data.monthly_budget)) {
    sets.push("budget = ?");
    values.push(amount(data.budget));
  }
  if (isSet(data.monthly_budget)) {
    sets.push("budget = ?");
    values.push(amount(data.monthly_budget));
  }
  if (isSet(data.period_budget)) {
    const type = String(data.budget_period_type ?? "monthly");
    const anchor = String(data.budget_period_anchor_date ?? "");
    sets.push("period_budget = ?", "budget_period_type = ?", "budget_period_anchor_date = ?");
    values.push(
      amount(data.period_budget),
      (BUDGET_PERIOD_TYPES as readonly string[]).includes(type) ? type : "monthly",
      isValidDate(anchor) ? anchor : todayUtc(),
    );
  }
  if (sets.length === 0) return c.json({ success: false, message: t("error_updating_user_data") });

  await c.env.DB.prepare(`UPDATE user SET ${sets.join(", ")} WHERE id = ?`)
    .bind(...values, c.get("user").id)
    .run();
  return c.json({ success: true, message: t("user_details_saved") });
});

// --- regenerateapikey.php --------------------------------------------------------------

routes.post("/endpoints/user/regenerateapikey.php", async (c) => {
  const t = userT(c);
  const apiKey = randomToken(32);
  await c.env.DB.prepare("UPDATE user SET api_key = ? WHERE id = ?").bind(apiKey, c.get("user").id).run();
  return c.json({ success: true, message: t("user_details_saved"), apiKey });
});

// --- enable_totp.php / disable_totp.php ------------------------------------------------

routes.post("/endpoints/user/enable_totp.php", async (c) => {
  const t = userT(c);
  const data = await jsonBody(c);
  if (data.action === "generate") {
    // The secret stays in the browser until a code proves the authenticator has it, as in PHP.
    const secret = generateTotpSecret();
    return c.json({ success: true, secret, qrCodeUrl: otpauthUrl(c.get("user").username, secret) });
  }
  if (data.action === "verify") {
    const secret = typeof data.totpSecret === "string" ? data.totpSecret : "";
    const code = typeof data.totpCode === "string" || typeof data.totpCode === "number" ? String(data.totpCode) : "";
    if (!secret || !code) return c.json({ success: false, message: t("totp_code_incorrect") });
    const result = await enableTotp(c.env.DB, c.get("user").id, secret, code);
    if (result.ok) return c.json({ success: true, backupCodes: result.backupCodes, message: t("success") });
    return c.json({ success: false, message: result.reason === "already_enabled" ? t("2fa_already_enabled") : t("totp_code_incorrect") });
  }
  return c.json({ success: false, message: t("error") });
});

routes.post("/endpoints/user/disable_totp.php", async (c) => {
  const t = userT(c);
  const data = await jsonBody(c);
  const code = typeof data.totpCode === "string" || typeof data.totpCode === "number" ? String(data.totpCode).trim() : "";
  if (!(await totpEnabled(c.env.DB, c.get("user").id))) return c.json({ success: false, message: "2FA is not enabled for this user", reload: true });
  if (!code) return c.json({ success: false, message: t("fields_missing"), reload: false });
  const result = await disableTotp(c.env.DB, c.get("user").id, code);
  if (result.ok) return c.json({ success: true, message: t("success"), reload: true });
  if (result.reason === "not_enabled") return c.json({ success: false, message: "2FA is not enabled for this user", reload: true });
  return c.json({ success: false, message: t("totp_code_incorrect"), reload: false });
});
