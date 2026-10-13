import type { Env } from "../env";
import { checkOutboundUrl } from "../lib/outbound";
import { LANGUAGES, resolveLanguage, translator, type Translate } from "../ui/i18n";

/*
  AI recommendations: includes/ai_client.php, endpoints/ai/*.php and
  endpoints/cronjobs/generaterecommendations.php.

  Providers as in PHP - ChatGPT, Gemini, OpenRouter, Ollama and any
  OpenAI-compatible server - plus Cloudflare Workers AI when the Worker has
  an AI binding (no key; billed to the Cloudflare account). Ollama and
  OpenAI-compatible servers must be reachable from the internet: a Worker
  cannot see the user's LAN, so private addresses are refused.

  The stored API key never leaves the server again: pages and answers show
  it as "********", and that value sent back means "keep the stored key".
*/

export const AI_TYPES = ["chatgpt", "gemini", "openrouter", "ollama", "openai-compatible", "workers-ai"] as const;
export type AiType = (typeof AI_TYPES)[number];
export const AI_SCHEDULES = ["manual", "weekly", "monthly"] as const;
export const AI_KEY_MASK = "********";

const KEY_PROVIDERS: AiType[] = ["chatgpt", "gemini", "openrouter"];
const HOST_PROVIDERS: AiType[] = ["ollama", "openai-compatible"];
const CHAT_PROVIDERS: AiType[] = ["chatgpt", "openrouter", "openai-compatible"];
const TIMEOUT = 300_000;

/** Text models offered for Workers AI (any other @cf/... id can be typed into the database). */
export const WORKERS_AI_MODELS = [
  { id: "@cf/meta/llama-3.3-70b-instruct-fp8-fast", name: "Llama 3.3 70B Instruct (fast)" },
  { id: "@cf/meta/llama-3.1-8b-instruct-fast", name: "Llama 3.1 8B Instruct (fast)" },
  { id: "@cf/mistralai/mistral-small-3.1-24b-instruct", name: "Mistral Small 3.1 24B Instruct" },
  { id: "@cf/google/gemma-3-12b-it", name: "Gemma 3 12B" },
  { id: "@cf/qwen/qwq-32b", name: "QwQ 32B" },
];

export interface AiSettings {
  type: string;
  enabled: number;
  api_key: string | null;
  model: string;
  url: string | null;
  run_schedule: string;
  last_successful_run: string | null;
}

export const isAiType = (value: unknown): value is AiType => typeof value === "string" && (AI_TYPES as readonly string[]).includes(value);

export async function loadAiSettings(db: D1Database, userId: number): Promise<AiSettings | null> {
  return db
    .prepare("SELECT type, enabled, api_key, model, url, run_schedule, last_successful_run FROM ai_settings WHERE user_id = ?")
    .bind(userId)
    .first<AiSettings>();
}

export const maskKey = (key: string | null | undefined) => (key ? AI_KEY_MASK : "");

export type AiResult<T> = { success: true } & T;
export type AiFailure = { success: false; message: string; json_error?: string };

const fail = (message: string): AiFailure => ({ success: false, message });

function checkHost(host: string, t: Translate): { ok: true; base: string } | AiFailure {
  if (!host) return fail(t("invalid_host"));
  const check = checkOutboundUrl(host);
  if (!check.ok) return fail(`${t("invalid_host")}: ${check.reason}`);
  return { ok: true, base: host.replace(/\/+$/, "") };
}

// --- save_settings.php -------------------------------------------------------------------

export interface AiSettingsInput {
  enabled: boolean;
  type: string;
  apiKey: string;
  host: string;
  model: string;
  schedule: string;
}

export async function saveAiSettings(env: Env, userId: number, input: AiSettingsInput, t: Translate): Promise<AiResult<{ enabled: boolean }> | AiFailure> {
  const type = input.type.trim();
  if (!isAiType(type)) return fail(t("error"));
  if (type === "workers-ai" && !env.AI) return fail("Workers AI is not set up for this server (no AI binding).");
  let apiKey = input.apiKey.trim();
  if (apiKey === AI_KEY_MASK) apiKey = (await loadAiSettings(env.DB, userId))?.api_key ?? "";
  if (KEY_PROVIDERS.includes(type) && !apiKey) return fail(t("invalid_api_key"));
  let host = input.host.trim();
  if (HOST_PROVIDERS.includes(type)) {
    const check = checkHost(host, t);
    if ("success" in check) return check;
    if (type === "ollama") apiKey = ""; // Ollama never uses a key
  } else {
    host = "";
  }
  if (type === "workers-ai") apiKey = "";
  const model = input.model.trim();
  if (!model) return fail(t("fill_mandatory_fields"));
  const schedule = (AI_SCHEDULES as readonly string[]).includes(input.schedule) ? input.schedule : "manual";

  await env.DB.prepare(
    `INSERT INTO ai_settings (user_id, type, enabled, api_key, model, url, run_schedule, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
     ON CONFLICT (user_id) DO UPDATE SET type = excluded.type, enabled = excluded.enabled, api_key = excluded.api_key,
       model = excluded.model, url = excluded.url, run_schedule = excluded.run_schedule, updated_at = CURRENT_TIMESTAMP`,
  )
    .bind(userId, type, input.enabled ? 1 : 0, apiKey.slice(0, 1024), model.slice(0, 255), host.slice(0, 2048), schedule)
    .run();
  return { success: true, enabled: input.enabled };
}

// --- fetch_models.php ---------------------------------------------------------------------

export async function fetchModels(env: Env, userId: number, type: string, apiKeyInput: string, hostInput: string, t: Translate): Promise<AiResult<{ models: { id: string; name: string }[] }> | AiFailure> {
  if (!isAiType(type)) return fail(t("error"));
  let apiKey = apiKeyInput.trim();
  if (apiKey === AI_KEY_MASK) apiKey = (await loadAiSettings(env.DB, userId))?.api_key ?? "";
  if (type === "workers-ai") return env.AI ? { success: true, models: WORKERS_AI_MODELS } : fail("Workers AI is not set up for this server (no AI binding).");
  if (KEY_PROVIDERS.includes(type) && !apiKey) return fail(t("invalid_api_key"));

  let url: string;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (type === "chatgpt") {
    url = "https://api.openai.com/v1/models";
    headers.authorization = `Bearer ${apiKey}`;
  } else if (type === "gemini") {
    url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`;
  } else if (type === "openrouter") {
    url = "https://openrouter.ai/api/v1/models";
    headers.authorization = `Bearer ${apiKey}`;
  } else {
    const check = checkHost(hostInput.trim(), t);
    if ("success" in check) return check;
    if (type === "openai-compatible") {
      url = `${check.base}/models`;
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    } else {
      url = `${check.base}/api/tags`;
    }
  }

  const hostProvider = HOST_PROVIDERS.includes(type);
  let data: Record<string, unknown> | null;
  try {
    const response = await fetch(url, { headers, redirect: "manual", signal: AbortSignal.timeout(60_000) });
    data = (await response.json().catch(() => null)) as Record<string, unknown> | null;
  } catch {
    return fail(hostProvider ? t("invalid_host") : t("error"));
  }
  const list = (value: unknown) => (Array.isArray(value) ? (value as Record<string, unknown>[]) : null);
  const geminiModels = type === "gemini" ? list(data?.models) : null;
  if (geminiModels) {
    return { success: true, models: geminiModels.map((m) => ({ id: String(m.name ?? "").replace(/^models\//, ""), name: String(m.displayName ?? m.name ?? "") })) };
  }
  const openAiModels = list(data?.data);
  if (openAiModels) return { success: true, models: openAiModels.map((m) => ({ id: String(m.id), name: String(m.name ?? m.id) })) };
  const ollamaModels = hostProvider ? list(data?.models) : null;
  if (ollamaModels) return { success: true, models: ollamaModels.map((m) => ({ id: String(m.name), name: String(m.name) })) };
  return fail(hostProvider ? t("invalid_host") : t("invalid_api_key"));
}

// --- ai_complete() -------------------------------------------------------------------------

/** Every complete JSON object or array inside a text (ai_decode_json_values()). */
export function decodeJsonValues(content: string): unknown[] {
  const values: unknown[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < content.length; i++) {
    const ch = content[i];
    if (start < 0) {
      if (ch === "{" || ch === "[") {
        start = i;
        depth = 1;
        inString = false;
        escaped = false;
      }
      continue;
    }
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{" || ch === "[") depth++;
    else if (ch === "}" || ch === "]") {
      depth--;
      if (depth === 0) {
        try {
          values.push(JSON.parse(content.slice(start, i + 1)));
        } catch {
          // not JSON after all; keep scanning
        }
        start = -1;
      }
    }
  }
  return values;
}

type Json = Record<string, any>;

/** The provider's reply as one document, also from streamed (several JSON documents) answers. */
export function decodeProviderResponse(reply: string): Json | null {
  try {
    const decoded = JSON.parse(reply);
    if (decoded && typeof decoded === "object") return decoded.summary && typeof decoded.summary === "object" ? decoded.summary : decoded;
  } catch {
    // fall through to the document scan
  }
  let completion: Json | null = null;
  let fallback: Json | null = null;
  let streamed = "";
  for (const document of decodeJsonValues(reply)) {
    if (!document || typeof document !== "object" || Array.isArray(document)) continue;
    const candidate = ((document as Json).summary && typeof (document as Json).summary === "object" ? (document as Json).summary : document) as Json;
    fallback = candidate;
    if (candidate.choices?.[0]?.message?.content !== undefined || candidate.candidates?.[0]?.content?.parts?.[0]?.text !== undefined || candidate.response !== undefined || candidate.error !== undefined) {
      completion = candidate;
    }
    const delta = candidate.choices?.[0]?.delta?.content;
    if (typeof delta === "string") streamed += delta;
  }
  if (completion) return completion;
  if (streamed) return { choices: [{ message: { role: "assistant", content: streamed }, finish_reason: "stop" }] };
  return fallback;
}

function textContent(content: unknown): string | null {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return null;
  const parts = content.filter((p): p is { text: string } => p && typeof p === "object" && typeof p.text === "string").map((p) => p.text);
  return parts.length ? parts.join("") : null;
}

function providerError(reply: Json): string | null {
  const error = reply.error;
  if (typeof error === "string" && error.trim()) return error.trim();
  if (error && typeof error === "object" && typeof error.message === "string") return error.message.trim();
  return null;
}

/** One completion against the configured provider (ai_complete()). */
export async function complete(env: Env, settings: AiSettings, prompt: string, t: Translate): Promise<AiResult<{ content: string }> | AiFailure> {
  const type = settings.type;
  const model = settings.model ?? "";
  if (!isAiType(type) || !Number(settings.enabled) || !model) return fail(t("error"));
  let apiKey = settings.api_key ?? "";

  if (type === "workers-ai") {
    if (!env.AI) return fail("Workers AI is not set up for this server (no AI binding).");
    try {
      const result = (await (env.AI as unknown as { run(model: string, input: unknown): Promise<unknown> }).run(model, { messages: [{ role: "user", content: prompt }], max_tokens: 4096 })) as Json;
      const content = typeof result?.response === "string" ? result.response : result?.response ? JSON.stringify(result.response) : null;
      return content === null ? fail(t("ai_invalid_response")) : { success: true, content };
    } catch (error) {
      console.error("[Wallos AI] provider=workers-ai", error);
      return fail(`${t("ai_provider_error")}: ${error instanceof Error ? error.message.slice(0, 500) : String(error)}`);
    }
  }

  let url: string;
  let body: unknown;
  const headers: Record<string, string> = { "content-type": "application/json" };
  if (HOST_PROVIDERS.includes(type)) {
    const check = checkHost(settings.url ?? "", t);
    if ("success" in check) return check;
    if (type === "ollama") {
      url = `${check.base}/api/generate`;
      body = { model, prompt, stream: false };
    } else {
      url = `${check.base}/chat/completions`;
      body = { model, messages: [{ role: "user", content: prompt }], stream: false };
      if (apiKey) headers.authorization = `Bearer ${apiKey}`;
    }
  } else {
    if (!apiKey) return fail(t("invalid_api_key"));
    if (type === "gemini") {
      url = `https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent?key=${encodeURIComponent(apiKey)}`;
      body = { contents: [{ parts: [{ text: prompt }] }] };
    } else {
      url = type === "chatgpt" ? "https://api.openai.com/v1/chat/completions" : "https://openrouter.ai/api/v1/chat/completions";
      headers.authorization = `Bearer ${apiKey}`;
      body = { model, messages: [{ role: "user", content: prompt }] };
    }
  }
  apiKey = "";

  let status: number;
  let reply: string;
  try {
    const response = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), redirect: "manual", signal: AbortSignal.timeout(TIMEOUT) });
    status = response.status;
    reply = await response.text();
  } catch (error) {
    console.error(`[Wallos AI] provider=${type} reason=request_failed`, error);
    return fail(error instanceof Error ? error.message : t("error"));
  }

  const data = decodeProviderResponse(reply);
  if (!data) {
    console.error(`[Wallos AI] provider=${type} reason=invalid_provider_json http_status=${status} response_length=${reply.length}`);
    return fail(t("ai_invalid_response"));
  }
  let problem = providerError(data);
  if ((status < 200 || status >= 300) && problem === null && typeof data.message === "string") problem = data.message.trim();
  if (status < 200 || status >= 300 || problem !== null) {
    console.error(`[Wallos AI] provider=${type} reason=provider_error http_status=${status}`);
    return fail(`${t("ai_provider_error")} (HTTP ${status})${problem ? `: ${problem.slice(0, 500)}` : ""}`);
  }

  let content: string | null = null;
  if (CHAT_PROVIDERS.includes(type)) content = textContent(data.choices?.[0]?.message?.content);
  else if (type === "gemini") content = typeof data.candidates?.[0]?.content?.parts?.[0]?.text === "string" ? data.candidates[0].content.parts[0].text : null;
  else if (type === "ollama") content = typeof data.response === "string" ? data.response : null;
  if (content === null) {
    console.error(`[Wallos AI] provider=${type} reason=missing_completion_content http_status=${status}`);
    return fail(t("ai_invalid_response"));
  }
  return { success: true, content };
}

/** Strips code fences and decodes the model's JSON (ai_extract_json()). */
export function extractJson(content: string): unknown {
  const stripped = content.trim().replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/, "").trim();
  try {
    return JSON.parse(stripped);
  } catch {
    // Some models add explanations or repeat the array: take the first complete value.
    return decodeJsonValues(stripped).find((value) => value && typeof value === "object") ?? null;
  }
}

// --- generate_recommendations.php ------------------------------------------------------------

function describeFrequency(cycle: number, frequency: number): string {
  if (cycle === 5) return "One-time purchase (lifetime)";
  const unit = ({ 1: "day", 2: "week", 3: "month", 4: "year" } as Record<number, string>)[cycle] ?? "unit";
  return frequency === 1 ? `Every ${unit}` : `Every ${frequency} ${unit}s`;
}

const RECOMMENDATIONS_PROMPT = (language: string) => `You are a helpful assistant designed to help users save money on digital subscriptions.

The user has shared a list of their active subscriptions across household members. For each subscription, you are given:
- Name of the service
- Price (in original currency)
- Payment frequency (e.g., every month, every year, etc.) — entries marked "One-time purchase (lifetime)" are perpetual licenses already paid for, not recurring costs
- Category
- Payer (which household member pays for it)

Analyze the data and give 3 to 7 smart and specific recommendations to reduce subscription costs. If possible, include estimated savings for each suggestion.

Follow these guidelines:
- Do NOT suggest switching to family or group plans unless two or more different household members are paying for the same or similar service.
- Recognize known feature overlaps, such as:
• YouTube Premium includes YouTube Music.
• Amazon Prime includes Prime Video.
• Google One, iCloud+, and Proton all offer cloud storage.
• Real Debrid, All Debrid, and Premiumize offer similar download capabilities.
- Suggest rotating or cancelling subscriptions that serve similar purposes (e.g. multiple streaming or IPTV services).
- Recommend switching from monthly to yearly plans only if it provides clear savings and the user is likely to keep the service long-term.
- Suggest looking for promo or new customer deals if a service appears overpriced.
- Only recommend cancelling rarely used services if they do not provide unique value.
- Do NOT suggest cancelling or changing one-time purchases (lifetime licenses) — they are already paid for and have no ongoing cost.

Return the result as a JSON array. Each item in the array should have:
- "title": a short summary of the suggestion
- "description": a longer explanation with reasoning
- "savings": a rough estimate like "10 EUR/month" or "60 EUR/year" (if possible)

If possible, all text should be in the user's language: ${language}. Otherwise, use English.

Do not include any other text, just the JSON output. Absolutely no additional comments or explanations.

Here is the user's data:`;

async function userLanguage(db: D1Database, userId: number): Promise<string> {
  const row = await db.prepare("SELECT language FROM user WHERE id = ?").bind(userId).first<{ language: string | null }>();
  return resolveLanguage(row?.language);
}

/** The prompt with the user's active subscriptions, or null when there are none. */
export async function recommendationsPrompt(db: D1Database, userId: number): Promise<string | null> {
  const rows = await db
    .prepare(
      `SELECT s.name, s.price, s.cycle, s.frequency, cur.code, cat.name AS category, h.name AS payer
         FROM subscriptions s
         LEFT JOIN currencies cur ON cur.id = s.currency_id AND cur.user_id = s.user_id
         LEFT JOIN categories cat ON cat.id = s.category_id AND cat.user_id = s.user_id
         LEFT JOIN household h ON h.id = s.payer_user_id AND h.user_id = s.user_id
        WHERE s.user_id = ? AND s.inactive = 0
        ORDER BY s.id`,
    )
    .bind(userId)
    .all<{ name: string; price: number; cycle: number; frequency: number; code: string | null; category: string | null; payer: string | null }>();
  if (rows.results.length === 0) return null;
  const data = rows.results.map((r) => {
    const price = Math.round(Number(r.price) * 100) / 100;
    return {
      name: r.name,
      price: r.code ? `${price} ${r.code}` : `${price}`,
      frequency: describeFrequency(Number(r.cycle), Number(r.frequency) || 1),
      category: r.category ?? "Uncategorized",
      payer: r.payer ?? "Unknown",
    };
  });
  const language = LANGUAGES[await userLanguage(db, userId)]?.name ?? "English";
  return `${RECOMMENDATIONS_PROMPT(language)}\n\n${JSON.stringify(data, null, 4)}`;
}

export interface Recommendation {
  title: string;
  description: string;
  savings: string;
}

/** The model's answer as clean recommendations (the PHP endpoint's normalisation). */
export function normalizeRecommendations(value: unknown): Recommendation[] {
  let list = value;
  if (list && typeof list === "object" && !Array.isArray(list) && Array.isArray((list as Json).recommendations)) list = (list as Json).recommendations;
  if (!Array.isArray(list)) return [];
  const scalar = (v: unknown) => typeof v === "string" || typeof v === "number" || typeof v === "boolean";
  const out: Recommendation[] = [];
  for (const item of list) {
    if (!item || typeof item !== "object") continue;
    const { title, description, savings = "" } = item as Json;
    if (!scalar(title) || !scalar(description) || (savings !== null && !scalar(savings))) continue;
    const rec = { title: String(title).trim().slice(0, 500), description: String(description).trim().slice(0, 5000), savings: savings === null ? "" : String(savings).trim().slice(0, 255) };
    if (rec.title && rec.description) out.push(rec);
  }
  return out.slice(0, 20);
}

/** Asks the provider and replaces the stored recommendations. */
export async function generateRecommendations(env: Env, userId: number, t: Translate): Promise<AiResult<{ recommendations: Recommendation[] }> | AiFailure> {
  const settings = await loadAiSettings(env.DB, userId);
  if (!settings) return fail(t("error"));
  const prompt = await recommendationsPrompt(env.DB, userId);
  if (!prompt) return fail(t("error"));
  const result = await complete(env, settings, prompt, t);
  if (!result.success) return result;

  const recommendations = normalizeRecommendations(extractJson(result.content));
  if (recommendations.length === 0) {
    console.error(`[Wallos AI] provider=${settings.type} user_id=${userId} reason=invalid_completion_json response_length=${result.content.length}`);
    return { success: false, message: t("ai_invalid_json_response"), json_error: "Syntax error" };
  }
  await env.DB.batch([
    env.DB.prepare("DELETE FROM ai_recommendations WHERE user_id = ?").bind(userId),
    ...recommendations.map((rec) =>
      env.DB.prepare("INSERT INTO ai_recommendations (user_id, type, title, description, savings) VALUES (?, 'subscription', ?, ?, ?)").bind(userId, rec.title, rec.description, rec.savings),
    ),
    env.DB.prepare("UPDATE ai_settings SET last_successful_run = CURRENT_TIMESTAMP WHERE user_id = ?").bind(userId),
  ]);
  return { success: true, recommendations };
}

// --- translate_categories.php --------------------------------------------------------------

const TRANSLATE_PROMPT = (language: string) => `You are a translation assistant.

Translate the following subscription category names into ${language}.

Follow these guidelines:
- Keep translations short and natural — these are category labels in a subscription tracker.
- Keep brand names, proper nouns, and abbreviations unchanged.
- If a name is already in ${language}, return it unchanged.
- Preserve the capitalization style of each name.

Return the result as a JSON array. Each item in the array must have:
- "id": the category id, unchanged
- "name": the translated category name

Do not include any other text, just the JSON output. Absolutely no additional comments or explanations.

Here are the categories:`;

export async function translateCategories(env: Env, userId: number, t: Translate): Promise<AiResult<{ translations: Record<string, string> }> | AiFailure> {
  const settings = await loadAiSettings(env.DB, userId);
  if (!settings) return fail(t("error"));
  const lang = await userLanguage(env.DB, userId);
  if (lang === "en") return fail(t("error"));

  // The account's first category is the untranslatable "No category" placeholder (PHP's id 1).
  const categories = await env.DB.prepare("SELECT id, name FROM categories WHERE user_id = ?1 AND id != (SELECT MIN(id) FROM categories WHERE user_id = ?1) ORDER BY id")
    .bind(userId)
    .all<{ id: number; name: string }>();
  if (categories.results.length === 0) return { success: true, translations: {} };

  const prompt = `${TRANSLATE_PROMPT(LANGUAGES[lang]?.name ?? "English")}\n\n${JSON.stringify(categories.results, null, 4)}`;
  const result = await complete(env, settings, prompt, t);
  if (!result.success) return result;
  const translated = extractJson(result.content);
  if (!Array.isArray(translated)) return { success: false, message: t("error"), json_error: "Syntax error" };

  const valid = new Set(categories.results.map((c) => c.id));
  const translations: Record<string, string> = {};
  const updates: D1PreparedStatement[] = [];
  for (const item of translated) {
    if (!item || typeof item !== "object") continue;
    const id = Math.trunc(Number((item as Json).id));
    const name = typeof (item as Json).name === "string" ? (item as Json).name.trim() : "";
    if (!valid.has(id) || !name || [...name].length > 100) continue;
    updates.push(env.DB.prepare("UPDATE categories SET name = ? WHERE id = ? AND user_id = ?").bind(name, id, userId));
    translations[String(id)] = name;
  }
  if (updates.length) await env.DB.batch(updates);
  return { success: true, translations };
}

// --- generaterecommendations.php (scheduled) -----------------------------------------------

/**
 * Runs the scheduled recommendations that are due: weekly ones a week after
 * the last success, monthly ones once per calendar month. A failing provider
 * is retried after a day. At most `limit` users per run, since each request
 * can take a while.
 */
export async function runScheduledRecommendations(env: Env, limit = 5) {
  const due = await env.DB.prepare(
    `SELECT user_id FROM ai_settings
      WHERE enabled = 1 AND model != ''
        AND (last_attempt IS NULL OR last_attempt <= datetime('now', '-1 day'))
        AND ((run_schedule = 'weekly' AND (last_successful_run IS NULL OR last_successful_run <= datetime('now', '-7 days')))
          OR (run_schedule = 'monthly' AND (last_successful_run IS NULL OR last_successful_run < datetime('now', 'start of month'))))
      ORDER BY COALESCE(last_successful_run, '') LIMIT ?`,
  )
    .bind(limit)
    .all<{ user_id: number }>();
  const failures: { user_id: number; reason: string }[] = [];
  let successes = 0;
  for (const { user_id } of due.results) {
    await env.DB.prepare("UPDATE ai_settings SET last_attempt = CURRENT_TIMESTAMP WHERE user_id = ?").bind(user_id).run();
    const result = await generateRecommendations(env, user_id, translator(await userLanguage(env.DB, user_id)));
    if (result.success) successes++;
    else failures.push({ user_id, reason: result.message });
  }
  return { processed: due.results.length, successes, failures };
}

export async function deleteRecommendation(db: D1Database, userId: number, id: number): Promise<boolean> {
  const result = await db.prepare("DELETE FROM ai_recommendations WHERE id = ? AND user_id = ?").bind(id, userId).run();
  return result.meta.changes > 0;
}
