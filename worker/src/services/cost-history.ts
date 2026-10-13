import { Cycle, type CycleId } from "../lib/dates";
import { convertPrice, pricePerMonth, roundMoney } from "../lib/pricing";

/*
  Yearly cost history (endpoints/cronjobs/storetotalyearlycost.php): once a
  week every user's active subscriptions are summed up as a yearly cost in
  the main currency and stored with the date. stats.php draws the history as
  "Total Monthly Cost" (cost / 12).

  Same arithmetic as PHP (30 days and 4.35 weeks per month, one-time
  purchases count 0), and one row per user and day, so a repeated run on the
  same day replaces the value instead of adding a second point.
*/

interface Row {
  user_id: number;
  main_currency: number | null;
  price: number | null;
  cycle: number | null;
  frequency: number | null;
  currency_id: number | null;
  rate: number | null;
  main_rate: number | null;
}

/** Total yearly cost per user, as storetotalyearlycost.php computed it. */
export async function yearlyCosts(db: D1Database, userId?: number): Promise<Map<number, { cost: number; currency: number | null }>> {
  const rows = await db
    .prepare(
      `SELECT u.id AS user_id, u.main_currency, s.price, s.cycle, s.frequency, s.currency_id, c.rate, m.rate AS main_rate
         FROM user u
         LEFT JOIN subscriptions s ON s.user_id = u.id AND s.inactive = 0
         LEFT JOIN currencies c ON c.id = s.currency_id AND c.user_id = u.id
         LEFT JOIN currencies m ON m.id = u.main_currency AND m.user_id = u.id
        ${userId === undefined ? "" : "WHERE u.id = ?"}`,
    )
    .bind(...(userId === undefined ? [] : [userId]))
    .all<Row>();
  const totals = new Map<number, { cost: number; currency: number | null }>();
  for (const row of rows.results) {
    const entry = totals.get(row.user_id) ?? { cost: 0, currency: row.main_currency };
    totals.set(row.user_id, entry);
    if (row.price === null) continue;
    const cycle = (Number(row.cycle) || Cycle.Monthly) as CycleId;
    const rate = row.currency_id === row.main_currency ? 1 : Number(row.rate ?? 0) / (Number(row.main_rate) || 1);
    entry.cost += pricePerMonth(cycle, Number(row.frequency) || 1, convertPrice(Number(row.price), rate)) * 12;
  }
  return totals;
}

/** Stores today's yearly cost for every user; returns how many rows were written. */
export async function storeTotalYearlyCost(db: D1Database, date: string): Promise<{ users: number }> {
  const totals = await yearlyCosts(db);
  const statements = [...totals].map(([userId, { cost, currency }]) =>
    db
      .prepare(
        `INSERT INTO total_yearly_cost (user_id, date, cost, currency) VALUES (?, ?, ?, ?)
         ON CONFLICT (user_id, date) DO UPDATE SET cost = excluded.cost, currency = excluded.currency`,
      )
      .bind(userId, date, roundMoney(cost), String(currency ?? "")),
  );
  for (let i = 0; i < statements.length; i += 50) await db.batch(statements.slice(i, i + 50));
  return { users: statements.length };
}

export async function costHistory(db: D1Database, userId: number) {
  const rows = await db
    .prepare("SELECT date, cost, currency FROM total_yearly_cost WHERE user_id = ? ORDER BY date")
    .bind(userId)
    .all<{ date: string; cost: number; currency: string }>();
  return rows.results.map((r) => ({ date: r.date, yearly_cost: roundMoney(r.cost), monthly_cost: roundMoney(r.cost / 12), currency_id: Number(r.currency) || null }));
}
