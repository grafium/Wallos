import type { Context } from "hono";
import type { Child } from "hono/jsx";
import { raw } from "hono/html";
import type { Ui } from "./context";
import { hexToRgb } from "./format";
import { ICONS, type IconName } from "./icons";

/*
  The page frame of PHP Wallos: includes/header.php and includes/footer.php.
  Markup, ids and classes are kept as they were, so styles/*.css and
  scripts/*.js work unchanged.
*/

export type PageName = "index" | "subscriptions" | "calendar" | "stats" | "settings" | "profile" | "admin" | "about" | "other";

/** An SVG icon from images/siteicons/svg/, inlined like the PHP includes. */
export const Icon = ({ name }: { name: IconName }) => raw(ICONS[name]);

/** A value for an inline <script>: JSON with "<" escaped so it cannot close the tag. */
export const js = (value: unknown) =>
  raw(
    JSON.stringify(value)
      .replace(/</g, "\\u003c")
      .replaceAll(String.fromCharCode(0x2028), "\\u2028")
      .replaceAll(String.fromCharCode(0x2029), "\\u2029"),
  );

/** A versioned asset URL, like PHP's "?<?= $version ?>". */
export const asset = (ui: Ui, path: string) => `${path}?${ui.version}`;

const NAV: [PageName, string, IconName, string][] = [
  ["index", ".", "mobile-menu/home", "dashboard"],
  ["subscriptions", "subscriptions.php", "mobile-menu/subscriptions", "subscriptions"],
  ["calendar", "calendar.php", "mobile-menu/calendar", "calendar"],
  ["stats", "stats.php", "mobile-menu/statistics", "stats"],
  ["settings", "settings.php", "mobile-menu/settings", "settings"],
];

function customColorCss(colors: NonNullable<Ui["customColors"]>): string {
  const lines: string[] = [];
  for (const [name, value] of [["main", colors.main_color], ["accent", colors.accent_color], ["hover", colors.hover_color]] as const) {
    if (value && /^#[0-9A-Fa-f]{3,6}$/.test(value)) lines.push(`--${name}-color: ${value}; --${name}-color-rgb: ${hexToRgb(value)};`);
  }
  return `:root { ${lines.join(" ")} }`;
}

export function Layout({ ui, page, children }: { ui: Ui; page: PageName; children?: Child }) {
  const { t } = ui;
  const mobileNav = ui.settings.mobile_nav ? "mobile-navigation" : "";
  const colorThemes = ["red", "green", "yellow", "purple"];
  return (
    <>
      {raw("<!DOCTYPE html>")}
      <html dir={ui.dir}>
        <head>
          <meta charset="UTF-8" />
          <meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no" />
          <title>Wallos - Subscription Tracker</title>
          <meta name="apple-mobile-web-app-title" content="Wallos" />
          <meta name="theme-color" content={ui.theme === "light" ? "#FFFFFF" : "#12151C"} id="theme-color" />
          <meta name="referrer" content="no-referrer" />
          <link rel="icon" type="image/png" href="images/icon/favicon.ico" sizes="16x16" />
          <link rel="apple-touch-icon" href="images/icon/apple-touch-icon.png" />
          <link rel="apple-touch-icon" sizes="152x152" href="images/icon/apple-touch-icon-152.png" />
          <link rel="apple-touch-icon" sizes="180x180" href="images/icon/apple-touch-icon-180.png" />
          <link rel="manifest" href="manifest.php" crossorigin="use-credentials" />
          <link rel="stylesheet" href={asset(ui, "styles/theme.css")} />
          <link rel="stylesheet" href={asset(ui, "styles/styles.css")} />
          <link rel="stylesheet" href={asset(ui, "styles/dark-theme.css")} id="dark-theme" disabled={ui.theme !== "dark"} />
          {colorThemes.map((name) => (
            <link rel="stylesheet" href={asset(ui, `styles/themes/${name}.css`)} id={`${name}-theme`} disabled={ui.colorTheme !== name} />
          ))}
          <link rel="stylesheet" href="styles/barlow.css" />
          <link rel="stylesheet" href="styles/font-awesome.min.css" />
          <link rel="stylesheet" href="styles/brands.css" />
          <script type="text/javascript" src={asset(ui, "scripts/all.js")}></script>
          <script type="text/javascript" src={asset(ui, "scripts/common.js")}></script>
          <script type="text/javascript">
            {raw(`window.theme = ${js(ui.theme)};
    window.update_theme_settings = "${ui.updateThemeSettings ? "1" : ""}";
    window.lang = ${js(ui.lang)};
    window.colorTheme = ${js(ui.colorTheme)};
    window.mobileNavigation = "${ui.settings.mobile_nav ? "1" : ""}";
    window.csrfToken = ${js(ui.csrf)};`)}
          </script>
          {/* Custom CSS is the user's own; "</style" is neutralised so it cannot break out. */}
          <style>{raw(ui.customCss.replace(/<\/style/gi, "<\\/style"))}</style>
          {ui.customColors && <style id="custom_theme_colors">{raw(customColorCss(ui.customColors))}</style>}
          <script type="text/javascript" src={asset(ui, `scripts/i18n/${ui.lang}.js`)}></script>
          <script type="text/javascript" src={asset(ui, "scripts/i18n/getlang.js")}></script>
          <script type="text/javascript" src={asset(ui, "scripts/password-toggle.js")}></script>
        </head>

        <body class={`${ui.theme} ${ui.dir} ${mobileNav}`}>
          <header>
            <div class="contain">
              <div class="logo">
                <a href=".">
                  <div class="logo-image" title="Wallos - Subscription Tracker">
                    <Icon name="logo" />
                  </div>
                </a>
              </div>
              <nav>
                <div class="dropdown">
                  <button class="dropbtn" onclick="toggleDropdown()">
                    <img src={ui.user.avatar} alt="me" id="avatar" />
                    <span id="user" class="mobileNavigationHideOnMobile">{ui.user.username}</span>
                  </button>
                  <div class="dropdown-content">
                    {NAV.map(([, href, icon, label]) => (
                      <a href={href} class="mobileNavigationHideOnMobile">
                        <Icon name={icon} />
                        {t(label)}
                      </a>
                    ))}
                    <a href="profile.php">
                      <Icon name="mobile-menu/profile" />
                      {t("profile")}
                    </a>
                    {ui.isAdmin && (
                      <a href="admin.php">
                        <Icon name="mobile-menu/admin" />
                        {t("admin")}
                      </a>
                    )}
                    <a href="about.php">
                      <Icon name="mobile-menu/about" />
                      {t("about")}
                    </a>
                    <a href="logout.php">
                      <Icon name="mobile-menu/logout" />
                      {t("logout")}
                    </a>
                  </div>
                </div>
              </nav>
            </div>
          </header>

          {ui.settings.mobile_nav ? (
            <nav class="mobile-nav">
              {NAV.map(([name, href, icon, label]) => (
                <a href={href} class={`nav-link ${page === name ? "active" : ""}`} title={t(label)}>
                  <Icon name={icon} />
                  {t(label)}
                </a>
              ))}
            </nav>
          ) : null}

          <main>{children}</main>

          <div class="toast" id="errorToast">
            <div class="toast-content">
              <i class="fas fa-solid fa-x toast-icon error"></i>
              <div class="message">
                <span class="text text-1">{t("error")}</span>
                <span class="text text-2 errorMessage"></span>
              </div>
            </div>
            <i class="fa-solid fa-xmark close close-error"></i>
            <div class="progress error"></div>
          </div>

          <div class="toast" id="successToast">
            <div class="toast-content">
              <i class="fas fa-solid fa-check toast-icon success"></i>
              <div class="message">
                <span class="text text-1">{t("success")}</span>
                <span class="text text-2 successMessage"></span>
              </div>
            </div>
            <i class="fa-solid fa-xmark close close-success"></i>
            <div class="progress success"></div>
          </div>
        </body>
      </html>
    </>
  );
}

/** Renders a page inside the frame. */
export function page(c: Context, ui: Ui, name: PageName, body: Child) {
  return c.html(<Layout ui={ui} page={name}>{body}</Layout>);
}
