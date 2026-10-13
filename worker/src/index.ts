import { Hono } from "hono";
import { secureHeaders } from "hono/secure-headers";
import { runScheduled } from "./cron";
import type { AppBindings, Env } from "./env";
import { requireAuth } from "./lib/auth";
import { fail, ok } from "./lib/http";
import { adminRoutes } from "./routes/admin";
import { authRoutes } from "./routes/auth";
import { exchangeRateRoutes } from "./routes/exchange-rates";
import { legacyRoutes } from "./routes/legacy";
import { logoRoutes } from "./routes/logos";
import { categories, currencies, household, paymentMethods } from "./routes/lookups";
import { meRoutes } from "./routes/me";
import { notificationRoutes } from "./routes/notifications";
import { fileRoutes, uploadRoutes } from "./routes/uploads";
import { statsRoutes } from "./routes/stats";
import { subscriptionRoutes } from "./routes/subscriptions";
import { ui } from "./ui/app";
import { WALLOS_COMPAT_VERSION, WORKER_VERSION } from "./version";

const app = new Hono<AppBindings>();

app.use("*", secureHeaders());

app.get("/api", (c) =>
  ok(c, "Wallos API", {
    version: WORKER_VERSION,
    wallos_compat: WALLOS_COMPAT_VERSION,
    docs: "https://github.com/grafium/Wallos/tree/main/worker#api",
  }),
);

app.get("/api/health", async (c) => {
  const db = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM cycles").first<{ n: number }>().catch(() => null);
  const healthy = (db?.n ?? 0) > 0;
  return c.json({ success: healthy, title: "health", database: healthy ? "ok" : "unavailable", version: WORKER_VERSION }, healthy ? 200 : 503);
});

app.route("/api/auth", authRoutes);
app.route("/", fileRoutes);

// Everything below requires a session token or an API key.
const api = new Hono<AppBindings>();
api.use("*", requireAuth);
// The PHP-compatible *.php paths go first so "/subscriptions/:id" does not
// swallow "/subscriptions/get_subscriptions.php".
api.route("/", legacyRoutes);
api.route("/", uploadRoutes);
api.route("/me", meRoutes);
api.route("/subscriptions", subscriptionRoutes);
api.route("/categories", categories.routes);
api.route("/household", household.routes);
api.route("/payment-methods", paymentMethods.routes);
api.route("/currencies", currencies.routes);
api.route("/stats", statsRoutes);
api.route("/admin", adminRoutes);
api.route("/notifications", notificationRoutes);
api.route("/exchange-rates", exchangeRateRoutes);
api.route("/logos", logoRoutes);
api.get("/cycles", async (c) => {
  const cycles = await c.env.DB.prepare("SELECT id, days, name FROM cycles ORDER BY id").all();
  return ok(c, "cycles", { cycles: cycles.results, notes: [] });
});

app.route("/api", api);

// The web interface (pages at the PHP URLs and the endpoints/*.php they call).
app.route("/", ui);

app.notFound((c) => fail(c, 404, "Not found"));
app.onError((error, c) => {
  console.error(error);
  return fail(c, 500, "Server error", "Something went wrong while handling the request.");
});

export default {
  fetch: app.fetch,

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduled(env, controller.scheduledTime));
  },
} satisfies ExportedHandler<Env>;

export { app };
