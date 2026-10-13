# Wallos Worker

A Wallos előfizetés-követő Cloudflare Workers + D1 változata. A felmérést és az ütemtervet lásd: [ROADMAP.md](./ROADMAP.md).

Jelenleg (1. fázis) egy JSON API: fiókok, előfizetések, kategóriák, háztartás, fizetési módok, devizák, statisztika, valamint a PHP Wallos `api/**/*.php` végpontjai kompatibilis formában.

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

Az első regisztrált felhasználó lesz az admin. Utána a regisztráció zárva marad, amíg az admin meg nem nyitja (`admin.registrations_open`; az admin API a 2. fázisban jön).

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

### PHP Wallos kompatibilitás

Ezek a régi útvonalak ugyanazt a választ adják, mint a PHP API: `/api/subscriptions/get_subscriptions.php`, `get_subscription.php`, `set_subscriptions.php` (`action=add|edit|delete`), `get_monthly_cost.php`, `/api/categories/get_categories.php`, `/api/currencies/get_currencies.php`, `/api/payment_methods/get_payment_methods.php`, `/api/household/get_household.php`, `/api/status/version.php`.

## Felépítés

```
migrations/          D1 migrációk (wrangler d1 migrations)
src/index.ts         Hono app, útvonalak, cron belépési pont
src/lib/             dátumaritmetika, árak, jelszó-hash, hitelesítés, validáció
src/services/        előfizetés-, fiók- és statisztikalogika
src/routes/          HTTP útvonalak (REST + PHP-kompatibilis)
src/cron/            ütemezett feladatok
test/                Vitest (Workers runtime, helyi D1)
```
