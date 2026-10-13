-- SerpAPI key for the Google Images section of the logo search, per user,
-- as in PHP Wallos (google_search).
CREATE TABLE google_search (
    user_id INTEGER PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
    api_key TEXT NOT NULL DEFAULT ''
);
