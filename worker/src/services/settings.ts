import type { SettingsInput } from "../lib/schemas";

const SETTINGS_COLUMNS = [
  "dark_theme",
  "color_theme",
  "monthly_price",
  "convert_currency",
  "show_original_price",
  "mobile_nav",
  "show_subscription_progress",
  "week_starts_sunday",
  "upcoming_payments_limit",
  "disabled_to_bottom",
  "hide_disabled",
  "remove_background",
  "square_icons",
] as const;

/** Settings with custom colours and CSS nested, as api/settings/get_settings.php returns them. */
export async function getSettings(db: D1Database, userId: number) {
  const [settings, colors, css] = await db.batch<Record<string, unknown>>([
    db.prepare(`SELECT ${SETTINGS_COLUMNS.join(", ")} FROM settings WHERE user_id = ?`).bind(userId),
    db.prepare("SELECT main_color, accent_color, hover_color FROM custom_colors WHERE user_id = ?").bind(userId),
    db.prepare("SELECT css FROM custom_css_style WHERE user_id = ?").bind(userId),
  ]);
  return {
    ...(settings?.results[0] ?? {}),
    ...(colors?.results[0] ? { custom_colors: colors.results[0] } : {}),
    ...(css?.results[0] ? { custom_css: css.results[0] } : {}),
  };
}

export async function updateSettings(db: D1Database, userId: number, input: SettingsInput): Promise<void> {
  const statements: D1PreparedStatement[] = [
    // Accounts created before settings existed may have no row yet.
    db.prepare("INSERT OR IGNORE INTO settings (user_id) VALUES (?)").bind(userId),
  ];

  const changes = SETTINGS_COLUMNS.filter((column) => input[column] !== undefined);
  if (changes.length > 0) {
    statements.push(
      db
        .prepare(`UPDATE settings SET ${changes.map((c) => `${c} = ?`).join(", ")} WHERE user_id = ?`)
        .bind(...changes.map((c) => input[c]!), userId),
    );
  }
  if (input.main_color && input.accent_color && input.hover_color) {
    statements.push(
      db
        .prepare("INSERT OR REPLACE INTO custom_colors (user_id, main_color, accent_color, hover_color) VALUES (?, ?, ?, ?)")
        .bind(userId, input.main_color, input.accent_color, input.hover_color),
    );
  }
  if (input.css !== undefined) {
    statements.push(db.prepare("INSERT OR REPLACE INTO custom_css_style (user_id, css) VALUES (?, ?)").bind(userId, input.css));
  }
  await db.batch(statements);
}
