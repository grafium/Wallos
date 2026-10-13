-- Phase 3: notifications, e-mail flows and exchange rates.

-- Reminders go out at a fixed local hour, so every account has a timezone.
ALTER TABLE user ADD COLUMN timezone TEXT NOT NULL DEFAULT 'UTC';

-- Web Push keys of this instance (VAPID): public key as base64url of the raw
-- P-256 point, private key as PKCS#8 PEM - the same format PHP Wallos stores,
-- so imported push subscriptions keep working.
ALTER TABLE admin ADD COLUMN vapid_public_key TEXT DEFAULT '';
ALTER TABLE admin ADD COLUMN vapid_private_key TEXT DEFAULT '';

CREATE TABLE notification_settings (
    user_id INTEGER PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
    -- Days before the payment to remind, unless a subscription says otherwise.
    days INTEGER NOT NULL DEFAULT 1,
    -- Also send the "amount needed this budget period" summary on the first day of each period.
    period_summary_at_period_start INTEGER NOT NULL DEFAULT 0
);

-- One row per user and channel. PHP Wallos had a table per channel
-- (discord_notifications, telegram_notifications, ...); the importer folds
-- them into this shape. config is a JSON object validated per channel.
CREATE TABLE notification_channels (
    user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    channel TEXT NOT NULL,
    enabled INTEGER NOT NULL DEFAULT 0,
    config TEXT NOT NULL DEFAULT '{}',
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (user_id, channel)
);

-- What has been sent, so a cron that fires twice never notifies twice.
CREATE TABLE notification_log (
    user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,          -- 'payment' or 'cancellation'
    local_date TEXT NOT NULL,    -- the user's local date the run was for
    sent_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
    result TEXT NOT NULL DEFAULT '{}',
    PRIMARY KEY (user_id, kind, local_date)
);

CREATE TABLE push_subscriptions (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    endpoint TEXT NOT NULL,
    p256dh TEXT NOT NULL,
    auth TEXT NOT NULL,
    user_agent TEXT DEFAULT '',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE UNIQUE INDEX push_subscriptions_user_endpoint ON push_subscriptions (user_id, endpoint);

-- Exchange-rate provider per user. Name and provider codes as in PHP Wallos:
-- 0 = Fixer.io, 1 = APILayer, 2 = Frankfurter (no key). No row = rates are
-- maintained by hand.
CREATE TABLE fixer (
    user_id INTEGER PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
    api_key TEXT NOT NULL DEFAULT '',
    provider INTEGER NOT NULL DEFAULT 2
);

CREATE TABLE last_exchange_update (
    user_id INTEGER PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    held TEXT NOT NULL DEFAULT '' -- currency codes the provider did not price
);

-- Tokens are stored as SHA-256 hashes; the plain token only travels in the e-mail.
CREATE TABLE email_verification (
    user_id INTEGER PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE password_resets (
    user_id INTEGER PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
    email TEXT NOT NULL,
    token_hash TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
