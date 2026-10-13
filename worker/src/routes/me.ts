import { Hono, type Context } from "hono";
import type { AppBindings } from "../env";
import { ADMIN_USER_ID } from "../env";
import { hashPassword, randomToken, sha256Hex, verifyPassword } from "../lib/crypto";
import { fail, ok, readBody, validationFailed } from "../lib/http";
import { budgetSchema, passwordSchema, profileSchema, settingsSchema } from "../lib/schemas";
import { deleteAvatarIfUnused } from "../services/files";
import { getSettings, updateSettings } from "../services/settings";
import { generateTotpSecret, otpauthUrl } from "../lib/totp";
import { disableTotp, enableTotp, remainingBackupCodes, totpEnabled } from "../services/two-factor";
import { WORKER_VERSION } from "../version";
import { z } from "zod";

type Ctx = Context<AppBindings>;

const PROFILE_COLUMNS = `id, username, email, firstname, lastname, main_currency, language, avatar, budget,
  budget_period_type, budget_period_anchor_date, period_budget, totp_enabled, timezone, created_at`;

async function profile(c: Ctx) {
  const user = c.get("user");
  const row = await c.env.DB.prepare(`SELECT ${PROFILE_COLUMNS} FROM user WHERE id = ?`).bind(user.id).first();
  return { ...row, is_admin: user.id === ADMIN_USER_ID };
}

/*
  Handlers shared with the PHP-compatible routes in legacy.ts.
*/

/** api/users/get_user.php: the profile with the secrets masked. */
export async function legacyUserHandler(c: Ctx) {
  const user = await profile(c);
  return ok(c, "user", { user: { ...user, password: "********", api_key: "********" }, notes: [] });
}

export async function settingsHandler(c: Ctx) {
  return ok(c, "settings", { settings: await getSettings(c.env.DB, c.get("user").id), notes: [] });
}

export async function updateSettingsHandler(c: Ctx, body: Record<string, unknown>) {
  const parsed = settingsSchema.safeParse(body);
  if (!parsed.success) return validationFailed(c, parsed.error);
  await updateSettings(c.env.DB, c.get("user").id, parsed.data);
  return ok(c, "Settings updated", {
    message: "User settings have been saved successfully.",
    settings: await getSettings(c.env.DB, c.get("user").id),
  });
}

export async function updateBudgetHandler(c: Ctx, body: Record<string, unknown>) {
  const parsed = budgetSchema.safeParse(body);
  if (!parsed.success) return validationFailed(c, parsed.error);
  const { budget, monthly_budget, ...rest } = parsed.data;
  const changes: Record<string, unknown> = { ...rest };
  if (monthly_budget !== undefined || budget !== undefined) changes.budget = monthly_budget ?? budget;
  const entries = Object.entries(changes).filter(([, value]) => value !== undefined);

  await c.env.DB.prepare(`UPDATE user SET ${entries.map(([key]) => `${key} = ?`).join(", ")} WHERE id = ?`)
    .bind(...entries.map(([, value]) => value), c.get("user").id)
    .run();
  const row = await c.env.DB.prepare(
    "SELECT budget, period_budget, budget_period_type, budget_period_anchor_date FROM user WHERE id = ?",
  )
    .bind(c.get("user").id)
    .first();
  return ok(c, "Updated", { message: "Budget settings updated successfully.", budget: row });
}

export const meRoutes = new Hono<AppBindings>();

meRoutes.get("/", async (c) => {
  return ok(c, "user", { user: await profile(c), settings: await getSettings(c.env.DB, c.get("user").id), notes: [] });
});

meRoutes.patch("/", async (c) => {
  const parsed = profileSchema.safeParse(await readBody(c));
  if (!parsed.success) return validationFailed(c, parsed.error);
  const user = c.get("user");

  if (parsed.data.main_currency !== undefined) {
    const owned = await c.env.DB.prepare("SELECT 1 FROM currencies WHERE id = ? AND user_id = ?")
      .bind(parsed.data.main_currency, user.id)
      .first();
    if (!owned) return fail(c, 400, "Invalid parameter", "main_currency must be one of your currencies.", { fields: ["main_currency"] });
  }

  const entries = Object.entries(parsed.data).filter(([, value]) => value !== undefined);
  const oldAvatar = parsed.data.avatar !== undefined
    ? (await c.env.DB.prepare("SELECT avatar FROM user WHERE id = ?").bind(user.id).first<{ avatar: string | null }>())?.avatar
    : null;
  if (entries.length > 0) {
    await c.env.DB.prepare(`UPDATE user SET ${entries.map(([key]) => `${key} = ?`).join(", ")} WHERE id = ?`)
      .bind(...entries.map(([, value]) => value), user.id)
      .run();
  }
  if (oldAvatar && oldAvatar !== parsed.data.avatar) await deleteAvatarIfUnused(c.env, oldAvatar);
  return ok(c, "Profile updated", { user: await profile(c) });
});

meRoutes.get("/settings", (c) => settingsHandler(c));
meRoutes.patch("/settings", async (c) => updateSettingsHandler(c, await readBody(c)));
meRoutes.patch("/budget", async (c) => updateBudgetHandler(c, await readBody(c)));

/**
 * Changes the password and signs out every other session. Requires a
 * logged-in session and the current password; an API key cannot do this.
 */
meRoutes.post("/password", async (c) => {
  if (c.get("authMethod") !== "session") {
    return fail(c, 403, "Session required", "Change the password from a logged-in session.");
  }
  const parsed = passwordSchema.safeParse(await readBody(c));
  if (!parsed.success) return validationFailed(c, parsed.error);
  const user = c.get("user");

  const row = await c.env.DB.prepare("SELECT password FROM user WHERE id = ?").bind(user.id).first<{ password: string }>();
  const check = await verifyPassword(parsed.data.current_password, row?.password ?? "");
  if (!check.valid) return fail(c, 400, "Invalid credentials", "The current password is incorrect.", { fields: ["current_password"] });

  const currentSession = await sha256Hex(c.get("sessionToken")!);
  await c.env.DB.batch([
    c.env.DB.prepare("UPDATE user SET password = ? WHERE id = ?").bind(await hashPassword(parsed.data.new_password), user.id),
    c.env.DB.prepare("DELETE FROM sessions WHERE user_id = ? AND id != ?").bind(user.id, currentSession),
  ]);
  return ok(c, "Password changed", { message: "Password changed; other sessions were signed out." });
});

/** Issues a new API key. Only a logged-in session may do this, never the API key itself. */
meRoutes.post("/api-key", async (c) => {
  if (c.get("authMethod") !== "session") {
    return fail(c, 403, "Session required", "Rotate the API key from a logged-in session.");
  }
  const apiKey = randomToken(32);
  await c.env.DB.prepare("UPDATE user SET api_key = ? WHERE id = ?").bind(apiKey, c.get("user").id).run();
  return ok(c, "API key rotated", { api_key: apiKey });
});

meRoutes.get("/api-key", async (c) => {
  if (c.get("authMethod") !== "session") {
    return fail(c, 403, "Session required", "The API key can only be read from a logged-in session.");
  }
  const row = await c.env.DB.prepare("SELECT api_key FROM user WHERE id = ?").bind(c.get("user").id).first<{ api_key: string }>();
  return ok(c, "API key", { api_key: row?.api_key ?? null });
});

/** Everything the user owns as one JSON document (no password hash or API key). */
meRoutes.get("/export", async (c) => {
  const userId = c.get("user").id;
  const tables = ["categories", "household", "payment_methods", "currencies", "subscriptions"] as const;
  const results = await c.env.DB.batch(
    tables.map((table) => c.env.DB.prepare(`SELECT * FROM ${table} WHERE user_id = ? ORDER BY id`).bind(userId)),
  );
  const data = Object.fromEntries(tables.map((table, i) => [table, results[i]?.results ?? []]));
  const exportedAt = new Date().toISOString();

  c.header("content-disposition", `attachment; filename="wallos-export-${exportedAt.slice(0, 10)}.json"`);
  return ok(c, "export", {
    format: "wallos-worker-export",
    format_version: 1,
    worker_version: WORKER_VERSION,
    exported_at: exportedAt,
    user: await profile(c),
    settings: await getSettings(c.env.DB, userId),
    ...data,
  });
});

// --- two-factor authentication ----------------------------------------------------------
// Session only: an API key must not be able to switch the second factor on or off.

const sessionOnly = (c: Context<AppBindings>) =>
  c.get("authMethod") !== "session" ? fail(c, 403, "Session required", "Manage two-factor authentication from a logged-in session.") : null;

meRoutes.get("/two-factor", async (c) => {
  const user = c.get("user");
  return ok(c, "two_factor", { enabled: await totpEnabled(c.env.DB, user.id), backup_codes_remaining: await remainingBackupCodes(c.env.DB, user.id) });
});

/** A new secret to put into the authenticator; nothing is stored until /two-factor/enable confirms it. */
meRoutes.post("/two-factor/setup", async (c) => {
  const denied = sessionOnly(c);
  if (denied) return denied;
  if (await totpEnabled(c.env.DB, c.get("user").id)) return fail(c, 409, "Already enabled", "Two-factor authentication is already on.");
  const secret = generateTotpSecret();
  return ok(c, "two_factor_setup", { secret, otpauth_url: otpauthUrl(c.get("user").username, secret) });
});

const enableSchema = z.object({ secret: z.string().trim().min(16).max(128), code: z.coerce.string().trim().min(6).max(32) });
const codeSchema = z.object({ code: z.coerce.string().trim().min(6).max(32) });

meRoutes.post("/two-factor/enable", async (c) => {
  const denied = sessionOnly(c);
  if (denied) return denied;
  const parsed = enableSchema.safeParse(await readBody(c));
  if (!parsed.success) return validationFailed(c, parsed.error);
  const result = await enableTotp(c.env.DB, c.get("user").id, parsed.data.secret, parsed.data.code);
  if (!result.ok) {
    if (result.reason === "already_enabled") return fail(c, 409, "Already enabled", "Two-factor authentication is already on.");
    if (result.reason === "invalid_secret") return fail(c, 400, "Invalid parameter", "secret must be base32.", { fields: ["secret"] });
    return fail(c, 400, "Invalid code", "The code does not match the secret.", { fields: ["code"] });
  }
  return ok(c, "Two-factor authentication enabled", { backup_codes: result.backupCodes });
});

meRoutes.post("/two-factor/disable", async (c) => {
  const denied = sessionOnly(c);
  if (denied) return denied;
  const parsed = codeSchema.safeParse(await readBody(c));
  if (!parsed.success) return validationFailed(c, parsed.error);
  const result = await disableTotp(c.env.DB, c.get("user").id, parsed.data.code);
  if (!result.ok) {
    if (result.reason === "not_enabled") return fail(c, 409, "Not enabled", "Two-factor authentication is not on.");
    return fail(c, 400, "Invalid code", "The code is incorrect.", { fields: ["code"] });
  }
  return ok(c, "Two-factor authentication disabled", {});
});
