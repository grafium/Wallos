# Wallos Worker

A Wallos előfizetés-követő Cloudflare Workers + D1 változata. A felmérést és az ütemtervet lásd: [ROADMAP.md](./ROADMAP.md); munkanapló: [NAPLO.md](./NAPLO.md); szabályok: [SZABALYOK.md](./SZABALYOK.md); átadás-átvétel és folytatás: [ATVETEL.md](./ATVETEL.md).

Jelenleg (5. fázis után) a PHP Wallos webes felülete ugyanazokon a címeken (`index.php`, `subscriptions.php`, `stats.php`, `settings.php` …), és mögötte egy JSON API: fiókok, profil és beállítások, előfizetések, kategóriák, háztartás, fizetési módok, devizák, statisztika és költségvetés, admin, export, értesítések 11 csatornán, e-mail (Resend), árfolyam-frissítés, logók/ikonok/avatarok R2-ben és logókereső, valamint a PHP Wallos `api/**/*.php` végpontjai kompatibilis formában. Egy meglévő PHP Wallos adatbázis importálható.

## Fejlesztés

```sh
npm install
npm run db:migrate:local   # helyi D1 (.wrangler/)
npm run dev                # http://localhost:8787 (előtte a build:assets a public/-ba másolja a CSS/JS/képeket)
npm test                   # Vitest a Workers runtime-ban, helyi D1-gyel
npm run typecheck
```

## Telepítés

```sh
npx wrangler login
npx wrangler d1 create wallos   # database_id → wrangler.jsonc
npx wrangler r2 bucket create wallos-files
npm run db:migrate:remote
npx wrangler secret put RESEND_API_KEY   # e-mail: a Resend API-kulcsa
npm run deploy
```

**E-mail (Resend).** A `wrangler.jsonc`-ben az `EMAIL_FROM` a feladó (pl. `Wallos <wallos@sajatdomain.hu>`); a domaint a Resendben hitelesíteni kell. Az `APP_URL` (vagy az admin `server_url` beállítása) adja az e-mailben küldött linkek alapját. Kulcs nélkül minden más működik, csak e-mail nem megy ki, és e-mail-megerősítés nem kapcsolható be.

**Képek.** A feltöltött logók, ikonok és avatarok a `wallos-files` R2 bucketbe kerülnek, és a PHP-val azonos címen érhetők el (`/images/uploads/logos/...`). Ha a fiókban be van kapcsolva a Cloudflare Images, a `wrangler.jsonc`-ben az `images` binding bekapcsolásával a feltöltések PNG-re alakulnak és átméreteződnek (logó 270×84, ikon 140×96, avatar 160×160); nélküle az eredeti fájl kerül tárolásra (max. 5 MB, PNG/JPEG/GIF/WebP/AVIF; SVG nem). A háttéreltávolítás és a sötét/világos témához készülő logóvariáns PNG-képeken mindkét esetben működik.

**Cron.** Óránként fut egy trigger: az emlékeztetők a felhasználó saját időzónája szerint 09:00-kor (fizetés) és 08:00-kor (lemondás) mennek ki, a napi feladatok UTC 01:00 (következő fizetési dátumok), 02:00 (árfolyamok) és 03:00 (takarítás) órakor futnak. Az ingyenes Workers csomag egy cron-futásban 50 kimenő hívást enged; sok felhasználónál vagy csatornánál a fizetős csomag kell.

**Webes felület.** A `npm run build:assets` (a `dev`, `test` és `deploy` előtt automatikusan fut) a repó gyökeréből a `styles/`, `scripts/`, `images/` és `libs/` könyvtárat a `public/`-ba másolja; ezeket a Workers Static Assets szolgálja ki, az oldalakat a Worker rendereli. A böngésző HttpOnly `wallos_session` cookie-val és CSRF-tokennel dolgozik. Nem elérhető még: TOTP, OIDC, AI-javaslatok (a gombok jelzik); a mentés JSON-export zip-ben, a visszaállítás az importálóval megy.

Az első regisztrált felhasználó lesz az admin (a felületen a `registration.php` űrlapon, vagy `POST /api/auth/register`). Utána a regisztráció zárva marad, amíg az admin meg nem nyitja (`PATCH /api/admin/settings` → `registrations_open`), vagy az admin maga vesz fel felhasználót (`POST /api/admin/users`).

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
- Az értesítési beállítások (mind a 11 csatorna), a push-feliratkozások a VAPID-kulcsokkal, az árfolyam-szolgáltató és -kulcs is átjön. A felhasználónkénti SMTP helyett az e-mail a példány Resend-feladóján megy; a „TLS-hiba figyelmen kívül hagyása” opció megszűnik (a Worker mindig ellenőrzi a tanúsítványt).
- A képfájlok (logók, feltöltött ikonok, avatarok) ugyanazon az útvonalon kerülnek R2-be, így az adatbázisban tárolt nevek változatlanul működnek:
  ```sh
  node scripts/upload-files.ts /path/to/wallos      # a PHP telepítés könyvtára; --dry-run: csak listáz
  ```
- Még nem jön át (jelentésben látszik, melyik fázisban jön): TOTP, OIDC, AI-beállítások, éves költségtörténet.

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
| POST | `/api/auth/password-reset` | `email` → visszaállító link e-mailben (1 óráig érvényes; ismeretlen címre is ugyanaz a válasz) |
| POST | `/api/auth/password-reset/confirm` | `email`, `token`, `password`; minden session kijelentkezik |
| POST | `/api/auth/verify-email` | `email`, `token` (ha az admin megköveteli az e-mail-megerősítést) |
| POST | `/api/auth/verification-email` | `email` → új megerősítő link |
| GET | `/verify-email`, `/reset-password` | Az e-mailes linkek céloldalai (egyszerű HTML) |
| GET | `/api/me` | Profil és beállítások |
| PATCH | `/api/me` | Profil: `firstname`, `lastname`, `email`, `language`, `main_currency`, `avatar`, `timezone` (IANA, pl. `Europe/Budapest`) |
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
| GET | `/api/notifications` | Értesítési beállítások és csatornák (a titkos mezők `********`-ként) |
| PATCH | `/api/notifications/settings` | `days` (hány nappal előtte), `period_summary_at_period_start` |
| PUT / DELETE | `/api/notifications/channels/:channel` | `enabled` + a csatorna mezői; `********` megtartja a tárolt titkot. Csatornák: `email` (`other_emails`), `discord` (`webhook_url`, `bot_username`, `bot_avatar_url`), `gotify` (`url`, `token`), `telegram` (`bot_token`, `chat_id`), `pushover` (`user_key`, `token`), `ntfy` (`host`, `topic`, `headers`), `webhook` (`url`, `request_method`, `headers`, `payload`, `cancelation_payload`), `mattermost` (`webhook_url`, `bot_username`, `bot_icon_emoji`), `pushplus` (`token`), `serverchan` (`sendkey`), `push` |
| POST | `/api/notifications/channels/:channel/test` | Tesztüzenet a tárolt vagy a törzsben megadott beállításokkal |
| GET | `/api/notifications/preview?kind=payment\|cancellation&date=` | Mit küldene a cron az adott napon (küldés nélkül) |
| GET | `/api/notifications/push/public-key` | VAPID publikus kulcs a böngészős feliratkozáshoz |
| POST / DELETE | `/api/notifications/push/subscriptions` | Böngésző push-feliratkozása (`endpoint`, `keys.p256dh`, `keys.auth`) |
| POST / DELETE | `/api/subscriptions/:id/logo` | Logó feltöltése (multipart `logo` fájl) vagy letöltése URL-ről (`url`); törlése. Létrehozáskor/módosításkor is küldhető `logo` fájl vagy `logo_url`. A válaszban `logo_path` és `logo_variant_path` mutatja a címet |
| POST | `/api/payment-methods/:id/icon` | Fizetési mód ikonja (multipart `icon` vagy `url`) |
| POST / DELETE | `/api/me/avatar` | Avatar feltöltése (multipart `avatar` vagy `url`) / visszaállítása az alapértelmezettre |
| GET | `/api/logos/search?q=&source=` | Logókeresés: `all` (DuckDuckGo → Brave → ikonkatalógusok), `duckduckgo`, `brave`, `google` (SerpAPI-kulccsal), `icons` (selfh.st, Dashboard Icons) |
| GET / PUT | `/api/logos/google-key` | SerpAPI-kulcs a Google-kereséshez (`""` törli) |
| GET | `/images/uploads/logos/:name`, `/images/uploads/logos/avatars/:name` | A tárolt képek (nyilvános, a PHP-val azonos címen) |
| GET / PUT | `/api/exchange-rates` | Árfolyam-szolgáltató: `provider` 0 Fixer.io, 1 APILayer, 2 Frankfurter (kulcs nélkül, új fiókok alapértéke), `"manual"`; `api_key` |
| POST | `/api/exchange-rates/refresh` | Árfolyamok frissítése most |
| GET / PATCH | `/api/admin/settings` | Csak admin: `registrations_open`, `max_users`, `require_email_verification`, `server_url`, `update_notification` |
| GET / POST | `/api/admin/users` | Csak admin: felhasználók listája / új felhasználó (zárt regisztráció mellett is) |
| DELETE | `/api/admin/users/:id` | Csak admin: felhasználó és minden adatának (képeinek is) törlése (az admin nem törölhető) |
| POST | `/api/admin/files/cleanup` | Csak admin: a sehol nem használt logófájlok törlése |

### PHP Wallos kompatibilitás

Ezek a régi útvonalak ugyanazt a választ adják, mint a PHP API: `/api/subscriptions/get_subscriptions.php`, `get_subscription.php`, `set_subscriptions.php` (`action=add|edit|delete`), `get_monthly_cost.php`, `/api/categories/get_categories.php`, `/api/currencies/get_currencies.php`, `/api/payment_methods/get_payment_methods.php`, `/api/household/get_household.php`, `/api/subscriptions/get_period_budget.php`, `/api/users/get_user.php`, `/api/users/set_budget.php`, `/api/settings/get_settings.php`, `/api/settings/set_settings.php`, `/api/admin/get_admin_settings.php`, `/api/admin/set_admin_settings.php`, `/api/notifications/get_notification_settings.php`, `/api/fixer/get_fixer.php`, `/api/fixer/set_fixer.php`, `/api/status/version.php`, `/api/subscriptions/get_ical_feed.php` (iCal).

## Felépítés

```
migrations/          D1 migrációk (wrangler d1 migrations)
src/index.ts         Hono app, útvonalak, cron belépési pont
src/lib/             dátumaritmetika, árak, jelszó-hash, hitelesítés, validáció
src/services/        előfizetés-, fiók- és statisztikalogika
src/routes/          HTTP útvonalak (REST + PHP-kompatibilis)
src/cron/            óránkénti cron-elosztó és napi feladatok
src/notifications/   csatornák és emlékeztetők
src/ui/              webes felület: oldalak (Hono JSX), endpoints/*.php a PHP JS-éhez, i18n, PWA
public/              statikus fájlok (generált, build:assets)
src/import/          PHP Wallos adatbázis → D1 SQL átalakítás
scripts/             importáló, fájlmásoló, asset-build és i18n-konverter, fixture-generátorok
test/                Vitest (Workers runtime, helyi D1); fixtures/php-wallos.json valódi PHP-ból
```
