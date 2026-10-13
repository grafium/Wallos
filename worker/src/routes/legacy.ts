import { Hono, type Context } from "hono";
import type { AppBindings } from "../env";
import { fail, ok, parseId, readBody } from "../lib/http";
import { WALLOS_COMPAT_VERSION } from "../version";
import { categories, currencies, household, paymentMethods } from "./lookups";
import { monthlyCostHandler } from "./stats";
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
  const params = await requestParams(c);
  // PHP accepted "notifications" as an alias of "notify".
  if (params.notify === undefined && params.notifications !== undefined) params.notify = params.notifications;
  switch (params.action) {
    case "add":
      return createHandler(c, params);
    case "edit":
      return updateHandler(c, subscriptionId(params), params);
    case "delete":
      return deleteHandler(c, subscriptionId(params));
    default:
      return fail(c, 400, "Invalid action", 'Action must be "add", "edit", or "delete".');
  }
});

legacyRoutes.on(["GET", "POST"], "/categories/get_categories.php", (c) => categories.list(c));
legacyRoutes.on(["GET", "POST"], "/currencies/get_currencies.php", (c) => currencies.list(c));
legacyRoutes.on(["GET", "POST"], "/payment_methods/get_payment_methods.php", (c) => paymentMethods.list(c));
legacyRoutes.on(["GET", "POST"], "/household/get_household.php", (c) => household.list(c));

legacyRoutes.on(["GET", "POST"], "/status/version.php", (c) =>
  ok(c, "version", { version: `v${WALLOS_COMPAT_VERSION}`, version_number: WALLOS_COMPAT_VERSION, notes: [] }),
);
