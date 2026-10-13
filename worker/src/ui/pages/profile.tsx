import { Hono } from "hono";
import { raw } from "hono/html";
import type { AppBindings } from "../../env";
import { ADMIN_USER_ID } from "../../env";
import { AVATAR_DIR } from "../../services/files";
import { loadUi, uiPage, type UiCtx } from "../context";
import { LANGUAGES } from "../i18n";
import { asset, page } from "../layout";

/*
  profile.php: user details and avatar, two-factor authentication, the API
  key, export and account deletion. The form is sent by scripts/profile.js to
  endpoints/user/save_user.php (see endpoints/user.ts).

  Avatars: the built-in images/avatars/N.svg, plus uploads. The Worker keeps
  an uploaded avatar only while an account uses it (services/files.ts removes
  it as soon as nothing refers to it), so the gallery of uploads PHP kept in
  uploaded_avatars is just the current upload here.
*/

export const routes = new Hono<AppBindings>();

/** The built-in avatars, as PHP listed images/avatars/. */
export const BUILT_IN_AVATARS = Array.from({ length: 10 }, (_, i) => `images/avatars/${i}.svg`);

routes.get("/profile.php", uiPage, async (c: UiCtx) => {
  const ui = await loadUi(c);
  const { t } = ui;
  const userId = c.get("user").id;
  const db = c.env.DB;

  const [currenciesRes, keyRes, adminRes] = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT id, name, symbol FROM currencies WHERE user_id = ? ORDER BY id").bind(userId),
    db.prepare("SELECT api_key FROM user WHERE id = ?").bind(userId),
    db.prepare("SELECT login_disabled FROM admin WHERE id = 1"),
  ]);
  const currencies = (currenciesRes?.results ?? []) as { id: number; name: string }[];
  const apiKey = (keyRes?.results[0]?.api_key as string | null | undefined) ?? "";
  const loginDisabled = Boolean(adminRes?.results[0]?.login_disabled);
  const totpEnabled = Boolean(ui.user.totp_enabled);
  const showTotpSection = !(loginDisabled && !totpEnabled);
  const uploadedAvatars = ui.user.avatar.startsWith(AVATAR_DIR) ? [ui.user.avatar] : [];
  const fileTypeError = t("file_type_error").replace(/\\/g, "\\\\").replace(/'/g, "\\'");
  const cssText = (value: string) => value.replace(/\\/g, "\\\\").replace(/'/g, "\\'").replace(/</g, "\\3c ");

  const body = (
    <>
      <script src="scripts/libs/sortable.min.js"></script>
      <script src="scripts/libs/qrcode.min.js"></script>
      <style>{raw(`
    .logo-preview:after {
        content: '${cssText(t("upload_logo"))}';
    }
`)}</style>
      <section class="contain settings">
        <section class="account-section">
          <header>
            <h2>{t("user_details")}</h2>
          </header>
          <form action="endpoints/user/saveuser.php" method="post" id="userForm" enctype="multipart/form-data">
            <div class="user-form">
              <div class="fields">
                <div>
                  <div class="user-avatar">
                    <img src={ui.user.avatar} alt="avatar" class="avatar" id="avatarImg" onclick="toggleAvatarSelect()" />
                    <span class="edit-avatar" onclick="toggleAvatarSelect()" title="Change Avatar">
                      <i class="fa-solid fa-pencil"></i>
                    </span>
                  </div>

                  <input type="hidden" name="avatar" value={ui.user.avatar} id="avatarUser" />
                  <div class="avatar-select" id="avatarSelect">
                    <div class="avatar-list">
                      {BUILT_IN_AVATARS.map((src) => {
                        const name = src.slice("images/avatars/".length);
                        return <img src={src} alt={name} class="avatar-option" data-src={src} />;
                      })}

                      {uploadedAvatars.map((path) => {
                        const filename = path.slice(path.lastIndexOf("/") + 1);
                        return (
                          <div class="avatar-container" data-src={filename}>
                            <img src={path} alt={filename} class="avatar-option" data-src={path} />
                            <div class="remove-avatar" onclick={`deleteAvatar(${JSON.stringify(filename)})`} title="Delete avatar">
                              <i class="fa-solid fa-xmark"></i>
                            </div>
                          </div>
                        );
                      })}

                      <label for="profile_pic" class="add-avatar" title={t("upload_avatar")}>
                        <i class="fa-solid fa-arrow-up-from-bracket"></i>
                      </label>
                    </div>

                    <input
                      type="file"
                      id="profile_pic"
                      class="hidden-input"
                      name="profile_pic"
                      accept="image/jpeg, image/png, image/gif, image/webp"
                      onchange={`successfulUpload(this, '${fileTypeError}')`}
                    />
                  </div>
                </div>
                <div class="grow">
                  <div class="form-group">
                    <label for="username">{t("username")}:</label>
                    <input type="text" id="username" name="username" value={ui.user.username} disabled />
                  </div>
                  <div class="form-group">
                    <label for="firstname">{t("firstname")}:</label>
                    <input type="text" id="firstname" name="firstname" autocomplete="given-name" value={ui.user.firstname} />
                  </div>
                  <div class="form-group">
                    <label for="lastname">{t("lastname")}:</label>
                    <input type="text" id="lastname" name="lastname" autocomplete="family-name" value={ui.user.lastname} />
                  </div>
                  <div class="form-group">
                    <label for="email">{t("email")}:</label>
                    <input type="email" id="email" name="email" autocomplete="email" value={ui.user.email} required />
                  </div>
                  <div class="form-group">
                    <label for="password">{t("password")}:</label>
                    <input type="password" id="password" name="password" autocomplete="new-password" />
                  </div>
                  <div class="form-group">
                    <label for="confirm_password">{t("confirm_password")}:</label>
                    <input type="password" id="confirm_password" name="confirm_password" autocomplete="new-password" />
                  </div>
                  <div class="form-group">
                    <label for="currency">{t("main_currency")}:</label>
                    <select id="currency" name="main_currency" placeholder="Currency">
                      {currencies.map((currency) => (
                        <option value={currency.id} selected={currency.id === ui.user.main_currency}>
                          {currency.name}
                        </option>
                      ))}
                    </select>
                  </div>
                  <div class="form-group">
                    <label for="language">{t("language")}:</label>
                    <select id="language" name="language" placeholder="Language">
                      {Object.entries(LANGUAGES).map(([code, language]) => (
                        <option value={code} selected={code === ui.lang}>
                          {language.name}
                        </option>
                      ))}
                    </select>
                  </div>
                </div>
              </div>
              <div class="buttons">
                <input type="submit" value={t("save")} id="userSubmit" class="thin mobile-grow" />
              </div>
            </div>
          </form>
        </section>

        {showTotpSection && (
          <section class="account-section">
            <header>
              <h2>{t("two_factor_authentication")}</h2>
            </header>
            <div class="account-2fa">
              <div class="buttons">
                {!totpEnabled ? (
                  <>
                    <input type="button" value={t("enable_two_factor_authentication")} id="enableTotp" onclick="enableTotp()" class="button thin mobile-grow" />
                    <div class="totp-popup" id="totp-popup">
                      <header>
                        <h3>{t("enable_two_factor_authentication")}</h3>
                        <span class="fa-solid fa-xmark close-form" onclick="closeTotpPopup()"></span>
                      </header>
                      <div class="totp-popup-content">
                        <div class="totp-setup" id="totp-setup">
                          <div class="totp-qrcode-container">
                            <div id="totp-qr-code"></div>
                          </div>
                          <p class="totp-secret" id="totp-secret-code"></p>
                          <div class="form-group-inline">
                            <input type="hidden" name="totp-secret" id="totp-secret" value="" />
                            <input type="text" id="totp" name="totp" autocomplete="one-time-code" placeholder={t("totp_code")} />
                            <input type="button" value={t("enable")} id="enableTotpButton" onclick="submitTotp()" />
                          </div>
                        </div>
                        <div class="totp-setup hide" id="totp-backup-codes">
                          <h4>{t("backup_codes")}</h4>
                          <ul class="totp-backup-codes" id="backup-codes"></ul>
                          <div class="form-group-inline wrap">
                            <input type="button" class="button secondary-button grow" value={t("copy_to_clipboard")} id="copyBackupCodes" onclick="copyBackupCodes()" />
                            <input type="button" class="grow" value={t("download_backup_codes")} id="downloadBackupCodes" onclick="downloadBackupCodes()" />
                          </div>
                          <div class="settings-notes">
                            <p>
                              <i class="fa-solid fa-circle-info"></i>
                              {t("totp_backup_codes_info")}
                            </p>
                          </div>
                        </div>
                      </div>
                    </div>
                  </>
                ) : (
                  <>
                    <input
                      type="button"
                      class="button secondary-button thin mobile-grow"
                      value={t("disable_two_factor_authentication")}
                      id="disableTotp"
                      onclick="disableTotp()"
                    />
                    <div class="totp-popup" id="totp-disable-popup">
                      <header>
                        <h3>{t("disable_two_factor_authentication")}</h3>
                        <span class="fa-solid fa-xmark close-form" onclick="closeTotpDisablePopup()"></span>
                      </header>
                      <div class="totp-popup-content">
                        <div class="form-group-inline">
                          <input type="text" id="totp-disable" name="totp-disable" autocomplete="one-time-code" placeholder="totp" />
                          <input type="button" value={t("disable")} id="disableTotpButton" onclick="submitDisableTotp()" />
                        </div>
                      </div>
                    </div>
                  </>
                )}
              </div>
              <div class="settings-notes">
                <p>
                  <i class="fa-solid fa-circle-info"></i>
                  {totpEnabled ? t("two_factor_enabled_info") : t("two_factor_info")}
                </p>
              </div>
            </div>
          </section>
        )}

        <section class="account-section">
          <header>
            <h2>{t("api_key")}</h2>
          </header>
          <div class="account-api-key">
            <div class="form-group-inline">
              <input type="text" id="apikey" name="apikey" value={apiKey} placeholder="API Key" readonly />
              <input type="submit" value={t("regenerate")} id="regenerateApiKey" onclick="regenerateApiKey()" />
            </div>
            <div class="settings-notes">
              <p>
                <i class="fa-solid fa-circle-info"></i> {t("api_key_info")}
              </p>
            </div>
          </div>
        </section>

        <section class="account-section">
          <header>
            <h2>{t("account")}</h2>
          </header>
          <div class="account-list">
            <div>
              <h3>{t("export_subscriptions")}</h3>
              <div class="form-group-inline wrap">
                <input type="button" value={t("export_as_json")} onclick="exportAsJson()" class="secondary-button thin mobile-grow" id="export-json" />
                <input type="button" value={t("export_as_csv")} onclick="exportAsCsv()" class="secondary-button thin mobile-grow" id="export-csv" />
              </div>
            </div>
          </div>
          <div>
            {userId !== ADMIN_USER_ID && (
              <>
                <h3>{t("danger_zone")}</h3>
                <div class="form-group-inline">
                  <input type="button" value={t("delete_account")} onclick={`deleteAccount(${userId})`} class="warning-button thin mobile-grow" id="delete-account" />
                </div>
                <div class="settings-notes">
                  <p>
                    <i class="fa-solid fa-circle-info"></i>
                    {t("delete_account_info")}
                  </p>
                </div>
              </>
            )}
          </div>
        </section>
      </section>
      <script src={asset(ui, "scripts/profile.js")}></script>
      <script src={asset(ui, "scripts/theme.js")}></script>
      <script src={asset(ui, "scripts/notifications.js")}></script>
    </>
  );
  return page(c, ui, "profile", body);
});
