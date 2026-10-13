import { Hono, type Context, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppBindings } from "../env";
import { ADMIN_USER_ID } from "../env";
import { fail, ok, parseId, readBody, validationFailed } from "../lib/http";
import { flag, registerSchema } from "../lib/schemas";
import { emailConfigured } from "../lib/email";
import { registerUser } from "../services/accounts";
import { createBackup, getBackup, listBackups } from "../services/backup";
import { deleteUnusedLogos, deleteUserAccount } from "../services/files";
import { maskedSettings, oidcConfiguration, OidcSettingsError, saveOidcSettings, setOidcEnabled, type OidcSettings } from "../services/oidc";

/*
  Instance administration. As in PHP Wallos the administrator is user 1.

  Accounts are deleted with a single DELETE: every per-user table cascades
  from user(id), which replaces the 30-odd DELETE statements of
  endpoints/admin/deleteuser.php.
*/

type Ctx = Context<AppBindings>;

export const requireAdmin: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (c.get("user").id !== ADMIN_USER_ID) {
    return fail(c, 403, "Denied. Not admin user", "Only the administrator can do this.");
  }
  return next();
};

const ADMIN_COLUMNS = ["registrations_open", "max_users", "require_email_verification", "server_url", "update_notification", "oidc_oauth_enabled"] as const;

const adminSettingsSchema = z
  .object({
    registrations_open: flag,
    max_users: z.coerce.number().int().min(0).max(1_000_000),
    require_email_verification: flag,
    server_url: z
      .string()
      .trim()
      .max(2048)
      .refine((v) => v === "" || /^https?:\/\/[^\s]+$/i.test(v), "Expected an http(s) URL"),
    update_notification: flag,
    oidc_oauth_enabled: flag,
  })
  .partial();

export async function adminSettingsHandler(c: Ctx) {
  const settings = await c.env.DB.prepare(`SELECT ${ADMIN_COLUMNS.join(", ")} FROM admin WHERE id = 1`).first();
  return ok(c, "admin_settings", { admin_settings: settings, notes: [] });
}

export async function updateAdminSettingsHandler(c: Ctx, body: Record<string, unknown>) {
  const parsed = adminSettingsSchema.safeParse(body);
  if (!parsed.success) return validationFailed(c, parsed.error);
  const entries = Object.entries(parsed.data).filter(([, value]) => value !== undefined);
  if (entries.length === 0) return fail(c, 400, "Missing parameters", `Provide at least one of: ${ADMIN_COLUMNS.join(", ")}.`);
  if (parsed.data.oidc_oauth_enabled !== undefined && c.env.OIDC_ENABLED !== undefined) {
    return fail(c, 409, "Environment override", "OIDC enablement is managed by the OIDC_ENABLED environment variable.", { fields: ["oidc_oauth_enabled"] });
  }
  if (parsed.data.require_email_verification === 1 && !emailConfigured(c.env)) {
    return fail(c, 400, "E-mail not configured", "Set RESEND_API_KEY and EMAIL_FROM before requiring e-mail verification.", {
      fields: ["require_email_verification"],
    });
  }

  await c.env.DB.prepare(`UPDATE admin SET ${entries.map(([key]) => `${key} = ?`).join(", ")} WHERE id = 1`)
    .bind(...entries.map(([, value]) => value))
    .run();
  const settings = await c.env.DB.prepare(`SELECT ${ADMIN_COLUMNS.join(", ")} FROM admin WHERE id = 1`).first();
  return ok(c, "Admin settings saved", { message: "Global admin settings have been updated successfully.", admin_settings: settings });
}

export const adminRoutes = new Hono<AppBindings>();
adminRoutes.use("*", requireAdmin);

adminRoutes.get("/settings", (c) => adminSettingsHandler(c));
adminRoutes.patch("/settings", async (c) => updateAdminSettingsHandler(c, await readBody(c)));

adminRoutes.get("/users", async (c) => {
  const users = await c.env.DB.prepare(
    `SELECT u.id, u.username, u.email, u.firstname, u.lastname, u.created_at,
            (SELECT COUNT(*) FROM subscriptions s WHERE s.user_id = u.id) AS subscriptions
       FROM user u ORDER BY u.id`,
  ).all<Record<string, unknown>>();
  return ok(c, "users", {
    users: users.results.map((u) => ({ ...u, is_admin: u.id === ADMIN_USER_ID })),
    notes: [],
  });
});

/** Creates an account regardless of whether registrations are open, like endpoints/admin/adduser.php. */
adminRoutes.post("/users", async (c) => {
  const parsed = registerSchema.safeParse(await readBody(c));
  if (!parsed.success) return validationFailed(c, parsed.error);

  const taken = await c.env.DB.prepare("SELECT 1 FROM user WHERE username = ? OR email = ?")
    .bind(parsed.data.username, parsed.data.email)
    .first();
  if (taken) return fail(c, 409, "User exists", "A user with that username or e-mail already exists.");

  try {
    const userId = await registerUser(c.env.DB, parsed.data);
    return ok(c, "User added", { user_id: userId }, 201);
  } catch (error) {
    if (String(error).includes("UNIQUE")) return fail(c, 409, "User exists", "A user with that username already exists.");
    throw error;
  }
});

adminRoutes.delete("/users/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return fail(c, 400, "Missing parameter", 'Parameter "id" is required.');
  if (id === ADMIN_USER_ID) return fail(c, 409, "Protected", "The administrator account can't be deleted.");
  if (!(await deleteUserAccount(c.env, id))) return fail(c, 404, "Not found", "No such user.");
  return ok(c, "User deleted", { id });
});

/** Deletes logo files that no subscription or payment method uses (deleteunusedlogos.php). */
adminRoutes.post("/files/cleanup", async (c) => ok(c, "Unused logos deleted", await deleteUnusedLogos(c.env)));

// --- OIDC ------------------------------------------------------------------------------

/** The effective OIDC configuration (client secret masked), as get_oidc_settings.php answers. */
export async function oidcSettingsHandler(c: Ctx) {
  const config = await oidcConfiguration(c.env);
  const stored = await c.env.DB.prepare("SELECT created_at, updated_at FROM oauth_settings WHERE id = 1").first<{ created_at: string; updated_at: string }>();
  return ok(c, "oidc_settings", {
    oidc_settings: { ...maskedSettings(config.settings), created_at: stored?.created_at ?? null, updated_at: stored?.updated_at ?? null },
    oidc_enabled: config.enabled,
    is_configured: config.isConfigured,
    managed_fields: config.managedFields,
    notes: config.notes,
  });
}

const OIDC_FIELDS = ["name", "client_id", "client_secret", "authorization_url", "token_url", "user_info_url", "redirect_url", "logout_url", "user_identifier_field", "scopes", "auth_style", "auto_create_user", "password_login_disabled", "require_email_verified"] as const;

/** set_oidc_settings.php: optional oidc_enabled plus any of the fields. */
export async function updateOidcSettingsHandler(c: Ctx, body: Record<string, unknown>) {
  const enabledValue = body.oidc_enabled ?? body.enabled;
  if (enabledValue !== undefined) {
    const error = await setOidcEnabled(c.env, Number(enabledValue) === 1 || enabledValue === true);
    if (error) return fail(c, 409, "Environment override", error);
  }
  const submitted: Partial<Record<keyof OidcSettings, unknown>> = {};
  for (const field of OIDC_FIELDS) if (body[field] !== undefined) submitted[field] = body[field];
  try {
    await saveOidcSettings(c.env, submitted);
  } catch (error) {
    if (error instanceof OidcSettingsError) return fail(c, 400, "Security Error", error.message);
    throw error;
  }
  return ok(c, "OIDC settings saved", { message: "OIDC configurations have been saved successfully." });
}

/** set_disable_password_login.php */
export async function disablePasswordLoginHandler(c: Ctx, body: Record<string, unknown>) {
  const disable = body.disable === undefined ? undefined : String(body.disable);
  if (disable === undefined) return fail(c, 400, "Missing parameter", 'Parameter "disable" is required.');
  if (disable !== "0" && disable !== "1") return fail(c, 400, "Invalid parameter", 'Parameter "disable" must be "0" or "1".');
  if (c.env.OIDC_DISABLE_PASSWORD_LOGIN !== undefined) {
    return fail(c, 409, "Managed by environment", "Password login is managed by the OIDC_DISABLE_PASSWORD_LOGIN environment variable.");
  }
  try {
    await saveOidcSettings(c.env, { password_login_disabled: Number(disable) });
  } catch (error) {
    if (error instanceof OidcSettingsError) return fail(c, 400, "Security Error", error.message);
    throw error;
  }
  return ok(c, "Updated", { message: `Password login has been ${disable === "1" ? "disabled" : "enabled"}.` });
}

adminRoutes.get("/oidc", (c) => oidcSettingsHandler(c));
adminRoutes.patch("/oidc", async (c) => updateOidcSettingsHandler(c, await readBody(c)));

// --- instance backups (src/services/backup.ts) -------------------------------------------

adminRoutes.get("/backups", async (c) => ok(c, "backups", { backups: await listBackups(c.env) }));

adminRoutes.post("/backups", async (c) => {
  const backup = await createBackup(c.env);
  return ok(c, "Backup created", { backup }, 201);
});

adminRoutes.get("/backups/:name", async (c) => {
  const object = await getBackup(c.env, c.req.param("name"));
  if (!object) return fail(c, 404, "Not found", "No such backup.");
  return new Response(object.body, {
    headers: {
      "content-type": "application/gzip",
      "content-disposition": `attachment; filename="${c.req.param("name")}"`,
      "cache-control": "no-store",
    },
  });
});
