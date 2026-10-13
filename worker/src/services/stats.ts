import type { AuthUser } from "../env";
import { isCycleId, paymentDatesInMonth } from "../lib/dates";
import { convertPrice, formatMoney, pricePerMonth, roundMoney } from "../lib/pricing";

interface ActiveRow {
  id: number;
  name: string;
  price: number;
  currency_id: number | null;
  next_payment: string | null;
  cycle: number | null;
  frequency: number | null;
  category_id: number | null;
}

async function loadActive(db: D1Database, userId: number) {
  const [subs, currencies] = await db.batch<Record<string, unknown>>([
    db
      .prepare(
        `SELECT id, name, price, currency_id, next_payment, cycle, frequency, category_id
           FROM subscriptions WHERE user_id = ? AND inactive = 0`,
      )
      .bind(userId),
    db.prepare("SELECT id, code, symbol, rate FROM currencies WHERE user_id = ?").bind(userId),
  ]);
  const rates = new Map<number, { code: string; symbol: string; rate: number }>();
  for (const row of currencies?.results ?? []) {
    rates.set(row.id as number, { code: row.code as string, symbol: row.symbol as string, rate: Number(row.rate) });
  }
  return { subscriptions: (subs?.results ?? []) as unknown as ActiveRow[], rates };
}

function mainCurrency(user: AuthUser, rates: Map<number, { code: string; symbol: string; rate: number }>) {
  return rates.get(user.main_currency ?? -1) ?? { code: "EUR", symbol: "€", rate: 1 };
}

/**
 * What the user actually pays in a calendar month: every billing date that
 * falls into the month, converted into the main currency. Same contract as
 * api/subscriptions/get_monthly_cost.php.
 */
export async function monthlyCost(db: D1Database, user: AuthUser, year: number, month: number) {
  const { subscriptions, rates } = await loadActive(db, user.id);
  const main = mainCurrency(user, rates);

  let total = 0;
  for (const sub of subscriptions) {
    const cycle = sub.cycle ?? 0;
    if (!sub.next_payment || !isCycleId(cycle)) continue;
    const payments = paymentDatesInMonth(sub.next_payment, cycle, sub.frequency ?? 1, year, month).length;
    if (payments === 0) continue;
    const rate = sub.currency_id === user.main_currency ? 1 : (rates.get(sub.currency_id ?? -1)?.rate ?? 0) / (main.rate || 1);
    total += convertPrice(sub.price, rate) * payments;
  }

  const title = new Date(Date.UTC(year, month - 1, 1)).toLocaleString("en-US", { month: "long", year: "numeric", timeZone: "UTC" });
  return {
    title,
    monthly_cost: roundMoney(total).toFixed(2),
    localized_monthly_cost: formatMoney(total, main.code),
    currency_code: main.code,
    currency_symbol: main.symbol,
    notes: [] as string[],
  };
}

/** Averaged monthly and yearly spend, overall and per category, in the main currency. */
export async function costSummary(db: D1Database, user: AuthUser) {
  const [{ subscriptions, rates }, inactive, categories] = await Promise.all([
    loadActive(db, user.id),
    db.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE user_id = ? AND inactive = 1").bind(user.id).first<{ n: number }>(),
    db.prepare("SELECT id, name FROM categories WHERE user_id = ?").bind(user.id).all<{ id: number; name: string }>(),
  ]);
  const main = mainCurrency(user, rates);
  const categoryNames = new Map(categories.results.map((c) => [c.id, c.name]));

  let monthly = 0;
  let mostExpensive: { id: number; name: string; monthly: number } | null = null;
  const byCategory = new Map<number, number>();

  for (const sub of subscriptions) {
    const cycle = sub.cycle ?? 0;
    if (!isCycleId(cycle)) continue;
    const rate = sub.currency_id === user.main_currency ? 1 : (rates.get(sub.currency_id ?? -1)?.rate ?? 0) / (main.rate || 1);
    const perMonth = convertPrice(pricePerMonth(cycle, sub.frequency ?? 1, sub.price), rate);
    monthly += perMonth;
    byCategory.set(sub.category_id ?? 0, (byCategory.get(sub.category_id ?? 0) ?? 0) + perMonth);
    if (!mostExpensive || perMonth > mostExpensive.monthly) {
      mostExpensive = { id: sub.id, name: sub.name, monthly: perMonth };
    }
  }

  return {
    currency_code: main.code,
    currency_symbol: main.symbol,
    active_subscriptions: subscriptions.length,
    inactive_subscriptions: inactive?.n ?? 0,
    monthly_cost: roundMoney(monthly),
    yearly_cost: roundMoney(monthly * 12),
    average_monthly_per_subscription: subscriptions.length ? roundMoney(monthly / subscriptions.length) : 0,
    most_expensive: mostExpensive ? { ...mostExpensive, monthly: roundMoney(mostExpensive.monthly) } : null,
    by_category: [...byCategory.entries()]
      .map(([id, cost]) => ({ category_id: id, category_name: categoryNames.get(id) ?? "No category", monthly_cost: roundMoney(cost) }))
      .sort((a, b) => b.monthly_cost - a.monthly_cost),
  };
}
