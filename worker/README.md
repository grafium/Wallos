# Wallos Worker

A Wallos előfizetés-követő Cloudflare Workers + D1 változata. A felmérést és az ütemtervet lásd: [ROADMAP.md](./ROADMAP.md).

Jelenleg (2. fázis után) egy JSON API: fiókok, profil és beállítások, előfizetések, kategóriák, háztartás, fizetési módok, devizák, statisztika és költségvetés, admin, export, valamint a PHP Wallos `api/**/*.php` végpontjai kompatibilis formában. Egy meglévő PHP Wallos adatbázis importálható.

## Fejlesztés

```sh
npm install
npm run db:migrate:local   # helyi D1 (.wrangler/)
npm run dev                # http://localhost:8787
npm test                   # Vitest a Workers runtime-ban, helyi D1-gyel
npm run typecheck
```

## Telepítés

```sh
npx wrangler login
npx wrangler d1 create wallos   # database_id → wrangler.jsonc
npm run db:migrate:remote
npm run deploy
```

Az első regisztrált felhasználó lesz az admin. Utána a regisztráció zárva marad, amíg az admin meg nem nyitja (`PATCH /api/admin/settings` → `registrations_open`), vagy az admin maga vesz fel felhasználót (`POST /api/admin/users`).

## Átköltözés PHP Wallosról

Node 22.18+ kell (beépített `node:sqlite`). A PHP példány `db/wallos.db` fájljából SQL-t készít a D1-hez:

```sh
npm run import -- /path/to/wallos.db -o import.sql      # jelentést ír ki: mi jött át, mi maradt ki, figyelmeztetések
npm run db:migrate:remote                               # üres, migrált adatbázisra
npx wrangler d1 execute wallos --remote --file import.sql
```

- A felhasználók a régi jelszavukkal lépnek be (bcrypt → első belépéskor PBKDF2), az API-kulcsok változatlanok, így a régi integrációk működnek tovább.
- A PHP által HTML-escapelve mentett szövegek (`&amp;` stb.) dekódolódnak; a jegyzetek érintetlenek maradnak.
- Javítja a hibás adatokat: szöveges árfolyamok, üres/hibás dátumok, árva sorok, duplikált beállítások, kis-nagybetűre ütköző felhasználónevek, duplikált API-kulcsok, lógó helyettesítő előfizetések. Mindről figyelmeztetést ír.
- `--replace`: az importálás előtt törli a meglévő felhasználókat és minden adatukat.
- Még nem jön át (jelentésben látszik, melyik fázisban jön): értesítési beállítások, árfolyam-API kulcs, TOTP, OIDC, AI-beállítások, éves költségtörténet. A logó- és avatarfájlokat (`images/uploads/`) a 4. fázis viszi R2-be.

## Hitelesítés

- `POST /api/auth/login` → `token`; küldd így: `Authorization: Bearer <token>`.
- Az API-kulcs (`GET /api/me/api-key`, csak sessionből) ugyanígy Bearer tokenként, `X-API-Key` fejlécben, vagy a régi módon `api_key` / `apiKey` paraméterként is használható.

## API

Minden válasz a Wallos-borítékot követi: `{ "success": bool, "title": string, ... }`. Hibánál `message`, validációs hibánál `errors[]` is jön.

| Metódus | Útvonal | Leírás |
|---|---|---|
| GET | `/api/health` | Állapot (nyilvános) |
| POST | `/api/auth/register` | `username`, `email`, `password`, `main_currency` (ISO kód, alap: EUR), `language`, `firstname`, `lastname` |
| POST | `/api/auth/login` | `username`, `password` → `token`, `expires_at` |
| POST | `/api/auth/logout` | A session token érvénytelenítése |
| GET | `/api/me` | Profil és beállítások |
| PATCH | `/api/me` | Profil: `firstname`, `lastname`, `email`, `language`, `main_currency`, `avatar` |
| GET / PATCH | `/api/me/settings` | Megjelenés: `dark_theme` (0/1/2), `color_theme`, `monthly_price`, `convert_currency`, `show_original_price`, `mobile_nav`, `show_subscription_progress`, `week_starts_sunday`, `upcoming_payments_limit` (3/5/10/20), `disabled_to_bottom`, `hide_disabled`, `remove_background`, `square_icons`, `main_color`+`accent_color`+`hover_color` (együtt), `css` |
| PATCH | `/api/me/budget` | `budget` / `monthly_budget`, `period_budget`, `budget_period_type` (weekly, fortnightly, monthly), `budget_period_anchor_date` |
| POST | `/api/me/password` | `current_password`, `new_password`; a többi session kijelentkezik (csak sessionből) |
| GET | `/api/me/export` | A felhasználó összes adata JSON-ként (jelszó és API-kulcs nélkül) |
| GET / POST | `/api/me/api-key` | API-kulcs lekérése / cseréje (csak sessionből) |
| GET | `/api/subscriptions` | Szűrők: `member`, `category`, `payment` (vesszővel elválasztott id-k), `state` (0 aktív, 1 inaktív), `sort` (`next_payment`, `name`, `alphanumeric`, `price`, `id`, `payer_user_id`, `category_id`, `payment_method_id`, `inactive`), `disabled_to_bottom=true`, `convert_currency=true` |
| POST | `/api/subscriptions` | Kötelező: `name`, `price`. Opcionális: `currency_id`, `next_payment`, `start_date`, `cycle` (1 nap, 2 hét, 3 hónap, 4 év, 5 egyszeri), `frequency` (1–31), `auto_renew`, `payment_method_id`, `payer_user_id`, `category_id`, `notes`, `url`, `notify`, `notify_days_before` (-1 = alapértelmezett), `inactive`, `cancellation_date`, `replacement_subscription_id` |
| GET / PATCH / DELETE | `/api/subscriptions/:id` | Lekérés / részleges módosítás / törlés |
| POST | `/api/subscriptions/:id/renew` | Kézi megújítás (csak `auto_renew = 0` esetén) |
| POST | `/api/subscriptions/:id/clone` | Másolat |
| GET / POST | `/api/categories` | Lista (`in_use` jelzővel) / új |
| PATCH / DELETE | `/api/categories/:id` | Módosítás / törlés (használatban lévőt nem) |
| … | `/api/household`, `/api/payment-methods`, `/api/currencies` | Ugyanígy; a devizánál `rate` = hány egység 1 fődevizáért |
| GET | `/api/cycles` | Ciklusok |
| GET | `/api/stats/monthly-cost?month=&year=` | Egy naptári hónap tényleges költsége fődevizában |
| GET | `/api/stats/summary` | Havi/éves átlag, kategóriánkénti bontás |
| GET | `/api/stats/period-budget?reference_date=` | Az aktuális költségvetési időszak: mennyi kell még, marad-e keret |
| GET / PATCH | `/api/admin/settings` | Csak admin: `registrations_open`, `max_users`, `require_email_verification`, `server_url`, `update_notification` |
| GET / POST | `/api/admin/users` | Csak admin: felhasználók listája / új felhasználó (zárt regisztráció mellett is) |
| DELETE | `/api/admin/users/:id` | Csak admin: felhasználó és minden adatának törlése (az admin nem törölhető) |

### PHP Wallos kompatibilitás

Ezek a régi útvonalak ugyanazt a választ adják, mint a PHP API: `/api/subscriptions/get_subscriptions.php`, `get_subscription.php`, `set_subscriptions.php` (`action=add|edit|delete`), `get_monthly_cost.php`, `/api/categories/get_categories.php`, `/api/currencies/get_currencies.php`, `/api/payment_methods/get_payment_methods.php`, `/api/household/get_household.php`, `/api/subscriptions/get_period_budget.php`, `/api/users/get_user.php`, `/api/users/set_budget.php`, `/api/settings/get_settings.php`, `/api/settings/set_settings.php`, `/api/admin/get_admin_settings.php`, `/api/admin/set_admin_settings.php`, `/api/status/version.php`.

## Felépítés

```
migrations/          D1 migrációk (wrangler d1 migrations)
src/index.ts         Hono app, útvonalak, cron belépési pont
src/lib/             dátumaritmetika, árak, jelszó-hash, hitelesítés, validáció
src/services/        előfizetés-, fiók- és statisztikalogika
src/routes/          HTTP útvonalak (REST + PHP-kompatibilis)
src/cron/            ütemezett feladatok
src/import/          PHP Wallos adatbázis → D1 SQL átalakítás
scripts/             importáló CLI, fixture-generátorok
test/                Vitest (Workers runtime, helyi D1); fixtures/php-wallos.json valódi PHP-ból
```
