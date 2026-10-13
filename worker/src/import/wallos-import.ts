import { isValidDate } from "../lib/dates.ts";

/*
  Turns the tables of a PHP Wallos SQLite database into SQL statements for
  the D1 schema.

  The input is plain rows (table name -> rows in rowid order), so the same
  code runs in the Node CLI (scripts/import-wallos.ts, reading the file with
  node:sqlite) and inside the Workers test suite. The output is literal SQL
  without bound parameters, ready for `wrangler d1 execute --file`.

  What it repairs on the way:
    * PHP stored most text through htmlspecialchars(); those entities are
      decoded, because the Worker stores raw text and escapes on output.
      Notes are left alone: PHP migration 000058 already decoded them.
    * Currency rates were TEXT; they become numbers (invalid -> 1).
    * Empty strings in date and id columns become NULL; malformed dates too.
    * Rows owned by users that no longer exist are dropped (D1 enforces the
      foreign key), as are duplicate per-user settings rows (the last wins).
    * Usernames that clash case-insensitively and duplicate API keys are
      made unique, because D1 enforces both.
    * replacement_subscription_id is set in a second pass and only when it
      points at a subscription of the same user.
*/

export type SourceRow = Record<string, unknown>;
export type SourceTables = Record<string, SourceRow[]>;

export interface ImportReport {
  imported: Record<string, number>;
  skipped: Record<string, number>;
  warnings: string[];
  /** Source tables with rows that this version does not import yet, and the roadmap phase that adds them. */
  notImported: Record<string, { rows: number; phase: string }>;
  /** Uploaded files the data refers to; copy them to R2 with scripts/upload-files.ts. */
  files: { logos: string[]; avatars: string[] };
}

export interface ImportResult {
  statements: string[];
  report: ImportReport;
}

export interface ImportOptions {
  /** Prepend statements that delete all existing users (and, by cascade, their data). */
  replace?: boolean;
}

/** Tables handled by later phases; listed so the report can say what was left behind. */
const LATER_TABLES: Record<string, string> = {
  totp: "6",
  oauth_settings: "6",
  total_yearly_cost: "7",
  ai_settings: "7",
  ai_recommendations: "7",
};

/** Tables whose content is recreated rather than copied. */
const IGNORED_TABLES = new Set([
  "migrations",
  "cycles",
  "frequencies",
  "last_update_next_payment_date",
  "sqlite_sequence",
  // Pre-multi-user global notification settings, superseded by the per-user tables.
  "notifications",
  // Short-lived tokens; they are not portable (the Worker stores hashes) and
  // "remember me" cookies of the PHP instance mean nothing to the Worker.
  "email_verification",
  "password_resets",
  "login_tokens",
  // The history of uploaded avatars; the one in use is user.avatar, and the
  // files themselves are copied by scripts/upload-files.ts.
  "uploaded_avatars",
]);

/** PHP notification tables -> channel name and the config fields to carry over. */
const CHANNEL_TABLES: Record<string, { channel: string; fields: Record<string, string> }> = {
  email_notifications: { channel: "email", fields: { other_emails: "other_emails" } },
  discord_notifications: { channel: "discord", fields: { webhook_url: "webhook_url", bot_username: "bot_username", bot_avatar_url: "bot_avatar_url" } },
  gotify_notifications: { channel: "gotify", fields: { url: "url", token: "token" } },
  telegram_notifications: { channel: "telegram", fields: { bot_token: "bot_token", chat_id: "chat_id" } },
  pushover_notifications: { channel: "pushover", fields: { user_key: "user_key", token: "token" } },
  ntfy_notifications: { channel: "ntfy", fields: { host: "host", topic: "topic", headers: "headers" } },
  webhook_notifications: {
    channel: "webhook",
    fields: { url: "url", request_method: "request_method", headers: "headers", payload: "payload", cancelation_payload: "cancelation_payload" },
  },
  mattermost_notifications: { channel: "mattermost", fields: { webhook_url: "webhook_url", bot_username: "bot_username", bot_icon_emoji: "bot_icon_emoji" } },
  pushplus_notifications: { channel: "pushplus", fields: { token: "token" } },
  serverchan_notifications: { channel: "serverchan", fields: { sendkey: "sendkey" } },
  push_notifications: { channel: "push", fields: {} },
};

const HTML_ENTITIES: Record<string, string> = {
  "&amp;": "&",
  "&lt;": "<",
  "&gt;": ">",
  "&quot;": '"',
  "&#039;": "'",
  "&#39;": "'",
  "&apos;": "'",
};

/** Reverses PHP htmlspecialchars() in a single pass, so "&amp;lt;" becomes "&lt;", not "<". */
export function decodeHtml(value: string): string {
  return value.replace(/&(?:amp|lt|gt|quot|apos|#0*39);/g, (entity) => HTML_ENTITIES[entity] ?? "'");
}

type Literal = string | number | null;

function sql(value: Literal): string {
  if (value === null) return "NULL";
  if (typeof value === "number") return Number.isFinite(value) ? String(value) : "NULL";
  return `'${value.replace(/\u0000/g, "").replace(/'/g, "''")}'`;
}

function insert(table: string, row: Record<string, Literal>, verb = "INSERT"): string {
  const columns = Object.keys(row);
  const quoted = columns.map((c) => (c === "order" ? '"order"' : c)).join(", ");
  return `${verb} INTO ${table} (${quoted}) VALUES (${columns.map((c) => sql(row[c]!)).join(", ")});`;
}

// --- value normalisers -------------------------------------------------------

function str(value: unknown): string | null {
  if (value === null || value === undefined) return null;
  return String(value);
}

function text(value: unknown, fallback = ""): string {
  const s = str(value);
  return s === null ? fallback : decodeHtml(s).trim();
}

function int(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim());
  return Number.isFinite(n) ? Math.trunc(n) : null;
}

function num(value: unknown): number | null {
  if (value === null || value === undefined || value === "") return null;
  const n = typeof value === "number" ? value : Number(String(value).trim().replace(",", "."));
  return Number.isFinite(n) ? n : null;
}

function flag(value: unknown, fallback = 0): number {
  if (value === null || value === undefined || value === "") return fallback;
  if (typeof value === "number") return value ? 1 : 0;
  const s = String(value).trim().toLowerCase();
  return ["1", "true", "on", "yes"].includes(s) ? 1 : 0;
}

// --- the import ----------------------------------------------------------------

export function buildImport(source: SourceTables, options: ImportOptions = {}): ImportResult {
  const statements: string[] = [];
  const report: ImportReport = { imported: {}, skipped: {}, warnings: [], notImported: {}, files: { logos: [], avatars: [] } };
  const count = (bucket: "imported" | "skipped", table: string) => {
    report[bucket][table] = (report[bucket][table] ?? 0) + 1;
  };
  const rows = (table: string) => source[table] ?? [];

  for (const [table, tableRows] of Object.entries(source)) {
    if (tableRows.length === 0 || IGNORED_TABLES.has(table)) continue;
    const phase = LATER_TABLES[table];
    if (phase) report.notImported[table] = { rows: tableRows.length, phase };
  }

  if (options.replace) {
    // Cascades to every per-user table, sessions included.
    statements.push("DELETE FROM user;");
  }

  // Users ---------------------------------------------------------------------
  const userIds = new Set<number>();
  const usernames = new Set<string>();
  const apiKeys = new Set<string>();

  for (const row of rows("user")) {
    const id = int(row.id);
    if (id === null || id <= 0) {
      count("skipped", "user");
      continue;
    }

    let username = text(row.username);
    if (!username) {
      username = `user${id}`;
      report.warnings.push(`User ${id} had no username; imported as "${username}".`);
    }
    if (usernames.has(username.toLowerCase())) {
      const renamed = `${username}_${id}`;
      report.warnings.push(`Username "${username}" is used twice (case-insensitively); user ${id} was renamed to "${renamed}".`);
      username = renamed;
    }
    usernames.add(username.toLowerCase());

    let apiKey = str(row.api_key)?.trim() || null;
    if (apiKey && apiKeys.has(apiKey)) {
      report.warnings.push(`User ${id} shared an API key with another user; theirs was cleared and must be regenerated.`);
      apiKey = null;
    }
    if (apiKey) apiKeys.add(apiKey);

    const password = str(row.password) ?? "";
    if (!password) report.warnings.push(`User ${id} ("${username}") has no password and cannot log in until one is set.`);
    if (flag(row.totp_enabled)) {
      report.warnings.push(`User ${id} ("${username}") uses two-factor authentication, which returns in phase 6; until then only the password is checked.`);
    }

    const periodType = str(row.budget_period_type);
    const anchor = str(row.budget_period_anchor_date)?.trim() ?? "";
    const avatar = str(row.avatar);
    if (avatar && avatar.includes("uploads/")) report.files.avatars.push(avatar);

    statements.push(
      insert("user", {
        id,
        username,
        email: text(row.email),
        password,
        main_currency: int(row.main_currency),
        avatar,
        language: str(row.language) || "en",
        budget: num(row.budget) ?? 0,
        totp_enabled: flag(row.totp_enabled),
        api_key: apiKey,
        firstname: text(row.firstname),
        lastname: text(row.lastname),
        oidc_sub: str(row.oidc_sub) || null,
        budget_period_type: periodType && ["weekly", "fortnightly", "monthly"].includes(periodType) ? periodType : "monthly",
        budget_period_anchor_date: isValidDate(anchor) ? anchor : null,
        period_budget: num(row.period_budget) ?? 0,
      }),
    );
    userIds.add(id);
    count("imported", "user");
  }

  if (!userIds.has(1) && userIds.size > 0) {
    report.warnings.push("There is no user with id 1, so the instance has no administrator.");
  }

  const ownerOf = (table: string, row: SourceRow): number | null => {
    // PHP defaulted user_id to 1 on rows created before multi-user support.
    const userId = int(row.user_id) ?? 1;
    if (!userIds.has(userId)) {
      count("skipped", table);
      return null;
    }
    return userId;
  };

  // Admin ---------------------------------------------------------------------
  const admin = rows("admin").at(-1);
  if (admin) {
    statements.push(
      insert(
        "admin",
        {
          id: 1,
          registrations_open: flag(admin.registrations_open),
          max_users: int(admin.max_users) ?? 0,
          require_email_verification: flag(admin.require_email_verification),
          server_url: str(admin.server_url),
          login_disabled: flag(admin.login_disabled),
          update_notification: flag(admin.update_notification),
          // Keeping the instance's VAPID keys keeps the browsers' push subscriptions valid.
          vapid_public_key: str(admin.vapid_public_key) ?? "",
          vapid_private_key: str(admin.vapid_private_key) ?? "",
        },
        "INSERT OR REPLACE",
      ),
    );
    count("imported", "admin");
    if (str(admin.smtp_address)) {
      report.warnings.push("The instance SMTP settings were not imported; the Worker sends e-mail through Resend (RESEND_API_KEY, EMAIL_FROM).");
    }
    if (flag(admin.oidc_oauth_enabled)) report.warnings.push("OIDC login was enabled; it returns in phase 6.");
    if (flag(admin.login_disabled)) report.warnings.push('"Disable login" is set; the Worker does not support password-less access and ignores it.');
  }

  // One row per user: settings, custom colours, custom CSS ----------------------
  const lastPerUser = (table: string) => {
    const byUser = new Map<number, SourceRow>();
    for (const row of rows(table)) {
      const userId = ownerOf(table, row);
      if (userId === null) continue;
      if (byUser.has(userId)) count("skipped", table);
      byUser.set(userId, row);
    }
    return byUser;
  };

  const settings = lastPerUser("settings");
  for (const [userId, row] of settings) {
    statements.push(
      insert("settings", {
        user_id: userId,
        dark_theme: int(row.dark_theme) ?? 2,
        monthly_price: flag(row.monthly_price),
        convert_currency: flag(row.convert_currency),
        remove_background: flag(row.remove_background),
        color_theme: str(row.color_theme) || "blue",
        hide_disabled: flag(row.hide_disabled),
        disabled_to_bottom: flag(row.disabled_to_bottom),
        show_original_price: flag(row.show_original_price),
        mobile_nav: flag(row.mobile_nav),
        show_subscription_progress: flag(row.show_subscription_progress),
        week_starts_sunday: flag(row.week_starts_sunday),
        upcoming_payments_limit: int(row.upcoming_payments_limit) ?? 3,
        square_icons: flag(row.square_icons),
      }),
    );
    count("imported", "settings");
  }
  // Every account needs a settings row; PHP did not always create one for the admin.
  for (const userId of userIds) {
    if (!settings.has(userId)) {
      statements.push(insert("settings", { user_id: userId }));
    }
  }

  for (const [userId, row] of lastPerUser("custom_colors")) {
    statements.push(
      insert("custom_colors", {
        user_id: userId,
        main_color: str(row.main_color) ?? "",
        accent_color: str(row.accent_color) ?? "",
        hover_color: str(row.hover_color) ?? "",
      }),
    );
    count("imported", "custom_colors");
  }

  for (const [userId, row] of lastPerUser("custom_css_style")) {
    statements.push(insert("custom_css_style", { user_id: userId, css: str(row.css) ?? "" }));
    count("imported", "custom_css_style");
  }

  // Reference lists ---------------------------------------------------------------
  const owned = new Map<string, Map<number, number>>(); // table -> id -> user_id
  const remember = (table: string, id: number, userId: number) => {
    if (!owned.has(table)) owned.set(table, new Map());
    owned.get(table)!.set(id, userId);
  };

  const lookups: [string, (row: SourceRow) => Record<string, Literal>][] = [
    ["household", (row) => ({ name: text(row.name), email: text(row.email) })],
    ["categories", (row) => ({ name: text(row.name), order: int(row.order) ?? 0 })],
    [
      "currencies",
      (row) => {
        const rate = num(row.rate);
        if (rate === null || rate <= 0) {
          report.warnings.push(`Currency ${text(row.code)} (id ${int(row.id)}) had rate "${str(row.rate)}"; set to 1.`);
        }
        return { name: text(row.name), symbol: text(row.symbol), code: text(row.code).toUpperCase(), rate: rate && rate > 0 ? rate : 1 };
      },
    ],
    [
      "payment_methods",
      (row) => {
        const icon = str(row.icon) ? text(row.icon) : null;
        // Built-in icons live under images/uploads/icons/; anything else is an uploaded file.
        if (icon && !icon.startsWith("images/")) report.files.logos.push(icon);
        return { name: text(row.name), icon, enabled: flag(row.enabled, 1), order: int(row.order) ?? 0 };
      },
    ],
  ];

  for (const [table, map] of lookups) {
    for (const row of rows(table)) {
      const id = int(row.id);
      const userId = ownerOf(table, row);
      if (userId === null) continue;
      if (id === null) {
        count("skipped", table);
        continue;
      }
      statements.push(insert(table, { id, ...map(row), user_id: userId }));
      remember(table, id, userId);
      count("imported", table);
    }
  }

  for (const row of rows("user")) {
    const id = int(row.id);
    const currency = int(row.main_currency);
    if (id === null || !userIds.has(id) || (currency !== null && owned.get("currencies")?.get(currency) === id)) continue;
    // The Worker relies on the main currency belonging to the user; fall back to their first currency.
    const fallback = [...(owned.get("currencies") ?? [])].find(([, owner]) => owner === id)?.[0] ?? null;
    statements.push(`UPDATE user SET main_currency = ${fallback ?? "NULL"} WHERE id = ${id};`);
    report.warnings.push(
      fallback === null
        ? `User ${id} has no currencies; add one before creating subscriptions.`
        : `User ${id}'s main currency (${currency}) is not one of their currencies; set to currency ${fallback}.`,
    );
  }

  // Subscriptions -----------------------------------------------------------------
  const date = (value: unknown, field: string, id: number): string | null => {
    const s = str(value)?.trim() ?? "";
    if (!s) return null;
    if (isValidDate(s)) return s;
    report.warnings.push(`Subscription ${id}: ${field} "${s}" is not a valid date and was cleared.`);
    return null;
  };

  const references: [string, string][] = [
    ["currency_id", "currencies"],
    ["category_id", "categories"],
    ["payment_method_id", "payment_methods"],
    ["payer_user_id", "household"],
  ];
  let foreignReferences = 0;
  const replacements: [number, number, number][] = []; // id, replacement, user

  for (const row of rows("subscriptions")) {
    const id = int(row.id);
    const userId = ownerOf("subscriptions", row);
    if (userId === null) continue;
    if (id === null) {
      count("skipped", "subscriptions");
      continue;
    }

    let cycle = int(row.cycle);
    if (cycle !== null && (cycle < 1 || cycle > 5)) {
      report.warnings.push(`Subscription ${id}: unknown cycle ${cycle}; cleared.`);
      cycle = null;
    }
    const price = num(row.price);
    if (price === null) report.warnings.push(`Subscription ${id}: price "${str(row.price)}" is not a number; set to 0.`);
    const frequency = int(row.frequency);
    const logo = str(row.logo);
    if (logo) report.files.logos.push(logo);
    const logoVariant = str(row.logo_variant);
    if (logoVariant) report.files.logos.push(logoVariant);

    const values: Record<string, Literal> = {
      id,
      name: text(row.name) || `Subscription ${id}`,
      logo: logo || null,
      price: price ?? 0,
      currency_id: int(row.currency_id),
      next_payment: date(row.next_payment, "next_payment", id),
      cycle,
      frequency: frequency !== null && frequency >= 1 ? frequency : 1,
      notes: str(row.notes) ?? "",
      payment_method_id: int(row.payment_method_id),
      payer_user_id: int(row.payer_user_id),
      category_id: int(row.category_id),
      notify: flag(row.notify),
      url: text(row.url),
      inactive: flag(row.inactive),
      notify_days_before: int(row.notify_days_before) ?? 0,
      user_id: userId,
      cancellation_date: date(row.cancellation_date, "cancellation_date", id),
      start_date: date(row.start_date, "start_date", id),
      auto_renew: flag(row.auto_renew, 1),
      logo_text_color: str(row.logo_text_color) || null,
      logo_variant: str(row.logo_variant) || null,
    };

    for (const [field, table] of references) {
      const ref = values[field] as number | null;
      if (ref !== null && owned.get(table)?.get(ref) !== userId) foreignReferences++;
    }

    statements.push(insert("subscriptions", values));
    remember("subscriptions", id, userId);
    count("imported", "subscriptions");

    const replacement = int(row.replacement_subscription_id);
    if (replacement !== null && replacement !== 0) replacements.push([id, replacement, userId]);
  }

  if (foreignReferences > 0) {
    report.warnings.push(
      `${foreignReferences} subscription reference(s) point at a category, currency, payment method or member that is missing or belongs to another user; they show as unknown until edited.`,
    );
  }

  for (const [id, replacement, userId] of replacements) {
    if (replacement !== id && owned.get("subscriptions")?.get(replacement) === userId) {
      statements.push(`UPDATE subscriptions SET replacement_subscription_id = ${replacement} WHERE id = ${id};`);
    } else {
      report.warnings.push(`Subscription ${id}: replacement subscription ${replacement} does not exist for the same user; dropped.`);
    }
  }

  // Notifications (phase 3) ------------------------------------------------------
  for (const [userId, row] of lastPerUser("notification_settings")) {
    statements.push(
      insert("notification_settings", {
        user_id: userId,
        days: int(row.days) ?? 1,
        period_summary_at_period_start: flag(row.period_summary_at_period_start),
      }),
    );
    count("imported", "notification_settings");
  }

  let smtpUsers = 0;
  let ignoredSsl = 0;
  for (const [table, { channel, fields }] of Object.entries(CHANNEL_TABLES)) {
    for (const [userId, row] of lastPerUser(table)) {
      const config: Record<string, string> = {};
      for (const [from, to] of Object.entries(fields)) {
        const value = str(row[from]);
        if (value !== null && value !== "") config[to] = value;
      }
      if (table === "email_notifications" && str(row.smtp_address)) smtpUsers++;
      if (flag(row.ignore_ssl) && flag(row.enabled)) ignoredSsl++;
      statements.push(insert("notification_channels", { user_id: userId, channel, enabled: flag(row.enabled), config: JSON.stringify(config) }));
      count("imported", "notification_channels");
    }
  }
  if (smtpUsers > 0) {
    report.warnings.push(`${smtpUsers} user(s) had their own SMTP server for e-mail notifications; e-mail now goes out through the instance's Resend sender.`);
  }
  if (ignoredSsl > 0) {
    report.warnings.push(`${ignoredSsl} channel(s) were set to ignore TLS errors; a Worker always verifies certificates, so self-signed servers need a valid certificate.`);
  }

  for (const row of rows("push_subscriptions")) {
    const userId = ownerOf("push_subscriptions", row);
    if (userId === null || !str(row.endpoint) || !str(row.p256dh) || !str(row.auth)) {
      if (userId !== null) count("skipped", "push_subscriptions");
      continue;
    }
    statements.push(
      insert("push_subscriptions", {
        user_id: userId,
        endpoint: str(row.endpoint)!,
        p256dh: str(row.p256dh)!,
        auth: str(row.auth)!,
        user_agent: str(row.user_agent) ?? "",
        created_at: str(row.created_at) || null,
      }).replace("INSERT INTO", "INSERT OR IGNORE INTO"),
    );
    count("imported", "push_subscriptions");
  }

  // Exchange rates: the provider row, and when rates were last fetched.
  for (const [userId, row] of lastPerUser("fixer")) {
    const provider = int(row.provider) ?? 0;
    statements.push(insert("fixer", { user_id: userId, api_key: str(row.api_key) ?? "", provider: provider >= 0 && provider <= 2 ? provider : 0 }));
    count("imported", "fixer");
  }
  for (const [userId, row] of lastPerUser("last_exchange_update")) {
    const date = str(row.date)?.trim() ?? "";
    if (!isValidDate(date)) continue;
    statements.push(insert("last_exchange_update", { user_id: userId, date }));
    count("imported", "last_exchange_update");
  }

  for (const [userId, row] of lastPerUser("google_search")) {
    const key = str(row.api_key) ?? "";
    if (!key) continue;
    statements.push(insert("google_search", { user_id: userId, api_key: key }));
    count("imported", "google_search");
  }

  report.files.logos = [...new Set(report.files.logos)];
  return { statements, report };
}
