import { Hono, type Context, type MiddlewareHandler } from "hono";
import { z } from "zod";
import type { AppBindings } from "../env";
import { ADMIN_USER_ID } from "../env";
import { fail, ok, parseId, readBody, validationFailed } from "../lib/http";
import { flag, registerSchema } from "../lib/schemas";
import { emailConfigured } from "../lib/email";
import { registerUser } from "../services/accounts";
import { deleteUnusedLogos, deleteUserAccount } from "../services/files";

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

const ADMIN_COLUMNS = ["registrations_open", "max_users", "require_email_verification", "server_url", "update_notification"] as const;

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
