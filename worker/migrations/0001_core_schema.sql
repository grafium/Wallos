-- Wallos core schema for Cloudflare D1.
--
-- Table and column names follow the PHP Wallos SQLite database (after all 59
-- PHP migrations) so an existing wallos.db can be imported row by row. The
-- differences are deliberate tightening, not renames:
--   * every per-user row has a NOT NULL user_id that cascades on user delete
--     (D1 enforces foreign keys);
--   * currencies.rate is REAL instead of TEXT;
--   * usernames and API keys are unique;
--   * login sessions live in their own table with hashed tokens.
-- Notification, OIDC, TOTP, AI and statistics tables arrive in later
-- migrations together with the features that use them (see ROADMAP.md).

CREATE TABLE user (
    id INTEGER PRIMARY KEY,
    username TEXT NOT NULL UNIQUE COLLATE NOCASE,
    email TEXT NOT NULL,
    password TEXT NOT NULL,
    main_currency INTEGER,
    avatar TEXT,
    language TEXT DEFAULT 'en',
    budget INTEGER DEFAULT 0,
    totp_enabled BOOLEAN DEFAULT 0,
    api_key TEXT UNIQUE,
    firstname TEXT DEFAULT '',
    lastname TEXT DEFAULT '',
    oidc_sub TEXT,
    budget_period_type TEXT DEFAULT 'monthly',
    budget_period_anchor_date TEXT,
    period_budget REAL DEFAULT 0,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE admin (
    id INTEGER PRIMARY KEY,
    registrations_open BOOLEAN DEFAULT 0,
    max_users INTEGER DEFAULT 0,
    require_email_verification BOOLEAN DEFAULT 0,
    server_url TEXT,
    login_disabled BOOLEAN DEFAULT 0,
    update_notification BOOLEAN DEFAULT 0
);

CREATE TABLE settings (
    user_id INTEGER PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
    dark_theme INTEGER DEFAULT 2,
    monthly_price BOOLEAN DEFAULT 0,
    convert_currency BOOLEAN DEFAULT 0,
    remove_background BOOLEAN DEFAULT 0,
    color_theme TEXT DEFAULT 'blue',
    hide_disabled BOOLEAN DEFAULT 0,
    disabled_to_bottom BOOLEAN DEFAULT 0,
    show_original_price BOOLEAN DEFAULT 0,
    mobile_nav BOOLEAN DEFAULT 0,
    show_subscription_progress BOOLEAN DEFAULT 0,
    week_starts_sunday BOOLEAN DEFAULT 0,
    upcoming_payments_limit INTEGER DEFAULT 3
);

CREATE TABLE household (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    email TEXT DEFAULT '',
    user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE
);
CREATE INDEX idx_household_user ON household (user_id);

CREATE TABLE categories (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    "order" INTEGER DEFAULT 0,
    user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE
);
CREATE INDEX idx_categories_user ON categories (user_id);

CREATE TABLE currencies (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    symbol TEXT NOT NULL,
    code TEXT NOT NULL,
    rate REAL NOT NULL DEFAULT 1,
    user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE
);
CREATE INDEX idx_currencies_user ON currencies (user_id);

CREATE TABLE payment_methods (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    icon TEXT,
    enabled BOOLEAN DEFAULT 1,
    "order" INTEGER DEFAULT 0,
    user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE
);
CREATE INDEX idx_payment_methods_user ON payment_methods (user_id);

-- Reference tables shared by every user.
CREATE TABLE cycles (
    id INTEGER PRIMARY KEY,
    days INTEGER NOT NULL,
    name TEXT NOT NULL
);

CREATE TABLE frequencies (
    id INTEGER PRIMARY KEY,
    name INTEGER NOT NULL
);

CREATE TABLE subscriptions (
    id INTEGER PRIMARY KEY,
    name TEXT NOT NULL,
    logo TEXT,
    price REAL NOT NULL,
    currency_id INTEGER,
    next_payment TEXT,
    cycle INTEGER REFERENCES cycles(id),
    frequency INTEGER,
    notes TEXT,
    payment_method_id INTEGER,
    payer_user_id INTEGER,
    category_id INTEGER,
    notify BOOLEAN DEFAULT 0,
    url TEXT,
    inactive BOOLEAN DEFAULT 0,
    notify_days_before INTEGER DEFAULT 0,
    user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    cancellation_date TEXT,
    replacement_subscription_id INTEGER REFERENCES subscriptions(id) ON DELETE SET NULL,
    start_date TEXT,
    auto_renew INTEGER DEFAULT 1,
    logo_text_color TEXT,
    logo_variant TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_subscriptions_user_inactive_next_payment
    ON subscriptions (user_id, inactive, next_payment);
CREATE INDEX idx_subscriptions_user_notify_inactive
    ON subscriptions (user_id, notify, inactive);
CREATE INDEX idx_subscriptions_renewal
    ON subscriptions (auto_renew, inactive, next_payment);

CREATE TABLE sessions (
    id TEXT PRIMARY KEY, -- SHA-256 of the bearer token, hex encoded
    user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    expires_at TEXT NOT NULL,
    user_agent TEXT DEFAULT ''
);
CREATE INDEX idx_sessions_user ON sessions (user_id);
CREATE INDEX idx_sessions_expires ON sessions (expires_at);

-- Single-row bookkeeping, as in PHP Wallos.
CREATE TABLE last_update_next_payment_date (
    date TEXT NOT NULL
);
