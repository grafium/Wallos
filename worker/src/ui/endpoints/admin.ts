import { Hono, type MiddlewareHandler } from "hono";
import type { AppBindings } from "../../env";
import { ADMIN_USER_ID } from "../../env";
import { emailConfigured } from "../../lib/email";
import { registerSchema } from "../../lib/schemas";
import { registerUser } from "../../services/accounts";
import { deleteUnusedLogos, deleteUserAccount } from "../../services/files";
import { WORKER_VERSION } from "../../version";
import type { UiCtx } from "../context";
import { userT } from "./user";

/*
  endpoints/admin/*.php and the cron job buttons of the admin page
  (scripts/admin.js). Only the administrator, user 1, may call them; anyone
  else gets PHP's {success: false, message: "Error"}.

  Not part of the Worker, so these only say so: OIDC (enableoidc,
  saveoidcsettings), SMTP (mail goes through Resend, configured with
  RESEND_API_KEY / EMAIL_FROM) and the local-webhook allowlist
  (savesecuritysettings; private addresses are unreachable from Cloudflare).
*/

export const routes = new Hono<AppBindings>();

const requireAdmin: MiddlewareHandler<AppBindings> = async (c, next) => {
  if (c.get("user").id !== ADMIN_USER_ID) return c.json({ success: false, message: userT(c)("error") });
  return next();
};
routes.use("/endpoints/admin/*", requireAdmin);

async function jsonBody(c: UiCtx): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

/** PHP's loose "== 1". */
const isOne = (value: unknown) => value === true || Number(value) === 1;
const text = (value: unknown) => (typeof value === "string" ? value.trim() : typeof value === "number" ? String(value) : "");

// --- adduser.php ----------------------------------------------------------------------------

routes.post("/endpoints/admin/adduser.php", async (c) => {
  const t = userT(c);
  const data = await jsonBody(c);
  const username = text(data.username);
  const email = text(data.email);
  const password = typeof data.password === "string" ? data.password : "";
  if (!username || !password || !email) return c.json({ success: false, message: t("error") });

  const taken = await c.env.DB.prepare("SELECT 1 FROM user WHERE username = ? OR email = ?").bind(username, email).first();
  if (taken) return c.json({ success: false, message: t("error") });

  // The new account starts with the administrator's main currency and language, as in PHP.
  const admin = await c.env.DB.prepare(
    "SELECT u.language, c.code FROM user u LEFT JOIN currencies c ON c.id = u.main_currency AND c.user_id = u.id WHERE u.id = ?",
  )
    .bind(c.get("user").id)
    .first<{ language: string | null; code: string | null }>();
  const parsed = registerSchema.safeParse({ username, email, password, main_currency: admin?.code ?? "EUR", language: admin?.language ?? "en" });
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    return c.json({ success: false, message: issue ? `${issue.path.join(".")}: ${issue.message}` : t("error") });
  }
  try {
    await registerUser(c.env.DB, parsed.data);
  } catch (error) {
    if (String(error).includes("UNIQUE")) return c.json({ success: false, message: t("error") });
    throw error;
  }
  return c.json({ success: true, message: t("success") });
});

// --- deleteuser.php -------------------------------------------------------------------------

routes.post("/endpoints/admin/deleteuser.php", async (c) => {
  const t = userT(c);
  const id = Number((await jsonBody(c)).userId);
  if (!Number.isInteger(id) || id <= 0 || id === ADMIN_USER_ID) return c.json({ success: false, message: t("error") });

  await deleteUserAccount(c.env, id);
  return c.json({ success: true, message: t("success") });
});

// --- deleteunusedlogos.php ------------------------------------------------------------------

routes.post("/endpoints/admin/deleteunusedlogos.php", async (c) => {
  const result = await deleteUnusedLogos(c.env);
  return c.json({ success: true, message: userT(c)("success"), count: result.deleted.length });
});

// --- saveopenregistrations.php ----------------------------------------------------------------

routes.post("/endpoints/admin/saveopenregistrations.php", async (c) => {
  const t = userT(c);
  const data = await jsonBody(c);
  const openRegistrations = isOne(data.open_registrations) ? 1 : 0;
  const requireEmailVerification = isOne(data.require_email_validation) ? 1 : 0;
  const serverUrl = text(data.server_url);
  const maxUsers = Number(data.max_users ?? 0);

  if (isOne(data.disable_login)) {
    // PHP refused it with open registrations or more than one user; the Worker has no password-less access at all.
    return c.json({ success: false, message: "Disabling the login is not available on this server." });
  }
  if (requireEmailVerification === 1 && serverUrl === "") return c.json({ success: false, message: t("fill_all_fields") });
  if (requireEmailVerification === 1 && !emailConfigured(c.env)) {
    return c.json({ success: false, message: "Set the RESEND_API_KEY secret and the EMAIL_FROM variable before requiring e-mail verification." });
  }
  if (!Number.isInteger(maxUsers) || maxUsers < 0 || maxUsers > 1_000_000) return c.json({ success: false, message: t("error") });
  if (serverUrl !== "" && !/^https?:\/\/[^\s]+$/i.test(serverUrl)) return c.json({ success: false, message: t("error") });

  await c.env.DB.prepare(
    "UPDATE admin SET registrations_open = ?, max_users = ?, require_email_verification = ?, server_url = ?, login_disabled = 0 WHERE id = 1",
  )
    .bind(openRegistrations, maxUsers, requireEmailVerification, serverUrl.slice(0, 2048))
    .run();
  return c.json({ success: true, message: t("success") });
});

// --- updatenotification.php -------------------------------------------------------------------

routes.post("/endpoints/admin/updatenotification.php", async (c) => {
  const data = await jsonBody(c);
  await c.env.DB.prepare("UPDATE admin SET update_notification = ?").bind(isOne(data.notificationEnabled) ? 1 : 0).run();
  return c.json({ success: true, message: userT(c)("success") });
});

// --- not available on the Worker --------------------------------------------------------------

routes.post("/endpoints/admin/savesmtpsettings.php", (c) =>
  emailConfigured(c.env)
    ? c.json({ success: true, message: "E-mail is sent through Resend, configured with the RESEND_API_KEY secret and the EMAIL_FROM variable; there is nothing to save here." })
    : c.json({ success: false, message: "E-mail is sent through Resend: set the RESEND_API_KEY secret and the EMAIL_FROM variable to configure it." }),
);

routes.post("/endpoints/admin/savesecuritysettings.php", (c) =>
  c.json({ success: false, message: "Requests leave from Cloudflare's network, where local and private addresses are not reachable, so there is no allowlist to configure." }),
);

export const OIDC_UNAVAILABLE = "OIDC login is not available on this server yet.";
routes.post("/endpoints/admin/enableoidc.php", (c) => c.json({ success: false, message: OIDC_UNAVAILABLE }));
routes.post("/endpoints/admin/saveoidcsettings.php", (c) => c.json({ success: false, message: OIDC_UNAVAILABLE }));

// --- endpoints/cronjobs/*.php (the admin page's buttons) -------------------------------------

/**
 * checkforupdates.php: the Worker is updated by deploying it, so there is no
 * release to look up; it answers in PHP's words. The other jobs run on the
 * hourly Cron Trigger (src/cron/).
 */
routes.get("/endpoints/cronjobs/:file{[a-z]+\\.php}", (c) => {
  if (c.get("user").id !== ADMIN_USER_ID) return c.text("Unauthorized");
  const job = c.req.param("file").slice(0, -".php".length);
  if (job === "checkforupdates") return c.text(`No new version available, currently on v${WORKER_VERSION}`);
  return c.text(`${job}: this job runs automatically on the Worker's hourly Cron Trigger.`);
});
