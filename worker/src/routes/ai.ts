import { Hono } from "hono";
import type { AppBindings } from "../env";
import { fail, ok, parseId, readBody } from "../lib/http";
import {
  AI_SCHEDULES,
  AI_TYPES,
  deleteRecommendation,
  fetchModels,
  generateRecommendations,
  loadAiSettings,
  maskKey,
  saveAiSettings,
  translateCategories,
  type AiFailure,
} from "../services/ai";
import { resolveLanguage, translator } from "../ui/i18n";

/*
  AI recommendations over the JSON API (the web interface uses
  endpoints/ai/*.php). Same service as the pages: src/services/ai.ts.
*/

export const aiRoutes = new Hono<AppBindings>();

const t = (language: string | null) => translator(resolveLanguage(language));
const str = (value: unknown) => (typeof value === "string" ? value : "");
const failed = (c: Parameters<typeof fail>[0], result: AiFailure) => fail(c, 400, "AI request failed", result.message, result.json_error ? { json_error: result.json_error } : {});

aiRoutes.get("/settings", async (c) => {
  const settings = await loadAiSettings(c.env.DB, c.get("user").id);
  return ok(c, "ai_settings", {
    ai_settings: settings ? { ...settings, api_key: maskKey(settings.api_key) } : null,
    providers: AI_TYPES.filter((type) => type !== "workers-ai" || c.env.AI),
    schedules: AI_SCHEDULES,
  });
});

/** enabled, type, api_key ("********" keeps the stored one), url, model, run_schedule */
aiRoutes.put("/settings", async (c) => {
  const body = await readBody(c);
  const result = await saveAiSettings(
    c.env,
    c.get("user").id,
    {
      enabled: body.enabled === true || Number(body.enabled) === 1,
      type: str(body.type),
      apiKey: str(body.api_key),
      host: str(body.url),
      model: str(body.model),
      schedule: str(body.run_schedule) || "manual",
    },
    t(c.get("user").language),
  );
  if (!result.success) return failed(c, result);
  const settings = await loadAiSettings(c.env.DB, c.get("user").id);
  return ok(c, "AI settings saved", { ai_settings: settings ? { ...settings, api_key: maskKey(settings.api_key) } : null });
});

aiRoutes.post("/models", async (c) => {
  const body = await readBody(c);
  const result = await fetchModels(c.env, c.get("user").id, str(body.type), str(body.api_key), str(body.url), t(c.get("user").language));
  return result.success ? ok(c, "models", { models: result.models }) : failed(c, result);
});

aiRoutes.get("/recommendations", async (c) => {
  const rows = await c.env.DB.prepare("SELECT id, type, title, description, savings, created_at FROM ai_recommendations WHERE user_id = ? ORDER BY id")
    .bind(c.get("user").id)
    .all();
  return ok(c, "recommendations", { recommendations: rows.results });
});

aiRoutes.post("/recommendations/generate", async (c) => {
  const result = await generateRecommendations(c.env, c.get("user").id, t(c.get("user").language));
  return result.success ? ok(c, "Recommendations generated", { recommendations: result.recommendations }) : failed(c, result);
});

aiRoutes.delete("/recommendations/:id", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null || !(await deleteRecommendation(c.env.DB, c.get("user").id, id))) return fail(c, 404, "Not found", "No such recommendation.");
  return ok(c, "Recommendation deleted", { id });
});

aiRoutes.post("/translate-categories", async (c) => {
  const result = await translateCategories(c.env, c.get("user").id, t(c.get("user").language));
  return result.success ? ok(c, "Categories translated", { translations: result.translations }) : failed(c, result);
});
