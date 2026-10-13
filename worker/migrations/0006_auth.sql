-- Phase 6: two-factor authentication, OIDC single sign-on, login throttling.
--
-- totp, oauth_settings and admin.oidc_oauth_enabled follow the PHP Wallos
-- tables (migrations 000027, 000038, 000039, 000047, 000054) so they can be
-- imported. Differences:
--   * totp.backup_codes holds SHA-256 hashes of the codes, not the codes;
--   * oauth_settings can only ever have the one row (id = 1);
--   * an OIDC subject belongs to at most one account.

ALTER TABLE admin ADD COLUMN oidc_oauth_enabled INTEGER DEFAULT 0;

CREATE TABLE totp (
    user_id INTEGER PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
    totp_secret TEXT NOT NULL,                 -- base32
    backup_codes TEXT NOT NULL DEFAULT '[]',   -- JSON array of SHA-256 hex hashes
    last_totp_used INTEGER DEFAULT 0,          -- last accepted 30-second time step (replay guard)
    failed_attempts INTEGER DEFAULT 0,
    lockout_until INTEGER DEFAULT 0            -- unix seconds
);

CREATE TABLE oauth_settings (
    id INTEGER PRIMARY KEY CHECK (id = 1),
    name TEXT NOT NULL DEFAULT '',
    client_id TEXT NOT NULL DEFAULT '',
    client_secret TEXT NOT NULL DEFAULT '',
    authorization_url TEXT NOT NULL DEFAULT '',
    token_url TEXT NOT NULL DEFAULT '',
    user_info_url TEXT NOT NULL DEFAULT '',
    redirect_url TEXT NOT NULL DEFAULT '',
    logout_url TEXT DEFAULT '',
    user_identifier_field TEXT NOT NULL DEFAULT 'sub',
    scopes TEXT NOT NULL DEFAULT 'openid email profile',
    auth_style TEXT DEFAULT 'auto',
    auto_create_user INTEGER DEFAULT 0,
    password_login_disabled INTEGER DEFAULT 0,
    require_email_verified INTEGER DEFAULT 1,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE UNIQUE INDEX idx_user_oidc_sub ON user (oidc_sub) WHERE oidc_sub IS NOT NULL AND oidc_sub != '';

-- Sessions started through OIDC log out at the provider too (PHP's $_SESSION['from_oidc']).
ALTER TABLE sessions ADD COLUMN via_oidc INTEGER NOT NULL DEFAULT 0;

-- Short-lived steps of a login: the pending second factor after the password
-- ("totp") and the state of an OIDC redirect ("oidc"). id is the SHA-256 of
-- the random token kept in an HttpOnly cookie.
CREATE TABLE auth_flows (
    id TEXT PRIMARY KEY,
    kind TEXT NOT NULL,
    user_id INTEGER REFERENCES user(id) ON DELETE CASCADE,
    data TEXT NOT NULL DEFAULT '{}',
    expires_at INTEGER NOT NULL                -- unix seconds
);

-- Failed login counters per client address and per address + username.
CREATE TABLE login_attempts (
    key TEXT PRIMARY KEY,
    failures INTEGER NOT NULL DEFAULT 0,
    window_start INTEGER NOT NULL,             -- unix seconds
    locked_until INTEGER NOT NULL DEFAULT 0    -- unix seconds
);
