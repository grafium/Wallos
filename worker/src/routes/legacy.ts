import { Hono, type Context } from "hono";
import type { AppBindings } from "../env";
import { fail, ok, parseId, readBody } from "../lib/http";
import { WALLOS_COMPAT_VERSION } from "../version";
import { adminSettingsHandler, disablePasswordLoginHandler, oidcSettingsHandler, requireAdmin, updateAdminSettingsHandler, updateOidcSettingsHandler } from "./admin";
import { icalFeed } from "../ui/endpoints/subscriptions";
import { legacyGetFixer, legacySetFixer } from "./exchange-rates";
import { legacyNotificationSettings } from "./notifications";
import { categories, currencies, household, paymentMethods } from "./lookups";
import { legacyUserHandler, settingsHandler, updateBudgetHandler, updateSettingsHandler } from "./me";
import { monthlyCostHandler, periodBudgetHandler } from "./stats";
import { createHandler, deleteHandler, getHandler, listHandler, updateHandler } from "./subscriptions";

/*
  The PHP Wallos API paths (api/<area>/<name>.php), so existing integrations -
  Home Assistant, mobile apps, scripts - keep working by only changing the
  base URL. Parameters may come from the query string or a form/JSON body,
  as with PHP's $_REQUEST.
*/

type Ctx = Context<AppBindings>;

async function requestParams(c: Ctx): Promise<Record<string, string>> {
  const params: Record<string, string> = { ...c.req.query() };
  if (c.req.method === "POST") {
    for (const [key, value] of Object.entries(await readBody(c))) {
      if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") {
        params[key] = String(value);
      }
    }
  }
  return params;
}

const subscriptionId = (params: Record<string, string>) =>
  parseId(params.id ?? params.subscription_id ?? params.subscriptionId);

export const legacyRoutes = new Hono<AppBindings>();

legacyRoutes.on(["GET", "POST"], "/subscriptions/get_subscriptions.php", async (c) => listHandler(c, await requestParams(c)));

legacyRoutes.on(["GET", "POST"], "/subscriptions/get_subscription.php", async (c) => {
  const params = await requestParams(c);
  return getHandler(c, subscriptionId(params), params.convert_currency === "true");
});

legacyRoutes.on(["GET", "POST"], "/subscriptions/get_monthly_cost.php", async (c) => monthlyCostHandler(c, await requestParams(c)));

legacyRoutes.post("/subscriptions/set_subscriptions.php", async (c) => {
  const body = await readBody(c);
  // Strings as $_REQUEST had them, plus an uploaded "logo" file ($_FILES).
  const params: Record<string, unknown> = { ...(await requestParams(c)), ...(body.logo instanceof File ? { logo: body.logo } : {}) };
  // PHP accepted "notifications" as an alias of "notify".
  if (params.notify === undefined && params.notifications !== undefined) params.notify = params.notifications;
  const ids = params as Record<string, string>;
  switch (params.action) {
    case "add":
      return createHandler(c, params);
    case "edit":
      return updateHandler(c, subscriptionId(ids), params);
    case "delete":
      return deleteHandler(c, subscriptionId(ids));
    default:
      return fail(c, 400, "Invalid action", 'Action must be "add", "edit", or "delete".');
  }
});

legacyRoutes.on(["GET", "POST"], "/categories/get_categories.php", (c) => categories.list(c));
legacyRoutes.on(["GET", "POST"], "/currencies/get_currencies.php", (c) => currencies.list(c));
legacyRoutes.on(["GET", "POST"], "/payment_methods/get_payment_methods.php", (c) => paymentMethods.list(c));
legacyRoutes.on(["GET", "POST"], "/household/get_household.php", (c) => household.list(c));

legacyRoutes.on(["GET", "POST"], "/subscriptions/get_period_budget.php", async (c) => periodBudgetHandler(c, await requestParams(c)));

legacyRoutes.on(["GET", "POST"], "/users/get_user.php", (c) => legacyUserHandler(c));
legacyRoutes.post("/users/set_budget.php", async (c) => updateBudgetHandler(c, await requestParams(c)));
legacyRoutes.on(["GET", "POST"], "/settings/get_settings.php", (c) => settingsHandler(c));
legacyRoutes.post("/settings/set_settings.php", async (c) => updateSettingsHandler(c, await requestParams(c)));

legacyRoutes.on(["GET", "POST"], "/admin/get_admin_settings.php", requireAdmin, (c) => adminSettingsHandler(c));
legacyRoutes.post("/admin/set_admin_settings.php", requireAdmin, async (c) => updateAdminSettingsHandler(c, await requestParams(c)));
legacyRoutes.on(["GET", "POST"], "/admin/get_oidc_settings.php", requireAdmin, (c) => oidcSettingsHandler(c));
legacyRoutes.post("/admin/set_oidc_settings.php", requireAdmin, async (c) => updateOidcSettingsHandler(c, await requestParams(c)));
legacyRoutes.post("/admin/set_disable_password_login.php", requireAdmin, async (c) => disablePasswordLoginHandler(c, await requestParams(c)));

legacyRoutes.on(["GET", "POST"], "/notifications/get_notification_settings.php", (c) => legacyNotificationSettings(c));
legacyRoutes.on(["GET", "POST"], "/fixer/get_fixer.php", (c) => legacyGetFixer(c));
legacyRoutes.post("/fixer/set_fixer.php", async (c) => legacySetFixer(c, await requestParams(c)));

// Calendar apps subscribe to this URL with the API key in the query string.
legacyRoutes.on(["GET", "POST"], "/subscriptions/get_ical_feed.php", async (c) => {
  const params = await requestParams(c);
  const ics = await icalFeed(c.env.DB, c.get("user"), params.convert_currency === "true");
  return c.body(ics, 200, { "content-type": "text/calendar; charset=utf-8", "content-disposition": 'attachment; filename="subscriptions.ics"' });
});

legacyRoutes.on(["GET", "POST"], "/status/version.php", (c) =>
  ok(c, "version", { version: `v${WALLOS_COMPAT_VERSION}`, version_number: WALLOS_COMPAT_VERSION, notes: [] }),
);
