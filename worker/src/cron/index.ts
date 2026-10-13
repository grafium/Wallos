import type { Env } from "../env";
import { runReminders } from "../notifications/reminders";
import { purgeExpiredResets } from "../services/email-flows";
import { runExchangeRates } from "../services/exchange-rates";
import { purgeExpiredSessions, updateNextPayments } from "./update-next-payment";

/*
  The Worker has one hourly cron trigger. Each tick sends the reminders that
  are due in users' local time; the daily jobs of the PHP crontab run at a
  fixed UTC hour:

    01:00  updatenextpayment.php  -> updateNextPayments, session cleanup
    02:00  updateexchange.php     -> runExchangeRates
    03:00  cleanupresettokens.php -> purgeExpiredResets, old notification log

  Each job is isolated so one failing does not stop the others.
*/

async function step(name: string, job: () => Promise<unknown>) {
  try {
    const result = await job();
    console.log(`${name}: ${JSON.stringify(result ?? "done")}`);
  } catch (error) {
    console.error(`${name} failed`, error);
  }
}

export async function runScheduled(env: Env, scheduledTime: number): Promise<void> {
  const now = new Date(scheduledTime);
  const hour = now.getUTCHours();

  if (hour === 1) {
    await step("updatenextpayment", () => updateNextPayments(env.DB));
    await step("sessions", () => purgeExpiredSessions(env.DB));
  }
  if (hour === 2) {
    await step("updateexchange", () => runExchangeRates(env.DB));
  }
  if (hour === 3) {
    await step("resettokens", () => purgeExpiredResets(env.DB));
    await step("notificationlog", () => env.DB.prepare("DELETE FROM notification_log WHERE sent_at < datetime('now', '-90 days')").run());
  }

  await step("cancellation reminders", () => runReminders(env, "cancellation", now));
  await step("payment reminders", () => runReminders(env, "payment", now));
}
