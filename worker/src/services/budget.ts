import type { AuthUser } from "../env";
import { addDays, clampedDate, diffDays, isCycleId, isValidDate, paymentDatesInRange, todayUtc } from "../lib/dates";
import { convertPrice, roundMoney } from "../lib/pricing";

/*
  Budget periods, ported from includes/budget_period_calculations.php.

  A user budgets per week, fortnight or month. The period is anchored on a
  date: weekly/fortnightly periods repeat every 7/14 days from the anchor,
  monthly periods start on the anchor's day of month (clamped to short
  months). The question answered is "how much will my subscriptions still
  cost until the end of the current period?".

  Like PHP, a subscription that does not renew automatically only counts its
  next payment. Unlike PHP, a one-time payment counts when it falls inside the
  period (PHP never counted it).
*/

export const BUDGET_PERIOD_TYPES = ["weekly", "fortnightly", "monthly"] as const;
export type BudgetPeriodType = (typeof BUDGET_PERIOD_TYPES)[number];

export interface BudgetPeriod {
  start: string;
  end: string;
  label: string;
  type: BudgetPeriodType;
}

function sanitizeType(value: string | null | undefined): BudgetPeriodType {
  return BUDGET_PERIOD_TYPES.includes(value as BudgetPeriodType) ? (value as BudgetPeriodType) : "monthly";
}

function label(start: string, end: string): string {
  const format = (date: string, withYear: boolean) =>
    new Date(`${date}T00:00:00Z`).toLocaleString("en-US", {
      month: "short",
      day: "numeric",
      ...(withYear ? { year: "numeric" } : {}),
      timeZone: "UTC",
    });
  const withYear = start.slice(0, 4) !== end.slice(0, 4);
  return `${format(start, withYear)} - ${format(end, withYear)}`;
}

export function activeBudgetPeriod(today: string, type: string | null | undefined, anchorDate: string | null | undefined): BudgetPeriod {
  const periodType = sanitizeType(type);
  const anchor = anchorDate && isValidDate(anchorDate) ? anchorDate : today;

  let start: string;
  let end: string;
  if (periodType === "weekly" || periodType === "fortnightly") {
    const length = periodType === "weekly" ? 7 : 14;
    start = addDays(anchor, Math.floor(diffDays(anchor, today) / length) * length);
    end = addDays(start, length - 1);
  } else {
    const anchorDay = Number(anchor.slice(8, 10));
    const year = Number(today.slice(0, 4));
    const month = Number(today.slice(5, 7));
    start = clampedDate(year, month, anchorDay);
    let nextStart = clampedDate(year, month + 1, anchorDay);
    if (today < start) {
      nextStart = start;
      start = clampedDate(year, month - 1, anchorDay);
    }
    end = addDays(nextStart, -1);
  }
  return { start, end, label: label(start, end), type: periodType };
}

interface BudgetSubscription {
  price: number;
  currency_id: number | null;
  next_payment: string | null;
  cycle: number | null;
  frequency: number | null;
  auto_renew: number;
}

function amountNeeded(
  subscriptions: BudgetSubscription[],
  rates: Map<number, number>,
  mainCurrency: number | null,
  from: string,
  to: string,
): number {
  let total = 0;
  for (const sub of subscriptions) {
    const cycle = sub.cycle ?? 0;
    if (!sub.next_payment || !isCycleId(cycle)) continue;
    const occurrences = sub.auto_renew
      ? paymentDatesInRange(sub.next_payment, cycle, sub.frequency ?? 1, from, to).length
      : Number(sub.next_payment >= from && sub.next_payment <= to);
    if (occurrences === 0) continue;
    const rate = sub.currency_id === mainCurrency ? 1 : rates.get(sub.currency_id ?? -1);
    total += convertPrice(sub.price, rate) * occurrences;
  }
  return total;
}

/** Same contract as api/subscriptions/get_period_budget.php. */
export async function periodBudget(db: D1Database, user: AuthUser, referenceDate = todayUtc()) {
  const [profile, subs, currencies] = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT period_budget, budget_period_type, budget_period_anchor_date FROM user WHERE id = ?").bind(user.id),
    db
      .prepare("SELECT price, currency_id, next_payment, cycle, frequency, auto_renew FROM subscriptions WHERE user_id = ? AND inactive = 0")
      .bind(user.id),
    db.prepare("SELECT id, code, symbol, rate FROM currencies WHERE user_id = ?").bind(user.id),
  ]);
  const row = profile?.results[0] ?? {};
  const budget = Math.max(0, Number(row.period_budget ?? 0) || 0);
  const anchor = typeof row.budget_period_anchor_date === "string" && isValidDate(row.budget_period_anchor_date)
    ? row.budget_period_anchor_date
    : referenceDate;
  const period = activeBudgetPeriod(referenceDate, row.budget_period_type as string, anchor);

  const rates = new Map<number, number>();
  let currency: { code: string; symbol: string } | null = null;
  for (const c of currencies?.results ?? []) {
    rates.set(c.id as number, Number(c.rate));
    if (c.id === user.main_currency) currency = { code: c.code as string, symbol: c.symbol as string };
  }

  const list = (subs?.results ?? []) as unknown as BudgetSubscription[];
  const neededFromReference = amountNeeded(list, rates, user.main_currency, referenceDate, period.end);
  const neededFullPeriod = amountNeeded(list, rates, user.main_currency, period.start, period.end);

  return {
    period_budget: roundMoney(budget),
    amount_needed_this_period: roundMoney(neededFromReference),
    amount_needed_full_period: roundMoney(neededFullPeriod),
    amount_remaining_this_period: roundMoney(Math.max(0, budget - neededFromReference)),
    amount_over_budget: roundMoney(Math.max(0, neededFromReference - budget)),
    is_over_budget: budget > 0 && neededFromReference > budget,
    budget_period_type: period.type,
    budget_period_anchor_date: anchor,
    period_start: period.start,
    period_end: period.end,
    period_label: period.label,
    currency_code: currency?.code ?? null,
    currency_symbol: currency?.symbol ?? null,
    reference_date: referenceDate,
    notes: budget <= 0 ? ["Period budget is set to 0."] : [],
  };
}
