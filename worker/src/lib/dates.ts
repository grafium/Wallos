/*
  Billing-date arithmetic for subscriptions.

  Dates are plain "YYYY-MM-DD" strings, exactly as Wallos stores them, and all
  arithmetic is done in UTC so the result never depends on the runtime's
  timezone.

  One intentional difference from the PHP implementation: PHP adds a month
  with DateInterval, which overflows (Jan 31 + 1 month = Mar 3) and then keeps
  drifting on every later renewal. Here every date is computed from the
  anchor as "anchor + k intervals" and clamped to the last day of the month,
  so a subscription billed on the 31st stays on the last day of each month.
*/

export const Cycle = {
  Daily: 1,
  Weekly: 2,
  Monthly: 3,
  Yearly: 4,
  OneTime: 5,
} as const;

export type CycleId = (typeof Cycle)[keyof typeof Cycle];

export function isCycleId(value: number): value is CycleId {
  return Number.isInteger(value) && value >= Cycle.Daily && value <= Cycle.OneTime;
}

const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 86_400_000;

export function isValidDate(value: string): boolean {
  const match = DATE_RE.exec(value);
  if (!match) return false;
  const [, y, m, d] = match.map(Number) as [number, number, number, number];
  const date = new Date(Date.UTC(y, m - 1, d));
  return date.getUTCFullYear() === y && date.getUTCMonth() === m - 1 && date.getUTCDate() === d;
}

function parse(value: string): Date {
  if (!isValidDate(value)) {
    throw new RangeError(`Invalid date: ${value}`);
  }
  const [y, m, d] = value.split("-").map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d));
}

function format(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function todayUtc(now: Date = new Date()): string {
  return format(now);
}

function daysInMonth(year: number, monthIndex: number): number {
  return new Date(Date.UTC(year, monthIndex + 1, 0)).getUTCDate();
}

function addMonthsClamped(date: Date, months: number): Date {
  const totalMonths = date.getUTCFullYear() * 12 + date.getUTCMonth() + months;
  const year = Math.floor(totalMonths / 12);
  const monthIndex = totalMonths - year * 12;
  const day = Math.min(date.getUTCDate(), daysInMonth(year, monthIndex));
  return new Date(Date.UTC(year, monthIndex, day));
}

/** Length of one billing interval in days, or null for calendar-based cycles. */
function stepDays(cycle: CycleId, frequency: number): number | null {
  if (cycle === Cycle.Daily) return frequency;
  if (cycle === Cycle.Weekly) return frequency * 7;
  return null;
}

/**
 * The anchor moved by `steps` billing intervals (negative steps go back).
 * One-time subscriptions never move.
 */
export function shiftDate(anchor: string, cycle: CycleId, frequency: number, steps: number): string {
  const date = parse(anchor);
  if (cycle === Cycle.OneTime || steps === 0) return anchor;
  const days = stepDays(cycle, frequency);
  if (days !== null) {
    return format(new Date(date.getTime() + steps * days * DAY_MS));
  }
  const months = cycle === Cycle.Monthly ? frequency * steps : frequency * 12 * steps;
  return format(addMonthsClamped(date, months));
}

/** Whole days from `a` to `b` (positive when b is later). */
export function diffDays(a: string, b: string): number {
  return Math.round((parse(b).getTime() - parse(a).getTime()) / DAY_MS);
}

/**
 * Smallest number of whole intervals to add to `anchor` so the result is on
 * or after `target`. Returns 0 when the anchor already is.
 */
function stepsUntil(anchor: string, cycle: CycleId, frequency: number, target: string): number {
  if (anchor >= target) return 0;
  const days = stepDays(cycle, frequency);
  if (days !== null) {
    return Math.ceil(diffDays(anchor, target) / days);
  }
  const a = parse(anchor);
  const t = parse(target);
  const monthsPerStep = cycle === Cycle.Monthly ? frequency : frequency * 12;
  const monthGap = (t.getUTCFullYear() - a.getUTCFullYear()) * 12 + (t.getUTCMonth() - a.getUTCMonth());
  // Start just below the estimate and walk forward; at most a couple of steps.
  let steps = Math.max(0, Math.floor(monthGap / monthsPerStep) - 1);
  while (shiftDate(anchor, cycle, frequency, steps) < target) steps++;
  return steps;
}

/**
 * Daily auto-renew job: an overdue payment date rolls forward to the first
 * billing date on or after today. A payment due today stays today.
 */
export function rollForward(nextPayment: string, cycle: CycleId, frequency: number, today: string): string {
  if (cycle === Cycle.OneTime) return nextPayment;
  const steps = stepsUntil(nextPayment, cycle, frequency, today);
  return shiftDate(nextPayment, cycle, frequency, steps);
}

/**
 * Manual renewal of a subscription that does not auto-renew: it moves at
 * least one interval, and on to the first billing date after today.
 */
export function renewDate(nextPayment: string, cycle: CycleId, frequency: number, today: string): string {
  if (cycle === Cycle.OneTime) return nextPayment;
  const tomorrow = format(new Date(parse(today).getTime() + DAY_MS));
  const steps = Math.max(1, stepsUntil(nextPayment, cycle, frequency, tomorrow));
  return shiftDate(nextPayment, cycle, frequency, steps);
}

/**
 * Every billing date of a subscription between two dates (inclusive),
 * projected both backwards and forwards from its next payment date.
 */
export function paymentDatesInRange(
  nextPayment: string,
  cycle: CycleId,
  frequency: number,
  rangeStart: string,
  rangeEnd: string,
): string[] {
  if (cycle === Cycle.OneTime) {
    return nextPayment >= rangeStart && nextPayment <= rangeEnd ? [nextPayment] : [];
  }

  // Find the first billing date on or after the range start, in either
  // direction from the anchor.
  let steps: number;
  if (nextPayment >= rangeStart) {
    const days = stepDays(cycle, frequency);
    if (days !== null) {
      steps = -Math.floor(diffDays(rangeStart, nextPayment) / days);
    } else {
      const a = parse(rangeStart);
      const n = parse(nextPayment);
      const monthsPerStep = cycle === Cycle.Monthly ? frequency : frequency * 12;
      const monthGap = (n.getUTCFullYear() - a.getUTCFullYear()) * 12 + (n.getUTCMonth() - a.getUTCMonth());
      steps = -Math.max(0, Math.floor(monthGap / monthsPerStep) - 1);
      while (shiftDate(nextPayment, cycle, frequency, steps - 1) >= rangeStart) steps--;
    }
  } else {
    steps = stepsUntil(nextPayment, cycle, frequency, rangeStart);
  }

  const dates: string[] = [];
  for (let date = shiftDate(nextPayment, cycle, frequency, steps); date <= rangeEnd; ) {
    dates.push(date);
    steps++;
    date = shiftDate(nextPayment, cycle, frequency, steps);
  }
  return dates;
}

/** Every billing date of a subscription inside the given calendar month. */
export function paymentDatesInMonth(
  nextPayment: string,
  cycle: CycleId,
  frequency: number,
  year: number,
  month: number,
): string[] {
  const monthStart = format(new Date(Date.UTC(year, month - 1, 1)));
  const monthEnd = format(new Date(Date.UTC(year, month, 0)));
  return paymentDatesInRange(nextPayment, cycle, frequency, monthStart, monthEnd);
}

/** The date `days` days after (or before, when negative) the given one. */
export function addDays(value: string, days: number): string {
  return format(new Date(parse(value).getTime() + days * DAY_MS));
}

/** Day of month clamped to the month's length: (2024, 2, 31) -> "2024-02-29". */
export function clampedDate(year: number, month: number, day: number): string {
  const totalMonths = year * 12 + (month - 1);
  const y = Math.floor(totalMonths / 12);
  const m = totalMonths - y * 12;
  return format(new Date(Date.UTC(y, m, Math.min(Math.max(1, day), daysInMonth(y, m)))));
}
