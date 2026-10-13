import { Hono } from "hono";
import { raw } from "hono/html";
import type { AppBindings, Env } from "../../env";
import { ADMIN_USER_ID } from "../../env";
import { emailConfigured } from "../../lib/email";
import { BACKUP_RETENTION, listBackups } from "../../services/backup";
import { LOGO_DIR } from "../../services/files";
import { maskedSettings, oidcConfiguration, type OidcSettings } from "../../services/oidc";
import { loadUi, uiPage, type UiCtx } from "../context";
import { asset, page } from "../layout";

/*
  admin.php: registrations, users, OIDC, e-mail, security, maintenance and
  backup. Only the administrator (user 1) may see it; anyone else is sent to
  the dashboard, as PHP did. The endpoints are in endpoints/admin.ts.

  What the Worker does differently shows here:
  - E-mail goes out through Resend, configured with the RESEND_API_KEY secret
    and the EMAIL_FROM variable, so the SMTP fields only show that state.
  - The OIDC client secret is shown masked; saving the mask keeps it.
  - Requests leave from Cloudflare's network, where the LAN is unreachable, so
    there is no local-webhook allowlist.
  - "Disable login" (password-less access) is not supported.
*/

export const routes = new Hono<AppBindings>();

/** Logo files in R2 that no subscription or payment method refers to (what deleteunusedlogos.php would remove). */
async function countUnusedLogos(env: Env): Promise<number> {
  const used = new Set<string>();
  const rows = await env.DB.batch<{ name: string | null }>([
    env.DB.prepare("SELECT logo AS name FROM subscriptions WHERE logo IS NOT NULL AND logo != ''"),
    env.DB.prepare("SELECT logo_variant AS name FROM subscriptions WHERE logo_variant IS NOT NULL AND logo_variant != ''"),
    env.DB.prepare("SELECT icon AS name FROM payment_methods WHERE icon IS NOT NULL AND icon != ''"),
  ]);
  for (const result of rows) for (const row of result.results) if (row.name) used.add(row.name);

  let unused = 0;
  let cursor: string | undefined;
  do {
    const listing = await env.FILES.list({ prefix: LOGO_DIR, cursor, delimiter: "/" });
    for (const object of listing.objects) if (!used.has(object.key.slice(LOGO_DIR.length))) unused++;
    cursor = listing.truncated ? listing.cursor : undefined;
  } while (cursor);
  return unused;
}

function Note({ icon = "fa-circle-info", children }: { icon?: string; children?: unknown }) {
  return (
    <p>
      <i class={`fa-solid ${icon}`} aria-hidden={icon === "fa-triangle-exclamation" ? "true" : undefined}></i>
      {children}
    </p>
  );
}

const OIDC_FIELDS: [string, string, keyof OidcSettings][] = [
  ["oidcName", "Provider Name", "name"],
  ["oidcClientId", "Client ID", "client_id"],
  ["oidcClientSecret", "Client Secret", "client_secret"],
  ["oidcAuthUrl", "Auth URL", "authorization_url"],
  ["oidcTokenUrl", "Token URL", "token_url"],
  ["oidcUserInfoUrl", "User Info URL", "user_info_url"],
  ["oidcRedirectUrl", "Redirect URL", "redirect_url"],
  ["oidcLogoutUrl", "Logout URL", "logout_url"],
  ["oidcUserIdentifierField", "User Identifier Field", "user_identifier_field"],
  ["oidcScopes", "Scopes", "scopes"],
];

const CRONJOBS: [string, string][] = [
  ["checkforupdates", "Check for Updates"],
  ["sendnotifications", "Send Notifications"],
  ["sendcancellationnotifications", "Send Cancellation Notifications"],
  ["sendresetpasswordemails", "Send Password Reset Emails"],
  ["sendverificationemails", "Send Verification Emails"],
  ["updateexchange", "Update Exchange Rates"],
  ["updatenextpayment", "Update Next Payments"],
  ["storetotalyearlycost", "Store Total Yearly Cost"],
  ["generaterecommendations", "Generate AI Recommendations"],
];

routes.get("/admin.php", uiPage, async (c: UiCtx) => {
  if (c.get("user").id !== ADMIN_USER_ID) return c.redirect(".");
  const ui = await loadUi(c);
  const { t } = ui;
  const db = c.env.DB;

  const [settingsRes, usersRes] = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT registrations_open, max_users, require_email_verification, server_url, update_notification FROM admin WHERE id = 1"),
    db.prepare("SELECT id, username, email FROM user ORDER BY id ASC"),
  ]);
  const settings = (settingsRes?.results[0] ?? {}) as {
    registrations_open?: number;
    max_users?: number;
    require_email_verification?: number;
    server_url?: string | null;
    update_notification?: number;
  };
  const users = (usersRes?.results ?? []) as { id: number; username: string; email: string }[];
  const mailReady = emailConfigured(c.env);
  const fromEmail = c.env.EMAIL_FROM ?? "";
  const logosToDelete = await countUnusedLogos(c.env);
  const backups = await listBackups(c.env);
  const oidc = await oidcConfiguration(c.env);
  const oidcSettings = maskedSettings(oidc.settings);
  // oidc_input_attrs(): a field pinned by a variable is shown but cannot be edited.
  const managed = (field: string) => (oidc.managedFields[field] ? { disabled: true, "data-managed-by": oidc.managedFields[field] } : {});

  const body = (
    <>
      <section class="contain settings">
        <section class="account-section">
          <header>
            <h2>{t("registrations")}</h2>
          </header>
          <div class="admin-form">
            <div class="form-group-inline">
              <input type="checkbox" id="registrations" checked={Boolean(settings.registrations_open)} />
              <label for="registrations">{t("enable_user_registrations")}</label>
            </div>
            <div class="form-group">
              <label for="maxUsers">{t("maximum_number_users")}</label>
              <input type="number" id="maxUsers" autocomplete="off" value={String(settings.max_users ?? 0)} />
            </div>
            <div class="settings-notes">
              <Note>{t("max_users_info")}</Note>
              <Note>{t("registrations_disable_login_info")}</Note>
            </div>
            <div class="form-group-inline">
              <input type="checkbox" id="requireEmail" checked={Boolean(settings.require_email_verification)} disabled={!mailReady} />
              <label for="requireEmail">{t("require_email_verification")}</label>
            </div>
            {!mailReady && (
              <div class="settings-notes">
                <Note>{t("configure_smtp_settings_to_enable")}</Note>
              </div>
            )}
            <div class="form-group">
              <label for="serverUrl">{t("server_url")}</label>
              <input type="text" id="serverUrl" autocomplete="off" value={settings.server_url ?? ""} />
            </div>
            <div class="settings-notes">
              <Note>{t("server_url_info")}</Note>
              <Note>{t("server_url_password_reset")}</Note>
            </div>
            <div class="form-group-inline">
              {/* Password-less access is not supported by the Worker. */}
              <input type="checkbox" id="disableLogin" disabled data-managed-by="worker" />
              <label for="disableLogin">{t("disable_login")}</label>
            </div>
            <div class="settings-notes">
              <Note icon="fa-triangle-exclamation">{t("disable_login_info")}</Note>
              <Note icon="fa-triangle-exclamation">{t("disable_login_info2")}</Note>
              <Note>Disabling the login is not available on this server.</Note>
            </div>
            <div class="buttons">
              <input type="submit" class="thin mobile-grow" value={t("save")} id="saveAccountRegistrations" onclick="saveAccountRegistrationsButton()" />
            </div>
          </div>
        </section>

        <section class="account-section">
          <header>
            <h2>{t("user_management")}</h2>
          </header>
          <div class="user-list">
            {users.map((user) => (
              <div class="form-group-inline" data-userid={user.id}>
                <div class="user-list-row">
                  <div title={t("username")}>
                    <div class="user-list-icon">
                      <i class={`fa-solid ${user.id === ADMIN_USER_ID ? "fa-user-shield" : "fa-user"}`}></i>
                    </div>
                    {user.username}
                  </div>
                  <div title={t("email")}>
                    <div class="user-list-icon">
                      <i class="fa-solid fa-at"></i>
                    </div>
                    <a href={`mailto:${user.email}`}>{user.email}</a>
                  </div>
                </div>
                <div>
                  {user.id !== ADMIN_USER_ID ? (
                    <button class="image-button medium" onclick={`removeUser(${user.id})`} title={t("delete_user")}>
                      <i class="fa-solid fa-trash-can"></i>
                    </button>
                  ) : (
                    <button class="image-button medium disabled" disabled title={t("delete_user")}>
                      <i class="fa-solid fa-trash-can"></i>
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
          <div class="settings-notes">
            <Note>{t("delete_user_info")}</Note>
          </div>
          <h2>{t("create_user")}</h2>
          <div class="form-group">
            <input type="text" id="newUsername" autocomplete="off" placeholder={t("username")} />
          </div>
          <div class="form-group">
            <input type="email" id="newEmail" autocomplete="off" placeholder={t("email")} />
          </div>
          <div class="form-group-inline">
            <input type="password" id="newPassword" autocomplete="off" placeholder={t("password")} />
            <input type="submit" class="thin" value={t("add")} id="addUserButton" onclick="addUserButton()" />
          </div>
        </section>

        <section class="account-section">
          <header>
            <h2>{t("oidc_settings")}</h2>
          </header>
          <div class="admin-form">
            <div class="form-group-inline">
              <input type="checkbox" id="oidcEnabled" checked={oidc.enabled === 1} {...managed("enabled")} onchange="toggleOidcEnabled()" />
              <label for="oidcEnabled">{t("oidc_oauth_enabled")}</label>
            </div>
            {OIDC_FIELDS.map(([id, placeholder, field]) => (
              <div class="form-group">
                <input type="text" id={id} placeholder={placeholder} autocomplete="off" value={String(oidcSettings[field])} {...managed(field)} />
              </div>
            ))}
            <div class="form-group">
              <input type="hidden" id="oidcAuthStyle" placeholder="Auth Style" autocomplete="off" value={oidcSettings.auth_style} />
            </div>
            <div class="form-group-inline">
              <input type="checkbox" id="oidcAutoCreateUser" checked={oidcSettings.auto_create_user === 1} {...managed("auto_create_user")} />
              <label for="oidcAutoCreateUser">{t("create_user_automatically")}</label>
            </div>
            <div class="form-group-inline">
              <input type="checkbox" id="oidcPasswordLoginDisabled" checked={oidcSettings.password_login_disabled === 1} {...managed("password_login_disabled")} />
              <label for="oidcPasswordLoginDisabled">{t("disable_password_login")}</label>
            </div>
            <div class="form-group-inline">
              <input type="checkbox" id="oidcRequireEmailVerified" checked={oidcSettings.require_email_verified === 1} {...managed("require_email_verified")} />
              <label for="oidcRequireEmailVerified">{t("require_email_verified_linking")}</label>
            </div>
            <div class="settings-notes">
              <Note>Redirect URL: the address of this Wallos (e.g. https://wallos.example.com/), registered at the provider as the callback.</Note>
              {Object.keys(oidc.managedFields).length > 0 && <Note>OIDC fields managed by environment variables are shown here but cannot be edited in the UI.</Note>}
              {oidc.notes.map((note) => (
                <Note>{note}</Note>
              ))}
            </div>
            <div class="buttons">
              <input type="submit" class="thin mobile-grow" value={t("save")} id="saveOidcSettingsButton" onclick="saveOidcSettingsButton()" />
            </div>
          </div>
        </section>

        <section class="account-section">
          <header>
            <h2>{t("smtp_settings")}</h2>
          </header>
          <div class="admin-form">
            <div class="form-group-inline">
              <input type="text" name="smtpaddress" id="smtpaddress" autocomplete="off" placeholder={t("smtp_address")} value={mailReady ? "api.resend.com" : ""} disabled data-managed-by="RESEND_API_KEY" />
              <input type="text" name="smtpport" id="smtpport" autocomplete="off" placeholder={t("port")} class="one-third" value={mailReady ? "443" : ""} disabled data-managed-by="RESEND_API_KEY" />
            </div>
            <div class="form-group-inline">
              <div>
                <input type="radio" name="encryption" id="encryptionnone" value="none" disabled data-managed-by="RESEND_API_KEY" />
                <label for="encryptionnone">{t("none")}</label>
              </div>
              <div>
                <input type="radio" name="encryption" id="encryptiontls" value="tls" checked disabled data-managed-by="RESEND_API_KEY" />
                <label for="encryptiontls">{t("tls")}</label>
              </div>
              <div>
                <input type="radio" name="encryption" id="encryptionssl" value="ssl" disabled data-managed-by="RESEND_API_KEY" />
                <label for="encryptionssl">{t("ssl")}</label>
              </div>
            </div>
            <div class="form-group-inline">
              <input type="text" name="smtpusername" id="smtpusername" autocomplete="off" placeholder={t("smtp_username")} value="" disabled data-managed-by="RESEND_API_KEY" />
            </div>
            <div class="form-group-inline">
              {/* The key is a secret: never rendered, only whether it is set. */}
              <input type="password" name="smtppassword" id="smtppassword" autocomplete="off" placeholder={t("smtp_password")} value="" disabled data-managed-by="RESEND_API_KEY" />
            </div>
            <div class="form-group-inline">
              <input type="text" name="fromemail" id="fromemail" autocomplete="off" placeholder={t("from_email")} value={fromEmail} disabled data-managed-by="EMAIL_FROM" />
            </div>
            <div class="buttons">
              <input type="button" class="secondary-button thin mobile-grow" value={t("test")} id="testSmtpSettingsButton" onclick="testSmtpSettingsButton()" disabled={!mailReady} />
              <input type="submit" class="thin mobile-grow" value={t("save")} id="saveSmtpSettingsButton" onclick="saveSmtpSettingsButton()" />
            </div>
            <div class="settings-notes">
              <Note>{t("smtp_info")}</Note>
              <Note>{t("smtp_usage_info")}</Note>
              <Note>
                {mailReady
                  ? "E-mail is sent through Resend, configured with the RESEND_API_KEY secret and the EMAIL_FROM variable."
                  : "E-mail is not configured. Set the RESEND_API_KEY secret and the EMAIL_FROM variable to send e-mail through Resend."}
              </Note>
              <Note>Fields managed by the deployment are shown here but cannot be edited in the UI: RESEND_API_KEY, EMAIL_FROM.</Note>
            </div>
          </div>
        </section>

        <section class="account-section">
          <header>
            <h2>{t("security_settings")}</h2>
          </header>
          <div class="admin-form">
            <div class="form-group-inline">
              <input
                type="text"
                name="local_webhook_notifications_allowlist"
                id="local_webhook_notifications_allowlist"
                autocomplete="off"
                placeholder="e.g., 192.168.1.5:8123, homeassistant.local"
                value=""
                disabled
                data-managed-by="worker"
              />
            </div>
            <div class="settings-notes">
              <Note>{t("ssrf_protection_info")}</Note>
              <Note>{t("local_webhook_info")}</Note>
              <Note>Requests leave from Cloudflare's network, where local and private addresses are not reachable, so there is no allowlist to configure.</Note>
            </div>
            <div class="form-group-inline">
              <input type="checkbox" id="allow_standard_users_local_webhooks" name="allow_standard_users_local_webhooks" disabled />
              <label for="allow_standard_users_local_webhooks">{t("allow_standard_users_local_webhooks")}</label>
            </div>
            <div class="settings-notes">
              <Note icon="fa-triangle-exclamation">{t("allow_standard_users_local_webhooks_info")}</Note>
            </div>
            <div class="buttons">
              <input type="submit" class="thin mobile-grow" value={t("save")} id="saveSecuritySettingsButton" onclick="saveSecuritySettingsButton()" />
            </div>
          </div>
        </section>

        <section class="account-section">
          <header>
            <h2>{t("maintenance_tasks")}</h2>
          </header>
          <div class="maintenance-tasks">
            <h3>{t("update")}</h3>
            <div class="form-group">{t("on_current_version")}</div>
            <div class="form-group-inline">
              <input type="checkbox" id="updateNotification" checked={Boolean(settings.update_notification)} onchange="toggleUpdateNotification()" />
              <label for="updateNotification">{t("show_update_notification")}</label>
            </div>
            <h3>{t("orphaned_logos")}</h3>
            <div class="form-group-inline">
              <input type="button" class="button thin mobile-grow" value={t("delete")} id="deleteUnusedLogos" onclick="deleteUnusedLogos()" disabled={logosToDelete === 0} />
              <span class="number-of-logos bold">{logosToDelete}</span>
              {t("orphaned_logos")}
            </div>
            <h3>{t("cronjobs")}</h3>
            <div>
              <div class="inline-row">
                {CRONJOBS.map(([job, label]) => (
                  <input type="button" value={label} class="button tiny mobile-grow" onclick={`executeCronJob('${job}')`} />
                ))}
              </div>
              <div class="inline-row">
                <textarea id="cronjobResult" class="thin" readonly></textarea>
              </div>
            </div>
          </div>
        </section>

        <section class="account-section">
          <header>
            <h2>{t("backup_and_restore")}</h2>
          </header>
          <div class="form-group-inline">
            <input type="button" class="button thin mobile-grow" value={t("backup")} id="backupDB" onclick="backupDB()" />
            <input type="button" class="secondary-button thin mobile-grow" value={t("restore")} id="restoreDB" onclick="openRestoreDBFileSelect()" />
            <input type="file" name="restoreDBFile" id="restoreDBFile" style="display: none;" onchange="restoreDB()" accept=".zip" />
          </div>
          <div class="settings-notes">
            <Note>{t("restore_info")}</Note>
          </div>
        </section>

        <section class="account-section">
          <header>
            <h2>Instance backups</h2>
          </header>
          <div class="form-group-inline">
            <input type="button" class="button thin mobile-grow" value={t("backup")} id="createInstanceBackup" onclick="createInstanceBackup()" />
          </div>
          {backups.length > 0 && (
            <ul class="instance-backups">
              {backups.map((b) => (
                <li>
                  <a href={`api/admin/backups/${b.name}`} download>
                    {b.name}
                  </a>{" "}
                  ({Math.max(1, Math.round(b.size / 1024))} KB)
                </li>
              ))}
            </ul>
          )}
          <div class="settings-notes">
            <Note>
              The whole database is dumped as SQL into the R2 bucket every Sunday at 04:00 UTC; the last {BACKUP_RETENTION} are kept. Restore onto a freshly migrated
              database with: npx wrangler d1 execute DB --remote --file wallos-DATE.sql (after gunzip). D1 Time Travel also keeps 30 days of history.
            </Note>
            <Note icon="fa-triangle-exclamation">Backups contain password hashes, API keys and provider secrets. Keep downloaded copies safe.</Note>
          </div>
          <script>
            {raw(`function createInstanceBackup() {
  const button = document.getElementById("createInstanceBackup");
  button.disabled = true;
  fetch("api/admin/backups", { method: "POST", headers: { "X-CSRF-Token": window.csrfToken } })
    .then((response) => response.json())
    .then((data) => { if (data.success) { location.reload(); } else { showErrorMessage(data.message || data.title); button.disabled = false; } })
    .catch(() => { showErrorMessage(translate("unknown_error")); button.disabled = false; });
}`)}
          </script>
        </section>
      </section>
      <script src={asset(ui, "scripts/admin.js")}></script>
    </>
  );
  return page(c, ui, "admin", body);
});
