import { raw } from "hono/html";
import type { Ui, UiCtx } from "./context";
import { asset, js } from "./layout";

/*
  Pieces several pages share.
*/

/**
 * A subscription logo; with a themed variant both images are rendered and
 * styles.css shows the one that suits the current theme
 * (renderThemedLogoImg() in includes/logo_theme_variant.php).
 */
export function ThemedLogo(props: {
  logo: string | null;
  variant?: string | null;
  textColor?: string | null;
  class?: string;
  alt?: string;
  title?: string;
}) {
  if (!props.logo) return null;
  const src = `images/uploads/logos/${props.logo}`;
  const className = props.class ?? "";
  if (!props.textColor || !props.variant) return <img src={src} class={className} alt={props.alt} title={props.title} />;
  const nativeTheme = props.textColor === "dark" ? "light" : "dark";
  return (
    <>
      <img src={src} class={`${className} logo-theme-original`.trim()} data-native-theme={nativeTheme} alt={props.alt} title={props.title} />
      <img
        src={`images/uploads/logos/${props.variant}`}
        class={`${className} logo-theme-variant`.trim()}
        data-native-theme={nativeTheme}
        alt={props.alt}
        title={props.title}
      />
    </>
  );
}

/** Where a payment method's icon is served: built-in icons keep their path, uploads live with the logos. */
export function paymentIconSrc(icon: string | null | undefined): string {
  if (!icon) return "";
  return icon.includes("images/uploads/icons/") ? icon : `images/uploads/logos/${icon}`;
}

/**
 * The subscription details dialog with the lookups scripts/subscription-details.js
 * reads (includes/subscription_details_popup.php). Include once per page.
 */
export async function SubscriptionDetailsPopup({ c, ui }: { c: UiCtx; ui: Ui }) {
  const { t } = ui;
  const userId = c.get("user").id;
  const [categories, members, methods, currencies, subscriptions] = await c.env.DB.batch<Record<string, unknown>>([
    c.env.DB.prepare("SELECT id, name FROM categories WHERE user_id = ?").bind(userId),
    c.env.DB.prepare("SELECT id, name FROM household WHERE user_id = ?").bind(userId),
    c.env.DB.prepare("SELECT id, name, icon FROM payment_methods WHERE user_id = ?").bind(userId),
    c.env.DB.prepare("SELECT id, code, symbol FROM currencies WHERE user_id = ?").bind(userId),
    c.env.DB.prepare("SELECT id, name FROM subscriptions WHERE user_id = ?").bind(userId),
  ]);
  const map = <T,>(rows: Record<string, unknown>[] | undefined, value: (r: Record<string, unknown>) => T) =>
    Object.fromEntries((rows ?? []).map((r) => [String(r.id), value(r)]));

  const lookups = {
    categories: map(categories?.results, (r) => r.name),
    members: map(members?.results, (r) => r.name),
    paymentMethods: map(methods?.results, (r) => ({ name: r.name, icon: paymentIconSrc(r.icon as string) })),
    currencies: map(currencies?.results, (r) => ({ code: r.code, symbol: r.symbol })),
    subscriptionNames: map(subscriptions?.results, (r) => r.name),
    cycles: {
      1: { one: t("Daily"), many: t("days") },
      2: { one: t("Weekly"), many: t("weeks") },
      3: { one: t("Monthly"), many: t("months") },
      4: { one: t("Yearly"), many: t("years") },
      5: { one: t("One-time"), many: t("One-time") },
    },
    i18n: {
      automatic: t("automatic"),
      manual_renewal: t("manual_renewal"),
      inactive: t("disabled"),
      one_time: t("One-time"),
      enabled: t("enabled"),
      disabled: t("disabled"),
      on_due_date: t("on_due_date"),
      day_before: t("day_before"),
      days_before: t("days_before"),
      none: t("none"),
    },
  };

  return (
    <>
      <div class="details-backdrop" id="details-backdrop" onclick="closeSubscriptionDetails()"></div>
      <section class="subscription-details" id="subscription-details" role="dialog" aria-modal="true" aria-labelledby="details-name">
        <button type="button" class="details-close" onclick="closeSubscriptionDetails()" title={t("cancel")}>
          <i class="fa-solid fa-xmark"></i>
        </button>
        <header class="details-hero">
          <div class="details-heading">
            <span class="details-logo" id="details-logo"></span>
            <div class="details-chips" id="details-chips"></div>
          </div>
          <h3 id="details-name"></h3>
        </header>
        <div class="details-price-row">
          <span class="details-price" id="details-price"></span>
          <span class="details-cycle" id="details-billing-cycle"></span>
          <button
            type="button"
            class="button secondary-button details-action-button details-export-button"
            id="details-export-button"
            title={t("export_icalendar")}
            aria-label={t("export_icalendar")}
          >
            <i class="fa-solid fa-calendar-plus"></i>
          </button>
          <a
            class="button secondary-button details-action-button hide"
            id="details-url-button"
            href="#"
            target="_blank"
            rel="noreferrer"
            title={t("external_url")}
            aria-label={t("external_url")}
          >
            <i class="fa-solid fa-globe"></i>
          </a>
        </div>
        <div class="details-progress-track" id="details-progress-track">
          <span class="details-progress" id="details-progress"></span>
        </div>
        <dl class="details-grid">
          <div class="details-item">
            <dt>{t("next_payment")}</dt>
            <dd id="details-next-payment"></dd>
          </div>
          <div class="details-item">
            <dt>{t("start_date")}</dt>
            <dd id="details-start-date"></dd>
          </div>
          <div class="details-item">
            <dt>{t("category")}</dt>
            <dd id="details-category"></dd>
          </div>
          <div class="details-item">
            <dt>{t("paid_by")}</dt>
            <dd id="details-payer"></dd>
          </div>
          <div class="details-item">
            <dt>{t("payment_method")}</dt>
            <dd id="details-payment-method">
              <img id="details-payment-icon" src="" alt="" />
              <span id="details-payment-name"></span>
            </dd>
          </div>
          <div class="details-item">
            <dt>{t("notifications")}</dt>
            <dd id="details-notifications"></dd>
          </div>
          <div class="details-item hide" id="details-cancellation-item">
            <dt>{t("cancellation_notification")}</dt>
            <dd id="details-cancellation"></dd>
          </div>
          <div class="details-item hide" id="details-replacement-item">
            <dt>{t("replaced_with")}</dt>
            <dd id="details-replacement"></dd>
          </div>
        </dl>
        <div class="details-notes hide" id="details-notes-item">
          <i class="fa-solid fa-note-sticky"></i>
          <div id="details-notes"></div>
        </div>
      </section>
      <script>{raw(`window.subscriptionLookups = ${js(lookups)};`)}</script>
      <script src={asset(ui, "scripts/subscription-details.js")}></script>
    </>
  );
}
