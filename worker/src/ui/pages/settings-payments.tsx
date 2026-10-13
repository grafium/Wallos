import type { Translate } from "../i18n";
import { paymentIconSrc } from "../components";

/*
  The payment method tiles of settings.php, shared by the page and by
  endpoints/payments/get.php (which the page reloads after adding one).
*/

export interface PaymentMethodRow {
  id: number;
  name: string;
  icon: string | null;
  enabled: number;
  in_use: number;
}

export async function loadPaymentMethods(db: D1Database, userId: number): Promise<PaymentMethodRow[]> {
  const rows = await db
    .prepare(
      `SELECT p.id, p.name, p.icon, p.enabled,
              EXISTS (SELECT 1 FROM subscriptions s WHERE s.payment_method_id = p.id AND s.user_id = p.user_id) AS in_use
         FROM payment_methods p WHERE p.user_id = ? ORDER BY p."order", p.id`,
    )
    .bind(userId)
    .all<PaymentMethodRow>();
  return rows.results;
}

/**
 * One tile. `reloaded` marks the copy get.php returns: the page wires the
 * delete buttons up once on load, so reloaded tiles carry their own handler
 * (which stops the click from also toggling the method).
 */
export function PaymentMethod({ t, payment, reloaded = false }: { t: Translate; payment: PaymentMethodRow; reloaded?: boolean }) {
  const inUse = Boolean(payment.in_use);
  const enabled = payment.enabled ? 1 : 0;
  return (
    <div
      class="payments-payment"
      data-enabled={String(enabled)}
      data-in-use={inUse ? "yes" : "no"}
      data-paymentid={String(payment.id)}
      title={inUse ? t("cant_delete_payment_method_in_use") : enabled ? t("disable") : t("enable")}
    >
      <div class="drag-icon" title="">
        <i class="fa-solid fa-grip-vertical"></i>
      </div>
      <img src={paymentIconSrc(payment.icon)} alt="Logo" />
      <span class="payment-name" contenteditable="true" title={t("rename_payment_method")}>
        {payment.name}
      </span>
      {!inUse && (
        <div
          class="delete-payment-method"
          title={t("delete")}
          data-paymentid={String(payment.id)}
          onclick={reloaded ? `event.stopPropagation(); deletePaymentMethod(${Number(payment.id)})` : undefined}
        >
          x
        </div>
      )}
    </div>
  );
}

export function PaymentMethods({ t, payments, reloaded = false }: { t: Translate; payments: PaymentMethodRow[]; reloaded?: boolean }) {
  return <>{payments.map((payment) => <PaymentMethod t={t} payment={payment} reloaded={reloaded} />)}</>;
}
