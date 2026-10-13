import { todayUtc } from "../lib/dates";

/*
  Exchange-rate refresh, ported from endpoints/cronjobs/updateexchange.php and
  includes/frankfurter.php.

  A currency's rate is "units of it per one unit of the user's main
  currency". Fixer and APILayer answer against EUR, so their numbers are
  divided by the main currency's EUR rate; Frankfurter is asked in the main
  currency directly. Providers keep PHP Wallos' numbering (stored in the
  `fixer` table): 0 Fixer.io, 1 APILayer, 2 Frankfurter. No row means the
  user maintains rates by hand.
*/

export const PROVIDERS: Record<number, string> = { 0: "Fixer.io", 1: "APILayer.com", 2: "Frankfurter" };

export interface RatesResult {
  rates: Record<string, number>;
  /** Codes the provider would not price; their stored rate is kept. */
  held: string[];
}

export class RatesError extends Error {}

async function getJson(url: string, headers: Record<string, string> = {}): Promise<{ status: number; body: unknown }> {
  const response = await fetch(url, { headers, signal: AbortSignal.timeout(15_000) });
  return { status: response.status, body: await response.json().catch(() => null) };
}

/** Codes Frankfurter can be asked about (three letters); the rest would make it refuse the whole request. */
function partitionCodes(codes: string[]): [string[], string[]] {
  const accepted: string[] = [];
  const rejected: string[] = [];
  for (const code of codes) (/^[A-Za-z]{3}$/.test(code) ? accepted : rejected).push(code.toUpperCase());
  return [accepted, rejected];
}

async function frankfurter(base: string, codes: string[]): Promise<RatesResult> {
  let [ask, held] = partitionCodes(codes.filter((c) => c.toUpperCase() !== base));
  if (ask.length === 0) return { rates: { [base]: 1 }, held };

  const url = (quotes: string[]) =>
    `https://api.frankfurter.dev/v2/rates?base=${encodeURIComponent(base)}&quotes=${encodeURIComponent(quotes.join(","))}`;
  let response = await getJson(url(ask));

  // A 422 names every code it refused ("invalid currency: ETH,XYZ"); retry once without them.
  if (response.status === 422) {
    const message = (response.body as { message?: string } | null)?.message ?? "";
    const refused = (/invalid currency:\s*(.+)$/i.exec(message)?.[1] ?? "").split(",").map((c) => c.trim().toUpperCase()).filter(Boolean);
    const retry = ask.filter((c) => !refused.includes(c));
    if (refused.length > 0 && retry.length > 0) {
      held = [...new Set([...held, ...refused])];
      ask = retry;
      response = await getJson(url(ask));
    }
  }

  // v2 answers [{"date","base","quote","rate"}, ...]; an unknown base answers 200 with [].
  const records = Array.isArray(response.body) ? (response.body as { quote?: string; rate?: number }[]) : [];
  const rates: Record<string, number> = {};
  for (const record of records) {
    if (record.quote && typeof record.rate === "number") rates[record.quote.toUpperCase()] = record.rate;
  }
  if (Object.keys(rates).length === 0) {
    const message = (response.body as { message?: string } | null)?.message;
    throw new RatesError(`Frankfurter returned no rates for base ${base}${message ? `: ${message}` : ""} (HTTP ${response.status}).`);
  }
  for (const code of ask) if (!(code in rates)) held.push(code);
  rates[base] = 1;
  return { rates, held };
}

async function eurBased(provider: 0 | 1, apiKey: string, base: string, codes: string[]): Promise<RatesResult> {
  if (!apiKey) throw new RatesError(`${PROVIDERS[provider]} needs an API key.`);
  const symbols = encodeURIComponent([...new Set([...codes, base])].join(","));
  const response =
    provider === 1
      ? await getJson(`https://api.apilayer.com/fixer/latest?base=EUR&symbols=${symbols}`, { apikey: apiKey })
      : // Fixer's free plan only serves plain http.
        await getJson(`http://data.fixer.io/api/latest?access_key=${encodeURIComponent(apiKey)}&base=EUR&symbols=${symbols}`);

  const body = response.body as { rates?: Record<string, number>; error?: { info?: string; type?: string }; message?: string } | null;
  const eurRates = body?.rates;
  if (!eurRates || typeof eurRates[base] !== "number") {
    const detail = body?.error?.info ?? body?.error?.type ?? body?.message ?? `HTTP ${response.status}`;
    throw new RatesError(`${PROVIDERS[provider]} returned no usable rates: ${detail}`);
  }
  const mainToEur = eurRates[base];
  const rates: Record<string, number> = {};
  for (const [code, rate] of Object.entries(eurRates)) rates[code] = code === base ? 1 : rate / mainToEur;
  return { rates, held: codes.filter((c) => !(c in rates)) };
}

export async function fetchRates(provider: number, apiKey: string, base: string, codes: string[]): Promise<RatesResult> {
  if (provider === 2) return frankfurter(base, codes);
  if (provider === 0 || provider === 1) return eurBased(provider, apiKey, base, codes);
  throw new RatesError(`Unknown exchange-rate provider ${provider}.`);
}

export type RefreshResult =
  | { status: "updated"; updated: number; held: string[]; date: string }
  | { status: "skipped"; reason: "manual" | "fresh" | "no_main_currency" }
  | { status: "failed"; error: string };

/** Refreshes one user's rates; at most once a day unless forced. */
export async function refreshUserRates(db: D1Database, userId: number, options: { force?: boolean; today?: string } = {}): Promise<RefreshResult> {
  const today = options.today ?? todayUtc();
  const [settings, last, currencies, main] = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT provider, api_key FROM fixer WHERE user_id = ?").bind(userId),
    db.prepare("SELECT date FROM last_exchange_update WHERE user_id = ?").bind(userId),
    db.prepare("SELECT code FROM currencies WHERE user_id = ?").bind(userId),
    db.prepare("SELECT c.code FROM user u JOIN currencies c ON c.id = u.main_currency AND c.user_id = u.id WHERE u.id = ?").bind(userId),
  ]);
  const config = settings?.results[0] as { provider: number; api_key: string } | undefined;
  if (!config) return { status: "skipped", reason: "manual" };
  if (!options.force && last?.results[0]?.date === today) return { status: "skipped", reason: "fresh" };
  const base = (main?.results[0]?.code as string | undefined)?.toUpperCase();
  if (!base) return { status: "skipped", reason: "no_main_currency" };

  const codes = [...new Set((currencies?.results ?? []).map((r) => String(r.code).toUpperCase()))];
  let result: RatesResult;
  try {
    result = await fetchRates(config.provider, config.api_key, base, codes);
  } catch (error) {
    return { status: "failed", error: error instanceof Error ? error.message : String(error) };
  }

  const updates = Object.entries(result.rates)
    .filter(([code]) => codes.includes(code))
    .map(([code, rate]) => db.prepare("UPDATE currencies SET rate = ? WHERE user_id = ? AND upper(code) = ?").bind(rate, userId, code));
  // Rates and their refresh date are one unit: all or nothing.
  await db.batch([
    ...updates,
    db
      .prepare("INSERT OR REPLACE INTO last_exchange_update (user_id, date, held) VALUES (?, ?, ?)")
      .bind(userId, today, result.held.join(",")),
  ]);
  return { status: "updated", updated: updates.length, held: result.held, date: today };
}

/** Daily job: every user with a provider configured. */
export async function runExchangeRates(db: D1Database, today = todayUtc()) {
  const users = await db.prepare("SELECT user_id FROM fixer").all<{ user_id: number }>();
  const results: Record<number, RefreshResult> = {};
  for (const { user_id } of users.results) {
    results[user_id] = await refreshUserRates(db, user_id, { today });
  }
  return results;
}
