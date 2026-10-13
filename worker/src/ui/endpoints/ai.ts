import { Hono, type Context } from "hono";
import type { AppBindings } from "../../env";
import { deleteRecommendation, fetchModels, generateRecommendations, saveAiSettings, translateCategories } from "../../services/ai";
import { resolveLanguage, translator } from "../i18n";

/*
  endpoints/ai/*.php, called by scripts/settings.js and scripts/dashboard.js.
  The work is in src/services/ai.ts; answers keep PHP's shape.
*/

type Ctx = Context<AppBindings>;

export const routes = new Hono<AppBindings>();

const userT = (c: Ctx) => translator(resolveLanguage(c.get("user").language));

async function jsonBody(c: Ctx): Promise<Record<string, unknown>> {
  try {
    const body = await c.req.json();
    return body && typeof body === "object" && !Array.isArray(body) ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

const text = (value: unknown) => (typeof value === "string" ? value : "");

routes.post("/endpoints/ai/save_settings.php", async (c) => {
  const t = userT(c);
  const data = await jsonBody(c);
  const result = await saveAiSettings(
    c.env,
    c.get("user").id,
    {
      enabled: Boolean(data.ai_enabled),
      type: text(data.ai_type),
      apiKey: text(data.api_key),
      host: text(data.ollama_host),
      model: text(data.model),
      schedule: text(data.ai_run_schedule) || "manual",
    },
    t,
  );
  return c.json(result.success ? { success: true, message: t("success"), enabled: result.enabled } : result);
});

routes.post("/endpoints/ai/fetch_models.php", async (c) => {
  const data = await jsonBody(c);
  return c.json(await fetchModels(c.env, c.get("user").id, text(data.type).trim(), text(data.api_key), text(data.ollama_host), userT(c)));
});

routes.post("/endpoints/ai/generate_recommendations.php", async (c) => {
  const t = userT(c);
  const result = await generateRecommendations(c.env, c.get("user").id, t);
  return c.json(result.success ? { success: true, message: t("success"), recommendations: result.recommendations } : result);
});

routes.post("/endpoints/ai/translate_categories.php", async (c) => {
  const t = userT(c);
  const result = await translateCategories(c.env, c.get("user").id, t);
  return c.json(result.success ? { success: true, message: t("success"), translations: result.translations } : result);
});

routes.post("/endpoints/ai/delete_recommendation.php", async (c) => {
  const t = userT(c);
  const id = Math.trunc(Number((await jsonBody(c)).id ?? 0)) || 0;
  const deleted = id > 0 && (await deleteRecommendation(c.env.DB, c.get("user").id, id));
  return c.json({ success: deleted, message: deleted ? t("success") : t("error") });
});
