import { isCycleId, isValidDate, shiftDate, todayUtc } from "../../lib/dates";
import { convertPrice, pricePerMonth } from "../../lib/pricing";
import type { UiCtx } from "../context";
import type { Translate } from "../i18n";
import type { Stats, StatsFilters } from "../stats-calculations";

/*
  Port of includes/stats_extra_calculations.php (and of
  includes/upcoming_cancellations.php) for the statistics page: the tiles and
  chart data that stats_calculations.php does not produce - cost per day,
  cheapest subscription, manual renewals, a 12-month projection, lifetime
  spend and age, and the split by billing cycle, currency, payment method and
  price band. Money is in the main currency; lifetime figures assume today's
  prices, as in PHP.

  One difference: renewal dates are walked with lib/dates' shiftDate, which
  clamps to the end of the month (Jan 31 -> Feb 28) where PHP's
  DateTime::modify overflowed into the next month.
*/

export interface DataPoint {
  label: string;
  y: number;
}

export interface LogoTile {
  name: string;
  logo: string | null;
  logo_text_color: string | null;
  logo_variant: string | null;
}

export interface ExtraStats {
  costPerDay: number;
  cheapest: (LogoTile & { price: number }) | null;
  manualRenewalsCount: number;
  monthOverMonthDelta: number | null;
  monthOverMonthPercentage: number | null;
  projectionDataPoints: DataPoint[];
  heaviestMonth: { label: string; total: number } | null;
  showProjectionGraph: boolean;
  monthsOverBudget: number | null;
  lifetimeDataPoints: DataPoint[];
  showLifetimeGraph: boolean;
  totalLifetimeSpend: number;
  oldest: (LogoTile & { years: number }) | null;
  averageSubscriptionAge: number | null;
  cycleDataPoints: DataPoint[];
  showCycleGraph: boolean;
  currencyDataPoints: DataPoint[];
  showCurrencyGraph: boolean;
  /** Monthly cost per payment method id (active subscriptions with a cost). */
  paymentMethodCost: Map<number | null, number>;
  histogramDataPoints: DataPoint[];
  showHistogramGraph: boolean;
  newPerYearDataPoints: DataPoint[];
  showYearlyNewGraph: boolean;
  /** Payment method id -> "order", for sorting the filter menu like PHP. */
  paymentMethodOrder: Map<number, number>;
  upcomingCancellationsCount: number;
  potentialMonthlySavings: number;
}

interface Row extends LogoTile {
  price: number;
  frequency: number | null;
  cycle: number | null;
  currency_id: number | null;
  next_payment: string | null;
  payment_method_id: number | null;
  inactive: number;
  start_date: string | null;
  auto_renew: number | null;
}

const CYCLE_NAMES: Record<number, string> = { 1: "Daily", 2: "Weekly", 3: "Monthly", 4: "Yearly" };

const round2 = (value: number) => Math.round(value * 100) / 100;
const byYDesc = (a: DataPoint, b: DataPoint) => b.y - a.y;

/** "MMM yy" in the interface language, like the IntlDateFormatter of the PHP page. */
function monthLabel(date: string, lang: string): string {
  const value = new Date(`${date}T00:00:00Z`);
  const options: Intl.DateTimeFormatOptions = { month: "short", year: "2-digit", timeZone: "UTC" };
  try {
    return new Intl.DateTimeFormat(lang.replace("_", "-"), options).format(value);
  } catch {
    return new Intl.DateTimeFormat("en", options).format(value);
  }
}

function addMonths(yearMonth: string, months: number): string {
  const [y, m] = yearMonth.split("-").map(Number) as [number, number];
  const d = new Date(Date.UTC(y, m - 1 + months, 1));
  return d.toISOString().slice(0, 10);
}

/** The subscriptions the page looks at, with the same filters as calculateStats(). */
function filteredQuery(c: UiCtx, filters: StatsFilters) {
  const where = ["user_id = ?"];
  const params: unknown[] = [c.get("user").id];
  for (const [column, ids] of [
    ["payer_user_id", filters.member],
    ["category_id", filters.category],
    ["payment_method_id", filters.payment],
  ] as const) {
    if (!ids?.length) continue;
    where.push(`${column} IN (${ids.map(() => "?").join(", ")})`);
    params.push(...ids);
  }
  return c.env.DB.prepare(
    `SELECT name, price, logo, logo_text_color, logo_variant, frequency, cycle, currency_id, next_payment,
            payment_method_id, inactive, start_date, auto_renew
       FROM subscriptions WHERE ${where.join(" AND ")}`,
  ).bind(...params);
}

export async function calculateExtraStats(
  c: UiCtx,
  t: Translate,
  lang: string,
  stats: Stats,
  filters: StatsFilters = {},
  today = todayUtc(),
): Promise<ExtraStats> {
  const db = c.env.DB;
  const userId = c.get("user").id;

  const [subsRes, currenciesRes, profileRes, methodsRes, cancellationsRes] = await db.batch<Record<string, unknown>>([
    filteredQuery(c, filters),
    db.prepare("SELECT id, code, rate FROM currencies WHERE user_id = ?").bind(userId),
    db.prepare("SELECT main_currency FROM user WHERE id = ?").bind(userId),
    db.prepare('SELECT id, "order" FROM payment_methods WHERE user_id = ?').bind(userId),
    db
      .prepare(
        `SELECT price, currency_id, cycle, frequency FROM subscriptions
          WHERE user_id = ? AND inactive = 0 AND cancellation_date IS NOT NULL AND cancellation_date != ''
            AND cancellation_date >= ? AND cycle != 5
          ORDER BY cancellation_date ASC`,
      )
      .bind(userId, today),
  ]);
  const rows = (subsRes?.results ?? []) as unknown as Row[];
  const codes = new Map((currenciesRes?.results ?? []).map((r) => [r.id as number, String(r.code)]));
  const rates = new Map((currenciesRes?.results ?? []).map((r) => [r.id as number, Number(r.rate)]));
  const mainCurrency = (profileRes?.results[0]?.main_currency as number | null | undefined) ?? null;
  const convert = (price: number, currency: number | null) => (currency === mainCurrency ? price : convertPrice(price, rates.get(currency ?? -1)));
  const perMonth = (cycle: number, frequency: number, price: number) => (isCycleId(cycle) ? pricePerMonth(cycle, frequency, price) : 0);

  // 12 projection buckets, starting next month.
  const projectionStart = addMonths(today.slice(0, 7), 1);
  const projectionEnd = addMonths(today.slice(0, 7), 13);
  const buckets = new Map<string, { label: string; total: number }>();
  for (let i = 0; i < 12; i++) {
    const date = addMonths(projectionStart.slice(0, 7), i);
    buckets.set(date.slice(0, 7), { label: monthLabel(date, lang), total: 0 });
  }

  const activeMonthlyPrices: number[] = [];
  let cheapest: ExtraStats["cheapest"] = null;
  let manualRenewalsCount = 0;
  const cycleSpend = new Map<number, number>();
  const currencySpend = new Map<string, number>();
  const paymentMethodCost = new Map<number | null, number>();
  const lifetimeSpends: DataPoint[] = [];
  let totalLifetimeSpend = 0;
  let oldest: ExtraStats["oldest"] = null;
  const ages: number[] = [];
  const newPerYear = new Map<string, number>();

  for (const row of rows) {
    const cycle = Number(row.cycle);
    const frequency = Math.max(1, Math.trunc(Number(row.frequency) || 0));
    const convertedPrice = convert(row.price, row.currency_id);
    const monthlyPrice = perMonth(cycle, frequency, convertedPrice);
    const tile: LogoTile = { name: row.name, logo: row.logo, logo_text_color: row.logo_text_color ?? null, logo_variant: row.logo_variant ?? null };

    const startDate = row.start_date && isValidDate(row.start_date) ? row.start_date : null;
    if (startDate) {
      const year = startDate.slice(0, 4);
      newPerYear.set(year, (newPerYear.get(year) ?? 0) + 1);
    }

    if (row.inactive) continue;

    if (monthlyPrice > 0) {
      cycleSpend.set(cycle, (cycleSpend.get(cycle) ?? 0) + monthlyPrice);
      const code = codes.get(row.currency_id ?? -1) ?? "?";
      currencySpend.set(code, (currencySpend.get(code) ?? 0) + monthlyPrice);
      paymentMethodCost.set(row.payment_method_id, (paymentMethodCost.get(row.payment_method_id) ?? 0) + monthlyPrice);
    }

    if (cycle === 5) continue;
    activeMonthlyPrices.push(monthlyPrice);
    if (!cheapest || monthlyPrice < cheapest.price) cheapest = { ...tile, price: monthlyPrice };
    if (Number(row.auto_renew) !== 1) manualRenewalsCount++;

    // Projection: walk the renewals forward into the buckets.
    if (row.next_payment && isValidDate(row.next_payment) && isCycleId(cycle)) {
      for (let step = 0; step < 1000; step++) {
        const date = shiftDate(row.next_payment, cycle, frequency, step);
        if (date >= projectionEnd) break;
        if (date >= projectionStart) {
          const bucket = buckets.get(date.slice(0, 7));
          if (bucket) bucket.total += convertedPrice;
        }
      }
    }

    // Lifetime spend and age (recurring subscriptions with a start date).
    if (startDate && startDate <= today) {
      const daysActive = Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${startDate}T00:00:00Z`)) / 86_400_000);
      const years = daysActive / 365.25;
      ages.push(years);
      const spend = monthlyPrice * (daysActive / 30.44);
      totalLifetimeSpend += spend;
      lifetimeSpends.push({ label: row.name, y: round2(spend) });
      if (!oldest || years > oldest.years) oldest = { ...tile, years };
    }
  }

  // Month-over-month change from the recorded cost history.
  const history = stats.totalMonthlyCostDataPoints;
  let monthOverMonthDelta: number | null = null;
  let monthOverMonthPercentage: number | null = null;
  if (history.length >= 2) {
    const last = history[history.length - 1]!.y;
    const previous = history[history.length - 2]!.y;
    monthOverMonthDelta = last - previous;
    if (previous > 0) monthOverMonthPercentage = (monthOverMonthDelta / previous) * 100;
  }

  const projectionDataPoints: DataPoint[] = [];
  let heaviestMonth: ExtraStats["heaviestMonth"] = null;
  for (const bucket of buckets.values()) {
    const total = round2(bucket.total);
    projectionDataPoints.push({ label: bucket.label, y: total });
    if (!heaviestMonth || total > heaviestMonth.total) heaviestMonth = { label: bucket.label, total };
  }
  const showProjectionGraph = stats.activeSubscriptions > 0 && heaviestMonth !== null && heaviestMonth.total > 0;
  const budget = stats.monthly?.budget ?? 0;
  const monthsOverBudget = budget > 0 && showProjectionGraph ? projectionDataPoints.filter((p) => p.y > budget).length : null;

  const lifetimeDataPoints = [...lifetimeSpends].sort(byYDesc).slice(0, 10);

  const cycleDataPoints: DataPoint[] = [];
  for (const [cycle, spend] of cycleSpend) {
    if (cycle === 5 || spend <= 0 || !CYCLE_NAMES[cycle]) continue;
    cycleDataPoints.push({ label: t(CYCLE_NAMES[cycle]!), y: round2(spend) });
  }
  cycleDataPoints.sort(byYDesc);

  const currencyDataPoints: DataPoint[] = [];
  for (const [code, spend] of currencySpend) if (spend > 0) currencyDataPoints.push({ label: code, y: round2(spend) });
  currencyDataPoints.sort(byYDesc);

  const boundaries = [5, 10, 20, 50];
  const histogram = new Array<number>(boundaries.length + 1).fill(0);
  for (const price of activeMonthlyPrices) {
    const index = boundaries.findIndex((b) => price < b);
    histogram[index === -1 ? boundaries.length : index]!++;
  }
  const histogramDataPoints: DataPoint[] = [];
  let previous = 0;
  boundaries.forEach((boundary, index) => {
    histogramDataPoints.push({ label: `${previous}–${boundary}`, y: histogram[index]! });
    previous = boundary;
  });
  histogramDataPoints.push({ label: `${previous}+`, y: histogram[boundaries.length]! });

  const newPerYearDataPoints = [...newPerYear.entries()].sort(([a], [b]) => a.localeCompare(b)).map(([year, count]) => ({ label: year, y: count }));

  let potentialMonthlySavings = 0;
  const cancellations = (cancellationsRes?.results ?? []) as unknown as { price: number; currency_id: number | null; cycle: number; frequency: number | null }[];
  for (const s of cancellations) potentialMonthlySavings += convert(perMonth(Number(s.cycle), Number(s.frequency) || 1, s.price), s.currency_id);

  return {
    costPerDay: stats.totalCostPerMonth > 0 ? (stats.totalCostPerMonth * 12) / 365.25 : 0,
    cheapest,
    manualRenewalsCount,
    monthOverMonthDelta,
    monthOverMonthPercentage,
    projectionDataPoints,
    heaviestMonth,
    showProjectionGraph,
    monthsOverBudget,
    lifetimeDataPoints,
    showLifetimeGraph: lifetimeDataPoints.length >= 2,
    totalLifetimeSpend,
    oldest,
    averageSubscriptionAge: ages.length > 0 ? ages.reduce((a, b) => a + b, 0) / ages.length : null,
    cycleDataPoints,
    showCycleGraph: cycleDataPoints.length > 1,
    currencyDataPoints,
    showCurrencyGraph: currencyDataPoints.length > 1,
    paymentMethodCost,
    histogramDataPoints,
    showHistogramGraph: activeMonthlyPrices.length >= 3,
    newPerYearDataPoints,
    showYearlyNewGraph: newPerYearDataPoints.length >= 2,
    paymentMethodOrder: new Map((methodsRes?.results ?? []).map((r) => [r.id as number, Number(r.order) || 0])),
    upcomingCancellationsCount: cancellations.length,
    potentialMonthlySavings,
  };
}

/** json_encode(..., JSON_NUMERIC_CHECK): numeric strings become numbers, as in the PHP page's chart data. */
export function numericCheck(value: unknown): unknown {
  if (typeof value === "string") {
    return /^\s*[+-]?(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?$/.test(value) ? Number(value) : value;
  }
  if (Array.isArray(value)) return value.map(numericCheck);
  if (value && typeof value === "object") return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, numericCheck(v)]));
  return value;
}

/** PHP's number_format($value, $decimals): "." decimals, "," thousands. */
export function numberFormat(value: number, decimals = 0): string {
  const fixed = Math.abs(value).toFixed(decimals);
  const [whole, fraction] = fixed.split(".");
  const grouped = whole!.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  const sign = value < 0 && Number(fixed) !== 0 ? "-" : "";
  return sign + grouped + (fraction ? `.${fraction}` : "");
}
