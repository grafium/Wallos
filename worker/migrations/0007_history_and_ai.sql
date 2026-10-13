-- Phase 7: yearly cost history and AI recommendations.
--
-- Tables as in PHP Wallos (migrations 000032 and 000039) so they import as
-- they are. Differences:
--   * one ai_settings row per user (PHP kept the first of possibly several);
--   * ai_settings.last_attempt (new): when the scheduled job last tried, so a
--     failing provider is retried once a day rather than every hour;
--   * total_yearly_cost.date is a YYYY-MM-DD text and one row per user and day.

CREATE TABLE total_yearly_cost (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    date TEXT NOT NULL,
    cost REAL NOT NULL,
    currency TEXT NOT NULL,                    -- id of the main currency then (as PHP stored it)
    UNIQUE (user_id, date)
);

CREATE TABLE ai_settings (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL UNIQUE REFERENCES user(id) ON DELETE CASCADE,
    type TEXT NOT NULL,                        -- chatgpt, gemini, openrouter, ollama, openai-compatible, workers-ai
    enabled BOOLEAN NOT NULL DEFAULT 0,
    api_key TEXT,
    model TEXT NOT NULL,
    url TEXT,
    run_schedule TEXT NOT NULL DEFAULT 'manual', -- manual, weekly, monthly
    last_successful_run TEXT,
    last_attempt TEXT,
    created_at TEXT DEFAULT CURRENT_TIMESTAMP,
    updated_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE ai_recommendations (
    id INTEGER PRIMARY KEY,
    user_id INTEGER NOT NULL REFERENCES user(id) ON DELETE CASCADE,
    type TEXT NOT NULL DEFAULT 'subscription',
    title TEXT NOT NULL,
    description TEXT NOT NULL,
    savings TEXT NOT NULL DEFAULT '',
    created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX idx_ai_recommendations_user ON ai_recommendations (user_id);
