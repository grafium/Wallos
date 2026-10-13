import { Hono, type Context } from "hono";
import type { AppBindings } from "../env";
import { ok, validationFailed } from "../lib/http";
import { monthlyCostQuery, periodBudgetQuery } from "../lib/schemas";
import { periodBudget } from "../services/budget";
import { costSummary, monthlyCost } from "../services/stats";

export async function monthlyCostHandler(c: Context<AppBindings>, query: Record<string, string>) {
  const parsed = monthlyCostQuery.safeParse(query);
  if (!parsed.success) return validationFailed(c, parsed.error);
  const { title, ...result } = await monthlyCost(c.env.DB, c.get("user"), parsed.data.year, parsed.data.month);
  return ok(c, title, result);
}

export async function periodBudgetHandler(c: Context<AppBindings>, query: Record<string, string>) {
  const parsed = periodBudgetQuery.safeParse(query);
  if (!parsed.success) return validationFailed(c, parsed.error);
  return ok(c, "period_budget", await periodBudget(c.env.DB, c.get("user"), parsed.data.reference_date));
}

export const statsRoutes = new Hono<AppBindings>();

statsRoutes.get("/monthly-cost", (c) => monthlyCostHandler(c, c.req.query()));
statsRoutes.get("/period-budget", (c) => periodBudgetHandler(c, c.req.query()));
statsRoutes.get("/summary", async (c) => ok(c, "summary", await costSummary(c.env.DB, c.get("user"))));
