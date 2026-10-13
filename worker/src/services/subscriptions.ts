import type { AuthUser } from "../env";
import { isCycleId, renewDate, todayUtc } from "../lib/dates";
import { convertPrice } from "../lib/pricing";
import type { CreateSubscriptionInput, UpdateSubscriptionInput } from "../lib/schemas";

export interface SubscriptionRow {
  id: number;
  name: string;
  logo: string | null;
  price: number;
  currency_id: number | null;
  next_payment: string | null;
  cycle: number | null;
  frequency: number | null;
  notes: string | null;
  payment_method_id: number | null;
  payer_user_id: number | null;
  category_id: number | null;
  notify: number;
  url: string | null;
  inactive: number;
  notify_days_before: number | null;
  user_id: number;
  cancellation_date: string | null;
  replacement_subscription_id: number | null;
  start_date: string | null;
  auto_renew: number;
  logo_text_color: string | null;
  logo_variant: string | null;
}

export interface EnrichedSubscription extends SubscriptionRow {
  /** Where the logo is served, e.g. "/images/uploads/logos/123-netflix.png". */
  logo_path: string | null;
  logo_variant_path: string | null;
  category_name: string;
  payer_user_name: string;
  payment_method_name: string;
  currency_code: string | null;
}

interface Lookups {
  categories: Map<number, string>;
  members: Map<number, string>;
  paymentMethods: Map<number, string>;
  currencies: Map<number, { code: string; rate: number }>;
}

const COLUMNS = [
  "name",
  "logo",
  "price",
  "currency_id",
  "next_payment",
  "cycle",
  "frequency",
  "notes",
  "payment_method_id",
  "payer_user_id",
  "category_id",
  "notify",
  "url",
  "inactive",
  "notify_days_before",
  "cancellation_date",
  "replacement_subscription_id",
  "start_date",
  "auto_renew",
] as const;

type Column = (typeof COLUMNS)[number];

async function loadLookups(db: D1Database, userId: number): Promise<Lookups> {
  const [categories, members, paymentMethods, currencies] = await db.batch<Record<string, unknown>>([
    db.prepare("SELECT id, name FROM categories WHERE user_id = ?").bind(userId),
    db.prepare("SELECT id, name FROM household WHERE user_id = ?").bind(userId),
    db.prepare("SELECT id, name FROM payment_methods WHERE user_id = ?").bind(userId),
    db.prepare("SELECT id, code, rate FROM currencies WHERE user_id = ?").bind(userId),
  ]);
  const names = (rows: Record<string, unknown>[] | undefined) =>
    new Map((rows ?? []).map((r) => [r.id as number, r.name as string]));
  return {
    categories: names(categories?.results),
    members: names(members?.results),
    paymentMethods: names(paymentMethods?.results),
    currencies: new Map(
      (currencies?.results ?? []).map((r) => [r.id as number, { code: r.code as string, rate: Number(r.rate) }]),
    ),
  };
}

function enrich(row: SubscriptionRow, lookups: Lookups, convertTo: number | null): EnrichedSubscription {
  let price = row.price;
  if (convertTo !== null && row.currency_id !== null && row.currency_id !== convertTo) {
    price = convertPrice(row.price, lookups.currencies.get(row.currency_id)?.rate);
  }
  return {
    ...row,
    price,
    logo_path: row.logo ? `/images/uploads/logos/${row.logo}` : null,
    logo_variant_path: row.logo_variant ? `/images/uploads/logos/${row.logo_variant}` : null,
    category_name: lookups.categories.get(row.category_id ?? -1) ?? "No category",
    payer_user_name: lookups.members.get(row.payer_user_id ?? -1) ?? "Unknown member",
    payment_method_name: lookups.paymentMethods.get(row.payment_method_id ?? -1) ?? "Unknown payment method",
    currency_code: lookups.currencies.get(row.currency_id ?? -1)?.code ?? null,
  };
}

function idList(value: string | undefined): number[] | null {
  if (value === undefined || value === "") return null;
  return value
    .split(",")
    .map((part) => Number(part.trim()))
    .filter((n) => Number.isSafeInteger(n));
}

export interface ListOptions {
  member?: string;
  category?: string;
  payment?: string;
  state?: string;
  sort?: string;
  disabled_to_bottom?: string;
  convert_currency?: string;
}

const SORTABLE = ["name", "id", "next_payment", "price", "payer_user_id", "category_id", "payment_method_id", "inactive"];

/** Same filters and ordering as the PHP get_subscriptions.php endpoint. */
export async function listSubscriptions(db: D1Database, user: AuthUser, options: ListOptions) {
  let sort = options.sort === "alphanumeric" ? "name" : (options.sort ?? "next_payment");
  if (!SORTABLE.includes(sort)) sort = "next_payment";
  const order = sort === "price" || sort === "id" ? "DESC" : "ASC";
  const sortExpr = sort === "name" ? "name COLLATE NOCASE" : sort;

  const where = ["user_id = ?"];
  const params: unknown[] = [user.id];
  const filters: [string, number[] | null][] = [
    ["payer_user_id", idList(options.member)],
    ["category_id", idList(options.category)],
    ["payment_method_id", idList(options.payment)],
  ];
  for (const [column, ids] of filters) {
    if (ids === null) continue;
    if (ids.length === 0) {
      where.push("0");
      continue;
    }
    where.push(`${column} IN (${ids.map(() => "?").join(", ")})`);
    params.push(...ids);
  }
  if (options.state === "0" || options.state === "1") {
    where.push("inactive = ?");
    params.push(Number(options.state));
  }

  const orderBy: string[] = [];
  if (options.disabled_to_bottom === "true") {
    if (["payer_user_id", "category_id", "payment_method_id"].includes(sort)) {
      orderBy.push(`${sortExpr} ${order}`, "inactive ASC");
    } else {
      orderBy.push("inactive ASC", `${sortExpr} ${order}`);
    }
  } else {
    orderBy.push(`${sortExpr} ${order}`);
    if (sort !== "inactive") orderBy.push("inactive ASC");
  }
  if (sort !== "next_payment") orderBy.push("next_payment ASC");

  const [rows, lookups] = await Promise.all([
    db
      .prepare(`SELECT * FROM subscriptions WHERE ${where.join(" AND ")} ORDER BY ${orderBy.join(", ")}`)
      .bind(...params)
      .all<SubscriptionRow>(),
    loadLookups(db, user.id),
  ]);
  const convertTo = options.convert_currency === "true" ? user.main_currency : null;
  return rows.results.map((row) => enrich(row, lookups, convertTo));
}

export async function findSubscription(db: D1Database, userId: number, id: number) {
  return db.prepare("SELECT * FROM subscriptions WHERE id = ? AND user_id = ?").bind(id, userId).first<SubscriptionRow>();
}

export async function getSubscription(db: D1Database, user: AuthUser, id: number, convert = false) {
  const [row, lookups] = await Promise.all([findSubscription(db, user.id, id), loadLookups(db, user.id)]);
  return row ? enrich(row, lookups, convert ? user.main_currency : null) : null;
}

/**
 * Returns the names of referenced fields that do not belong to the user, so a
 * subscription can never point at another account's category, currency,
 * member, payment method or subscription.
 */
async function foreignReferences(
  db: D1Database,
  userId: number,
  refs: Partial<Record<"currency_id" | "payment_method_id" | "payer_user_id" | "category_id" | "replacement_subscription_id", number | null>>,
): Promise<string[]> {
  const tables = {
    currency_id: "currencies",
    payment_method_id: "payment_methods",
    payer_user_id: "household",
    category_id: "categories",
    replacement_subscription_id: "subscriptions",
  } as const;
  const checks = (Object.keys(tables) as (keyof typeof tables)[]).filter(
    (field) => refs[field] !== undefined && refs[field] !== null,
  );
  if (checks.length === 0) return [];

  const selects = checks.map((field) => `EXISTS (SELECT 1 FROM ${tables[field]} WHERE id = ? AND user_id = ?) AS ${field}`);
  const params = checks.flatMap((field) => [refs[field], userId]);
  const result = await db.prepare(`SELECT ${selects.join(", ")}`).bind(...params).first<Record<string, number>>();
  return checks.filter((field) => !result?.[field]);
}

export class ReferenceError extends Error {
  constructor(readonly fields: string[]) {
    super(`These references do not exist or belong to another user: ${fields.join(", ")}`);
  }
}

async function userDefaults(db: D1Database, user: AuthUser) {
  return db
    .prepare(
      `SELECT
         (SELECT id FROM categories WHERE user_id = ?1 ORDER BY "order", id LIMIT 1) AS category_id,
         (SELECT id FROM household WHERE user_id = ?1 ORDER BY id LIMIT 1) AS payer_user_id,
         (SELECT id FROM payment_methods WHERE user_id = ?1 AND enabled = 1 ORDER BY "order", id LIMIT 1) AS payment_method_id`,
    )
    .bind(user.id)
    .first<{ category_id: number | null; payer_user_id: number | null; payment_method_id: number | null }>();
}

export async function createSubscription(db: D1Database, user: AuthUser, input: CreateSubscriptionInput): Promise<number> {
  const defaults = await userDefaults(db, user);
  const values: Record<Column, unknown> = {
    name: input.name,
    logo: input.logo,
    price: input.price,
    currency_id: input.currency_id ?? user.main_currency,
    next_payment: input.next_payment ?? input.start_date ?? todayUtc(),
    cycle: input.cycle,
    frequency: input.frequency,
    notes: input.notes,
    payment_method_id: input.payment_method_id ?? defaults?.payment_method_id ?? null,
    payer_user_id: input.payer_user_id ?? defaults?.payer_user_id ?? null,
    category_id: input.category_id ?? defaults?.category_id ?? null,
    notify: input.notify,
    url: input.url,
    inactive: input.inactive,
    notify_days_before: input.notify_days_before,
    cancellation_date: input.cancellation_date ?? null,
    replacement_subscription_id: input.replacement_subscription_id ?? null,
    start_date: input.start_date ?? null,
    auto_renew: input.auto_renew,
  };

  const invalid = await foreignReferences(db, user.id, {
    currency_id: values.currency_id as number | null,
    payment_method_id: values.payment_method_id as number | null,
    payer_user_id: values.payer_user_id as number | null,
    category_id: values.category_id as number | null,
    replacement_subscription_id: values.replacement_subscription_id as number | null,
  });
  if (invalid.length > 0) throw new ReferenceError(invalid);

  const result = await db
    .prepare(
      `INSERT INTO subscriptions (${COLUMNS.join(", ")}, user_id)
       VALUES (${COLUMNS.map(() => "?").join(", ")}, ?) RETURNING id`,
    )
    .bind(...COLUMNS.map((column) => values[column]), user.id)
    .first<{ id: number }>();
  return result!.id;
}

/** Applies a partial update; returns false when the subscription does not exist for this user. */
export async function updateSubscription(
  db: D1Database,
  user: AuthUser,
  id: number,
  input: UpdateSubscriptionInput,
): Promise<boolean> {
  const existing = await findSubscription(db, user.id, id);
  if (!existing) return false;

  if (input.replacement_subscription_id === id) throw new ReferenceError(["replacement_subscription_id"]);
  const invalid = await foreignReferences(db, user.id, {
    currency_id: input.currency_id,
    payment_method_id: input.payment_method_id,
    payer_user_id: input.payer_user_id,
    category_id: input.category_id,
    replacement_subscription_id: input.replacement_subscription_id,
  });
  if (invalid.length > 0) throw new ReferenceError(invalid);

  const changes = COLUMNS.filter((column) => input[column] !== undefined);
  if (changes.length === 0) return true;

  await db
    .prepare(
      `UPDATE subscriptions SET ${changes.map((c) => `${c} = ?`).join(", ")}, updated_at = CURRENT_TIMESTAMP
        WHERE id = ? AND user_id = ?`,
    )
    .bind(...changes.map((column) => input[column] ?? null), id, user.id)
    .run();
  return true;
}

export async function deleteSubscription(db: D1Database, userId: number, id: number): Promise<boolean> {
  const result = await db.prepare("DELETE FROM subscriptions WHERE id = ? AND user_id = ?").bind(id, userId).run();
  return result.meta.changes > 0;
}

export type RenewResult = { ok: true; next_payment: string } | { ok: false; reason: "not_found" | "not_renewable" };

/**
 * Marks a manually renewed subscription as paid by moving its next payment
 * forward, like endpoints/subscription/renew.php. Auto-renewing and one-time
 * subscriptions are not renewable by hand.
 */
export async function renewSubscription(db: D1Database, userId: number, id: number, today = todayUtc()): Promise<RenewResult> {
  const row = await findSubscription(db, userId, id);
  if (!row) return { ok: false, reason: "not_found" };
  const cycle = row.cycle ?? 0;
  if (row.auto_renew || !isCycleId(cycle) || cycle === 5 || !row.next_payment) {
    return { ok: false, reason: "not_renewable" };
  }
  const next = renewDate(row.next_payment, cycle, row.frequency ?? 1, today);
  await db
    .prepare("UPDATE subscriptions SET next_payment = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?")
    .bind(next, id, userId)
    .run();
  return { ok: true, next_payment: next };
}

/** Copies a subscription unchanged, like endpoints/subscription/clone.php. */
export async function cloneSubscription(db: D1Database, userId: number, id: number): Promise<number | null> {
  const columns = [...COLUMNS, "logo_text_color", "logo_variant", "user_id"].join(", ");
  const result = await db
    .prepare(
      `INSERT INTO subscriptions (${columns})
       SELECT ${columns} FROM subscriptions WHERE id = ? AND user_id = ?
       RETURNING id`,
    )
    .bind(id, userId)
    .first<{ id: number }>();
  return result?.id ?? null;
}
