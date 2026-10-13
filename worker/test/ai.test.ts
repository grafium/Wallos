import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { runScheduled } from "../src/cron";
import { decodeProviderResponse, extractJson, normalizeRecommendations } from "../src/services/ai";
import { storeTotalYearlyCost } from "../src/services/cost-history";
import { browserSession, endpoint, getPage, raw, type Browser, type Json } from "./ui-helpers";

/*
  Phase 7: yearly cost history and AI recommendations.
*/

async function api(browser: Browser, path: string, json?: unknown, method = json === undefined ? "GET" : "POST", environment: object = env) {
  const response = await raw(
    path,
    {
      method,
      headers: { authorization: `Bearer ${browser.token}`, ...(json === undefined ? {} : { "content-type": "application/json" }) },
      body: json === undefined ? undefined : JSON.stringify(json),
    },
    environment,
  );
  return { status: response.status, body: (await response.json()) as Json };
}

async function currencyId(browser: Browser, code: string): Promise<number> {
  return (await env.DB.prepare("SELECT id FROM currencies WHERE user_id = ? AND code = ?").bind(browser.userId, code).first<{ id: number }>())!.id;
}

async function addSubscription(browser: Browser, fields: Record<string, unknown>) {
  const res = await api(browser, "/api/subscriptions", { next_payment: "2030-01-01", ...fields });
  expect(res.status, JSON.stringify(res.body)).toBe(201);
  return res.body;
}

type Call = { url: string; body: Json | null; headers: Headers };
let calls: Call[] = [];

/** Mocks outbound fetch; `reply` answers each call. */
function provider(reply: (call: Call) => Response | Promise<Response>) {
  calls = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
    const url = String(input instanceof Request ? input.url : input);
    let body: Json | null = null;
    try {
      body = init?.body ? JSON.parse(String(init.body)) : null;
    } catch {
      body = null;
    }
    const call = { url, body, headers: new Headers(init?.headers) };
    calls.push(call);
    return reply(call);
  });
}

const RECOMMENDATIONS = [
  { title: "Drop YouTube Music", description: "YouTube Premium already includes it.", savings: "10 EUR/month" },
  { title: "Rotate streaming", description: "Keep one streaming service at a time.", savings: 15 },
];
const chatReply = (content: string) => Response.json({ choices: [{ message: { role: "assistant", content } }] });

afterEach(() => vi.restoreAllMocks());

describe("yearly cost history", () => {
  let user: Browser;
  beforeAll(async () => {
    user = await browserSession("hist");
    await env.DB.prepare("UPDATE currencies SET rate = 2 WHERE user_id = ? AND code = 'USD'").bind(user.userId).run();
    await addSubscription(user, { name: "Monthly", price: 10, cycle: 3, frequency: 1 });
    await addSubscription(user, { name: "Yearly in USD", price: 240, cycle: 4, frequency: 1, currency_id: await currencyId(user, "USD") });
    await addSubscription(user, { name: "Weekly", price: 1, cycle: 2, frequency: 1 });
    await addSubscription(user, { name: "Lifetime", price: 500, cycle: 5, frequency: 1 });
    await addSubscription(user, { name: "Paused", price: 99, cycle: 3, frequency: 1, inactive: 1 });
  });

  it("stores the yearly cost like storetotalyearlycost.php, once per day", async () => {
    await storeTotalYearlyCost(env.DB, "2026-10-05");
    // 10*12 + 240/2 + 1*4.35*12; the one-time and the inactive ones count nothing.
    const expected = 120 + 120 + 52.2;
    let history = (await api(user, "/api/stats/history")).body.history;
    expect(history).toEqual([{ date: "2026-10-05", yearly_cost: expected, monthly_cost: 24.35, currency_id: expect.any(Number) }]);

    await addSubscription(user, { name: "Another", price: 5, cycle: 3, frequency: 1 });
    await storeTotalYearlyCost(env.DB, "2026-10-05");
    history = (await api(user, "/api/stats/history")).body.history;
    expect(history).toHaveLength(1);
    expect(history[0].yearly_cost).toBe(expected + 60);
  });

  it("runs on Monday's 01:00 UTC tick only, and draws the graph from two points", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({}));
    await runScheduled(env, Date.UTC(2026, 9, 13, 1)); // Tuesday
    expect((await api(user, "/api/stats/history")).body.history).toHaveLength(1);
    await runScheduled(env, Date.UTC(2026, 9, 12, 1)); // Monday
    const history = (await api(user, "/api/stats/history")).body.history;
    expect(history.map((h: Json) => h.date)).toEqual(["2026-10-05", "2026-10-12"]);

    const stats = await getPage(user, "/stats.php");
    expect(stats.html).toMatch(/loadLineGraph\("totalMonthlyCostChart", \[\{"label":"2026-10-05","y":29\.35\},\{"label":"2026-10-12","y":29\.35\}\], "EUR", 1\)/);
  });
});

describe("AI settings", () => {
  it("validates like save_settings.php and never shows the stored key", async () => {
    const user = await browserSession("aiset");
    const save = (json: Json) => endpoint(user, "/endpoints/ai/save_settings.php", { json });
    expect((await save({ ai_enabled: true, ai_type: "nonsense", model: "m" })).json).toEqual({ success: false, message: "Error" });
    expect((await save({ ai_enabled: true, ai_type: "chatgpt", api_key: "", model: "gpt" })).json).toEqual({ success: false, message: "Invalid API Key." });
    expect((await save({ ai_enabled: true, ai_type: "ollama", ollama_host: "http://192.168.1.5:11434", model: "llama3" })).json!.message).toMatch(/^Invalid Host/);
    expect((await save({ ai_enabled: true, ai_type: "chatgpt", api_key: "sk-1", model: "" })).json).toEqual({ success: false, message: "Please fill all mandatory fields" });
    expect((await save({ ai_enabled: true, ai_type: "chatgpt", api_key: "sk-secret", model: "gpt-4o-mini", ai_run_schedule: "weekly" })).json).toEqual({ success: true, message: "Success", enabled: true });

    const page = await getPage(user, "/settings.php");
    expect(page.html).not.toContain("sk-secret");
    expect(page.html).toMatch(/id="ai_api_key"[^>]*value="\*\*\*\*\*\*\*\*"/);
    expect(page.html).toContain('<option value="gpt-4o-mini" selected="">gpt-4o-mini</option>');
    expect(page.html).not.toContain('value="workers-ai"');
    const withAi = await raw("/settings.php", { headers: { cookie: user.cookie } }, { ...env, AI: { run: async () => ({}) } });
    expect(await withAi.text()).toContain('<option value="workers-ai">Cloudflare Workers AI</option>');

    // The mask keeps the stored key; Ollama drops it.
    expect((await save({ ai_enabled: false, ai_type: "chatgpt", api_key: "********", model: "gpt-4o", ai_run_schedule: "monthly" })).json!.success).toBe(true);
    expect(await env.DB.prepare("SELECT api_key, model, enabled, run_schedule FROM ai_settings WHERE user_id = ?").bind(user.userId).first()).toEqual({
      api_key: "sk-secret",
      model: "gpt-4o",
      enabled: 0,
      run_schedule: "monthly",
    });
    expect((await api(user, "/api/ai/settings")).body.ai_settings).toMatchObject({ type: "chatgpt", api_key: "********" });
  });

  it("lists models from each provider's own format", async () => {
    const user = await browserSession("aimodels");
    provider((call) => {
      if (call.url === "https://api.openai.com/v1/models") return Response.json({ data: [{ id: "gpt-4o" }, { id: "gpt-4o-mini" }] });
      if (call.url.startsWith("https://generativelanguage.googleapis.com/v1beta/models?key=g-key")) return Response.json({ models: [{ name: "models/gemini-2.0-flash", displayName: "Gemini 2.0 Flash" }] });
      if (call.url === "https://ollama.example.com/api/tags") return Response.json({ models: [{ name: "llama3.2:latest" }] });
      return new Response("nope", { status: 401 });
    });
    const models = (json: Json) => endpoint(user, "/endpoints/ai/fetch_models.php", { json });
    expect((await models({ type: "chatgpt", api_key: "sk" })).json).toEqual({ success: true, models: [{ id: "gpt-4o", name: "gpt-4o" }, { id: "gpt-4o-mini", name: "gpt-4o-mini" }] });
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer sk");
    expect((await models({ type: "gemini", api_key: "g-key" })).json).toEqual({ success: true, models: [{ id: "gemini-2.0-flash", name: "Gemini 2.0 Flash" }] });
    expect((await models({ type: "ollama", ollama_host: "https://ollama.example.com/" })).json).toEqual({ success: true, models: [{ id: "llama3.2:latest", name: "llama3.2:latest" }] });
    expect((await models({ type: "openrouter", api_key: "bad" })).json).toEqual({ success: false, message: "Invalid API Key." });
    expect((await models({ type: "workers-ai" })).json!.success).toBe(false);
    const workersAi = await raw(
      "/endpoints/ai/fetch_models.php",
      { method: "POST", headers: { cookie: user.cookie, "x-csrf-token": user.csrf, "content-type": "application/json" }, body: JSON.stringify({ type: "workers-ai" }) },
      { ...env, AI: { run: async () => ({}) } },
    );
    expect(((await workersAi.json()) as Json).models[0].id).toMatch(/^@cf\//);
  });
});

describe("AI recommendations", () => {
  async function aiUser(prefix: string, settings: Json = { ai_type: "chatgpt", api_key: "sk-test", model: "gpt-4o-mini" }) {
    const user = await browserSession(prefix);
    await addSubscription(user, { name: "YouTube Premium", price: 11.99, cycle: 3, frequency: 1 });
    await addSubscription(user, { name: "YouTube Music", price: 10.99, cycle: 3, frequency: 1 });
    await addSubscription(user, { name: "Photoshop lifetime", price: 600, cycle: 5, frequency: 1 });
    expect((await endpoint(user, "/endpoints/ai/save_settings.php", { json: { ai_enabled: true, ai_run_schedule: "weekly", ...settings } })).json!.success).toBe(true);
    return user;
  }

  it("asks the provider with PHP's prompt, stores the answer and shows it on the dashboard", async () => {
    const user = await aiUser("airec");
    provider(() => chatReply("```json\n" + JSON.stringify(RECOMMENDATIONS) + "\n```"));
    const res = await endpoint(user, "/endpoints/ai/generate_recommendations.php", { method: "POST" });
    expect(res.json).toMatchObject({ success: true, message: "Success", recommendations: [{ title: "Drop YouTube Music" }, { title: "Rotate streaming", savings: "15" }] });

    expect(calls[0]!.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(calls[0]!.headers.get("authorization")).toBe("Bearer sk-test");
    const prompt = calls[0]!.body!.messages[0].content as string;
    expect(calls[0]!.body!.model).toBe("gpt-4o-mini");
    expect(prompt).toContain("give 3 to 7 smart and specific recommendations");
    expect(prompt).toContain("all text should be in the user's language: English");
    expect(prompt).toContain('"price": "11.99 EUR"');
    expect(prompt).toContain('"frequency": "One-time purchase (lifetime)"');

    const dashboard = await getPage(user, "/index.php");
    expect(dashboard.html).toContain("Drop YouTube Music");
    expect(dashboard.html).toContain("YouTube Premium already includes it.");

    const stored = (await api(user, "/api/ai/recommendations")).body.recommendations as Json[];
    expect(stored).toHaveLength(2);
    expect((await endpoint(user, "/endpoints/ai/delete_recommendation.php", { json: { id: stored[0]!.id } })).json).toEqual({ success: true, message: "Success" });
    const other = await browserSession("aiother");
    expect((await endpoint(other, "/endpoints/ai/delete_recommendation.php", { json: { id: stored[1]!.id } })).json).toEqual({ success: false, message: "Error" });
    expect((await api(user, "/api/ai/recommendations")).body.recommendations).toHaveLength(1);
  });

  it("reports provider errors and unusable answers without touching what is stored", async () => {
    const user = await aiUser("aierr");
    provider(() => Response.json({ error: { message: "Incorrect API key provided" } }, { status: 401 }));
    expect((await endpoint(user, "/endpoints/ai/generate_recommendations.php", { method: "POST" })).json).toEqual({
      success: false,
      message: "AI provider error (HTTP 401): Incorrect API key provided",
    });
    vi.restoreAllMocks();
    provider(() => chatReply("I cannot help with that."));
    expect((await endpoint(user, "/endpoints/ai/generate_recommendations.php", { method: "POST" })).json).toMatchObject({
      success: false,
      message: "The AI response did not contain valid recommendations.",
    });
  });

  it("speaks Gemini, Ollama, OpenAI-compatible servers and Workers AI", async () => {
    const gemini = await aiUser("aigem", { ai_type: "gemini", api_key: "g-key", model: "gemini-2.0-flash" });
    provider(() => Response.json({ candidates: [{ content: { parts: [{ text: JSON.stringify(RECOMMENDATIONS) }] } }] }));
    expect((await endpoint(gemini, "/endpoints/ai/generate_recommendations.php", { method: "POST" })).json!.success).toBe(true);
    expect(calls[0]!.url).toBe("https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=g-key");
    vi.restoreAllMocks();

    const ollama = await aiUser("aiollama", { ai_type: "ollama", ollama_host: "https://ollama.example.com", model: "llama3" });
    provider(() => Response.json({ response: JSON.stringify(RECOMMENDATIONS) }));
    expect((await endpoint(ollama, "/endpoints/ai/generate_recommendations.php", { method: "POST" })).json!.success).toBe(true);
    expect(calls[0]!).toMatchObject({ url: "https://ollama.example.com/api/generate", body: { model: "llama3", stream: false } });
    vi.restoreAllMocks();

    const compatible = await aiUser("aicompat", { ai_type: "openai-compatible", ollama_host: "https://llm.example.com/v1/", api_key: "", model: "qwen" });
    // A streamed answer (several JSON documents) is put back together, as ai_decode_provider_response() did.
    const chunks = [...JSON.stringify(RECOMMENDATIONS).match(/.{1,40}/g)!].map((piece) => JSON.stringify({ choices: [{ delta: { content: piece } }] }));
    provider(() => new Response(chunks.map((c) => `data: ${c}`).join("\n\n")));
    expect((await endpoint(compatible, "/endpoints/ai/generate_recommendations.php", { method: "POST" })).json!.success).toBe(true);
    expect(calls[0]!.url).toBe("https://llm.example.com/v1/chat/completions");
    expect(calls[0]!.headers.get("authorization")).toBeNull();
    vi.restoreAllMocks();

    const prompts: string[] = [];
    const ai = { run: async (model: string, input: Json) => (prompts.push(`${model}|${input.messages[0].content.length > 100}`), { response: JSON.stringify(RECOMMENDATIONS) }) };
    const workers = await browserSession("aiworkers");
    await addSubscription(workers, { name: "Netflix", price: 13.99, cycle: 3, frequency: 1 });
    const withAi = { ...env, AI: ai };
    const call = (path: string, json: Json) =>
      raw(path, { method: "POST", headers: { cookie: workers.cookie, "x-csrf-token": workers.csrf, "content-type": "application/json" }, body: JSON.stringify(json) }, withAi).then((r) => r.json() as Promise<Json>);
    expect((await call("/endpoints/ai/save_settings.php", { ai_enabled: true, ai_type: "workers-ai", model: "@cf/meta/llama-3.1-8b-instruct-fast" })).success).toBe(true);
    expect((await call("/endpoints/ai/generate_recommendations.php", {})).success).toBe(true);
    expect(prompts).toEqual(["@cf/meta/llama-3.1-8b-instruct-fast|true"]);
  });

  it("translates the categories except the placeholder, only for other languages", async () => {
    const user = await aiUser("aitr");
    expect((await endpoint(user, "/endpoints/ai/translate_categories.php", { method: "POST" })).json).toEqual({ success: false, message: "Error" });
    await env.DB.prepare("UPDATE user SET language = 'hu' WHERE id = ?").bind(user.userId).run();
    const categories = (await env.DB.prepare("SELECT id, name FROM categories WHERE user_id = ? ORDER BY id").bind(user.userId).all<{ id: number; name: string }>()).results;
    const [placeholder, first, second] = categories;
    provider((call) => {
      const sent = JSON.parse((call.body!.messages[0].content as string).split("Here are the categories:")[1]!) as { id: number; name: string }[];
      expect(sent.map((c) => c.id)).not.toContain(placeholder!.id);
      return chatReply(JSON.stringify([{ id: first!.id, name: "Szórakozás" }, { id: second!.id, name: "" }, { id: placeholder!.id, name: "Hack" }, { id: 999999, name: "Other" }]));
    });
    const res = await endpoint(user, "/endpoints/ai/translate_categories.php", { method: "POST" });
    expect(res.json).toEqual({ success: true, message: "Siker", translations: { [first!.id]: "Szórakozás" } });
    expect(calls[0]!.body!.messages[0].content).toContain("into Magyar");
    const after = (await env.DB.prepare("SELECT id, name FROM categories WHERE user_id = ? ORDER BY id").bind(user.userId).all<{ id: number; name: string }>()).results;
    expect(after[0]!.name).toBe(placeholder!.name);
    expect(after[1]!.name).toBe("Szórakozás");
    expect(after[2]!.name).toBe(second!.name);
  });

  it("runs the scheduled recommendations when due, retrying a failure after a day", async () => {
    await env.DB.prepare("UPDATE ai_settings SET enabled = 0").run();
    const weekly = await aiUser("aiweekly");
    provider(() => chatReply(JSON.stringify(RECOMMENDATIONS)));
    await runScheduled(env, Date.UTC(2026, 9, 13, 5));
    expect(calls.filter((c) => c.url.includes("chat/completions"))).toHaveLength(1);
    const row = await env.DB.prepare("SELECT last_successful_run, last_attempt FROM ai_settings WHERE user_id = ?").bind(weekly.userId).first<Json>();
    expect(row!.last_successful_run).toBeTruthy();

    // Not due again within the week.
    await runScheduled(env, Date.UTC(2026, 9, 13, 6));
    expect(calls.filter((c) => c.url.includes("chat/completions"))).toHaveLength(1);

    // A week later it is, and a failure waits a day before the next try.
    await env.DB.prepare("UPDATE ai_settings SET last_successful_run = datetime('now', '-8 days'), last_attempt = NULL WHERE user_id = ?").bind(weekly.userId).run();
    vi.restoreAllMocks();
    provider(() => new Response("down", { status: 503 }));
    await runScheduled(env, Date.UTC(2026, 9, 13, 7));
    await runScheduled(env, Date.UTC(2026, 9, 13, 8));
    expect(calls.filter((c) => c.url.includes("chat/completions"))).toHaveLength(1);
    expect((await api(weekly, "/api/ai/recommendations")).body.recommendations).toHaveLength(2); // the earlier ones stay
  });

  it("is available over the JSON API", async () => {
    const user = await aiUser("aiapi");
    expect((await api(user, "/api/ai/settings", { enabled: true, type: "openrouter", api_key: "or-key", model: "x/y", run_schedule: "manual" }, "PUT")).body.ai_settings).toMatchObject({
      type: "openrouter",
      api_key: "********",
      run_schedule: "manual",
    });
    provider(() => chatReply(JSON.stringify({ recommendations: RECOMMENDATIONS })));
    const generated = await api(user, "/api/ai/recommendations/generate", {});
    expect(generated.status).toBe(200);
    expect(calls[0]!.url).toBe("https://openrouter.ai/api/v1/chat/completions");
    const id = generated.body.recommendations && (await api(user, "/api/ai/recommendations")).body.recommendations[0].id;
    expect((await api(user, `/api/ai/recommendations/${id}`, undefined, "DELETE")).status).toBe(200);
    expect((await api(user, `/api/ai/recommendations/${id}`, undefined, "DELETE")).status).toBe(404);
  });
});

describe("parsing model output", () => {
  it("finds the JSON in chatty or repeated answers", () => {
    expect(extractJson('Here you go:\n[{"title":"a","description":"b"}]\nHope this helps! [1,2]')).toEqual([{ title: "a", description: "b" }]);
    expect(extractJson("```\n[]\n```")).toEqual([]);
    expect(extractJson("no json at all")).toBeNull();
  });

  it("keeps only complete recommendations", () => {
    expect(normalizeRecommendations([{ title: " t ", description: " d ", savings: null }, { title: "", description: "x" }, { title: { x: 1 }, description: "d" }, "junk"])).toEqual([
      { title: "t", description: "d", savings: "" },
    ]);
  });

  it("reads a provider's error and streamed documents", () => {
    expect(decodeProviderResponse('{"error":{"message":"quota"}}')).toEqual({ error: { message: "quota" } });
    expect(decodeProviderResponse('data: {"choices":[{"delta":{"content":"he"}}]}\n\ndata: {"choices":[{"delta":{"content":"llo"}}]}')).toEqual({
      choices: [{ message: { role: "assistant", content: "hello" }, finish_reason: "stop" }],
    });
  });
});
