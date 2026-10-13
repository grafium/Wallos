import { Hono } from "hono";
import type { AppBindings } from "../../env";
import { todayUtc } from "../../lib/dates";
import { SubscriptionDetailsPopup, ThemedLogo } from "../components";
import { loadCurrencies, loadUi, uiPage, type Ui, type UiCtx } from "../context";
import { formatDate, formatPrice } from "../format";
import { asset, page } from "../layout";
import { calculateStats } from "../stats-calculations";

/*
  index.php (the dashboard) and about.php.
*/

export const routes = new Hono<AppBindings>();

interface DashboardItem {
  id: number;
  name: string;
  logo: string | null;
  logo_text_color: string | null;
  logo_variant: string | null;
  price: number;
  currency_id: number | null;
  next_payment: string | null;
  cancellation_date?: string | null;
}

function SubscriptionItem({ item, date, price }: { item: DashboardItem; date: string; price: string }) {
  return (
    <div class="subscription-item" onclick={`showSubscriptionDetails(event, ${item.id})`} data-id={item.id}>
      {item.logo ? (
        <ThemedLogo
          logo={item.logo}
          variant={item.logo_variant}
          textColor={item.logo_text_color}
          class="subscription-item-logo"
          alt={`${item.name} logo`}
          title={item.name}
        />
      ) : (
        <p class="subscription-item-title">{item.name}</p>
      )}
      <div class="subscription-item-info">
        <p class="subscription-item-date"> {date}</p>
        <p class="subscription-item-price"> {price}</p>
      </div>
    </div>
  );
}

function Value({ title, value }: { title: string; value: string | number }) {
  return (
    <div class="subscription-item thin">
      <p class="subscription-item-title">{title}</p>
      <div class="subscription-item-info">
        <p class="subscription-item-value">{value}</p>
      </div>
    </div>
  );
}

function Section({ className, title, subtitle, children }: { className: string; title: string; subtitle?: string; children?: unknown }) {
  return (
    <div class={className}>
      <h2>{title}</h2>
      {subtitle && <p class="header-subtitle">{subtitle}</p>}
      <div class="dashboard-subscriptions-container">
        <div class="dashboard-subscriptions-list">{children}</div>
      </div>
    </div>
  );
}

routes.get("/", uiPage, dashboard);
routes.get("/index.php", uiPage, dashboard);

async function dashboard(c: UiCtx) {
  const userId = c.get("user").id;
  const db = c.env.DB;
  const today = todayUtc();

  // An account without subscriptions starts on the subscriptions page (checkredirect.php).
  const any = await db.prepare("SELECT 1 FROM subscriptions WHERE user_id = ? LIMIT 1").bind(userId).first();
  if (!any) return c.redirect("subscriptions.php");

  const ui = await loadUi(c);
  const { t } = ui;
  const currencies = await loadCurrencies(c);
  const limit = [3, 5, 10, 20].includes(ui.settings.upcoming_payments_limit) ? ui.settings.upcoming_payments_limit : 3;
  const columns = "id, logo, logo_text_color, logo_variant, name, price, currency_id, next_payment, cancellation_date";

  const [upcoming, overdue, cancellations, aiRes] = await db.batch<DashboardItem>([
    db
      .prepare(`SELECT ${columns} FROM subscriptions WHERE user_id = ? AND next_payment >= ? AND inactive = 0 AND cycle != 5 ORDER BY next_payment ASC LIMIT ?`)
      .bind(userId, today, limit),
    db
      .prepare(`SELECT ${columns} FROM subscriptions WHERE user_id = ? AND next_payment < ? AND auto_renew = 0 AND inactive = 0 AND cycle != 5 ORDER BY next_payment ASC`)
      .bind(userId, today),
    db
      .prepare(
        `SELECT ${columns} FROM subscriptions WHERE user_id = ? AND inactive = 0 AND cancellation_date IS NOT NULL AND cancellation_date != ''
           AND cancellation_date >= ? AND cycle != 5 ORDER BY cancellation_date ASC`,
      )
      .bind(userId, today),
    db.prepare("SELECT id, title, description, savings FROM ai_recommendations WHERE user_id = ? ORDER BY id").bind(userId),
  ]);
  const recommendations = (aiRes?.results ?? []) as unknown as { id: number; title: string; description: string; savings: string }[];

  const stats = await calculateStats(c, t);
  const user = await db.prepare("SELECT username, firstname FROM user WHERE id = ?").bind(userId).first<{ username: string; firstname: string | null }>();
  const mainCode = currencies.get(ui.user.main_currency ?? -1)?.code ?? "EUR";
  const money = (amount: number, code = mainCode) => formatPrice(amount, code, currencies.values(), ui.locale);
  const itemPrice = (item: DashboardItem) => money(item.price, currencies.get(item.currency_id ?? -1)?.code ?? mainCode);

  const body = (
    <>
      <section class="contain dashboard">
        <h1>
          {t("hello")} {user?.firstname || user?.username || ""}
        </h1>

        {overdue!.results.length > 0 && (
          <div class="overdue-subscriptions">
            <h2>{t("overdue_renewals")}</h2>
            <div class="dashboard-subscriptions-container">
              <div class="dashboard-subscriptions-list">
                {overdue!.results.map((item) => (
                  <SubscriptionItem item={item} date={formatDate(item.next_payment ?? "", ui.lang)} price={itemPrice(item)} />
                ))}
              </div>
            </div>
          </div>
        )}

        <div class="upcoming-subscriptions">
          <h2>{t("upcoming_payments")}</h2>
          <div class="dashboard-subscriptions-container">
            <div class="dashboard-subscriptions-list">
              {upcoming!.results.length === 0 ? (
                <p>{t("no_upcoming_payments")}</p>
              ) : (
                upcoming!.results.map((item) => <SubscriptionItem item={item} date={formatDate(item.next_payment ?? "", ui.lang)} price={itemPrice(item)} />)
              )}
            </div>
          </div>

          {cancellations!.results.length > 0 && (
            <Section className="cancellation-subscriptions" title={t("upcoming_cancellations")}>
              {cancellations!.results.map((item) => (
                <SubscriptionItem item={item} date={formatDate(item.cancellation_date ?? "", ui.lang)} price={itemPrice(item)} />
              ))}
            </Section>
          )}

          {recommendations.length > 0 && (
            <div class="ai-recommendations">
              <h2>{t("ai_recommendations")}</h2>
              <div class="ai-recommendations-container">
                <ul class="ai-recommendations-list">
                  {recommendations.map((r, i) => (
                    <li class="ai-recommendation-item" data-id={r.id}>
                      <div class="ai-recommendation-header">
                        <h3>
                          <span>{`${i + 1}. `}</span>
                          {r.title}
                        </h3>
                        <span class="item-arrow-down fa fa-caret-down"></span>
                      </div>
                      <p class="collapsible">{r.description}</p>
                      <p class="ai-recommendation-savings">
                        {r.savings}
                        <span>
                          <a href="#" class="delete-ai-recommendation" title={t("delete")}>
                            <i class="fa fa-trash"></i>
                          </a>
                        </span>
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            </div>
          )}

          <Section className="budget-subscriptions" title={t("monthly_budget")}>
            <Value title={t("monthly_cost")} value={money(stats.totalCostPerMonth)} />
            {stats.monthly && (
              <>
                <Value title={t("budget")} value={money(stats.monthly.budget)} />
                <Value title={t("budget_used")} value={`${stats.monthly.used.toFixed(2)}%`} />
                <Value title={t("budget_remaining")} value={money(stats.monthly.left)} />
                {stats.monthly.over > 0 && <Value title={t("over_budget")} value={money(stats.monthly.over)} />}
              </>
            )}
          </Section>

          {stats.period && (
            <Section className="budget-subscriptions" title={t("period_budget")} subtitle={`${t("current_period")}: ${stats.budgetPeriodLabel}`}>
              <Value title={t("amount_needed_this_period")} value={money(stats.amountNeededThisPeriod)} />
              <Value title={t("budget")} value={money(stats.period.budget)} />
              <Value title={t("budget_used")} value={`${stats.period.used.toFixed(2)}%`} />
              <Value title={t("budget_remaining")} value={money(stats.period.left)} />
              {stats.period.over > 0 && <Value title={t("over_budget")} value={money(stats.period.over)} />}
            </Section>
          )}
        </div>

        {stats.activeSubscriptions > 0 && (
          <Section className="current-subscriptions" title={t("your_subscriptions")}>
            <Value title={t("active_subscriptions")} value={stats.activeSubscriptions} />
            <Value title={t("monthly_cost")} value={money(stats.totalCostPerMonth)} />
            <Value title={t("yearly_cost")} value={money(stats.totalCostPerYear)} />
          </Section>
        )}

        {stats.inactiveSubscriptions > 0 && (
          <Section className="savings-subscriptions" title={t("your_savings")}>
            <Value title={t("inactive_subscriptions")} value={stats.inactiveSubscriptions} />
            {stats.totalSavingsPerMonth > 0 && (
              <>
                <Value title={t("monthly_savings")} value={money(stats.totalSavingsPerMonth)} />
                <Value title={t("yearly_savings")} value={money(stats.totalSavingsPerMonth * 12)} />
              </>
            )}
          </Section>
        )}
      </section>

      {await SubscriptionDetailsPopup({ c, ui })}
      <script src={asset(ui, "scripts/dashboard.js")}></script>
    </>
  );
  return page(c, ui, "index", body);
}

function External({ href, title }: { href: string; title: string }) {
  return (
    <a href={href} target="_blank" title={title} rel="noreferrer">
      <i class="fa-solid fa-arrow-up-right-from-square"></i>
    </a>
  );
}

function Credit({ ui, title, text, href }: { ui: Ui; title: string; text: string; href: string }) {
  return (
    <div>
      <h3>{title}</h3>
      <span>
        {text} <External href={href} title={ui.t("external_url")} />
      </span>
    </div>
  );
}

routes.get("/about.php", uiPage, async (c) => {
  const ui = await loadUi(c);
  const { t } = ui;
  const figma = "https://www.figma.com/file/5IMW8JfoXfB5GRlPNdTyeg/Credit-Cards-and-Payment-Methods-Icons-(Community)";
  return page(
    c,
    ui,
    "about",
    <section class="contain">
      <section class="account-section">
        <header>
          <h2>{t("about")}</h2>
        </header>
        <div class="credits-list">
          <Credit ui={ui} title={`Wallos ${ui.version} (Cloudflare Workers)`} text={t("release_notes")} href="https://github.com/grafium/Wallos/tree/main/worker" />
          <Credit ui={ui} title={t("license")} text="GPLv3" href="https://www.gnu.org/licenses/gpl-3.0.en.html" />
          <Credit ui={ui} title={t("issues_and_requests")} text="GitHub" href="https://github.com/ellite/Wallos/issues" />
          <Credit ui={ui} title={t("the_author")} text="https://henrique.pt" href="https://henrique.pt/" />
        </div>
      </section>
      <section class="account-section">
        <header>
          <h2>{t("credits")}</h2>
        </header>
        <div class="credits-list">
          <Credit ui={ui} title={t("payment_icons")} text={figma} href={figma} />
          <Credit ui={ui} title="ApexCharts" text="https://apexcharts.com/" href="https://apexcharts.com/" />
          <Credit ui={ui} title="QRCode.js" text="https://github.com/davidshimjs/qrcodejs" href="https://github.com/davidshimjs/qrcodejs" />
          <Credit ui={ui} title="Icons by icons8" text="https://icons8.com/" href="https://icons8.com/" />
        </div>
      </section>
    </section>,
  );
});

