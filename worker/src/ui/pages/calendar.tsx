import { Hono } from "hono";
import type { AppBindings } from "../../env";
import { Cycle, isCycleId, isValidDate, paymentDatesInRange, shiftDate, todayUtc } from "../../lib/dates";
import { convertPrice } from "../../lib/pricing";
import type { SubscriptionRow } from "../../services/subscriptions";
import { SubscriptionDetailsPopup } from "../components";
import { loadUi, uiPage } from "../context";
import { formatPrice } from "../format";
import { asset, Icon, page } from "../layout";

/*
  calendar.php: one month of payments, projected from each active
  subscription's next payment date, with the month's totals in the main
  currency and the iCalendar feed link.
*/

export const routes = new Hono<AppBindings>();

const pad = (n: number) => String(n).padStart(2, "0");

export interface CalendarMonth {
  /** Subscriptions paid on each day of the month (1-based). */
  paymentsByDay: Map<number, SubscriptionRow[]>;
  count: number;
  totalCost: number;
  amountDue: number;
}

/**
 * Every payment of the active subscriptions in a month, as calendar.php
 * registered them: recurring ones from their start date (or next payment
 * when there is none) up to yearsToLoad years past the next payment, one-time
 * purchases only on their date. Amounts are converted to the main currency.
 */
export function projectMonth(
  rows: SubscriptionRow[],
  year: number,
  month: number,
  yearsToLoad: number,
  rates: Map<number, number>,
  today = todayUtc(),
): CalendarMonth {
  const monthStart = `${year}-${pad(month)}-01`;
  const monthEnd = `${year}-${pad(month)}-${pad(new Date(Date.UTC(year, month, 0)).getUTCDate())}`;
  const result: CalendarMonth = { paymentsByDay: new Map(), count: 0, totalCost: 0, amountDue: 0 };
  const register = (date: string, row: SubscriptionRow) => {
    const day = Number(date.slice(8, 10));
    result.paymentsByDay.set(day, [...(result.paymentsByDay.get(day) ?? []), row]);
    const converted = convertPrice(Number(row.price), rates.get(row.currency_id ?? -1));
    result.totalCost += converted;
    result.count++;
    if (date >= today) result.amountDue += converted;
  };

  for (const row of rows) {
    const next = row.next_payment ?? "";
    if (!isValidDate(next)) continue;
    const cycle = row.cycle ?? Cycle.Monthly;
    if (cycle === Cycle.OneTime) {
      if (next.slice(0, 7) === monthStart.slice(0, 7)) register(next, row);
      continue;
    }
    const cycleId = isCycleId(cycle) ? cycle : Cycle.Monthly;
    const frequency = row.frequency || 1;
    const start = row.start_date && isValidDate(row.start_date) ? row.start_date : next;
    const end = shiftDate(next, Cycle.Yearly, yearsToLoad, 1);
    for (const date of paymentDatesInRange(next, cycleId, frequency, monthStart, monthEnd)) {
      if (date < start || date > end) continue;
      register(date, row);
    }
  }
  return result;
}

routes.get("/calendar.php", uiPage, async (c) => {
  const ui = await loadUi(c);
  const { t } = ui;
  const db = c.env.DB;
  const userId = c.get("user").id;
  const today = todayUtc();
  const currentYear = Number(today.slice(0, 4));
  const currentMonth = Number(today.slice(5, 7));

  // Past months cannot be viewed.
  let calendarYear = currentYear;
  let calendarMonth = currentMonth;
  let sameAsCurrent = true;
  const qMonth = c.req.query("month");
  const qYear = c.req.query("year");
  if (qMonth !== undefined && qYear !== undefined) {
    const month = Number.parseInt(qMonth, 10);
    const year = Number.parseInt(qYear, 10);
    if (month >= 1 && month <= 12 && year >= 1 && year <= 9999 && year * 12 + month >= currentYear * 12 + currentMonth) {
      calendarYear = year;
      calendarMonth = month;
    }
    sameAsCurrent = calendarYear === currentYear && calendarMonth === currentMonth;
  }

  const [subscriptions, currencies, fixer, user] = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT * FROM subscriptions WHERE user_id = ? AND inactive = 0").bind(userId),
    db.prepare("SELECT id, code, symbol, rate FROM currencies WHERE user_id = ?").bind(userId),
    db.prepare("SELECT 1 AS present FROM fixer WHERE user_id = ?").bind(userId),
    db.prepare("SELECT budget, api_key FROM user WHERE id = ?").bind(userId),
  ]);
  const rows = (subscriptions?.results ?? []) as unknown as SubscriptionRow[];
  const rates = new Map((currencies?.results ?? []).map((r) => [r.id as number, Number(r.rate)]));
  const usesMultipleCurrencies = new Set(rows.map((r) => r.currency_id)).size > 1;
  const showCantConvert = usesMultipleCurrencies && !fixer?.results.length;
  const code = String((currencies?.results ?? []).find((r) => r.id === ui.user.main_currency)?.code ?? "");
  const budget = Number(user?.results[0]?.budget ?? 0);
  const apiKey = String(user?.results[0]?.api_key ?? "");

  const yearsToLoad = calendarYear - currentYear + 1;
  const month = projectMonth(rows, calendarYear, calendarMonth, yearsToLoad, rates, today);
  const money = (amount: number) => formatPrice(amount, code, [], ui.locale);

  const weekStartsSunday = Boolean(ui.settings.week_starts_sunday);
  const weekDays = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"];
  if (weekStartsSunday) weekDays.unshift(weekDays.pop()!);

  const daysInMonth = new Date(Date.UTC(calendarYear, calendarMonth, 0)).getUTCDate();
  // ISO day of week of the 1st, 0 = Monday.
  let firstDayOfWeek = (new Date(Date.UTC(calendarYear, calendarMonth - 1, 1)).getUTCDay() + 6) % 7;
  if (weekStartsSunday) firstDayOfWeek = (firstDayOfWeek + 1) % 7;
  const todayDay = Number(today.slice(8, 10));

  // The grid, a week per row.
  const weeks: unknown[][] = [[]];
  let dayOfWeek = 0;
  for (let i = 0; i < firstDayOfWeek; i++, dayOfWeek++) weeks[0]!.push(<div class="calendar-cell empty"></div>);
  for (let day = 1; day <= daysInMonth; day++, dayOfWeek++) {
    if (dayOfWeek > 0 && dayOfWeek % 7 === 0) weeks.push([]);
    const isToday = day === todayDay && calendarMonth === currentMonth && calendarYear === currentYear;
    const payments = month.paymentsByDay.get(day) ?? [];
    weeks[weeks.length - 1]!.push(
      <div class={`calendar-cell${isToday ? " today" : ""}`}>
        <span class="day">{day}</span>
        {payments.length > 0 && (
          <div class="calendar-cell-content">
            {payments.map((payment) => (
              <div class="calendar-event" onclick={`showSubscriptionDetails(event, ${payment.id})`} title={payment.name}>
                {payment.name}
              </div>
            ))}
          </div>
        )}
      </div>,
    );
  }
  for (; dayOfWeek % 7 !== 0; dayOfWeek++) weeks[weeks.length - 1]!.push(<div class="calendar-cell empty"></div>);

  const body = (
    <>
      <section class="contain">
        {showCantConvert && (
          <div class="error-box">
            <div class="error-message">
              <i class="fa-solid fa-exclamation-circle"></i>
              {t("cant_convert_currency")}
            </div>
          </div>
        )}
        <div class="split-header">
          <div class="calendar-title">
            <h2>
              {t(`month-${pad(calendarMonth)}`)} {calendarYear}
            </h2>
            <div class="calendar-nav">
              <button class="button secondary-button" id="prev" onclick={`prevMonth(${calendarMonth}, ${calendarYear})`} disabled={sameAsCurrent}>
                <i class="fa-solid fa-chevron-left"></i>
              </button>
              <button class="button secondary-button" id="next" onclick={`nextMonth(${calendarMonth}, ${calendarYear})`}>
                <i class="fa-solid fa-chevron-right"></i>
              </button>
              {!sameAsCurrent && (
                <button class="button secondary-button" onclick="currentMoth()" title={t("reset")}>
                  <i class="fa-solid fa-calendar-day"></i>
                </button>
              )}
            </div>
          </div>
          <button class="button secondary-button export-ical" onclick="showExportPopup()" title={t("export_icalendar")} aria-label={t("export_icalendar")}>
            <Icon name="export_ical" />
          </button>
          <div id="subscriptions_calendar" class="subscription-modal">
            <div class="modal-header">
              <h3>{t("export_icalendar")}</h3>
              <span class="fa-solid fa-xmark close-modal" onclick="closePopup()"></span>
            </div>
            <div class="form-group-inline">
              <input id="iCalendarUrl" type="text" value="" readonly />
              <input type="hidden" id="apiKey" value={apiKey} />
              <button onclick="copyToClipboard()" class="button tiny">
                {" "}
                {t("copy_to_clipboard")}{" "}
              </button>
            </div>
          </div>
        </div>
        <div>
          <div class="calendar">
            <div class="calendar-header">
              {weekDays.map((key) => (
                <div class="calendar-cell">{t(key)}</div>
              ))}
            </div>
            <div class="calendar-body">
              {weeks.map((cells) => (
                <div class="week calendar-row">{cells}</div>
              ))}
            </div>
          </div>

          {budget > 0 && month.totalCost > budget && (
            <div class="over-budget">
              <i class="fa-solid fa-triangle-exclamation"></i>
              <span>
                {t("over_budget_warning")} <strong>({money(month.totalCost - budget)})</strong>
              </span>
            </div>
          )}

          <div class="calendar-monthly-stats">
            <div class="calendar-monthly-stats-header">
              <h3>{t("stats")}</h3>
            </div>
            <div class="statistics">
              <div class="statistic">
                <span>{month.count}</span>
                <div class="title">{t("active_subscriptions")}</div>
              </div>
              <div class="statistic">
                <span>{money(month.totalCost)}</span>
                <div class="title">{t("total_cost")}</div>
              </div>
              <div class="statistic">
                <span>{money(month.amountDue)}</span>
                <div class="title">{t("amount_due")}</div>
              </div>
            </div>
          </div>
        </div>
      </section>

      {await SubscriptionDetailsPopup({ c, ui })}
      <script src={asset(ui, "scripts/calendar.js")}></script>
    </>
  );
  return page(c, ui, "calendar", body);
});
