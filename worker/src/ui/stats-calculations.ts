import { isCycleId, todayUtc } from "../lib/dates";
import { convertPrice, pricePerMonth } from "../lib/pricing";
import { periodBudget } from "../services/budget";
import type { Translate } from "./i18n";
import type { UiCtx } from "./context";

/*
  Port of includes/stats_calculations.php, shared by the dashboard and the
  statistics page: per-month totals, counts and costs per category, member
  and payment method, savings from inactive subscriptions (minus their
  replacements), the amount still due this month, and both budgets.
*/

export interface StatsFilters {
  member?: number[];
  category?: number[];
  payment?: number[];
}

export interface Named {
  id: number;
  name: string;
  count: number;
  cost: number;
  icon?: string | null;
  order?: number;
}

export interface LogoRef {
  name: string;
  price: number;
  logo: string | null;
  logo_text_color: string | null;
  logo_variant: string | null;
}

export interface Stats {
  categories: Map<number, Named>;
  members: Map<number, Named>;
  /** Enabled payment methods; count is active, recurring subscriptions using them. */
  paymentMethods: Map<number, Named>;
  menuCounts: { category: Map<number, number>; member: Map<number, number>; payment: Map<number, number> };
  subtitle: string;
  activeSubscriptions: number;
  inactiveSubscriptions: number;
  totalCostPerMonth: number;
  totalCostPerYear: number;
  averageSubscriptionCost: number;
  totalSavingsPerMonth: number;
  amountDueThisMonth: number;
  mostExpensive: LogoRef | null;
  usesMultipleCurrencies: boolean;
  /** Several currencies but no exchange-rate provider configured. */
  showCantConvertMessage: boolean;
  budgetPeriodLabel: string;
  budgetPeriodStart: string;
  budgetPeriodEnd: string;
  periodDiffersFromCalendarMonth: boolean;
  amountNeededThisPeriod: number;
  monthly: { budget: number; left: number; used: number; over: number } | null;
  period: { budget: number; left: number; used: number; over: number } | null;
  vsMonthlyBudgetDataPoints: { label: string; y: number }[];
  vsPeriodBudgetDataPoints: { label: string; y: number }[];
  totalMonthlyCostDataPoints: { label: string; y: number }[];
}

interface Row {
  id: number;
  name: string;
  price: number;
  logo: string | null;
  logo_text_color: string | null;
  logo_variant: string | null;
  frequency: number | null;
  cycle: number | null;
  currency_id: number | null;
  next_payment: string | null;
  payer_user_id: number | null;
  category_id: number | null;
  payment_method_id: number | null;
  inactive: number;
  replacement_subscription_id: number | null;
}

function daysBetween(a: string, b: string): number {
  return Math.round((Date.parse(`${b}T00:00:00Z`) - Date.parse(`${a}T00:00:00Z`)) / 86_400_000);
}

export async function calculateStats(c: UiCtx, t: Translate, filters: StatsFilters = {}, today = todayUtc()): Promise<Stats> {
  const db = c.env.DB;
  const user = c.get("user");
  const userId = user.id;

  const [categoriesRes, methodsRes, membersRes, catCounts, memberCounts, paymentCounts, currenciesRes, profileRes, fixerRes, yearlyRes] = await db.batch<
    Record<string, unknown>
  >([
    db.prepare('SELECT id, name, "order" FROM categories WHERE user_id = ? ORDER BY "order" ASC').bind(userId),
    db.prepare("SELECT id, name, icon FROM payment_methods WHERE user_id = ? AND enabled = 1").bind(userId),
    db.prepare("SELECT id, name FROM household WHERE user_id = ?").bind(userId),
    db.prepare("SELECT category_id AS id, COUNT(*) AS n FROM subscriptions WHERE user_id = ? GROUP BY category_id").bind(userId),
    db.prepare("SELECT payer_user_id AS id, COUNT(*) AS n FROM subscriptions WHERE user_id = ? GROUP BY payer_user_id").bind(userId),
    db.prepare("SELECT payment_method_id AS id, COUNT(*) AS n FROM subscriptions WHERE user_id = ? AND inactive = 0 GROUP BY payment_method_id").bind(userId),
    db.prepare("SELECT id, rate FROM currencies WHERE user_id = ?").bind(userId),
    db.prepare("SELECT main_currency, budget, period_budget FROM user WHERE id = ?").bind(userId),
    db.prepare("SELECT 1 AS ok FROM fixer WHERE user_id = ?").bind(userId),
    db.prepare("SELECT 1 AS ok FROM sqlite_master WHERE type = 'table' AND name = 'total_yearly_cost'"),
  ]);

  const named = (rows: Record<string, unknown>[] | undefined) =>
    new Map((rows ?? []).map((r) => [r.id as number, { id: r.id as number, name: r.name as string, count: 0, cost: 0, icon: (r.icon as string) ?? null, order: r.order as number }]));
  const categories = named(categoriesRes?.results);
  const paymentMethods = named(methodsRes?.results);
  const members = named(membersRes?.results);
  const counts = (rows: Record<string, unknown>[] | undefined) => new Map((rows ?? []).map((r) => [r.id as number, r.n as number]));
  const rates = new Map((currenciesRes?.results ?? []).map((r) => [r.id as number, Number(r.rate)]));
  const profile = (profileRes?.results[0] ?? {}) as { main_currency: number | null; budget: number | null; period_budget: number | null };

  // Filters, as the ?member=&category=&payment= query of the statistics page.
  const where = ["user_id = ?"];
  const params: unknown[] = [userId];
  const subtitleParts: string[] = [];
  for (const [column, ids, lookup] of [
    ["payer_user_id", filters.member, members],
    ["category_id", filters.category, categories],
    ["payment_method_id", filters.payment, paymentMethods],
  ] as const) {
    if (!ids?.length) continue;
    where.push(`${column} IN (${ids.map(() => "?").join(", ")})`);
    params.push(...ids);
    for (const id of ids) {
      const item = lookup.get(id);
      if (item) subtitleParts.push(item.name);
    }
  }
  const rows = (
    await db
      .prepare(
        `SELECT id, name, price, logo, logo_text_color, logo_variant, frequency, cycle, currency_id, next_payment, payer_user_id,
                category_id, payment_method_id, inactive, replacement_subscription_id
           FROM subscriptions WHERE ${where.join(" AND ")}`,
      )
      .bind(...params)
      .all<Row>()
  ).results;
  const byId = new Map(rows.map((r) => [r.id, r]));

  const convert = (price: number, currency: number | null) => (currency === profile.main_currency ? price : convertPrice(price, rates.get(currency ?? -1)));
  const perMonth = (row: { cycle: number | null; frequency: number | null; price: number; currency_id: number | null }) =>
    isCycleId(row.cycle ?? 0) ? pricePerMonth(row.cycle as 1, row.frequency ?? 1, convert(row.price, row.currency_id)) : 0;

  const endOfMonth = new Date(Date.UTC(Number(today.slice(0, 4)), Number(today.slice(5, 7)), 0)).toISOString().slice(0, 10);
  let active = 0;
  let inactive = 0;
  let totalCostPerMonth = 0;
  let totalSavingsPerMonth = 0;
  let replacementsCost = 0;
  let amountDueThisMonth = 0;
  let usesMultipleCurrencies = false;
  let mostExpensive: LogoRef | null = null;
  const countedReplacements = new Set<number | null>();

  for (const row of rows) {
    if (row.currency_id !== profile.main_currency) usesMultipleCurrencies = true;
    const member = members.get(row.payer_user_id ?? -1);
    const category = categories.get(row.category_id ?? -1);
    const method = paymentMethods.get(row.payment_method_id ?? -1);
    if (member) member.count++;
    if (category) category.count++;
    const original = convert(row.price, row.currency_id);
    const monthly = perMonth(row);

    if (!row.inactive) {
      if (row.cycle !== 5) {
        active++;
        if (method) method.count++;
      }
      totalCostPerMonth += monthly;
      if (member) member.cost += monthly;
      if (category) category.cost += monthly;
      if (!mostExpensive || monthly > mostExpensive.price) {
        mostExpensive = { name: row.name, price: monthly, logo: row.logo, logo_text_color: row.logo_text_color, logo_variant: row.logo_variant };
      }
      // What is still due between today and the end of the month.
      if (row.cycle !== 5 && row.next_payment && row.next_payment >= today && row.next_payment <= endOfMonth) {
        let times = 1;
        const daysRemaining = daysBetween(row.next_payment, endOfMonth) + 1;
        if (row.cycle === 1) times = daysRemaining / (row.frequency ?? 1);
        if (row.cycle === 2) times = Math.ceil(daysRemaining / 7) / (row.frequency ?? 1);
        amountDueThisMonth += original * times;
      }
    } else {
      inactive++;
      totalSavingsPerMonth += monthly;
      const replacementId = row.replacement_subscription_id;
      if (replacementId && !countedReplacements.has(replacementId)) {
        const replacement =
          byId.get(replacementId) ??
          (await db
            .prepare("SELECT price, currency_id, cycle, frequency FROM subscriptions WHERE id = ? AND user_id = ?")
            .bind(replacementId, userId)
            .first<Row>());
        if (replacement) replacementsCost += perMonth(replacement);
      }
      countedReplacements.add(replacementId);
    }
  }
  totalSavingsPerMonth -= replacementsCost;
  const totalCostPerYear = active > 0 ? totalCostPerMonth * 12 : 0;
  const averageSubscriptionCost = active > 0 ? totalCostPerMonth / active : 0;

  const budget = await periodBudget(db, user, today);
  const monthStart = `${today.slice(0, 8)}01`;
  const periodDiffersFromCalendarMonth = budget.period_start !== monthStart || budget.period_end !== endOfMonth;
  const amountNeededThisPeriod = budget.amount_needed_this_period;

  let monthlyBudget: Stats["monthly"] = null;
  let vsMonthly: Stats["vsMonthlyBudgetDataPoints"] = [];
  if (profile.budget && profile.budget > 0) {
    const b = profile.budget;
    monthlyBudget = { budget: b, left: Math.max(0, b - totalCostPerMonth), used: Math.min(100, (totalCostPerMonth / b) * 100), over: Math.max(0, totalCostPerMonth - b) };
    vsMonthly = [
      { label: t("budget_remaining"), y: monthlyBudget.left },
      { label: t("monthly_cost"), y: totalCostPerMonth },
    ];
  }
  let period: Stats["period"] = null;
  let vsPeriod: Stats["vsPeriodBudgetDataPoints"] = [];
  if (periodDiffersFromCalendarMonth && profile.period_budget && profile.period_budget > 0) {
    const b = profile.period_budget;
    period = { budget: b, left: Math.max(0, b - amountNeededThisPeriod), used: Math.min(100, (amountNeededThisPeriod / b) * 100), over: Math.max(0, amountNeededThisPeriod - b) };
    vsPeriod = [
      { label: t("budget_remaining"), y: period.left },
      { label: t("amount_needed_this_period"), y: amountNeededThisPeriod },
    ];
  }

  // Yearly cost history arrives with phase 7 (total_yearly_cost).
  let totalMonthlyCostDataPoints: Stats["totalMonthlyCostDataPoints"] = [];
  if (yearlyRes?.results.length) {
    const history = await db.prepare("SELECT date, cost FROM total_yearly_cost WHERE user_id = ? ORDER BY date").bind(userId).all<{ date: string; cost: number }>();
    totalMonthlyCostDataPoints = history.results.map((r) => ({ label: String(r.date), y: Math.round((r.cost / 12) * 100) / 100 }));
  }

  return {
    categories,
    members,
    paymentMethods,
    menuCounts: { category: counts(catCounts?.results), member: counts(memberCounts?.results), payment: counts(paymentCounts?.results) },
    subtitle: subtitleParts.length ? `(${subtitleParts.join(", ")})` : "",
    activeSubscriptions: active,
    inactiveSubscriptions: inactive,
    totalCostPerMonth,
    totalCostPerYear,
    averageSubscriptionCost,
    totalSavingsPerMonth,
    amountDueThisMonth,
    mostExpensive,
    usesMultipleCurrencies,
    showCantConvertMessage: usesMultipleCurrencies && !fixerRes?.results.length,
    budgetPeriodLabel: budget.period_label,
    budgetPeriodStart: budget.period_start,
    budgetPeriodEnd: budget.period_end,
    periodDiffersFromCalendarMonth,
    amountNeededThisPeriod,
    monthly: monthlyBudget,
    period,
    vsMonthlyBudgetDataPoints: vsMonthly,
    vsPeriodBudgetDataPoints: vsPeriod,
    totalMonthlyCostDataPoints,
  };
}
