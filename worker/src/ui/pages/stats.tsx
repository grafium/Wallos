import { Hono } from "hono";
import type { Child } from "hono/jsx";
import { raw } from "hono/html";
import type { AppBindings } from "../../env";
import { DEFAULT_CATEGORIES } from "../../lib/defaults";
import { todayUtc } from "../../lib/dates";
import { ThemedLogo } from "../components";
import { loadCurrencies, loadUi, uiPage, type UiCtx } from "../context";
import { formatPrice } from "../format";
import { asset, js, page } from "../layout";
import { calculateStats, type StatsFilters } from "../stats-calculations";
import { calculateExtraStats, numberFormat, numericCheck, type DataPoint, type LogoTile } from "./stats-extra";

/*
  stats.php: the statistics page. Numbers come from stats-calculations.ts
  (includes/stats_calculations.php) and stats-extra.ts
  (includes/stats_extra_calculations.php); the charts are drawn by
  scripts/stats.js with ApexCharts from the data embedded at the end, in the
  same calls PHP made.
*/

export const routes = new Hono<AppBindings>();

/** "?member=1,2" -> [1, 2], like array_map('intval', explode(',', ...)); undefined when absent or empty. */
function ids(value: string | undefined): number[] | undefined {
  if (value === undefined || value === "") return undefined;
  return value.split(",").map((v) => parseInt(v, 10) || 0);
}

function Statistic({ value, title, short, children }: { value: Child; title: Child; short?: boolean; children?: Child }) {
  return (
    <div class={short ? "statistic short" : "statistic"}>
      <span>{value}</span>
      <div class="title">{title}</div>
      {children}
    </div>
  );
}

/** The logo (or name) under a tile, as renderThemedLogoImg() printed it. */
function TileSubtitle({ tile }: { tile: LogoTile | null }) {
  if (!tile) return null;
  if (tile.logo) {
    return (
      <div class="subtitle">
        <ThemedLogo logo={tile.logo} variant={tile.logo_variant} textColor={tile.logo_text_color} class="" alt={tile.name} title={tile.name} />
      </div>
    );
  }
  return tile.name ? <div class="subtitle">{tile.name}</div> : null;
}

function Graph({ id, title, sub, wide }: { id: string; title: Child; sub?: Child; wide?: boolean }) {
  return (
    <section class={wide ? "graph x2" : "graph"}>
      <header>
        {title}
        {sub !== undefined && <div class="sub-header">{sub}</div>}
      </header>
      <div id={id} style="width: 100%;"></div>
    </section>
  );
}

routes.get("/stats.php", uiPage, async (c: UiCtx) => {
  const ui = await loadUi(c);
  const { t } = ui;
  const query = c.req.query();
  const filters: StatsFilters = { member: ids(query.member), category: ids(query.category), payment: ids(query.payment) };
  const today = todayUtc();

  const currencies = await loadCurrencies(c);
  const stats = await calculateStats(c, t, filters, today);
  const extra = await calculateExtraStats(c, t, ui.lang, stats, filters, today);
  const code = currencies.get(ui.user.main_currency ?? -1)?.code ?? "EUR";
  const money = (amount: number) => formatPrice(amount, code, currencies.values(), ui.locale);

  // A category still carrying its untouched default name shows as "No category".
  const noCategoryName = DEFAULT_CATEGORIES[0];
  const categoryName = (name: string) => (name === noCategoryName ? t("no_category") : name);

  // Subtitle with the active filters (the shared calculation does not translate "No category").
  const subtitleParts: string[] = [];
  for (const id of filters.member ?? []) if (stats.members.has(id)) subtitleParts.push(stats.members.get(id)!.name);
  for (const id of filters.category ?? []) if (stats.categories.has(id)) subtitleParts.push(categoryName(stats.categories.get(id)!.name));
  for (const id of filters.payment ?? []) if (stats.paymentMethods.has(id)) subtitleParts.push(stats.paymentMethods.get(id)!.name);
  const statsSubtitle = subtitleParts.length ? `(${subtitleParts.join(", ")})` : "";

  const selected = (key: "member" | "category" | "payment", id: number) => query[key] !== undefined && (ids(query[key]) ?? [0]).includes(id);
  const members = [...stats.members.values()];
  const categories = [...stats.categories.values()].sort((a, b) => (a.order ?? 0) - (b.order ?? 0));
  const paymentMethods = [...stats.paymentMethods.values()].sort((a, b) => (extra.paymentMethodOrder.get(a.id) ?? 0) - (extra.paymentMethodOrder.get(b.id) ?? 0));

  // Graph datasets for the split views.
  const split = (items: Iterable<{ name: string; cost: number }>) =>
    [...items].filter((i) => i.cost !== 0).map((i): DataPoint => ({ label: i.name, y: i.cost })).sort((a, b) => b.y - a.y);
  const categoryDataPoints = split(stats.categories.values());
  const memberDataPoints = split(stats.members.values());
  const paymentMethodDataPoints: DataPoint[] = [];
  for (const [id, cost] of extra.paymentMethodCost) {
    const method = stats.paymentMethods.get(id ?? -1);
    if (cost > 0 && method) paymentMethodDataPoints.push({ label: method.name, y: Math.round(cost * 100) / 100 });
  }
  paymentMethodDataPoints.sort((a, b) => b.y - a.y);
  const showCategoryCostGraph = categoryDataPoints.length > 1;
  const showMemberCostGraph = memberDataPoints.length > 1;
  const showPaymentMethodsGraph = paymentMethodDataPoints.length > 1;
  const showTotalMonthlyCostGraph = stats.totalMonthlyCostDataPoints.length > 1;
  const showVsMonthlyBudgetGraph = stats.monthly !== null;
  const showVsPeriodBudgetGraph = stats.period !== null;

  const showMonthlyStats = query.budget === undefined || query.budget === "monthly";
  const showPeriodStats = query.budget === undefined || query.budget === "period";

  const showAnyGraph =
    showCategoryCostGraph ||
    showMemberCostGraph ||
    showPaymentMethodsGraph ||
    showTotalMonthlyCostGraph ||
    (showMonthlyStats && showVsMonthlyBudgetGraph) ||
    (showPeriodStats && showVsPeriodBudgetGraph) ||
    extra.showProjectionGraph ||
    extra.showLifetimeGraph ||
    extra.showCycleGraph ||
    extra.showCurrencyGraph ||
    extra.showHistogramGraph ||
    extra.showYearlyNewGraph;
  const showTrendsSection = showTotalMonthlyCostGraph || extra.showProjectionGraph || extra.monthOverMonthDelta !== null;
  const showBudgetSection = (showMonthlyStats && stats.monthly !== null) || (showPeriodStats && stats.period !== null);
  const showSplitSection =
    showMemberCostGraph || showCategoryCostGraph || showPaymentMethodsGraph || extra.showCycleGraph || extra.showCurrencyGraph || extra.showHistogramGraph;
  const showHistorySection =
    extra.totalLifetimeSpend > 0 || extra.oldest !== null || extra.averageSubscriptionAge !== null || extra.showLifetimeGraph || extra.showYearlyNewGraph;

  const momSign = (extra.monthOverMonthDelta ?? 0) >= 0 ? "+" : "-";
  const periodRange = stats.budgetPeriodLabel;
  const mostExpensive = stats.mostExpensive;

  const data = (points: unknown) => js(numericCheck(points));
  const flag = (value: boolean) => (value ? 1 : 0);
  const budgetLine = stats.monthly && stats.monthly.budget > 0 ? String(stats.monthly.budget) : "null";
  const chartScript = [
    "window.onload = function () {",
    `      loadLineGraph("totalMonthlyCostChart", ${data(stats.totalMonthlyCostDataPoints)}, ${js(code)}, ${flag(showTotalMonthlyCostGraph)});`,
    `      loadBarGraph("projectionChart", ${data(extra.projectionDataPoints)}, ${js(code)}, ${flag(extra.showProjectionGraph)}, ${budgetLine});`,
    `      loadGraph("categorySplitChart", ${data(categoryDataPoints)}, ${js(code)}, ${flag(showCategoryCostGraph)});`,
    `      loadGraph("memberSplitChart", ${data(memberDataPoints)}, ${js(code)}, ${flag(showMemberCostGraph)});`,
    `      loadGraph("paymentMethidSplitChart", ${data(paymentMethodDataPoints)}, ${js(code)}, ${flag(showPaymentMethodsGraph)});`,
    ...(showMonthlyStats && showVsMonthlyBudgetGraph ? [`      loadGraph("monthlyBudgetVsCostChart", ${data(stats.vsMonthlyBudgetDataPoints)}, ${js(code)}, 1);`] : []),
    ...(showPeriodStats && showVsPeriodBudgetGraph ? [`      loadGraph("periodBudgetVsCostChart", ${data(stats.vsPeriodBudgetDataPoints)}, ${js(code)}, 1);`] : []),
    `      loadGraph("cycleSplitChart", ${data(extra.cycleDataPoints)}, ${js(code)}, ${flag(extra.showCycleGraph)});`,
    `      loadGraph("currencySplitChart", ${data(extra.currencyDataPoints)}, ${js(code)}, ${flag(extra.showCurrencyGraph)});`,
    `      loadBarGraph("priceHistogramChart", ${data(extra.histogramDataPoints)}, "", ${flag(extra.showHistogramGraph)}, null);`,
    `      loadBarGraph("newPerYearChart", ${data(extra.newPerYearDataPoints)}, "", ${flag(extra.showYearlyNewGraph)}, null);`,
    `      loadHorizontalBarGraph("lifetimeSpendChart", ${data(extra.lifetimeDataPoints)}, ${js(code)}, ${flag(extra.showLifetimeGraph)});`,
    "    }",
  ].join("\n");

  const body = (
    <>
      <section class="contain">
        {stats.showCantConvertMessage && (
          <div class="error-box">
            <div class="error-message">
              <i class="fa-solid fa-exclamation-circle"></i>
              {t("cant_convert_currency")}
            </div>
          </div>
        )}
        <div class="split-header">
          <h2>
            {t("general_statistics")} <span class="header-subtitle">{statsSubtitle}</span>
          </h2>
          <div class="filtermenu">
            <button class="button secondary-button" id="filtermenu-button" title={t("filter")}>
              <i class="fa-solid fa-filter"></i>
            </button>
            <div class="filtermenu-content">
              {members.length > 1 && (
                <div class="filtermenu-submenu">
                  <div class="filter-title" onclick="toggleSubMenu('member')">
                    {t("member")}
                  </div>
                  <div class="filtermenu-submenu-content" id="filter-member">
                    {members
                      .filter((m) => (stats.menuCounts.member.get(m.id) ?? 0) > 0 || selected("member", m.id))
                      .map((m) => (
                        <div class={`filter-item ${selected("member", m.id) ? "selected" : ""}`} data-memberid={m.id}>
                          {m.name}
                        </div>
                      ))}
                  </div>
                </div>
              )}
              {categories.length > 1 && (
                <div class="filtermenu-submenu">
                  <div class="filter-title" onclick="toggleSubMenu('category')">
                    {t("category")}
                  </div>
                  <div class="filtermenu-submenu-content" id="filter-category">
                    {categories
                      .filter((cat) => (stats.menuCounts.category.get(cat.id) ?? 0) > 0 || selected("category", cat.id))
                      .map((cat) => (
                        <div class={`filter-item ${selected("category", cat.id) ? "selected" : ""}`} data-categoryid={cat.id}>
                          {categoryName(cat.name)}
                        </div>
                      ))}
                  </div>
                </div>
              )}
              {paymentMethods.length > 1 && (
                <div class="filtermenu-submenu">
                  <div class="filter-title" onclick="toggleSubMenu('payment')">
                    {t("payment_method")}
                  </div>
                  <div class="filtermenu-submenu-content" id="filter-payment">
                    {paymentMethods
                      .filter((p) => (stats.menuCounts.payment.get(p.id) ?? 0) > 0 || selected("payment", p.id))
                      .map((p) => (
                        <div class={`filter-item ${selected("payment", p.id) ? "selected" : ""}`} data-paymentid={p.id}>
                          {p.name}
                        </div>
                      ))}
                  </div>
                </div>
              )}
              {(query.member !== undefined || query.category !== undefined || query.payment !== undefined) && (
                <div class="filtermenu-submenu">
                  <div class="filter-title filter-clear" onclick="clearFilters()">
                    <i class="fa-solid fa-times-circle"></i> {t("clear")}
                  </div>
                </div>
              )}
            </div>
          </div>
        </div>

        <section class="stats-section">
          <h2>{t("overview")}</h2>
          <div class="statistics">
            <Statistic value={stats.activeSubscriptions} title={t("active_subscriptions")} />
            <Statistic value={money(stats.totalCostPerMonth)} title={t("monthly_cost")} />
            <Statistic value={money(stats.totalCostPerYear)} title={t("yearly_cost")} />
            {stats.totalCostPerMonth > 0 && <Statistic value={money(extra.costPerDay)} title={t("cost_per_day")} />}
            <Statistic value={money(stats.averageSubscriptionCost)} title={t("average_monthly")} />
            <Statistic value={money(mostExpensive?.price ?? 0)} title={t("most_expensive")} short>
              <TileSubtitle tile={mostExpensive} />
            </Statistic>
            {extra.cheapest && (
              <Statistic value={money(extra.cheapest.price)} title={t("cheapest_subscription")} short>
                <TileSubtitle tile={extra.cheapest} />
              </Statistic>
            )}
            <Statistic value={money(stats.amountDueThisMonth)} title={t("amount_due")} />
            {extra.manualRenewalsCount > 0 && <Statistic value={extra.manualRenewalsCount} title={t("manual_renewals")} />}
          </div>
        </section>

        {showTrendsSection && (
          <section class="stats-section">
            <h2>{t("trends_and_forecast")}</h2>
            {(extra.monthOverMonthDelta !== null || (extra.showProjectionGraph && extra.heaviestMonth !== null) || extra.monthsOverBudget !== null) && (
              <div class="statistics">
                {extra.monthOverMonthDelta !== null && (
                  <Statistic value={`${momSign}${money(Math.abs(extra.monthOverMonthDelta))}`} title={t("vs_last_month")} short>
                    {extra.monthOverMonthPercentage !== null && (
                      <div class="subtitle">{`${momSign}${numberFormat(Math.abs(extra.monthOverMonthPercentage), 1)}%`}</div>
                    )}
                  </Statistic>
                )}
                {extra.showProjectionGraph && extra.heaviestMonth && (
                  <Statistic value={money(extra.heaviestMonth.total)} title={t("heaviest_month")} short>
                    <div class="subtitle capitalize">{extra.heaviestMonth.label}</div>
                  </Statistic>
                )}
                {extra.monthsOverBudget !== null && <Statistic value={extra.monthsOverBudget} title={t("months_over_budget")} />}
              </div>
            )}
            {(showTotalMonthlyCostGraph || extra.showProjectionGraph) && (
              <div class="graphs">
                {showTotalMonthlyCostGraph && <Graph id="totalMonthlyCostChart" title={t("total_cost_trend")} sub={`(${t("monthly_cost")})`} wide />}
                {extra.showProjectionGraph && <Graph id="projectionChart" title={t("projected_cost")} wide />}
              </div>
            )}
          </section>
        )}

        {showBudgetSection && (
          <section class="stats-section">
            <h2>{t("budget")}</h2>
            <div class="statistics">
              {showMonthlyStats && stats.monthly && (
                <>
                  <Statistic value={`${numberFormat(stats.monthly.used, 2)}%`} title={`${t("monthly_budget")} - ${t("percentage_budget_used")}`} />
                  <Statistic value={money(stats.monthly.left)} title={`${t("monthly_budget")} - ${t("budget_remaining")}`} />
                  {stats.monthly.over > 0 && <Statistic value={money(stats.monthly.over)} title={`${t("monthly_budget")} - ${t("amount_over_budget")}`} />}
                </>
              )}
              {showPeriodStats && stats.period && (
                <>
                  <Statistic value={money(stats.amountNeededThisPeriod)} title={t("amount_needed_this_period")}>
                    <div class="period-range">{periodRange}</div>
                  </Statistic>
                  <Statistic value={`${numberFormat(stats.period.used, 2)}%`} title={`${t("period_budget")} - ${t("percentage_budget_used")}`}>
                    <div class="period-range">{periodRange}</div>
                  </Statistic>
                  <Statistic value={money(stats.period.left)} title={`${t("period_budget")} - ${t("budget_remaining")}`}>
                    <div class="period-range">{periodRange}</div>
                  </Statistic>
                  {stats.period.over > 0 && (
                    <Statistic value={money(stats.period.over)} title={`${t("period_budget")} - ${t("amount_over_budget")}`}>
                      <div class="period-range">{periodRange}</div>
                    </Statistic>
                  )}
                </>
              )}
            </div>
            {((showMonthlyStats && showVsMonthlyBudgetGraph) || (showPeriodStats && showVsPeriodBudgetGraph)) && (
              <div class="graphs">
                {showMonthlyStats && stats.monthly && (
                  <Graph id="monthlyBudgetVsCostChart" title={`${t("cost_vs_monthly_budget")} (${money(stats.monthly.budget)})`} sub={`(${t("monthly_cost")})`} />
                )}
                {showPeriodStats && stats.period && (
                  <Graph id="periodBudgetVsCostChart" title={`${t("cost_vs_period_budget")} (${money(stats.period.budget)})`} sub={`(${t("amount_needed_this_period")})`} />
                )}
              </div>
            )}
          </section>
        )}

        {showSplitSection && (
          <section class="stats-section">
            <h2>{t("split_views")}</h2>
            <div class="graphs">
              {showMemberCostGraph && <Graph id="memberSplitChart" title={t("household_split")} sub={`(${t("monthly_cost")})`} />}
              {showCategoryCostGraph && <Graph id="categorySplitChart" title={t("category_split")} sub={`(${t("monthly_cost")})`} />}
              {showPaymentMethodsGraph && <Graph id="paymentMethidSplitChart" title={t("payment_method_split")} sub={`(${t("monthly_cost")})`} />}
              {extra.showCycleGraph && <Graph id="cycleSplitChart" title={t("billing_cycle_split")} sub={`(${t("monthly_cost")})`} />}
              {extra.showCurrencyGraph && <Graph id="currencySplitChart" title={t("currency_split")} sub={`(${t("monthly_cost")})`} />}
              {extra.showHistogramGraph && <Graph id="priceHistogramChart" title={t("price_distribution")} sub={`(${t("monthly_cost")}, ${code})`} />}
            </div>
          </section>
        )}

        {showHistorySection && (
          <section class="stats-section">
            <h2>{t("history_and_lifetime")}</h2>
            {(extra.totalLifetimeSpend > 0 || extra.oldest !== null || extra.averageSubscriptionAge !== null) && (
              <div class="statistics">
                {extra.totalLifetimeSpend > 0 && <Statistic value={money(extra.totalLifetimeSpend)} title={t("all_time_spend")} />}
                {extra.oldest && (
                  <Statistic value={numberFormat(extra.oldest.years, 1)} title={t("oldest_subscription")} short>
                    <TileSubtitle tile={extra.oldest} />
                  </Statistic>
                )}
                {extra.averageSubscriptionAge !== null && <Statistic value={numberFormat(extra.averageSubscriptionAge, 1)} title={t("average_subscription_age")} />}
              </div>
            )}
            {(extra.showLifetimeGraph || extra.showYearlyNewGraph) && (
              <div class="graphs">
                {extra.showYearlyNewGraph && <Graph id="newPerYearChart" title={t("new_subscriptions_per_year")} />}
                {extra.showLifetimeGraph && <Graph id="lifetimeSpendChart" title={t("lifetime_spend")} sub={t("estimated_from_current_prices")} />}
              </div>
            )}
          </section>
        )}

        {extra.upcomingCancellationsCount > 0 && (
          <section class="stats-section">
            <h2>{t("upcoming_cancellations")}</h2>
            <div class="statistics">
              <Statistic value={extra.upcomingCancellationsCount} title={t("subscriptions")} />
              {extra.potentialMonthlySavings > 0 && (
                <>
                  <Statistic value={money(extra.potentialMonthlySavings)} title={t("potential_monthly_savings")} />
                  <Statistic value={money(extra.potentialMonthlySavings * 12)} title={t("potential_yearly_savings")} />
                </>
              )}
            </div>
          </section>
        )}

        {stats.inactiveSubscriptions > 0 && (
          <section class="stats-section">
            <h2>{t("your_savings")}</h2>
            <div class="statistics">
              <Statistic value={stats.inactiveSubscriptions} title={t("inactive_subscriptions")} />
              {stats.totalSavingsPerMonth > 0 && (
                <>
                  <Statistic value={money(stats.totalSavingsPerMonth)} title={t("monthly_savings")} />
                  <Statistic value={money(stats.totalSavingsPerMonth * 12)} title={t("yearly_savings")} />
                </>
              )}
            </div>
          </section>
        )}
      </section>
      {showAnyGraph && (
        <>
          <script src="scripts/libs/apexcharts.min.js"></script>
          <script type="text/javascript">{raw(chartScript)}</script>
        </>
      )}
      <script src={asset(ui, "scripts/stats.js")}></script>
    </>
  );
  return page(c, ui, "stats", body);
});
