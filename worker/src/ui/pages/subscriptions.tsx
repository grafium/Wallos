import { Hono } from "hono";
import { getCookie } from "hono/cookie";
import { raw } from "hono/html";
import type { AppBindings } from "../../env";
import { diffDays, addDays, isCycleId, isValidDate, todayUtc } from "../../lib/dates";
import { convertPrice, pricePerMonth } from "../../lib/pricing";
import type { SubscriptionRow } from "../../services/subscriptions";
import { paymentIconSrc, SubscriptionDetailsPopup, ThemedLogo } from "../components";
import { loadUi, uiPage, type Ui, type UiCtx } from "../context";
import { formatDate, formatPrice, type CurrencyInfo } from "../format";
import { translator } from "../i18n";
import { asset, Icon, js, page } from "../layout";

/*
  subscriptions.php: the list (includes/list_subscriptions.php), the filter
  menu (includes/filters_menu.php), the sort options (includes/sort_options.php)
  and the add/edit form. The list rendering is shared with
  endpoints/subscriptions/get.php, which returns the same markup as a fragment
  when the scripts refresh the list.
*/

export const routes = new Hono<AppBindings>();

// --- the user's lookups (includes/getdbkeys.php) ---------------------------------

export interface Member {
  id: number;
  name: string;
}
export interface Category {
  id: number;
  name: string;
  order: number;
}
export interface PaymentMethod {
  id: number;
  name: string;
  icon: string | null;
  enabled: number;
  order: number;
}

export interface Lookups {
  currencies: Map<number, CurrencyInfo & { name: string; rate: number }>;
  members: Map<number, Member>;
  categories: Map<number, Category>;
  /** Every payment method; the menus and the form only offer the enabled ones. */
  paymentMethods: Map<number, PaymentMethod>;
  cycles: { id: number; name: string }[];
}

export async function loadLookups(c: UiCtx): Promise<Lookups> {
  const db = c.env.DB;
  const userId = c.get("user").id;
  const [currencies, members, methods, categories, cycles] = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT id, name, symbol, code, rate FROM currencies WHERE user_id = ? ORDER BY id").bind(userId),
    db.prepare("SELECT id, name FROM household WHERE user_id = ? ORDER BY id").bind(userId),
    db.prepare('SELECT id, name, icon, enabled, "order" FROM payment_methods WHERE user_id = ? ORDER BY "order" ASC, id').bind(userId),
    db.prepare('SELECT id, name, "order" FROM categories WHERE user_id = ? ORDER BY "order" ASC, id').bind(userId),
    db.prepare("SELECT id, name FROM cycles ORDER BY id"),
  ]);
  const byId = <T,>(rows: Record<string, unknown>[] | undefined) => new Map((rows ?? []).map((r) => [r.id as number, r as unknown as T]));
  return {
    currencies: byId(currencies?.results),
    members: byId(members?.results),
    paymentMethods: byId(methods?.results),
    categories: byId(categories?.results),
    cycles: (cycles?.results ?? []) as unknown as { id: number; name: string }[],
  };
}

// --- querying -------------------------------------------------------------------

const SORT_CRITERIA = ["name", "id", "next_payment", "price", "payer_user_id", "category_id", "payment_method_id", "inactive", "alphanumeric", "renewal_type"];

export interface Sorting {
  /** The option the user picked (sortOrder cookie), as the sort menu shows it. */
  sortOrder: string;
  /** The column the list is ordered and grouped by. */
  sort: string;
  order: "ASC" | "DESC";
}

export function sorting(c: UiCtx): Sorting {
  const cookie = getCookie(c, "sortOrder");
  const sortOrder = cookie ? cookie : "next_payment";
  const order = sortOrder === "price" || sortOrder === "id" ? "DESC" : "ASC";
  let sort = sortOrder === "alphanumeric" ? "name" : sortOrder;
  if (!SORT_CRITERIA.includes(sort)) sort = "next_payment";
  if (sort === "renewal_type") sort = "auto_renew";
  return { sortOrder, sort, order };
}

function orderBy({ sort, order }: Sorting, disabledToBottom: boolean): string {
  const clauses: string[] = [];
  if (disabledToBottom) {
    if (["payer_user_id", "category_id", "payment_method_id"].includes(sort)) clauses.push(`${sort} ${order}`, "inactive ASC");
    else clauses.push("inactive ASC", `${sort} ${order}`);
  } else {
    clauses.push(`${sort} ${order}`);
    if (sort !== "inactive") clauses.push("inactive ASC");
  }
  if (sort !== "next_payment") clauses.push("next_payment ASC");
  return clauses.join(", ");
}

export interface Filters {
  member?: string;
  category?: string;
  payment?: string;
  state?: string;
  renewalType?: string;
  notifications?: string;
}

const ids = (value: string) => value.split(",").map((v) => Number.parseInt(v.trim(), 10) || 0);

/** The user's subscriptions, filtered and ordered like subscriptions.php and endpoints/subscriptions/get.php. */
export async function querySubscriptions(c: UiCtx, filters: Filters, sort: Sorting, disabledToBottom: boolean): Promise<SubscriptionRow[]> {
  const where = ["user_id = ?"];
  const params: unknown[] = [c.get("user").id];
  for (const [column, value] of [
    ["payer_user_id", filters.member],
    ["category_id", filters.category],
    ["payment_method_id", filters.payment],
  ] as const) {
    if (value === undefined || value === "") continue;
    const list = ids(value);
    where.push(`${column} IN (${list.map(() => "?").join(", ")})`);
    params.push(...list);
  }
  if (filters.state !== undefined && filters.state !== "") {
    where.push("inactive = ?");
    params.push(Number.parseInt(filters.state, 10) || 0);
  }
  if (filters.renewalType !== undefined && filters.renewalType !== "") {
    if (filters.renewalType === "onetime") where.push("cycle = 5");
    else {
      where.push("auto_renew = ? AND cycle != 5");
      params.push(Number.parseInt(filters.renewalType, 10) || 0);
    }
  }
  if (filters.notifications) {
    const conditions: string[] = [];
    for (const type of filters.notifications.split(",")) {
      if (type === "reminder") conditions.push("notify = 1");
      // One-time purchases are never cancellable, as on the dashboard and in the cron.
      else if (type === "cancellation") conditions.push("(cancellation_date IS NOT NULL AND cancellation_date != '' AND cycle != 5)");
      else if (type === "none") conditions.push("(notify = 0 AND (cancellation_date IS NULL OR cancellation_date = '' OR cycle = 5))");
    }
    if (conditions.length) where.push(`(${conditions.join(" OR ")})`);
  }
  const sql = `SELECT * FROM subscriptions WHERE ${where.join(" AND ")} ORDER BY ${orderBy(sort, disabledToBottom)}`;
  return (await c.env.DB.prepare(sql).bind(...params).all<SubscriptionRow>()).results;
}

// --- what a list entry shows (the $print array) --------------------------------------

export interface PrintItem {
  id: number;
  logo: string | null;
  logo_text_color: string | null;
  logo_variant: string | null;
  name: string;
  billing_cycle: string;
  one_time: boolean;
  currency_code: string;
  auto_renew: number;
  next_payment: string;
  payment_method_icon: string;
  payment_method_name: string;
  payment_method_id: number | null;
  category_id: number | null;
  payer_user_id: number | null;
  price: number;
  progress: number;
  inactive: number;
  original_price?: number;
  original_currency_code?: string;
}

export function billingCycle(ui: Ui, cycle: number | null, frequency: number | null): string {
  const { t } = ui;
  const one = frequency === 1;
  switch (cycle) {
    case 1:
      return one ? t("Daily") : `${frequency} ${t("days")}`;
    case 2:
      return one ? t("Weekly") : `${frequency} ${t("weeks")}`;
    case 3:
      return one ? t("Monthly") : `${frequency} ${t("months")}`;
    case 4:
      return one ? t("Yearly") : `${frequency} ${t("years")}`;
    case 5:
      return t("One-time");
    default:
      return "";
  }
}

/** getSubscriptionProgress(): how far into the current billing period today is, in percent. */
export function subscriptionProgress(cycle: number | null, frequency: number | null, nextPayment: string | null, today = todayUtc()): number {
  if (cycle === 5 || !nextPayment || !isValidDate(nextPayment)) return 0;
  const freq = frequency ?? 1;
  const cycleDays = cycle === 1 ? freq : cycle === 2 ? 7 * freq : cycle === 3 ? 30 * freq : cycle === 4 ? 365 * freq : 30;
  if (cycleDays <= 0) return 0;
  const daysUntil = Math.abs(diffDays(today, nextPayment));
  const cyclesBack = today <= nextPayment ? Math.max(1, Math.ceil(daysUntil / cycleDays)) : 1;
  const lastPayment = addDays(nextPayment, -cyclesBack * cycleDays);
  const daysSince = Math.abs(diffDays(lastPayment, today));
  return Math.floor((daysSince / cycleDays) * 100);
}

/** strnatcmp(): digit runs compare as numbers, everything else byte-wise. */
export function naturalCompare(a: string, b: string): number {
  const re = /\d+|\D+/g;
  const left = a.match(re) ?? [];
  const right = b.match(re) ?? [];
  for (let i = 0; i < Math.min(left.length, right.length); i++) {
    const x = left[i]!;
    const y = right[i]!;
    if (/^\d/.test(x) && /^\d/.test(y)) {
      const diff = Number(x) - Number(y);
      if (diff !== 0) return diff;
    } else if (x !== y) return x < y ? -1 : 1;
  }
  return left.length - right.length;
}

export function printItems(rows: SubscriptionRow[], ui: Ui, lookups: Lookups, mainCurrencyId: number | null): PrintItem[] {
  const s = ui.settings;
  const items: PrintItem[] = [];
  for (const row of rows) {
    if (row.inactive && s.hide_disabled) continue;
    const method = lookups.paymentMethods.get(row.payment_method_id ?? -1);
    const code = lookups.currencies.get(row.currency_id ?? -1)?.code ?? "";
    const item: PrintItem = {
      id: row.id,
      logo: row.logo || null,
      logo_text_color: row.logo_text_color ?? null,
      logo_variant: row.logo_variant || null,
      name: row.name ?? "",
      billing_cycle: billingCycle(ui, row.cycle, row.frequency),
      one_time: row.cycle === 5,
      currency_code: code,
      auto_renew: row.auto_renew,
      next_payment: row.next_payment ?? "",
      payment_method_icon: paymentIconSrc(method?.icon),
      payment_method_name: method?.name ?? "",
      payment_method_id: row.payment_method_id,
      category_id: row.category_id,
      payer_user_id: row.payer_user_id,
      price: Number(row.price),
      progress: subscriptionProgress(row.cycle, row.frequency, row.next_payment),
      inactive: row.inactive,
    };
    if (s.convert_currency && row.currency_id !== mainCurrencyId && mainCurrencyId !== null) {
      item.price = convertPrice(item.price, lookups.currencies.get(row.currency_id ?? -1)?.rate);
      item.currency_code = lookups.currencies.get(mainCurrencyId)?.code ?? code;
    }
    if (s.monthly_price) {
      const cycle = row.cycle ?? 3;
      item.price = isCycleId(cycle) ? pricePerMonth(cycle, row.frequency || 1, item.price) : item.price;
    }
    if (s.show_original_price) {
      item.original_price = Number(row.price);
      item.original_currency_code = code;
    }
    items.push(item);
  }
  return items;
}

/** The re-orderings PHP did in PHP after the query: category/payment-method order, natural name order. */
export function reorder(items: PrintItem[], sortOrder: string, ui: Ui, lookups: Lookups): PrintItem[] {
  let list = [...items];
  if (sortOrder === "alphanumeric") {
    list.sort((a, b) => naturalCompare(a.name.toLowerCase(), b.name.toLowerCase()));
    if (ui.settings.disabled_to_bottom) list.sort((a, b) => a.inactive - b.inactive);
  }
  const position = (map: Map<number, { order: number }>, id: number | null) => map.get(id ?? -1)?.order ?? 0;
  if (sortOrder === "category_id") list.sort((a, b) => position(lookups.categories, a.category_id) - position(lookups.categories, b.category_id));
  if (sortOrder === "payment_method_id") {
    list.sort((a, b) => position(lookups.paymentMethods, a.payment_method_id) - position(lookups.paymentMethods, b.payment_method_id));
  }
  return list;
}

/** A category still carrying its untouched default name (filters_menu.php). */
function isDefaultNoCategory(ui: Ui, name: string): boolean {
  return name === "No category" || name === translator(ui.user.language || "en")("no_category");
}

// --- printSubscriptions() -----------------------------------------------------------

export function SubscriptionList({ items, sort, ui, lookups }: { items: PrintItem[]; sort: string; ui: Ui; lookups: Lookups }) {
  const { t } = ui;
  const mobileNavigation = Boolean(ui.settings.mobile_nav);
  let list = [...items];
  if (sort === "price") {
    list.sort((a, b) => b.price - a.price);
    if (ui.settings.disabled_to_bottom) list.sort((a, b) => a.inactive - b.inactive);
  }
  // One-time purchases always go to the bottom, whatever the order.
  list.sort((a, b) => (a.one_time ? 1 : 0) - (b.one_time ? 1 : 0));

  let currentCategory: number | null = 0;
  let currentPayer: number | null = 0;
  let currentMethod: number | null = 0;
  let oneTimeShown = false;
  const out: unknown[] = [];

  for (const item of list) {
    if (item.one_time && !oneTimeShown) {
      out.push(<div class="subscription-list-title">{t("lifetime_purchases")}</div>);
      oneTimeShown = true;
    }
    if (sort === "category_id" && item.category_id !== currentCategory) {
      const name = lookups.categories.get(item.category_id ?? -1)?.name ?? "";
      out.push(<div class="subscription-list-title">{isDefaultNoCategory(ui, name) ? t("no_category") : name}</div>);
      currentCategory = item.category_id;
    }
    if (sort === "payer_user_id" && item.payer_user_id !== currentPayer) {
      out.push(<div class="subscription-list-title">{lookups.members.get(item.payer_user_id ?? -1)?.name ?? ""}</div>);
      currentPayer = item.payer_user_id;
    }
    if (sort === "payment_method_id" && item.payment_method_id !== currentMethod) {
      out.push(<div class="subscription-list-title">{item.payment_method_name}</div>);
      currentMethod = item.payment_method_id;
    }

    const id = item.id;
    const renewable = item.auto_renew !== 1 && !item.one_time;
    const extra = `${item.inactive ? " inactive" : ""}${item.auto_renew !== 1 ? " manual" : ""}`;
    const hasLogo = Boolean(item.logo);
    const cycleTitle = item.one_time ? item.billing_cycle : item.auto_renew ? t("automatically_renews") : t("manual_renewal");
    const progress = Math.min(item.progress, 100);

    out.push(
      <div class="subscription-container">
        {mobileNavigation && (
          <div class="mobile-actions" data-id={id}>
            <button class="mobile-action-clone"></button>
            <button class="mobile-action-clone" onclick={`cloneSubscription(event, ${id})`}>
              <Icon name="mobile-menu/clone" />
              Clone
            </button>
            <button class="mobile-action-delete" onclick={`deleteSubscription(event, ${id})`}>
              <Icon name="mobile-menu/delete" />
              Delete
            </button>
            {renewable && (
              <button class="mobile-action-renew" onclick={`renewSubscription(event, ${id})`}>
                <Icon name="mobile-menu/renew" />
                Renew
              </button>
            )}
            <button class="mobile-action-edit" onclick={`openEditSubscription(event, ${id})`}>
              <Icon name="mobile-menu/edit" />
              Edit
            </button>
          </div>
        )}

        <div class={`subscription${extra}`} onclick={`showSubscriptionDetails(event, ${id})`} data-id={id} data-name={item.name}>
          <div class="subscription-main">
            <span class={`logo ${!hasLogo ? "hideOnMobile" : ""}`}>
              {hasLogo ? <ThemedLogo logo={item.logo} variant={item.logo_variant} textColor={item.logo_text_color} /> : <Icon name="logo" />}
            </span>
            <span class={`name ${hasLogo ? "hideOnMobile" : ""}`}>{item.name}</span>
            <span class="cycle" title={cycleTitle}>
              {!item.one_time && (item.auto_renew ? <Icon name="automatic" /> : <Icon name="manual" />)}
              {item.billing_cycle}
            </span>
            <span class="next">{item.next_payment ? formatDate(item.next_payment, ui.lang) : ""}</span>
            <span class="price">
              <span class="value">
                {formatPrice(item.price, item.currency_code, lookups.currencies.values(), ui.locale)}
                {item.original_price !== undefined && item.original_price !== item.price && (
                  <span class="original_price">({formatPrice(item.original_price, item.original_currency_code ?? "", lookups.currencies.values(), ui.locale)})</span>
                )}
              </span>
            </span>
            <span class="payment_method">
              <img src={item.payment_method_icon} title={`${t("payment_method")}: ${item.payment_method_name}`} />
            </span>
            <button type="button" class={`actions-expand ${mobileNavigation ? "mobileNavigationHideOnMobile" : ""}`} onclick={`expandActions(event, ${id})`}>
              <i class="fas fa-ellipsis-v"></i>
            </button>
            <ul class="actions">
              <li class="edit" title={t("edit_subscription")} onclick={`openEditSubscription(event, ${id})`}>
                <i class="fa-solid fa-pen-to-square"></i>
                {t("edit_subscription")}
              </li>
              <li class="delete" title={t("delete")} onclick={`deleteSubscription(event, ${id})`}>
                <i class="fa-solid fa-trash-can"></i>
                {t("delete")}
              </li>
              <li class="clone" title={t("clone")} onclick={`cloneSubscription(event, ${id})`}>
                <i class="fa-solid fa-copy"></i>
                {t("clone")}
              </li>
              {renewable && (
                <li class="renew" title={t("renew")} onclick={`renewSubscription(event, ${id})`}>
                  <i class="fa-solid fa-rotate-right"></i>
                  {t("renew")}
                </li>
              )}
            </ul>
          </div>
          <div class="subscription-back" inert>
            <button type="button" class="subscription-back-close" onclick={`event.stopPropagation(); unflipCard(${id})`} title={t("cancel")}>
              <i class="fa-solid fa-xmark"></i>
            </button>
            <button type="button" class="back-action" onclick={`unflipCard(${id}); openEditSubscription(event, ${id})`}>
              <i class="fa-solid fa-pen-to-square"></i>
              {t("edit_subscription")}
            </button>
            <button type="button" class="back-action" onclick={`unflipCard(${id}); cloneSubscription(event, ${id})`}>
              <i class="fa-solid fa-copy"></i>
              {t("clone")}
            </button>
            {renewable && (
              <button type="button" class="back-action" onclick={`unflipCard(${id}); renewSubscription(event, ${id})`}>
                <i class="fa-solid fa-rotate-right"></i>
                {t("renew")}
              </button>
            )}
            <button type="button" class="back-action delete" onclick={`unflipCard(${id}); deleteSubscription(event, ${id})`}>
              <i class="fa-solid fa-trash-can"></i>
              {t("delete")}
            </button>
          </div>
        </div>
        {ui.settings.show_subscription_progress && !item.inactive ? (
          <div class="subscription-progress-container">
            <span class="subscription-progress" style={`width: ${progress}%;`}></span>
          </div>
        ) : null}
      </div>,
    );
  }
  return <>{out}</>;
}

// --- the filter menu and sort options ------------------------------------------------

function FiltersMenu({ ui, lookups, counts, query }: { ui: Ui; lookups: Lookups; counts: Counts; query: Record<string, string> }) {
  const { t } = ui;
  const selected = (param: string, id: number) => (query[param] !== undefined && query[param]!.split(",").includes(String(id)) ? "selected" : "");
  const methods = [...lookups.paymentMethods.values()].filter((m) => m.enabled);
  return (
    <div class="filtermenu-content">
      {lookups.members.size > 1 && (
        <div class="filtermenu-submenu">
          <div class="filter-title" onclick="toggleSubMenu('member')">{t("member")}</div>
          <div class="filtermenu-submenu-content" id="filter-member">
            {[...lookups.members.values()]
              .filter((m) => (counts.member.get(m.id) ?? 0) > 0)
              .map((m) => (
                <div class={`filter-item ${selected("member", m.id)}`} data-memberid={m.id}>
                  {m.name}
                </div>
              ))}
          </div>
        </div>
      )}
      {lookups.categories.size > 1 && (
        <div class="filtermenu-submenu">
          <div class="filter-title" onclick="toggleSubMenu('category')">{t("category")}</div>
          <div class="filtermenu-submenu-content" id="filter-category">
            {[...lookups.categories.values()]
              .filter((cat) => (counts.category.get(cat.id) ?? 0) > 0)
              .map((cat) => (
                <div class={`filter-item ${selected("category", cat.id)}`} data-categoryid={cat.id}>
                  {isDefaultNoCategory(ui, cat.name) ? t("no_category") : cat.name}
                </div>
              ))}
          </div>
        </div>
      )}
      {methods.length > 1 && (
        <div class="filtermenu-submenu">
          <div class="filter-title" onclick="toggleSubMenu('payment')">{t("payment_method")}</div>
          <div class="filtermenu-submenu-content" id="filter-payment">
            {methods
              .filter((m) => (counts.payment.get(m.id) ?? 0) > 0)
              .map((m) => (
                <div class={`filter-item ${selected("payment", m.id)}`} data-paymentid={m.id}>
                  {m.name}
                </div>
              ))}
          </div>
        </div>
      )}
      {!ui.settings.hide_disabled && (
        <div class="filtermenu-submenu">
          <div class="filter-title" onclick="toggleSubMenu('state')">{t("state")}</div>
          <div class="filtermenu-submenu-content" id="filter-state">
            <div class="filter-item capitalize" data-state="0">{t("enabled")}</div>
            <div class="filter-item capitalize" data-state="1">{t("disabled")}</div>
          </div>
        </div>
      )}

      <div class="filtermenu-submenu">
        <div class="filter-title" onclick="toggleSubMenu('renewal_type')">{t("renewal_type")}</div>
        <div class="filtermenu-submenu-content" id="filter-renewal_type">
          <div class="filter-item capitalize" data-renewaltype="1">{t("auto_renewal")}</div>
          <div class="filter-item capitalize" data-renewaltype="0">{t("manual_renewal")}</div>
          <div class="filter-item capitalize" data-renewaltype="onetime">{t("One-time")}</div>
        </div>
      </div>

      <div class="filtermenu-submenu">
        <div class="filter-title" onclick="toggleSubMenu('notification')">{t("notifications")}</div>
        <div class="filtermenu-submenu-content" id="filter-notification">
          <div class="filter-item capitalize" data-notificationtype="reminder">{t("reminder")}</div>
          <div class="filter-item capitalize" data-notificationtype="cancellation">{t("cancellation")}</div>
          <div class="filter-item capitalize" data-notificationtype="none">{t("none")}</div>
        </div>
      </div>

      <div class="filtermenu-submenu hide" id="clear-filters">
        <div class="filter-title filter-clear" onclick="clearFilters()">
          <i class="fa-solid fa-times-circle"></i> {t("clear")}
        </div>
      </div>
    </div>
  );
}

function SortOptions({ ui, sortOrder }: { ui: Ui; sortOrder: string }) {
  const { t } = ui;
  const options: [string, string][] = [
    ["name", "name"],
    ["id", "last_added"],
    ["price", "price"],
    ["next_payment", "next_payment"],
    ["payer_user_id", "member"],
    ["category_id", "category"],
    ["payment_method_id", "payment_method"],
    ...(!ui.settings.hide_disabled ? ([["inactive", "state"]] as [string, string][]) : []),
    ["alphanumeric", "alphanumeric"],
    ["renewal_type", "renewal_type"],
  ];
  return (
    <div class="sort-options" id="sort-options">
      <ul>
        {options.map(([value, label]) => (
          <li class={sortOrder === value ? "selected" : undefined} onclick={`setSortOption('${value}')`} id={`sort-${value}`}>
            {t(label)}
          </li>
        ))}
      </ul>
    </div>
  );
}

// --- the page ------------------------------------------------------------------------

interface Counts {
  member: Map<number, number>;
  category: Map<number, number>;
  payment: Map<number, number>;
}

function countBy(rows: SubscriptionRow[], key: "payer_user_id" | "category_id" | "payment_method_id"): Map<number, number> {
  const map = new Map<number, number>();
  for (const row of rows) {
    const id = row[key];
    if (id !== null) map.set(id, (map.get(id) ?? 0) + 1);
  }
  return map;
}

async function googleSearchEnabled(c: UiCtx): Promise<boolean> {
  const row = await c.env.DB.prepare("SELECT COUNT(*) AS n FROM google_search WHERE user_id = ? AND api_key != ''")
    .bind(c.get("user").id)
    .first<{ n: number }>()
    .catch(() => null);
  return Boolean(row?.n);
}

routes.get("/subscriptions.php", uiPage, async (c) => {
  const ui = await loadUi(c);
  const { t } = ui;
  const lookups = await loadLookups(c);
  const query = c.req.query();
  const sort = sorting(c);
  const disabledToBottom = Boolean(ui.settings.disabled_to_bottom);

  const filters: Filters = { member: query.member, category: query.category, payment: query.payment };
  if (!ui.settings.hide_disabled) filters.state = query.state;
  const rows = await querySubscriptions(c, filters, sort, disabledToBottom);

  const counts: Counts = {
    member: countBy(rows, "payer_user_id"),
    category: countBy(rows, "category_id"),
    payment: countBy(rows, "payment_method_id"),
  };
  const items = reorder(printItems(rows, ui, lookups, ui.user.main_currency), sort.sortOrder, ui, lookups);
  const google = await googleSearchEnabled(c);
  const view = getCookie(c, "subscriptionsView") === "grid" ? "grid" : "list";
  const headerClass = rows.length > 0 ? "main-actions" : "main-actions hidden";
  const methods = [...lookups.paymentMethods.values()].filter((m) => m.enabled);
  const replacements = rows.filter((r) => !r.inactive).sort((a, b) => naturalCompare((a.name ?? "").toLowerCase(), (b.name ?? "").toLowerCase()));
  const frequencies = Array.from({ length: 366 }, (_, i) => i + 1);
  const notifyDays = Array.from({ length: 179 }, (_, i) => i + 2);

  const body = (
    <>
      <style>{raw(`
  .logo-preview:after {
    content: ${js(t("upload_logo"))};
  }
`)}</style>

      <section class="contain">
        <header class={headerClass} id="main-actions">
          <button class="button" onclick="addSubscription()">
            <i class="fa-solid fa-circle-plus"></i>
            {t("new_subscription")}
          </button>
          <div class="top-actions">
            <button class="button secondary-button mobile-search-toggle" id="mobile-search-toggle" title={t("search")} onclick="toggleMobileSearch()">
              <i class="fa-solid fa-magnifying-glass"></i>
            </button>
            <div class="search">
              <input type="text" autocomplete="off" name="search" id="search" placeholder={t("search")} onkeyup="searchSubscriptions()" />
              <span class="fa-solid fa-magnifying-glass search-icon"></span>
              <span class="fa-solid fa-xmark clear-search" onclick="clearSearch()"></span>
            </div>

            <div class="filtermenu on-dashboard">
              <button class="button secondary-button" id="filtermenu-button" title={t("filter")}>
                <i class="fa-solid fa-filter"></i>
              </button>
              <FiltersMenu ui={ui} lookups={lookups} counts={counts} query={query} />
            </div>

            <div class="sort-container">
              <button class="button secondary-button" value="Sort" onclick="toggleSortOptions()" id="sort-button" title={t("sort")}>
                <i class="fa-solid fa-arrow-down-wide-short"></i>
              </button>
              <SortOptions ui={ui} sortOrder={sort.sortOrder} />
            </div>

            <div class="view-toggle" id="view-toggle">
              <button
                type="button"
                class={`view-toggle-button${view === "list" ? " selected" : ""}`}
                id="view-list-button"
                title={t("list_view")}
                onclick="setSubscriptionsView('list')"
              >
                <i class="fa-solid fa-list"></i>
              </button>
              <button
                type="button"
                class={`view-toggle-button${view === "grid" ? " selected" : ""}`}
                id="view-grid-button"
                title={t("grid_view")}
                onclick="setSubscriptionsView('grid')"
              >
                <i class="fa-solid fa-table-cells-large"></i>
              </button>
            </div>
          </div>
        </header>
        <div class={`subscriptions${view === "grid" ? " grid-view" : ""}`} id="subscriptions">
          <SubscriptionList items={items} sort={sort.sort} ui={ui} lookups={lookups} />
          {rows.length === 0 && (
            <div class="empty-page">
              <img src="images/siteimages/empty.png" alt={t("empty_page")} />
              <p>{t("no_subscriptions_yet")}</p>
              <button class="button" onclick="addSubscription()">
                <i class="fa-solid fa-circle-plus"></i>
                {t("add_first_subscription")}
              </button>
            </div>
          )}
        </div>
      </section>
      <section class="subscription-form" id="subscription-form">
        <header>
          <h3 id="form-title">{t("add_subscription")}</h3>
          <span class="fa-solid fa-xmark close-form" onclick="closeAddSubscription()"></span>
        </header>
        <form action="endpoints/subscription/add.php" method="post" id="subs-form">
          <div class="form-group-inline">
            <input
              type="text"
              id="name"
              name="name"
              autocomplete="off"
              placeholder={t("subscription_name")}
              onchange="setSearchButtonStatus()"
              onkeypress="this.onchange();"
              onpaste="this.onchange();"
              oninput="this.onchange();"
              required
            />
            <label for="logo" class="logo-preview">
              <img src="" alt={t("logo_preview")} id="form-logo" />
            </label>
            <input type="file" id="logo" name="logo" accept="image/jpeg, image/png, image/gif, image/webp, image/svg+xml" onchange="handleFileSelect(event)" class="hidden-input" />
            <input type="hidden" id="logo-url" name="logo-url" />
            <div id="logo-search-button" class="image-button medium disabled" title={t("search_logo")} onclick="searchLogo()">
              <i class="fa-solid fa-magnifying-glass"></i>
            </div>
            <input type="hidden" id="id" name="id" />
            <div class="logo-search-backdrop" id="logo-search-backdrop" onclick="closeLogoSearch()"></div>
            <div id="logo-search-results" class="logo-search" data-google-search={google ? "1" : undefined}>
              <button type="button" class="close-logo-search" onclick="closeLogoSearch()" title={t("cancel")}>
                <i class="fa-solid fa-xmark"></i>
              </button>
              <header>
                <h3 id="logo-search-title" data-title={t("web_search")}>
                  {t("web_search")}
                </h3>
              </header>
              <div class="logo-search-controls">
                <div class="logo-search-query">
                  <input type="text" id="logo-search-query" autocomplete="off" inputmode="search" placeholder={t("search_logo")} aria-label={t("search_logo")} />
                  <button type="button" id="logo-search-submit" title={t("search")}>
                    <i class="fa-solid fa-magnifying-glass"></i>
                  </button>
                </div>
                <div id="logo-search-nav" class="logo-search-nav"></div>
              </div>
              <div id="logo-search-images"></div>
            </div>
          </div>

          <div class="form-group-inline">
            <input type="number" step="0.01" id="price" name="price" autocomplete="off" placeholder={t("price")} required />
            <select id="currency" name="currency_id" placeholder={t("add_subscription")}>
              {[...lookups.currencies.values()].map((currency) => (
                <option value={currency.id} selected={currency.id === ui.user.main_currency}>
                  {currency.name}
                </option>
              ))}
            </select>
          </div>

          <div class="form-group">
            <div class="inline">
              <div class="split66">
                <label for="cycle">{t("payment_every")}</label>
                <div class="inline">
                  <select id="frequency" name="frequency" placeholder={t("frequency")}>
                    {frequencies.map((i) => (
                      <option value={i}>{i}</option>
                    ))}
                  </select>
                  <select id="cycle" name="cycle" placeholder="Cycle">
                    {lookups.cycles.map((cycle) => (
                      <option value={cycle.id} selected={cycle.id === 3}>
                        {t(cycle.name.toLowerCase())}
                      </option>
                    ))}
                  </select>
                </div>
              </div>
              <div class="split33" id="auto-renew-group">
                <label>{t("auto_renewal")}</label>
                <div class="inline height50">
                  <input type="checkbox" id="auto_renew" name="auto_renew" checked />
                  <label for="auto_renew">{t("automatically_renews")}</label>
                </div>
              </div>
            </div>
          </div>

          <div class="form-group">
            <div class="inline">
              <div class="split50">
                <label for="start_date">{t("start_date")}</label>
                <div class="date-wrapper">
                  <input type="date" id="start_date" name="start_date" autocomplete="off" />
                </div>
              </div>
              <button
                type="button"
                id="autofill-next-payment-button"
                class="button secondary-button autofill-next-payment hideOnMobile"
                title={t("calculate_next_payment_date")}
                onclick="autoFillNextPaymentDate(event)"
              >
                <i class="fa-solid fa-wand-magic-sparkles"></i>
              </button>
              <div class="split50">
                <label for="next_payment" class="split-label">
                  <span id="next-payment-label-recurring">{t("next_payment")}</span>
                  <span id="next-payment-label-onetime" style="display:none">
                    {t("payment_date")}
                  </span>
                  <div id="autofill-next-payment-button" class="autofill-next-payment hideOnDesktop" title={t("calculate_next_payment_date")} onclick="autoFillNextPaymentDate(event)">
                    <i class="fa-solid fa-wand-magic-sparkles"></i>
                  </div>
                </label>
                <div class="date-wrapper">
                  <input type="date" id="next_payment" name="next_payment" autocomplete="off" required />
                </div>
              </div>
            </div>
          </div>

          <div class="form-group">
            <div class="inline">
              <div class="split50">
                <label for="payment_method">{t("payment_method")}</label>
                <select id="payment_method" name="payment_method_id">
                  {methods.map((payment) => (
                    <option value={payment.id}>{payment.name}</option>
                  ))}
                </select>
              </div>
              <div class="split50">
                <label for="payer_user">{t("paid_by")}</label>
                <select id="payer_user" name="payer_user_id">
                  {[...lookups.members.values()].map((member) => (
                    <option value={member.id}>{member.name}</option>
                  ))}
                </select>
              </div>
            </div>
          </div>

          <div class="form-group">
            <label for="category">{t("category")}</label>
            <select id="category" name="category_id">
              {[...lookups.categories.values()].map((category) => (
                <option value={category.id}>{category.name}</option>
              ))}
            </select>
          </div>

          <div class="form-group-inline grow" id="notifications-group">
            <input type="checkbox" id="notifications" name="notifications" onchange="toggleNotificationDays()" />
            <label for="notifications" class="grow">
              {t("enable_notifications")}
            </label>
          </div>

          <div class="form-group" id="notify-days-cancellation-group">
            <div class="inline">
              <div class="split66 mobile-split-50">
                <label for="notify_days_before">{t("notify_me")}</label>
                <select id="notify_days_before" name="notify_days_before" disabled>
                  <option value="-1">{t("default_value_from_settings")}</option>
                  <option value="0">{t("on_due_date")}</option>
                  <option value="1">1 {t("day_before")}</option>
                  {notifyDays.map((i) => (
                    <option value={i}>
                      {i} {t("days_before")}
                    </option>
                  ))}
                </select>
              </div>
              <div class="split33 mobile-split-50">
                <label for="cancellation_date">{t("cancellation_notification")}</label>
                <div class="date-wrapper">
                  <input type="date" id="cancellation_date" name="cancellation_date" autocomplete="off" />
                </div>
              </div>
            </div>
          </div>

          <div class="form-group">
            <input type="text" id="url" name="url" autocomplete="off" placeholder={t("url")} />
          </div>

          <div class="form-group">
            <div class="notes-editor">
              <div class="notes-toolbar">
                <button type="button" class="notes-toolbar-button" title={t("notes_bold")} onclick="applyNotesMarkdown('bold')">
                  <i class="fa-solid fa-bold"></i>
                </button>
                <button type="button" class="notes-toolbar-button" title={t("notes_italic")} onclick="applyNotesMarkdown('italic')">
                  <i class="fa-solid fa-italic"></i>
                </button>
                <button type="button" class="notes-toolbar-button" title={t("notes_list")} onclick="applyNotesMarkdown('list')">
                  <i class="fa-solid fa-list-ul"></i>
                </button>
                <button type="button" class="notes-toolbar-button" title={t("notes_link")} onclick="applyNotesMarkdown('link')">
                  <i class="fa-solid fa-link"></i>
                </button>
              </div>
              <textarea id="notes" name="notes" class="thin" autocomplete="off" placeholder={t("notes")}></textarea>
            </div>
          </div>

          <div class="form-group">
            <div class="inline grow">
              <input type="checkbox" id="inactive" name="inactive" onchange="toggleReplacementSub()" />
              <label for="inactive" class="grow">
                {t("inactive")}
              </label>
            </div>
          </div>

          <div class="form-group hide" id="replacement_subscritpion">
            <label for="replacement_subscription_id">{t("replaced_with")}:</label>
            <select id="replacement_subscription_id" name="replacement_subscription_id">
              <option value="0">{t("none")}</option>
              {replacements.map((sub) => (
                <option value={sub.id}>{sub.name}</option>
              ))}
            </select>
          </div>

          <div class="buttons">
            <input type="button" value={t("delete")} class="warning-button left thin" id="deletesub" style="display: none" />
            <input type="button" value={t("cancel")} class="secondary-button thin" onclick="closeAddSubscription()" />
            <input type="submit" value={t("save")} class="thin" id="save-button" />
          </div>
        </form>
      </section>

      {await SubscriptionDetailsPopup({ c, ui })}
      <script src={asset(ui, "scripts/subscriptions.js")}></script>
      {query.add !== undefined && <script>{raw("addSubscription();")}</script>}
    </>
  );
  return page(c, ui, "subscriptions", body);
});
