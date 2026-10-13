import { Hono } from "hono";
import type { AppBindings } from "../env";
import { uiEndpoint } from "./context";
import { routes as adminEndpoints } from "./endpoints/admin";
import { routes as aiEndpoints } from "./endpoints/ai";
import { routes as dbEndpoints } from "./endpoints/db";
import { routes as notificationEndpoints } from "./endpoints/notifications";
import { routes as settingsEndpoints } from "./endpoints/settings";
import { routes as subscriptionEndpoints } from "./endpoints/subscriptions";
import { routes as userEndpoints } from "./endpoints/user";
import { routes as adminPage } from "./pages/admin";
import { routes as authPages, oidcCallback } from "./pages/auth";
import { routes as calendarPage } from "./pages/calendar";
import { routes as dashboardPage } from "./pages/dashboard";
import { routes as profilePage } from "./pages/profile";
import { routes as settingsPage } from "./pages/settings";
import { routes as statsPage } from "./pages/stats";
import { routes as subscriptionsPage } from "./pages/subscriptions";
import { routes as pwa } from "./pwa";

/*
  The web interface: the pages of PHP Wallos at their old URLs (index.php,
  subscriptions.php, ...) and the endpoints/<area>/<name>.php its scripts
  call. Pages apply uiPage themselves; every endpoint passes uiEndpoint
  (session + CSRF) here, once.
*/

export const ui = new Hono<AppBindings>();

// The OIDC provider sends the browser back to the redirect URL (normally the
// Wallos address) with ?code&state, as PHP's checksession.php expected on any page.
const OIDC_RETURN = /^\/(?:[a-z_]+\.php)?$/;
ui.get("*", async (c, next) => {
  if (c.req.query("code") !== undefined && c.req.query("state") !== undefined && OIDC_RETURN.test(c.req.path)) return oidcCallback(c);
  return next();
});

ui.route("/", authPages);
ui.route("/", pwa);

ui.use("/endpoints/*", uiEndpoint);
for (const endpoints of [subscriptionEndpoints, settingsEndpoints, notificationEndpoints, aiEndpoints, dbEndpoints, userEndpoints, adminEndpoints]) {
  ui.route("/", endpoints);
}

for (const pages of [dashboardPage, subscriptionsPage, calendarPage, statsPage, settingsPage, profilePage, adminPage]) {
  ui.route("/", pages);
}
