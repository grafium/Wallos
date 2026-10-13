import { Hono } from "hono";
import { z } from "zod";
import type { AppBindings } from "../env";
import { fail, ok, readBody, validationFailed } from "../lib/http";
import { searchLogos, SearchError, SOURCES } from "../services/logo-search";

const MASK = "********";

const searchQuery = z.object({
  q: z.string().trim().min(1).max(100),
  source: z.enum([...SOURCES, "all"]).default("all"),
});

export const logoRoutes = new Hono<AppBindings>();

/** GET /api/logos/search?q=netflix&source=all|duckduckgo|brave|google|icons */
logoRoutes.get("/search", async (c) => {
  const parsed = searchQuery.safeParse({ q: c.req.query("q") ?? c.req.query("search"), source: c.req.query("source") || undefined });
  if (!parsed.success) return validationFailed(c, parsed.error);
  const key = await c.env.DB.prepare("SELECT api_key FROM google_search WHERE user_id = ?").bind(c.get("user").id).first<{ api_key: string }>();
  try {
    const results = await searchLogos(parsed.data.q, parsed.data.source, key?.api_key || null);
    return ok(c, "logos", { source: parsed.data.source, results });
  } catch (error) {
    if (error instanceof SearchError) return fail(c, 502, "Logo search failed", error.message);
    throw error;
  }
});

logoRoutes.get("/google-key", async (c) => {
  const row = await c.env.DB.prepare("SELECT api_key FROM google_search WHERE user_id = ?").bind(c.get("user").id).first<{ api_key: string }>();
  return ok(c, "google_search", { configured: Boolean(row?.api_key), api_key: row?.api_key ? MASK : "" });
});

/** Stores the SerpAPI key ("" removes it) that enables the Google source. */
logoRoutes.put("/google-key", async (c) => {
  const parsed = z.object({ api_key: z.string().trim().max(255) }).safeParse(await readBody(c));
  if (!parsed.success) return validationFailed(c, parsed.error);
  if (parsed.data.api_key === MASK) return ok(c, "google_search", { configured: true, api_key: MASK });
  if (parsed.data.api_key === "") {
    await c.env.DB.prepare("DELETE FROM google_search WHERE user_id = ?").bind(c.get("user").id).run();
    return ok(c, "google_search", { configured: false, api_key: "" });
  }
  await c.env.DB.prepare("INSERT OR REPLACE INTO google_search (user_id, api_key) VALUES (?, ?)").bind(c.get("user").id, parsed.data.api_key).run();
  return ok(c, "google_search", { configured: true, api_key: MASK });
});
