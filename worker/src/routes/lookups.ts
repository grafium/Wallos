import { Hono, type Context } from "hono";
import type { z } from "zod";
import type { AppBindings } from "../env";
import { fail, ok, parseId, readBody, validationFailed } from "../lib/http";
import { deleteLogosIfUnused } from "../services/files";
import { categorySchema, currencySchema, householdSchema, paymentMethodSchema } from "../lib/schemas";

/*
  The per-user reference lists a subscription points at: categories,
  household members, payment methods and currencies. They share one CRUD
  implementation; each list reports whether a row is "in_use" and refuses to
  delete rows that subscriptions still reference, as PHP Wallos does.
*/

type Ctx = Context<AppBindings>;

interface LookupConfig {
  table: "categories" | "household" | "payment_methods" | "currencies";
  /** Response title and collection key, matching the PHP API. */
  title: string;
  columns: readonly string[];
  orderBy: string;
  /** Column of subscriptions that references this table. */
  refColumn: string;
  schema: z.ZodObject;
  /** Reason a row may not be deleted even when unused, or null. */
  protect?: (c: Ctx, id: number) => Promise<string | null>;
  /** Extra top-level fields for the list response. */
  listExtras?: (c: Ctx) => Record<string, unknown>;
  /** Runs after a row was deleted, with the row as it was. */
  onDeleted?: (c: Ctx, row: Record<string, unknown>) => Promise<void>;
}

const quote = (column: string) => `"${column}"`;

function lookupRoutes(config: LookupConfig) {
  const routes = new Hono<AppBindings>();
  const selected = config.columns.map((col) => `t.${quote(col)}`).join(", ");
  const inUse = `EXISTS (SELECT 1 FROM subscriptions s WHERE s.${config.refColumn} = t.id AND s.user_id = t.user_id)`;

  const fetchRow = (c: Ctx, id: number) =>
    c.env.DB.prepare(`SELECT ${selected}, ${inUse} AS in_use FROM ${config.table} t WHERE t.id = ? AND t.user_id = ?`)
      .bind(id, c.get("user").id)
      .first<Record<string, unknown>>();

  const present = (row: Record<string, unknown>) => ({ ...row, in_use: Boolean(row.in_use) });

  const list = async (c: Ctx) => {
    const rows = await c.env.DB.prepare(
      `SELECT ${selected}, ${inUse} AS in_use FROM ${config.table} t WHERE t.user_id = ? ORDER BY ${config.orderBy}`,
    )
      .bind(c.get("user").id)
      .all<Record<string, unknown>>();
    return ok(c, config.title, { ...config.listExtras?.(c), [config.title]: rows.results.map(present), notes: [] });
  };

  routes.get("/", list);

  routes.post("/", async (c) => {
    const parsed = config.schema.safeParse(await readBody(c));
    if (!parsed.success) return validationFailed(c, parsed.error);
    const data = Object.entries(parsed.data).filter(([, value]) => value !== undefined);
    const result = await c.env.DB.prepare(
      `INSERT INTO ${config.table} (${[...data.map(([key]) => quote(key)), "user_id"].join(", ")})
       VALUES (${[...data.map(() => "?"), "?"].join(", ")}) RETURNING id`,
    )
      .bind(...data.map(([, value]) => value), c.get("user").id)
      .first<{ id: number }>();
    const row = await fetchRow(c, result!.id);
    return ok(c, `${config.title} added`, { item: present(row!) }, 201);
  });

  routes.patch("/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return fail(c, 400, "Missing parameter", 'Parameter "id" is required.');
    const parsed = config.schema.partial().safeParse(await readBody(c));
    if (!parsed.success) return validationFailed(c, parsed.error);
    const data = Object.entries(parsed.data).filter(([, value]) => value !== undefined);
    if (data.length > 0) {
      await c.env.DB.prepare(
        `UPDATE ${config.table} SET ${data.map(([key]) => `${quote(key)} = ?`).join(", ")} WHERE id = ? AND user_id = ?`,
      )
        .bind(...data.map(([, value]) => value), id, c.get("user").id)
        .run();
    }
    const row = await fetchRow(c, id);
    if (!row) return fail(c, 404, "Not found");
    return ok(c, `${config.title} updated`, { item: present(row) });
  });

  routes.delete("/:id", async (c) => {
    const id = parseId(c.req.param("id"));
    if (id === null) return fail(c, 400, "Missing parameter", 'Parameter "id" is required.');
    const row = await fetchRow(c, id);
    if (!row) return fail(c, 404, "Not found");
    if (row.in_use) return fail(c, 409, "In use", "It is used by subscriptions and can't be removed.");
    const reason = await config.protect?.(c, id);
    if (reason) return fail(c, 409, "Protected", reason);
    await c.env.DB.prepare(`DELETE FROM ${config.table} WHERE id = ? AND user_id = ?`).bind(id, c.get("user").id).run();
    await config.onDeleted?.(c, row);
    return ok(c, `${config.title} removed`, { id });
  });

  return { routes, list };
}

export const categories = lookupRoutes({
  table: "categories",
  title: "categories",
  columns: ["id", "name", "order"],
  orderBy: 't."order", t.id',
  refColumn: "category_id",
  schema: categorySchema,
});

export const household = lookupRoutes({
  table: "household",
  title: "household",
  columns: ["id", "name", "email"],
  orderBy: "t.id",
  refColumn: "payer_user_id",
  schema: householdSchema,
  protect: async (c, id) => {
    const owner = await c.env.DB.prepare("SELECT MIN(id) AS id FROM household WHERE user_id = ?")
      .bind(c.get("user").id)
      .first<{ id: number }>();
    return owner?.id === id ? "The account owner can't be removed from the household." : null;
  },
});

export const paymentMethods = lookupRoutes({
  table: "payment_methods",
  title: "payment_methods",
  columns: ["id", "name", "icon", "enabled", "order"],
  orderBy: 't."order", t.id',
  refColumn: "payment_method_id",
  schema: paymentMethodSchema,
  // An uploaded icon goes with the payment method.
  onDeleted: (c, row) => deleteLogosIfUnused(c.env, [row.icon as string | null]),
});

export const currencies = lookupRoutes({
  table: "currencies",
  title: "currencies",
  columns: ["id", "name", "symbol", "code", "rate"],
  orderBy: "t.id",
  refColumn: "currency_id",
  schema: currencySchema,
  listExtras: (c) => ({ main_currency: c.get("user").main_currency }),
  protect: async (c, id) => (c.get("user").main_currency === id ? "The main currency can't be removed." : null),
});
