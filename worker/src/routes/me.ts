import { Hono } from "hono";
import type { AppBindings } from "../env";
import { ADMIN_USER_ID } from "../env";
import { randomToken } from "../lib/crypto";
import { fail, ok } from "../lib/http";

export const meRoutes = new Hono<AppBindings>();

meRoutes.get("/", async (c) => {
  const user = c.get("user");
  const [profile, settings] = await Promise.all([
    c.env.DB.prepare(
      `SELECT id, username, email, firstname, lastname, main_currency, language, avatar, budget,
              budget_period_type, budget_period_anchor_date, period_budget, totp_enabled, created_at
         FROM user WHERE id = ?`,
    )
      .bind(user.id)
      .first(),
    c.env.DB.prepare("SELECT * FROM settings WHERE user_id = ?").bind(user.id).first(),
  ]);
  return ok(c, "user", { user: { ...profile, is_admin: user.id === ADMIN_USER_ID }, settings, notes: [] });
});

/** Issues a new API key. Only a logged-in session may do this, never the API key itself. */
meRoutes.post("/api-key", async (c) => {
  if (c.get("authMethod") !== "session") {
    return fail(c, 403, "Session required", "Rotate the API key from a logged-in session.");
  }
  const apiKey = randomToken(32);
  await c.env.DB.prepare("UPDATE user SET api_key = ? WHERE id = ?").bind(apiKey, c.get("user").id).run();
  return ok(c, "API key rotated", { api_key: apiKey });
});

meRoutes.get("/api-key", async (c) => {
  if (c.get("authMethod") !== "session") {
    return fail(c, 403, "Session required", "The API key can only be read from a logged-in session.");
  }
  const row = await c.env.DB.prepare("SELECT api_key FROM user WHERE id = ?").bind(c.get("user").id).first<{ api_key: string }>();
  return ok(c, "API key", { api_key: row?.api_key ?? null });
});
