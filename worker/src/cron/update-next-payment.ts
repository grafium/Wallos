import { isCycleId, rollForward, todayUtc } from "../lib/dates";

/*
  Port of endpoints/cronjobs/updatenextpayment.php: every active,
  auto-renewing subscription whose next payment is in the past is moved to
  its first billing date on or after today.
*/

const BATCH_SIZE = 100;

export async function updateNextPayments(db: D1Database, today = todayUtc()): Promise<number> {
  const overdue = await db
    .prepare(
      `SELECT id, next_payment, cycle, frequency FROM subscriptions
        WHERE next_payment < ? AND auto_renew = 1 AND inactive = 0`,
    )
    .bind(today)
    .all<{ id: number; next_payment: string; cycle: number; frequency: number | null }>();

  const updates: D1PreparedStatement[] = [];
  for (const row of overdue.results) {
    if (!isCycleId(row.cycle)) continue;
    let next: string;
    try {
      next = rollForward(row.next_payment, row.cycle, row.frequency ?? 1, today);
    } catch {
      // A malformed date imported from an old database; leave it for the user to fix.
      continue;
    }
    if (next !== row.next_payment) {
      updates.push(db.prepare("UPDATE subscriptions SET next_payment = ? WHERE id = ?").bind(next, row.id));
    }
  }

  for (let i = 0; i < updates.length; i += BATCH_SIZE) {
    await db.batch(updates.slice(i, i + BATCH_SIZE));
  }

  await db.batch([
    db.prepare("DELETE FROM last_update_next_payment_date"),
    db.prepare("INSERT INTO last_update_next_payment_date (date) VALUES (?)").bind(today),
  ]);

  return updates.length;
}

export async function purgeExpiredSessions(db: D1Database): Promise<void> {
  await db.prepare("DELETE FROM sessions WHERE expires_at <= ?").bind(new Date().toISOString()).run();
}
