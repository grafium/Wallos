import { Hono, type Context } from "hono";
import type { AppBindings } from "../../env";
import { resolveLanguage, translator } from "../i18n";

/*
  endpoints/ai/*.php. AI recommendations (provider settings, model lists,
  recommendations and category translation) arrive in a later phase; until
  then these answer {success: false, message} the way the PHP files answered
  when AI was not set up, so the settings page shows a clear notice instead
  of failing. delete_recommendation works whenever an ai_recommendations
  table exists (e.g. after that phase's migration).
*/

type Ctx = Context<AppBindings>;

export const routes = new Hono<AppBindings>();

export const AI_NOT_AVAILABLE = "AI recommendations are not available in this version of Wallos yet.";

const notAvailable = (c: Ctx) => c.json({ success: false, message: AI_NOT_AVAILABLE });

for (const name of ["save_settings", "fetch_models", "generate_recommendations", "translate_categories"]) {
  routes.post(`/endpoints/ai/${name}.php`, notAvailable);
}

routes.post("/endpoints/ai/delete_recommendation.php", async (c) => {
  const t = translator(resolveLanguage(c.get("user").language));
  let body: Record<string, unknown> = {};
  try {
    body = ((await c.req.json()) as Record<string, unknown>) ?? {};
  } catch {
    body = {};
  }
  const id = Math.trunc(Number(body.id ?? 0)) || 0;
  if (id <= 0) return c.json({ success: false, message: t("error") });

  const table = await c.env.DB.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'ai_recommendations'").first();
  if (!table) return notAvailable(c);

  const result = await c.env.DB.prepare("DELETE FROM ai_recommendations WHERE id = ? AND user_id = ?").bind(id, c.get("user").id).run();
  return result.meta.changes > 0 ? c.json({ success: true, message: t("success") }) : c.json({ success: false, message: t("error") });
});
