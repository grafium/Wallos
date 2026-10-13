import { Hono, type Context } from "hono";
import type { Child } from "hono/jsx";
import { raw } from "hono/html";
import { getCookie, setCookie } from "hono/cookie";
import type { AppBindings } from "../../env";
import { ADMIN_USER_ID } from "../../env";
import { createSession, userFromSession } from "../../lib/auth";
import { hashPassword, randomToken, sha256Hex, verifyPassword } from "../../lib/crypto";
import { emailConfigured } from "../../lib/email";
import { registerSchema } from "../../lib/schemas";
import { canRegister, registerUser } from "../../services/accounts";
import { DEFAULT_CURRENCIES } from "../../lib/defaults";
import {
  isUnverified,
  publicBaseUrl,
  requestPasswordReset,
  resetPassword,
  sendVerificationEmail,
  verificationRequired,
  verifyEmail,
} from "../../services/email-flows";
import { WORKER_VERSION } from "../../version";
import { LANGUAGES, resolveLanguage, translator, type Translate } from "../i18n";
import { Icon, js } from "../layout";
import { clearSessionCookie, sessionTokenFromCookie, setSessionCookie } from "../session";

/*
  The pages before a session exists: login.php, registration.php,
  passwordreset.php, verifyemail.php, logout.php. They share the split
  "auth" frame of PHP Wallos (styles/login.css).
*/

type Ctx = Context<AppBindings>;

export const routes = new Hono<AppBindings>();

const YEAR = 365 * 86_400;

/** Language of a visitor without a session: the "language" cookie, else the browser's. */
function visitorLanguage(c: Ctx): string {
  const cookie = getCookie(c, "language");
  if (cookie) return resolveLanguage(cookie);
  const header = (c.req.header("accept-language") ?? "").split(",")[0]?.split(";")[0] ?? "";
  return resolveLanguage(header);
}

function AuthFrame({ c, t, lang, script, title, wide, children }: { c: Ctx; t: Translate; lang: string; script?: string; title: string; wide?: boolean; children?: Child }) {
  const themeCookie = getCookie(c, "theme");
  const theme = themeCookie === "dark" || themeCookie === "automatic" ? themeCookie : "light";
  const updateThemeSettings = !themeCookie;
  const colorCookie = getCookie(c, "colorTheme");
  const colorTheme = ["red", "green", "yellow", "purple"].includes(colorCookie ?? "") ? colorCookie! : "blue";
  const dir = LANGUAGES[lang]?.dir ?? "ltr";
  const v = WORKER_VERSION;
  return (
    <>
      {raw("<!DOCTYPE html>")}
      <html dir={dir}>
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
          <meta name="theme-color" content={theme === "light" ? "#FFFFFF" : "#12151C"} id="theme-color" />
          <meta name="apple-mobile-web-app-title" content="Wallos" />
          <title>Wallos - Subscription Tracker</title>
          <link rel="icon" type="image/png" href="images/icon/favicon.ico" sizes="16x16" />
          <link rel="apple-touch-icon" href="images/icon/apple-touch-icon.png" />
          <link rel="apple-touch-icon" sizes="152x152" href="images/icon/apple-touch-icon-152.png" />
          <link rel="apple-touch-icon" sizes="180x180" href="images/icon/apple-touch-icon-180.png" />
          <link rel="manifest" href="manifest.php" />
          <link rel="stylesheet" href={`styles/theme.css?${v}`} />
          <link rel="stylesheet" href={`styles/login.css?${v}`} />
          {["red", "green", "yellow", "purple"].map((name) => (
            <link rel="stylesheet" href={`styles/themes/${name}.css?${v}`} id={`${name}-theme`} disabled={colorTheme !== name} />
          ))}
          <link rel="stylesheet" href="styles/font-awesome.min.css" />
          <link rel="stylesheet" href="styles/barlow.css" />
          <link rel="stylesheet" href={`styles/login-dark-theme.css?${v}`} id="dark-theme" disabled={theme === "light"} />
          <script type="text/javascript">
            {raw(`window.update_theme_settings = "${updateThemeSettings ? "1" : ""}";
        window.color_theme = ${js(colorTheme)};
        window.colorTheme = ${js(colorTheme)};`)}
          </script>
          {script && <script type="text/javascript" src={`scripts/${script}?${v}`}></script>}
          <script type="text/javascript" src={`scripts/auth-theme.js?${v}`}></script>
          <script type="text/javascript" src={`scripts/password-toggle.js?${v}`}></script>
        </head>
        <body class={dir}>
          <button type="button" class="theme-toggle" id="theme-toggle" title={t("theme")} aria-label={t("theme")}>
            <i class={`fa-solid ${theme === "dark" ? "fa-sun" : "fa-moon"}`}></i>
          </button>
          <div class="content auth-split">
            <aside class="auth-brand" aria-hidden="true">
              <div class="auth-brand-logo">
                <Icon name="logo" />
              </div>
              <div class="auth-brand-text">
                <h1>{t("auth_tagline")}</h1>
                <p>{t("auth_tagline_sub")}</p>
              </div>
              <div class="auth-brand-footer">{raw("Wallos &mdash; Subscription Tracker")}</div>
            </aside>
            <section class={wide ? "container wide" : "container"}>
              <header>
                <div class="logo-image" title="Wallos - Subscription Tracker">
                  <Icon name="logo" />
                </div>
                <p>{title}</p>
              </header>
              {children}
            </section>
          </div>
        </body>
      </html>
    </>
  );
}

const ErrorBox = ({ messages }: { messages: string[] }) =>
  messages.length ? (
    <ul class="error-box">
      {messages.map((m) => (
        <li>
          <i class="fa-solid fa-triangle-exclamation"></i>
          {m}
        </li>
      ))}
    </ul>
  ) : null;

const SuccessBox = ({ messages }: { messages: (string | { plain: string })[] }) =>
  messages.length ? (
    <ul class="success-box">
      {messages.map((m) =>
        typeof m === "string" ? (
          <li>
            <i class="fa-solid fa-check"></i>
            {m}
          </li>
        ) : (
          <li>{m.plain}</li>
        ),
      )}
    </ul>
  ) : null;

async function userCount(c: Ctx): Promise<number> {
  return (await c.env.DB.prepare("SELECT COUNT(*) AS n FROM user").first<{ n: number }>())?.n ?? 0;
}

async function hasSession(c: Ctx): Promise<boolean> {
  const token = sessionTokenFromCookie(c);
  return Boolean(token && (await userFromSession(c.env.DB, token)));
}

function preferenceCookie(c: Ctx, name: string, value: string) {
  setCookie(c, name, value, { path: "/", sameSite: "Lax", maxAge: YEAR });
}

// --- login.php -------------------------------------------------------------------

let dummyHash: Promise<string> | null = null;

async function loginPage(c: Ctx) {
  if ((await userCount(c)) === 0) return c.redirect("registration.php");
  if (await hasSession(c)) return c.redirect(".");

  const lang = visitorLanguage(c);
  const t = translator(lang);
  const errors: string[] = [];

  if (c.req.method === "POST") {
    const body = await c.req.parseBody();
    const username = String(body.username ?? "").trim();
    const password = String(body.password ?? "");
    const user = username
      ? await c.env.DB.prepare(
          "SELECT u.id, u.password, u.language, s.color_theme FROM user u LEFT JOIN settings s ON s.user_id = u.id WHERE u.username = ?",
        )
          .bind(username)
          .first<{ id: number; password: string; language: string | null; color_theme: string | null }>()
      : null;
    dummyHash ??= hashPassword(randomToken(16));
    const check = await verifyPassword(password, user?.password ?? (await dummyHash));

    if (user && check.valid) {
      if (await isUnverified(c.env.DB, user.id)) {
        errors.push(t("user_email_waiting_verification"));
      } else {
        if (check.needsRehash) {
          await c.env.DB.prepare("UPDATE user SET password = ? WHERE id = ?").bind(await hashPassword(password), user.id).run();
        }
        const token = randomToken(32);
        const expiresAt = await createSession(c.env, user.id, token, c.req.header("user-agent") ?? "");
        setSessionCookie(c, token, expiresAt, body.remember !== undefined);
        preferenceCookie(c, "language", resolveLanguage(user.language));
        if (!getCookie(c, "sortOrder")) preferenceCookie(c, "sortOrder", "next_payment");
        preferenceCookie(c, "colorTheme", user.color_theme || "blue");
        return c.redirect(".");
      }
    } else {
      errors.push(t("login_failed"));
    }
  }

  const registration = await canRegister(c.env.DB);
  const success: (string | { plain: string })[] = [];
  if (c.req.query("validated") === "true") success.push(t("email_verified"));
  else if (c.req.query("registered")) {
    success.push(t("registration_successful"));
    if (c.req.query("requireValidation") === "1" || c.req.query("requireValidation") === "true") success.push({ plain: t("user_email_waiting_verification") });
  }

  return c.html(
    <AuthFrame c={c} t={t} lang={lang} script="login.js" title={t("please_login")}>
      <form action="login.php" method="post">
        <div class="form-group">
          <label for="username">{t("username")}:</label>
          <input type="text" id="username" name="username" autocomplete="username" required />
        </div>
        <div class="form-group">
          <label for="password">{t("password")}:</label>
          <input type="password" id="password" name="password" autocomplete="current-password" required />
        </div>
        <div class="form-group-inline">
          <input type="checkbox" id="remember" name="remember" />
          <label for="remember">{t("stay_logged_in")}</label>
        </div>
        <div class="form-group">
          <input type="submit" value={t("login")} />
        </div>
        <div class="form-group"></div>
        <ErrorBox messages={errors} />
        <SuccessBox messages={success} />
        {emailConfigured(c.env) && (
          <div class="login-form-link">
            <a href="passwordreset.php">{t("forgot_password")}</a>
          </div>
        )}
        {registration.allowed && (
          <div class="login-form-link account-switch">
            <span>{t("no_account_yet")}</span>
            <a href="registration.php">{t("register")}</a>
          </div>
        )}
      </form>
    </AuthFrame>,
    errors.length ? 401 : 200,
  );
}

routes.get("/login.php", loginPage);
routes.post("/login.php", loginPage);

// --- registration.php ------------------------------------------------------------------

async function registrationPage(c: Ctx) {
  const count = await userCount(c);
  if (count > 0 && !(await canRegister(c.env.DB)).allowed) return c.redirect("login.php");
  if (count > 0 && (await hasSession(c))) return c.redirect(".");

  const lang = visitorLanguage(c);
  const t = translator(lang);
  const errors: string[] = [];

  if (c.req.method === "POST") {
    const body = await c.req.parseBody();
    const field = (name: string) => String(body[name] ?? "").trim();
    if (String(body.password ?? "") !== String(body.confirm_password ?? "")) errors.push(t("passwords_dont_match"));
    if (await c.env.DB.prepare("SELECT 1 FROM user WHERE email = ?").bind(field("email")).first()) errors.push(t("email_exists"));
    if (await c.env.DB.prepare("SELECT 1 FROM user WHERE username = ?").bind(field("username")).first()) errors.push(t("username_exists"));

    const parsed = registerSchema.safeParse({
      username: field("username"),
      firstname: field("firstname"),
      lastname: field("lastname"),
      email: field("email"),
      password: String(body.password ?? ""),
      main_currency: field("main_currency") || "EUR",
      language: resolveLanguage(field("language")),
    });
    if (errors.length === 0 && !parsed.success) errors.push(t("registration_failed"));

    if (errors.length === 0 && parsed.success) {
      let userId: number;
      try {
        userId = await registerUser(c.env.DB, parsed.data);
      } catch {
        errors.push(t("registration_failed"));
        userId = 0;
      }
      if (userId) {
        let requireValidation = false;
        if (userId !== ADMIN_USER_ID && (await verificationRequired(c.env))) {
          requireValidation = true;
          await sendVerificationEmail(c.env, userId, parsed.data.email, await publicBaseUrl(c.env, c.req.url)).catch((error) =>
            console.error("verification e-mail failed", error),
          );
        }
        preferenceCookie(c, "language", parsed.data.language);
        return c.redirect(`login.php?registered=true&requireValidation=${requireValidation ? "1" : ""}`);
      }
    }
  }

  return c.html(
    <AuthFrame c={c} t={t} lang={lang} script="registration.js" title={t("create_account")} wide>
      <form action="registration.php" method="post" class="registration-form">
        <div class="form-group">
          <label for="username">{t("username")}:</label>
          <input type="text" id="username" name="username" autocomplete="username" required />
        </div>
        <div class="form-group">
          <label for="firstname">{t("firstname")}:</label>
          <input type="text" id="firstname" name="firstname" autocomplete="given-name" />
        </div>
        <div class="form-group">
          <label for="lastname">{t("lastname")}:</label>
          <input type="text" id="lastname" name="lastname" autocomplete="family-name" />
        </div>
        <div class="form-group">
          <label for="email">{t("email")}:</label>
          <input type="email" id="email" name="email" autocomplete="email" required />
        </div>
        <div class="form-group">
          <label for="password">{t("password")}:</label>
          <input type="password" id="password" name="password" autocomplete="new-password" required />
        </div>
        <div class="form-group">
          <label for="confirm_password">{t("confirm_password")}:</label>
          <input type="password" id="confirm_password" name="confirm_password" autocomplete="new-password" required />
        </div>
        <div class="form-group">
          <label for="currency">{t("main_currency")}:</label>
          <select id="currency" name="main_currency" placeholder="Currency">
            {DEFAULT_CURRENCIES.map((currency) => (
              <option value={currency.code}>{currency.name}</option>
            ))}
          </select>
        </div>
        <div class="form-group">
          <label for="language">{t("language")}:</label>
          <select id="language" name="language" placeholder="Language" onchange="changeLanguage(this.value)">
            {Object.entries(LANGUAGES).map(([code, info]) => (
              <option value={code} selected={code === lang}>
                {info.name}
              </option>
            ))}
          </select>
        </div>
        <ErrorBox messages={errors} />
        <div class="form-group">
          <input type="submit" value={t("register")} />
        </div>
      </form>
      {count > 0 && (
        <div class="login-form-link account-switch">
          <span>{t("already_have_account")}</span>
          <a href="login.php">{t("login")}</a>
        </div>
      )}
    </AuthFrame>,
    errors.length ? 400 : 200,
  );
}

routes.get("/registration.php", registrationPage);
routes.post("/registration.php", registrationPage);

// --- logout.php --------------------------------------------------------------------------

routes.get("/logout.php", async (c) => {
  const token = sessionTokenFromCookie(c);
  if (token) await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(await sha256Hex(token)).run();
  clearSessionCookie(c);
  return c.redirect("login.php");
});

// --- passwordreset.php ----------------------------------------------------------------------

async function passwordResetPage(c: Ctx) {
  const lang = visitorLanguage(c);
  const t = translator(lang);
  const body = c.req.method === "POST" ? await c.req.parseBody() : {};
  const token = String(body.token ?? c.req.query("token") ?? "");
  const email = String(body.email ?? c.req.query("email") ?? "").trim();
  const resetMode = token !== "";
  const errors: string[] = [];
  const success: string[] = [];
  let hideForm = false;

  if (c.req.method === "POST") {
    if (!resetMode) {
      if (!emailConfigured(c.env) || !email) {
        errors.push(t("error"));
      } else {
        await requestPasswordReset(c.env, email, await publicBaseUrl(c.env, c.req.url)).catch((error) => console.error("password reset e-mail failed", error));
        success.push(t("reset_sent_check_email"));
        hideForm = true;
      }
    } else if (String(body.password ?? "") !== String(body.confirm_password ?? "")) {
      errors.push(t("passwords_dont_match"));
    } else if (String(body.password ?? "").length < 8 || !/^[0-9a-f]{64}$/.test(token) || !(await resetPassword(c.env.DB, email, token, String(body.password)))) {
      errors.push(t("error"));
    } else {
      success.push(t("password_reset_successful"));
      hideForm = true;
    }
  }

  return c.html(
    <AuthFrame c={c} t={t} lang={lang} title={t("reset_password")}>
      <form action={resetMode ? `passwordreset.php?submit=true&email=${encodeURIComponent(email)}&token=${encodeURIComponent(token)}` : "passwordreset.php?submit=true"} method="post">
        {!resetMode && !hideForm && (
          <>
            <div class="form-group">
              <label for="email">{t("email")}:</label>
              <input type="text" id="email" name="email" autocomplete="email" required />
            </div>
            <div class="form-group">
              <input type="submit" value={t("reset_password")} />
            </div>
          </>
        )}
        {resetMode && !hideForm && (
          <>
            <div class="form-group">
              <input type="hidden" name="token" value={token} />
              <input type="hidden" name="email" value={email} />
              <label for="password">{t("password")}:</label>
              <input type="password" id="password" name="password" autocomplete="new-password" minlength={8} required />
            </div>
            <div class="form-group">
              <label for="confirm_password">{t("confirm_password")}:</label>
              <input type="password" id="confirm_password" name="confirm_password" autocomplete="new-password" minlength={8} required />
            </div>
            <div class="form-group">
              <input type="submit" value={t("reset_password")} />
            </div>
          </>
        )}
        <SuccessBox messages={success} />
        <ErrorBox messages={errors} />
        <div class="login-form-link">
          <a href="login.php">{t("login")}</a>
        </div>
      </form>
    </AuthFrame>,
    errors.length ? 400 : 200,
  );
}

routes.get("/passwordreset.php", passwordResetPage);
routes.post("/passwordreset.php", passwordResetPage);

// Links from e-mails sent before the pages were ported.
routes.get("/reset-password", (c) => c.redirect(`passwordreset.php${new URL(c.req.url).search}`));

// --- verifyemail.php ---------------------------------------------------------------------------

async function verifyEmailPage(c: Ctx) {
  const email = c.req.query("email") ?? "";
  const token = c.req.query("token") ?? "";
  if (/^[0-9a-f]{64}$/.test(token) && email && (await verifyEmail(c.env.DB, email, token))) {
    return c.redirect("login.php?validated=true");
  }
  const lang = visitorLanguage(c);
  const t = translator(lang);
  return c.html(
    <AuthFrame c={c} t={t} lang={lang} title={t("email_verification_failed")}>
      <form>
        <ErrorBox messages={[t("email_verification_failed")]} />
        <div class="login-form-link">
          <a href="login.php">{t("login")}</a>
        </div>
      </form>
    </AuthFrame>,
    400,
  );
}

routes.get("/verifyemail.php", verifyEmailPage);
routes.get("/verify-email", verifyEmailPage);

// Two-factor login returns with phase 6; until then nothing redirects here.
routes.get("/totp.php", (c) => c.redirect("login.php"));
