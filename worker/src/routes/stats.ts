import { Hono, type Context } from "hono";
import type { AppBindings } from "../env";
import { ok, validationFailed } from "../lib/http";
import { monthlyCostQuery } from "../lib/schemas";
import { costSummary, monthlyCost } from "../services/stats";

export async function monthlyCostHandler(c: Context<AppBindings>, query: Record<string, string>) {
  const parsed = monthlyCostQuery.safeParse(query);
  if (!parsed.success) return validationFailed(c, parsed.error);
  const { title, ...result } = await monthlyCost(c.env.DB, c.get("user"), parsed.data.year, parsed.data.month);
  return ok(c, title, result);
}

export const statsRoutes = new Hono<AppBindings>();

statsRoutes.get("/monthly-cost", (c) => monthlyCostHandler(c, c.req.query()));
statsRoutes.get("/summary", async (c) => ok(c, "summary", await costSummary(c.env.DB, c.get("user"))));
