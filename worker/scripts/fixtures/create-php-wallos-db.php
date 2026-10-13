<?php
/*
  Builds a small but realistic PHP Wallos database for the importer tests,
  using the real PHP migrations and the same escaping PHP applies on save.

  php scripts/fixtures/create-php-wallos-db.php <output.db>
  (run from worker/; the Wallos PHP sources are expected in ..)
*/

$out = $argv[1] ?? 'php-wallos.db';
$root = realpath(__DIR__ . '/../../..');
@unlink($out);
copy("$root/db/wallos.empty.db", $out);

chdir($root);
$db = new SQLite3($out);
ob_start();
require "$root/includes/run_migrations.php";
ob_end_clean();
require_once "$root/includes/inputvalidation.php";

function q(SQLite3 $db, string $sql, array $params = []): void {
    $stmt = $db->prepare($sql);
    foreach ($params as $k => $v) {
        $stmt->bindValue(is_int($k) ? $k + 1 : $k, $v);
    }
    $stmt->execute();
}

// Users. The seed currencies/categories/payment methods already belong to user 1.
q($db, 'INSERT INTO user (id, username, firstname, lastname, email, password, main_currency, avatar, language, budget, api_key, budget_period_type, budget_period_anchor_date, period_budget)
        VALUES (1, ?, ?, ?, ?, ?, 1, ?, "en", 200, ?, "monthly", "2024-01-15", 150)', [
    validate('admin'), validate('Zoë & Co'), validate("O'Brien"), validate('admin@example.com'),
    password_hash('admin-pass', PASSWORD_DEFAULT), 'images/uploads/logos/avatars/me.png', str_repeat('a', 64),
]);
q($db, 'INSERT INTO user (id, username, email, password, main_currency, language, budget, api_key)
        VALUES (2, "bob", "bob@example.com", ?, 0, "hu", 0, ?)', [password_hash('bob-pass', PASSWORD_DEFAULT), str_repeat('a', 64)]);
q($db, 'INSERT INTO user (id, username, email, password, main_currency, language, budget, api_key)
        VALUES (3, "BOB", "bob2@example.com", ?, 0, "en", 0, "")', [password_hash('bob2-pass', PASSWORD_DEFAULT)]);

// Bob gets his own copies of the reference lists, as registration.php does.
$db->exec('INSERT INTO categories (name, "order", user_id) SELECT name, "order", 2 FROM categories WHERE user_id = 1');
$db->exec('INSERT INTO payment_methods (name, icon, "order", user_id) SELECT name, icon, "order", 2 FROM payment_methods WHERE user_id = 1');
$db->exec('INSERT INTO currencies (name, symbol, code, rate, user_id) SELECT name, symbol, code, rate, 2 FROM currencies WHERE user_id = 1');
$db->exec("UPDATE user SET main_currency = (SELECT id FROM currencies WHERE user_id = 2 AND code = 'HUF') WHERE id = 2");

q($db, 'INSERT INTO household (name, email, user_id) VALUES (?, ?, 1)', [validate('admin'), '']);
q($db, 'INSERT INTO household (name, email, user_id) VALUES (?, ?, 1)', [validate('Anna "Panni" <K>'), validate('anna@example.com')]);
q($db, 'INSERT INTO household (name, email, user_id) VALUES (?, ?, 2)', ['bob', '']);
q($db, 'INSERT INTO categories (name, "order", user_id) VALUES (?, 99, 1)', [validate('Kids & Family')]);

// Rates are TEXT in PHP: 1 EUR = 1.0850 USD; one broken rate.
$db->exec("UPDATE currencies SET rate = '1.0850' WHERE user_id = 1 AND code = 'USD'");
$db->exec("UPDATE currencies SET rate = '' WHERE user_id = 1 AND code = 'GBP'");

// Duplicate settings rows for user 1 (the last one should win).
$db->exec("INSERT INTO settings (dark_theme, color_theme, user_id) VALUES (0, 'red', 1)");
$db->exec("INSERT INTO settings (dark_theme, color_theme, user_id, disabled_to_bottom) VALUES (1, 'green', 1, 1)");
$db->exec("INSERT INTO custom_colors (main_color, accent_color, hover_color, user_id) VALUES ('#112233', '#445566', '#778899', 1)");
$db->exec("INSERT INTO email_notifications (enabled, smtp_address, other_emails, user_id) VALUES (1, 'smtp.example.com', 'cc@example.com', 1)");
$db->exec("INSERT INTO notification_settings (days, user_id, period_summary_at_period_start) VALUES (3, 1, 0)");
$db->exec("INSERT INTO discord_notifications (enabled, webhook_url, bot_username, bot_avatar_url, user_id) VALUES (1, 'https://discord.com/api/webhooks/1/abc', 'Wallos', '', 1)");
$db->exec("INSERT INTO webhook_notifications (enabled, headers, url, request_method, payload, user_id, ignore_ssl, cancelation_payload) VALUES (1, '{\"X-Token\":\"secret\"}', 'https://hooks.example.com/wallos', 'POST', '{\"name\":\"{{subscription_name}}\"}', 1, 1, '')");
$db->exec("INSERT INTO telegram_notifications (enabled, bot_token, chat_id, user_id) VALUES (0, '123:abc', '42', 2)");
$db->exec("INSERT INTO push_notifications (enabled, user_id) VALUES (1, 1)");
$db->exec("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent, created_at) VALUES (1, 'https://fcm.googleapis.com/fcm/send/xyz', 'BNcRdreALRFXTkOOUHK1EtK2wtaz5Ry4YfYCA_0QTpQtUbVlUls0VJXg7A8u-Ts1XbjhazAkj7I99e8QcYP7DkM', 'tBHItJI5svbpez7KI4CCXg', 'Firefox', '2026-01-01 10:00:00')");
$db->exec("INSERT INTO fixer (api_key, provider, user_id) VALUES ('', 2, 1)");
$db->exec("INSERT INTO last_exchange_update (date, user_id) VALUES ('2026-10-12', 1)");
$db->exec("UPDATE admin SET registrations_open = 1, max_users = 10, smtp_address = 'smtp.example.com'");

$usd = $db->querySingle("SELECT id FROM currencies WHERE user_id = 1 AND code = 'USD'");
$music = $db->querySingle("SELECT id FROM categories WHERE user_id = 1 AND name = 'Music'");
$bobCategory = $db->querySingle("SELECT id FROM categories WHERE user_id = 2 ORDER BY id DESC LIMIT 1");

$subs = [
    // id, name, price, currency, next_payment, cycle, frequency, category, notes, url, inactive, auto_renew, start_date, replacement, user, logo
    [1, 'Netflix', 15.99, 1, '2024-05-10', 3, 1, 1, '', 'https://netflix.com/?a=1&b=2', 0, 1, '2020-01-10', null, 1, '1700000000-netflix.png'],
    [2, "Tom & Jerry's <Plus>", 10.85, $usd, '2024-05-20', 3, 1, $music, 'Fish & chips **bold**', '', 0, 1, '', null, 1, ''],
    [3, 'Domain', 12, 1, '2024-11-01', 4, 1, 1, '', '', 0, 0, '2019-11-01', null, 1, ''],
    [4, 'Old gym', 30, 1, '', 3, 1, 1, '', '', 1, 1, '', 5, 1, ''],
    [5, 'New gym', 25, 1, '2024-05-03', 3, 1, 1, '', '', 0, 1, '2024-04-03', 4, 1, ''],
    [6, 'Course', 300, 1, '2024-05-25', 5, 1, 1, '', '', 0, 0, '', 999, 1, ''],
    [7, 'Sneaky', 1, 1, '2024-05-05', 3, 1, $bobCategory, '', '', 0, 1, '', null, 1, ''],
    [8, 'Orphan', 1, 1, '2024-05-05', 3, 1, 1, '', '', 0, 1, '', null, 99, ''],
    [9, 'Bob TV', 4990, null, '2024-05-15', 3, 1, null, '', '', 0, 1, '', null, 2, ''],
];
foreach ($subs as $s) {
    q($db, 'INSERT INTO subscriptions (id, name, price, currency_id, next_payment, cycle, frequency, category_id, notes, url, inactive, auto_renew, start_date, replacement_subscription_id, user_id, logo, payment_method_id, payer_user_id, notify, notify_days_before)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, 1, 1, 1, -1)', [
        $s[0], validate($s[1]), $s[2], $s[3], $s[4], $s[5], $s[6], $s[7], validate_markdown($s[8]), validate($s[9]),
        $s[10], $s[11], $s[12], $s[13], $s[14], $s[15],
    ]);
}
$db->exec("UPDATE subscriptions SET currency_id = (SELECT main_currency FROM user WHERE id = 2), category_id = $bobCategory, payment_method_id = (SELECT MIN(id) FROM payment_methods WHERE user_id = 2), payer_user_id = 3 WHERE id = 9");

$db->close();
echo "Wrote $out\n";
