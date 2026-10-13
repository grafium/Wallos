import { z } from "zod";
import { isValidDate } from "./dates";

/*
  Input schemas. Every field accepts both JSON values and the strings a
  form-encoded body produces, because the PHP Wallos API is form based.
*/

const emptyToUndefined = (value: unknown) => (value === "" || value === null ? undefined : value);

export const id = z.coerce.number().int().positive();

export const flag = z
  .union([z.boolean(), z.number(), z.string()])
  .transform((value, ctx) => {
    if (typeof value === "boolean") return value ? 1 : 0;
    const text = String(value).trim().toLowerCase();
    if (["1", "true", "on", "yes"].includes(text)) return 1;
    if (["0", "false", "off", "no"].includes(text)) return 0;
    ctx.addIssue({ code: "custom", message: "Expected a boolean" });
    return z.NEVER;
  });

export const date = z.string().trim().refine(isValidDate, "Expected a date as YYYY-MM-DD");

const optionalDate = z.preprocess(emptyToUndefined, date.optional());
const nullableDate = z.preprocess((v) => (v === "" ? null : v), date.nullable().optional());

const text = (max: number) => z.string().trim().max(max);

const httpUrl = z
  .string()
  .trim()
  .max(2048)
  .refine((value) => value === "" || /^https?:\/\//i.test(value), "Expected an http(s) URL");

export const subscriptionFields = {
  name: text(255).min(1, "Name is required"),
  price: z.coerce.number().min(0).max(1e12),
  currency_id: id,
  next_payment: date,
  start_date: nullableDate,
  cycle: z.coerce.number().int().min(1).max(5),
  frequency: z.coerce.number().int().min(1).max(31),
  auto_renew: flag,
  payment_method_id: id,
  payer_user_id: id,
  category_id: id,
  notes: text(10_000),
  url: httpUrl,
  logo: text(2048),
  notify: flag,
  // -1 means "use the default from the notification settings".
  notify_days_before: z.coerce.number().int().min(-1).max(366),
  inactive: flag,
  cancellation_date: nullableDate,
  replacement_subscription_id: z.preprocess((v) => (v === "" || v === 0 || v === "0" ? null : v), id.nullable().optional()),
};

export const createSubscriptionSchema = z.object({
  ...subscriptionFields,
  // Only name and price are mandatory; the rest default to the user's first
  // category, member and payment method, their main currency, and a monthly
  // cycle starting today.
  currency_id: z.preprocess(emptyToUndefined, id.optional()),
  next_payment: optionalDate,
  cycle: z.preprocess(emptyToUndefined, subscriptionFields.cycle.default(3)),
  frequency: z.preprocess(emptyToUndefined, subscriptionFields.frequency.default(1)),
  auto_renew: z.preprocess(emptyToUndefined, flag.default(1)),
  payment_method_id: z.preprocess(emptyToUndefined, id.optional()),
  payer_user_id: z.preprocess(emptyToUndefined, id.optional()),
  category_id: z.preprocess(emptyToUndefined, id.optional()),
  notes: subscriptionFields.notes.default(""),
  url: subscriptionFields.url.default(""),
  logo: subscriptionFields.logo.default(""),
  notify: z.preprocess(emptyToUndefined, flag.default(0)),
  notify_days_before: z.preprocess(emptyToUndefined, subscriptionFields.notify_days_before.default(-1)),
  inactive: z.preprocess(emptyToUndefined, flag.default(0)),
});

export const updateSubscriptionSchema = z.object(subscriptionFields).partial();

export type CreateSubscriptionInput = z.infer<typeof createSubscriptionSchema>;
export type UpdateSubscriptionInput = z.infer<typeof updateSubscriptionSchema>;

export const registerSchema = z.object({
  username: z
    .string()
    .trim()
    .min(2)
    .max(64)
    .regex(/^[\p{L}\p{N}._@-]+$/u, "Only letters, numbers and . _ @ - are allowed"),
  email: z.email().max(255),
  password: z.string().min(8).max(256),
  main_currency: z.string().trim().toUpperCase().length(3).default("EUR"),
  language: z.string().trim().min(2).max(10).default("en"),
  firstname: text(100).default(""),
  lastname: text(100).default(""),
});

export const loginSchema = z.object({
  username: z.string().trim().min(1).max(64),
  password: z.string().min(1).max(256),
});

export const categorySchema = z.object({
  name: text(255).min(1),
  order: z.coerce.number().int().min(0).optional(),
});

export const householdSchema = z.object({
  name: text(255).min(1),
  email: z.preprocess(emptyToUndefined, z.email().max(255).optional()),
});

export const paymentMethodSchema = z.object({
  name: text(255).min(1),
  icon: text(2048).optional(),
  enabled: flag.optional(),
  order: z.coerce.number().int().min(0).optional(),
});

export const currencySchema = z.object({
  name: text(255).min(1),
  symbol: text(16).min(1),
  code: z.string().trim().toUpperCase().min(3).max(3),
  rate: z.coerce.number().positive().max(1e12).optional(),
});

export const monthlyCostQuery = z.object({
  month: z.coerce.number().int().min(1).max(12),
  year: z.coerce.number().int().min(1970).max(9999),
});
