-- Per-user appearance settings, as in PHP Wallos (custom_colors,
-- custom_css_style). square_icons is read and written by the PHP settings API
-- but no PHP migration ever created the column; it exists here.

ALTER TABLE settings ADD COLUMN square_icons BOOLEAN DEFAULT 0;

CREATE TABLE custom_colors (
    user_id INTEGER PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
    main_color TEXT NOT NULL,
    accent_color TEXT NOT NULL,
    hover_color TEXT NOT NULL
);

CREATE TABLE custom_css_style (
    user_id INTEGER PRIMARY KEY REFERENCES user(id) ON DELETE CASCADE,
    css TEXT DEFAULT ''
);
