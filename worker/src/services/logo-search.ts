/*
  Logo search, ported from endpoints/logos/search.php (DuckDuckGo, Brave),
  google_search.php (SerpAPI) and icon_search.php (selfh.st and Dashboard
  Icons). Every source answers [{thumbnail, image, width, height}].

  The two search engines are scraped and rate-limit aggressively, so results
  are cached for an hour with the Cache API; the icon indexes for a day. The
  icon catalogues are the dependable source - plain JSON indexes on jsDelivr.
*/

export interface LogoResult {
  thumbnail: string;
  image: string;
  width: number | null;
  height: number | null;
}

export const SOURCES = ["duckduckgo", "brave", "google", "icons"] as const;
export type Source = (typeof SOURCES)[number];

const MAX_ICON_RESULTS = 24;
const BROWSER_UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36";

async function cached<T>(key: string, ttlSeconds: number, load: () => Promise<T | null>): Promise<T | null> {
  const cache = typeof caches !== "undefined" ? caches.default : null;
  const request = new Request(`https://wallos-cache.invalid/${encodeURIComponent(key)}`);
  const hit = await cache?.match(request).catch(() => undefined);
  if (hit) return (await hit.json()) as T;
  const fresh = await load();
  if (fresh !== null && cache) {
    await cache
      .put(request, new Response(JSON.stringify(fresh), { headers: { "content-type": "application/json", "cache-control": `max-age=${ttlSeconds}` } }))
      .catch(() => undefined);
  }
  return fresh;
}

async function get(url: string, headers: Record<string, string> = {}): Promise<Response | null> {
  try {
    const response = await fetch(url, { headers: { "user-agent": BROWSER_UA, ...headers }, signal: AbortSignal.timeout(15_000) });
    return response.ok ? response : null;
  } catch {
    return null;
  }
}

const extension = (url: string) => {
  try {
    return new URL(url).pathname.split(".").pop()?.toLowerCase() ?? "";
  } catch {
    return "";
  }
};

// --- DuckDuckGo -----------------------------------------------------------------

async function duckDuckGoOnce(query: string): Promise<LogoResult[] | null> {
  const page = await get(`https://duckduckgo.com/?q=${encodeURIComponent(query)}&ia=images`);
  const vqd = page ? /vqd=["']?([\d-]+)["']?/.exec(await page.text())?.[1] : undefined;
  if (!vqd) return null;
  const params = new URLSearchParams({ l: "us-en", o: "json", q: query, vqd, f: ",,transparent,Wide,", p: "1" });
  const response = await get(`https://duckduckgo.com/i.js?${params}`, { accept: "application/json", referer: "https://duckduckgo.com/" });
  const data = (await response?.json().catch(() => null)) as { results?: { thumbnail?: string; image?: string; width?: number; height?: number }[] } | null;
  if (!data?.results?.length) return null;
  const results = data.results
    .filter((r) => r.image || r.thumbnail)
    .map((r) => ({ thumbnail: r.thumbnail ?? r.image!, image: r.image ?? r.thumbnail!, width: r.width ?? null, height: r.height ?? null }));
  // PNG sources first (likelier to be transparent), keeping relevance order within each group.
  return [...results.filter((r) => extension(r.image) === "png"), ...results.filter((r) => extension(r.image) !== "png")];
}

async function duckDuckGo(term: string): Promise<LogoResult[] | null> {
  return (await duckDuckGoOnce(`${term} logo filetype:png`)) ?? (await duckDuckGoOnce(`${term} logo`));
}

// --- Brave -----------------------------------------------------------------------

async function brave(term: string): Promise<LogoResult[] | null> {
  const response = await get(`https://search.brave.com/images?q=${encodeURIComponent(`${term} logo`)}`, {
    accept: "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
    "accept-language": "en-US,en;q=0.5",
    referer: "https://search.brave.com/",
  });
  if (!response) return null;
  // Results are rendered client-side; the image proxy URLs sit in the page's JS payload.
  const matches = (await response.text()).match(/https:\/\/imgs\.search\.brave\.com\/[A-Za-z0-9_-]+\/rs:fit:[0-9:]+\/[^"'\\\s]+/g) ?? [];
  const urls = [...new Set(matches)].filter((src) => {
    const fit = /\/rs:fit:(\d+):(\d+)/.exec(src);
    return !fit || Math.max(Number(fit[1]), Number(fit[2])) > 64; // skip favicon-sized entries
  });
  return urls.length ? urls.slice(0, 30).map((url) => ({ thumbnail: url, image: url, width: null, height: null })) : null;
}

// --- Google Images via SerpAPI ------------------------------------------------------

export class SearchError extends Error {}

async function google(term: string, apiKey: string): Promise<LogoResult[] | null> {
  const params = new URLSearchParams({ engine: "google_images", q: `${term} logo`, api_key: apiKey, safe: "active", imgar: "w" });
  let response: Response;
  try {
    response = await fetch(`https://serpapi.com/search.json?${params}`, { headers: { "user-agent": "Wallos" }, signal: AbortSignal.timeout(20_000) });
  } catch {
    throw new SearchError("Failed to reach SerpAPI.");
  }
  const data = (await response.json().catch(() => null)) as {
    error?: string;
    images_results?: { thumbnail?: string; original?: string; original_width?: number; original_height?: number }[];
  } | null;
  if (!response.ok || data?.error) throw new SearchError(data?.error ?? "SerpAPI request failed.");
  const results = (data?.images_results ?? [])
    .slice(0, 12)
    .filter((r) => r.original || r.thumbnail)
    .map((r) => ({ thumbnail: r.thumbnail ?? r.original!, image: r.original ?? r.thumbnail!, width: r.original_width ?? null, height: r.original_height ?? null }));
  return results.length ? results : null;
}

// --- icon catalogues ---------------------------------------------------------------------

type SelfhstIndex = { Name?: string; Reference?: string; PNG?: string }[];
type DashboardIndex = { png?: string[] };

async function iconIndex<T>(name: string, url: string): Promise<T | null> {
  return cached<T>(`icon-index:${name}`, 86_400, async () => {
    const response = await get(url, { "user-agent": "Wallos" });
    return ((await response?.json().catch(() => null)) as T | null) ?? null;
  });
}

async function icons(term: string): Promise<LogoResult[] | null> {
  const needle = term.toLowerCase();
  const [selfhst, dashboard] = await Promise.all([
    iconIndex<SelfhstIndex>("selfhst", "https://cdn.jsdelivr.net/gh/selfhst/icons/index.json"),
    iconIndex<DashboardIndex>("dashboard-icons", "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/tree.json"),
  ]);
  const urls: string[] = [];
  for (const icon of Array.isArray(selfhst) ? selfhst : []) {
    const slug = icon.Reference ?? "";
    if (!slug || icon.PNG !== "Yes") continue;
    if ((icon.Name ?? "").toLowerCase().includes(needle) || slug.toLowerCase().includes(needle)) {
      urls.push(`https://cdn.jsdelivr.net/gh/selfhst/icons/png/${slug}.png`);
    }
  }
  for (const file of dashboard?.png ?? []) {
    const slug = file.replace(/\.png$/, "");
    if (/-(light|dark)$/.test(slug)) continue; // theme variants of an icon already listed
    if (slug.toLowerCase().includes(needle)) urls.push(`https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/${file}`);
  }
  const results = [...new Set(urls)].slice(0, MAX_ICON_RESULTS).map((url) => ({ thumbnail: url, image: url, width: null, height: null }));
  return results.length ? results : null;
}

// --- entry point ------------------------------------------------------------------------------

export async function searchLogos(term: string, source: Source | "all", googleKey: string | null): Promise<LogoResult[]> {
  const key = term.trim().toLowerCase();
  const run = (name: Source, load: () => Promise<LogoResult[] | null>, ttl = 3600) => cached<LogoResult[]>(`logo-search:${name}:${key}`, ttl, load);

  switch (source) {
    case "icons":
      return (await icons(term)) ?? [];
    case "duckduckgo":
      return (await run("duckduckgo", () => duckDuckGo(term))) ?? [];
    case "brave":
      return (await run("brave", () => brave(term))) ?? [];
    case "google":
      if (!googleKey) throw new SearchError("Google search is not configured.");
      return (await run("google", () => google(term, googleKey), 86_400)) ?? [];
    case "all":
      // PHP's fallback chain, with the icon catalogues as the last resort.
      return (
        (await run("duckduckgo", () => duckDuckGo(term))) ??
        (await run("brave", () => brave(term))) ??
        (await icons(term)) ??
        []
      );
  }
}
