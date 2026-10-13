import { Hono, type Context } from "hono";
import { z } from "zod";
import type { AppBindings } from "../env";
import { fail, ok, readBody, validationFailed } from "../lib/http";
import { PROVIDERS, refreshUserRates } from "../services/exchange-rates";

type Ctx = Context<AppBindings>;

const MASK = "********";

const providerSchema = z.object({
  // 0 Fixer.io, 1 APILayer, 2 Frankfurter (no key), "manual" = no automatic refresh.
  provider: z.union([z.literal("manual"), z.coerce.number().int().min(0).max(2)]),
  api_key: z.string().trim().max(255).optional(),
});

async function currentSettings(c: Ctx) {
  const [row, last] = await Promise.all([
    c.env.DB.prepare("SELECT provider, api_key FROM fixer WHERE user_id = ?").bind(c.get("user").id).first<{ provider: number; api_key: string }>(),
    c.env.DB.prepare("SELECT date, held FROM last_exchange_update WHERE user_id = ?").bind(c.get("user").id).first<{ date: string; held: string }>(),
  ]);
  return {
    provider: row ? row.provider : "manual",
    provider_name: row ? PROVIDERS[row.provider] : "Manual",
    api_key: row?.api_key ? MASK : "",
    last_update: last?.date ?? null,
    held: last?.held ? last.held.split(",") : [],
  };
}

/** api/fixer/get_fixer.php */
export async function legacyGetFixer(c: Ctx) {
  const settings = await currentSettings(c);
  if (settings.provider === "manual") return ok(c, "fixer", { fixer: null, notes: ["No exchange-rate provider is configured."] });
  return ok(c, "fixer", { fixer: { api_key: settings.api_key, provider: settings.provider, provider_name: settings.provider_name }, notes: [] });
}

async function saveProvider(c: Ctx, provider: number | "manual", apiKey: string | undefined) {
  const userId = c.get("user").id;
  if (provider === "manual") {
    await c.env.DB.prepare("DELETE FROM fixer WHERE user_id = ?").bind(userId).run();
    return;
  }
  // Frankfurter needs no key; "********" keeps the stored one.
  const key = provider === 2 ? "" : apiKey;
  if (key === MASK || key === undefined) {
    await c.env.DB.prepare(
      "INSERT INTO fixer (user_id, provider, api_key) VALUES (?, ?, '') ON CONFLICT(user_id) DO UPDATE SET provider = excluded.provider",
    )
      .bind(userId, provider)
      .run();
  } else {
    await c.env.DB.prepare("INSERT OR REPLACE INTO fixer (user_id, provider, api_key) VALUES (?, ?, ?)").bind(userId, provider, key).run();
  }
}

/** api/fixer/set_fixer.php: fixer_api_key + provider (default 0). */
export async function legacySetFixer(c: Ctx, params: Record<string, string>) {
  const parsed = providerSchema.safeParse({ provider: params.provider ?? "0", api_key: params.fixer_api_key ?? "" });
  if (!parsed.success) return validationFailed(c, parsed.error);
  await saveProvider(c, parsed.data.provider, parsed.data.api_key);
  return ok(c, "Fixer settings updated", { message: "Fixer API key has been saved." });
}

export const exchangeRateRoutes = new Hono<AppBindings>();

exchangeRateRoutes.get("/", async (c) => ok(c, "exchange_rates", { ...(await currentSettings(c)), providers: PROVIDERS }));

exchangeRateRoutes.put("/", async (c) => {
  const parsed = providerSchema.safeParse(await readBody(c));
  if (!parsed.success) return validationFailed(c, parsed.error);
  if ((parsed.data.provider === 0 || parsed.data.provider === 1) && !parsed.data.api_key) {
    const existing = await c.env.DB.prepare("SELECT api_key FROM fixer WHERE user_id = ?").bind(c.get("user").id).first<{ api_key: string }>();
    if (!existing?.api_key) return fail(c, 400, "Missing parameter", `${PROVIDERS[parsed.data.provider]} needs an API key.`, { fields: ["api_key"] });
  }
  await saveProvider(c, parsed.data.provider, parsed.data.api_key);
  return ok(c, "Exchange rate settings saved", await currentSettings(c));
});

/** Refreshes now, regardless of whether today's rates were already fetched. */
exchangeRateRoutes.post("/refresh", async (c) => {
  const result = await refreshUserRates(c.env.DB, c.get("user").id, { force: true });
  if (result.status === "failed") return fail(c, 502, "Exchange rates update failed", result.error);
  if (result.status === "skipped") {
    return fail(c, 409, "Not refreshed", result.reason === "manual" ? "No exchange-rate provider is configured." : "The main currency is not set.");
  }
  return ok(c, "Exchange rates updated", result);
});
