import { hashPassword, randomToken } from "../lib/crypto";
import { DEFAULT_CATEGORIES, DEFAULT_CURRENCIES, DEFAULT_PAYMENT_METHODS } from "../lib/defaults";
import type { z } from "zod";
import type { registerSchema } from "../lib/schemas";

export type RegisterInput = z.infer<typeof registerSchema>;

export type RegistrationCheck = { allowed: true } | { allowed: false; reason: string };

/**
 * The first account is always allowed and becomes the admin. After that the
 * admin decides: registrations must be open and below max_users (0 = no cap).
 */
export async function canRegister(db: D1Database): Promise<RegistrationCheck> {
  const state = await db
    .prepare(
      `SELECT (SELECT COUNT(*) FROM user) AS users,
              registrations_open, max_users
         FROM admin WHERE id = 1`,
    )
    .first<{ users: number; registrations_open: number; max_users: number }>();
  if (!state || state.users === 0) return { allowed: true };
  if (!state.registrations_open) return { allowed: false, reason: "Registrations are closed." };
  if (state.max_users > 0 && state.users >= state.max_users) {
    return { allowed: false, reason: "The maximum number of users has been reached." };
  }
  return { allowed: true };
}

/**
 * Creates the account together with everything a Wallos account starts with -
 * a household member named after the user, the default categories, payment
 * methods and currencies, and settings - in one atomic batch. Rows refer to
 * the new user through its (unique) username, so no step depends on reading
 * an id back in between.
 */
export async function registerUser(db: D1Database, input: RegisterInput): Promise<number> {
  const passwordHash = await hashPassword(input.password);
  const apiKey = randomToken(32);
  const userId = "(SELECT id FROM user WHERE username = ?1)";

  const currencies = DEFAULT_CURRENCIES.some((c) => c.code === input.main_currency)
    ? DEFAULT_CURRENCIES
    : [...DEFAULT_CURRENCIES, { name: input.main_currency, symbol: input.main_currency, code: input.main_currency }];

  await db.batch([
    db
      .prepare(
        `INSERT INTO user (username, firstname, lastname, email, password, language, budget, api_key, budget_period_anchor_date)
         VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0, ?7, date('now'))`,
      )
      .bind(input.username, input.firstname, input.lastname, input.email, passwordHash, input.language, apiKey),
    db.prepare(`INSERT INTO household (name, user_id) VALUES (?1, ${userId})`).bind(input.username),
    db
      .prepare(
        `INSERT INTO categories (name, "order", user_id)
         SELECT value, key + 1, ${userId} FROM json_each(?2)`,
      )
      .bind(input.username, JSON.stringify(DEFAULT_CATEGORIES)),
    db
      .prepare(
        `INSERT INTO payment_methods (name, icon, "order", user_id)
         SELECT value ->> 'name', value ->> 'icon', key + 1, ${userId} FROM json_each(?2)`,
      )
      .bind(input.username, JSON.stringify(DEFAULT_PAYMENT_METHODS)),
    db
      .prepare(
        `INSERT INTO currencies (name, symbol, code, rate, user_id)
         SELECT value ->> 'name', value ->> 'symbol', value ->> 'code', 1, ${userId} FROM json_each(?2)`,
      )
      .bind(input.username, JSON.stringify(currencies)),
    db
      .prepare(
        `UPDATE user SET main_currency = (SELECT id FROM currencies WHERE user_id = user.id AND code = ?2)
          WHERE username = ?1`,
      )
      .bind(input.username, input.main_currency),
    db.prepare(`INSERT INTO settings (user_id) VALUES (${userId})`).bind(input.username),
  ]);

  const created = await db.prepare("SELECT id FROM user WHERE username = ?").bind(input.username).first<{ id: number }>();
  return created!.id;
}
