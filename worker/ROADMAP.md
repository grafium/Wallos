# Wallos → Cloudflare Workers + D1: felmérés és ütemterv

Állapot: 2026-10-13, 2. fázis kész · Alap: Wallos v5.8.3 (`grafium/Wallos`, `main`)

## 1. A kódbázis felmérése

### Technológia

| Terület | Jelenlegi megoldás |
|---|---|
| Futtatás | PHP 8 + nginx, Docker image, 11 cron job (`cronjobs` fájl) |
| Adatbázis | Egyetlen SQLite fájl (`db/wallos.db`), 33 tábla, 59 PHP migráció (`migrations/`) |
| Felület | Szerveroldalon renderelt PHP oldalak + natív JS (`scripts/`, kb. 5 500 sor), saját CSS, témák, PWA service worker |
| Méret | ~52 000 sor saját PHP (a `libs/` nélkül), 31 nyelv (`includes/i18n`, kb. 500 kulcs/nyelv) |
| API | 27 `api/**/*.php` végpont, `api_key` paraméteres hitelesítés |
| Tesztek | Saját PHP tesztfuttató, 23 teszteset (`tests/`) |

### Funkcionális modulok

| Modul | Fő fájlok | Cloudflare-megfelelő | Nehézség |
|---|---|---|---|
| Előfizetések CRUD, klón, megújítás | `endpoints/subscription/*`, `api/subscriptions/*` | Worker + D1 | **kész (1. fázis)** |
| Kategóriák, tagok, fizetési módok, devizák | `endpoints/{categories,household,payments,currency}`, `api/*` | Worker + D1 | **kész (1. fázis)** |
| Következő fizetési dátum léptetése (cron) | `endpoints/cronjobs/updatenextpayment.php` | Cron Trigger | **kész (1. fázis)** |
| Havi költség, összesítők, költségvetési időszakok | `api/subscriptions/get_monthly_cost.php`, `get_period_budget.php`, `includes/budget_period_calculations.php` | Worker | **kész (1–2. fázis)**; a statisztika-oldal grafikonjai a 7. fázisban |
| Regisztráció, belépés, API-kulcs | `registration.php`, `login.php`, `includes/checksession.php` | D1 sessions tábla, PBKDF2 | **kész (1. fázis)** |
| Jelszó-visszaállítás, e-mail-megerősítés | `passwordreset.php`, `verifyemail.php`, cron | E-mail küldés HTTP API-n | közepes |
| TOTP 2FA, OIDC/OAuth SSO | `totp.php`, `includes/oidc/*`, `libs/OTPHP` | WebCrypto, `fetch` | közepes |
| Árfolyam-frissítés (Fixer, apilayer, Frankfurter) | `endpoints/cronjobs/updateexchange.php`, `includes/frankfurter.php` | Cron Trigger + `fetch` | könnyű |
| Értesítések (11 csatorna) | `endpoints/notifications/*`, `endpoints/cronjobs/sendnotifications.php` | Cron + `fetch`; Web Push VAPID WebCrypto-val | közepes |
| E-mail (SMTP, PHPMailer) | `libs/PHPMailer` | **Nincs SMTP** → Cloudflare Email Service / Resend / Postmark HTTP API | közepes |
| Logók és avatarok (feltöltés, URL, webes keresés) | `endpoints/logos/*`, `includes/gd_background_removal.php` | R2 tároló; háttéreltávolítás → Cloudflare Images vagy elhagyás | közepes |
| Statisztika-oldal, éves költségtörténet | `stats.php`, `storetotalyearlycost.php` | Worker + D1 + Cron | könnyű |
| Naptár és iCal feed | `calendar.php`, `includes/ical_helper.php` | Worker | könnyű |
| AI-javaslatok (OpenAI, Gemini, Ollama…) | `endpoints/ai/*`, `includes/ai_client.php` | `fetch` vagy Workers AI | könnyű |
| Admin (felhasználók, regisztráció, SMTP, OIDC, mentés/visszaállítás) | `admin.php`, `endpoints/admin/*`, `endpoints/db/*` | Worker + D1 export | **felhasználók, regisztráció, export kész (2. fázis)**; SMTP a 3., OIDC a 6. fázisban |
| Profil, beállítások, jelszócsere | `profile.php`, `settings.php`, `endpoints/user/*`, `api/settings/*`, `api/users/*` | Worker + D1 | **kész (2. fázis)** |
| Adatmigráció PHP → D1 | — | Node CLI + `wrangler d1 execute` | **kész (2. fázis)** |
| Webes felület (8 fő oldal), témák, egyedi CSS, PWA | `*.php`, `scripts/`, `styles/` | Workers Static Assets + Hono JSX SSR | **nagy** |
| Többnyelvűség | `includes/i18n/*.php`, `scripts/i18n/*.js` | PHP tömbök → JSON (szkripttel) | könnyű |

### Kockázatok, döntések

1. **Jelszó-hashek.** A PHP `password_hash()` bcryptet használ. A Worker az új jelszavakat PBKDF2-SHA256-tal hash-eli (natív WebCrypto, 100 000 iteráció), a régi bcrypt hasheket elfogadja, és sikeres belépéskor lecseréli. A bcrypt JS-ben fut, néhányszor 10 ms CPU — az ingyenes Workers csomag 10 ms-os CPU-limitjébe nem mindig fér bele, ezért **Workers Paid csomag ajánlott** (havi 5 USD), legalább a migrációs időszakra.
2. **HTML-escapelt adatok.** A PHP a neveket `htmlspecialchars`-szal menti (`includes/inputvalidation.php`), tehát a régi adatbázisban `&amp;` szerepel `&` helyett. Az új Worker nyers szöveget tárol és megjelenítéskor escapel; az importálónak dekódolnia kell.
3. **Hónap-túlcsordulás.** A PHP `DateInterval` jan. 31. + 1 hónapot márc. 2-re/3-ra teszi, és utána el is csúszik. A Worker a hónap utolsó napjára vágja (jan. 31. → feb. 29. → márc. 31.). Ez szándékos javítás, a tesztek rögzítik.
4. **Egyszeri fizetések.** A PHP havi költség-számítása az egyszeri (cycle 5) tételt havi ismétlődőként számolja, a költségvetés-számítás pedig soha nem számolja. A Worker mindkét helyen pontosan egyszer, a saját hónapjában/időszakában számolja.
5. **Devizaváltás frissítés előtt.** A PHP addig nem vált át devizát, amíg nem futott le árfolyam-frissítés; a Worker mindig a tárolt árfolyammal számol (alapból 1). Az importált adatbázison ez a két pont az egyetlen eltérés a PHP havi költségéhez képest (a tesztek rögzítik).
6. **Ma esedékes fizetés.** A PHP cron a ma esedékes fizetést időnként (az aktuális óra miatt) a következő ciklusra léptette. A Worker a ma esedékest ma hagyja.
7. **Időzóna.** A PHP a konténer `TZ` változóját használja; a Worker UTC-ben számol. Felhasználónkénti időzóna a 3. fázisban (értesítések időzítése miatt).
8. **D1-korlátok.** Max. 100 kötött paraméter/lekérdezés, 10 GB/adatbázis, a batch tranzakcionális. Az alapértelmezett adatokat ezért `json_each()`-csel, egy paraméterrel szúrjuk be. Wallos-méretű adatnál ezek nem szűk keresztmetszetek.
9. **Helyi hálózati elérés.** A felhőben futó Worker nem éri el a helyi Ollama-t, Gotify-t vagy ntfy-t. Ezekhez Cloudflare Tunnel kell, a „local webhook allowlist” funkció pedig értelmét veszti.
10. **SMTP.** A Workers nem tud kényelmesen SMTP-t; e-mailt HTTP-s szolgáltatón keresztül küldünk. A felhasználónkénti SMTP-beállítás helyett instance-szintű küldőt javaslunk.
11. **API-kulcsok** a régi adatbázisban titkosítatlanok. A kompatibilitás miatt egyelőre így maradnak (egyenlőségvizsgálat), később hash-elhetők, ha a régi klienseket már nem kell támogatni.

## 2. Ebben a körben elkészült (1. fázis)

`worker/` — Hono alapú TypeScript Worker, D1 adatbázissal:

- **D1 séma** (`migrations/0001_core_schema.sql`, `0002_reference_data.sql`): a PHP-séma tábla- és oszlopnevei megmaradtak (importálhatóság), szigorítva: `NOT NULL user_id` kaszkádolt törléssel, egyedi felhasználónév és API-kulcs, `REAL` árfolyam, új `sessions` tábla hash-elt tokenekkel.
- **Hitelesítés:** regisztráció (az első felhasználó admin, utána az admin dönt; `max_users`), belépés session tokennel, kilépés, API-kulcs lekérése és cseréje (csak sessionből), bcrypt → PBKDF2 automatikus átállás.
- **Előfizetések:** lista a PHP-val azonos szűrőkkel/rendezéssel/devizaváltással, lekérés, létrehozás okos alapértékekkel, részleges módosítás, törlés, klónozás, kézi megújítás. Minden hivatkozás (kategória, deviza, tag, fizetési mód, helyettesítő előfizetés) tulajdonjogát ellenőrzi.
- **Törzsadatok:** kategóriák, háztartás, fizetési módok, devizák CRUD; használatban lévő sor, fődeviza és a fióktulajdonos nem törölhető.
- **Statisztika:** adott naptári hónap tényleges költsége, havi/éves átlag kategóriánként.
- **PHP API-kompatibilitás:** `get_subscriptions.php`, `get_subscription.php`, `set_subscriptions.php`, `get_monthly_cost.php`, `get_categories.php`, `get_currencies.php`, `get_payment_methods.php`, `get_household.php`, `version.php` — a meglévő integrációknak csak az alap URL-t kell átírni.
- **Cron:** naponta 01:00 UTC a lejárt automatikus megújítású előfizetések léptetése és a lejárt sessionök törlése.
- **Tesztek:** 41 Vitest-teszt a valódi Workers runtime-ban (dátumaritmetika, árak, teljes API helyi D1-gyel, cron, régi bcrypt hash).

## 2b. Elkészült a 2. fázisban

- **Importáló** (`npm run import -- wallos.db`): a PHP adatbázisból SQL-fájlt készít a D1-hez, és részletes jelentést ad (átvett/kihagyott sorok, későbbi fázisra váró táblák, hivatkozott fájlok, figyelmeztetések). Dekódolja a HTML-entitásokat, javítja a típusokat és a hibás adatokat, megőrzi az azonosítókat, a jelszavakat és az API-kulcsokat. Valódi PHP-val generált adatbázison tesztelve (`scripts/fixtures/create-php-wallos-db.php`), és a havi költséget összevetettem az eredeti PHP API-val.
- **Profil és beállítások:** profil módosítása (fődeviza csak saját devizából), megjelenési beállítások egyedi színekkel és CSS-sel, költségvetés és költségvetési időszakok (heti, kétheti, havi), jelszócsere (a többi session kijelentkeztetésével).
- **Admin API:** példánybeállítások, felhasználók listája, felvétele (zárt regisztráció mellett is) és törlése (kaszkáddal minden adatával).
- **Export:** a felhasználó összes adata egy JSON-fájlban.
- **További PHP-kompatibilis végpontok:** `get_period_budget.php`, `get_user.php`, `set_budget.php`, `get_settings.php`, `set_settings.php`, `get_admin_settings.php`, `set_admin_settings.php`.
- **Tesztek:** 64 teszt (az 1. fázis 41 tesztje mellett az importáló, a fiók-, költségvetés- és admin-funkciók).

## 3. Ütemterv

Becslés egy fejlesztőre, teljes munkaidőben. A fázisok sorrendje függőségi sorrend; a 3. és 4. párhuzamosítható.

| # | Fázis | Tartalom | Becslés | Kész, ha |
|---|---|---|---|---|
| 0 | Felmérés | Kódbázis, séma, cron, API feltérképezése | — | ✅ ez a dokumentum |
| 1 | **Alap: Worker + D1** | Lásd 2. szakasz | — | ✅ |
| 2 | **Adatmigráció és fiókkezelés** ✅ | `wallos.db` → D1 importáló szkript (HTML-dekódolás, típusjavítás, duplikátumok); profil és beállítások API (téma, nyelv, költségvetés és költségvetési időszakok, `budget_period_*`); jelszócsere; admin API (felhasználók listája, törlése, regisztráció nyitása, `max_users`); JSON export/mentés | — | ✅ (lásd 2b) |
| 3 | Árfolyamok, értesítések, e-mail | Árfolyam-cron (Frankfurter alapból, Fixer/apilayer kulccsal); értesítési táblák migrációja; HTTP-csatornák: Discord, Telegram, Gotify, Pushover, ntfy, webhook, Mattermost, PushPlus, ServerChan; e-mail HTTP-szolgáltatón; Web Push (VAPID); lemondási értesítések; e-mail-megerősítés és jelszó-visszaállítás; felhasználónkénti időzóna; „teszt” végpontok | 1,5–2 hét | Minden csatornára megy tesztüzenet, a napi cron a beállított napokkal előre értesít |
| 4 | Fájlok és logók | R2 a logóknak és avatároknak; feltöltés méret- és típusellenőrzéssel; logó letöltése URL-ről SSRF-védelemmel; logókereső; törléskor a fájl takarítása; Cloudflare Images átméretezés (háttéreltávolítás opcionális) | 1 hét | Logó feltölthető, URL-ről behúzható, és törléskor eltűnik az R2-ből |
| 5 | Webes felület | Workers Static Assets a meglévő CSS/JS/képekhez; az oldalak portolása Hono JSX SSR-re (főoldal/előfizetések, statisztika, naptár, beállítások, profil, admin, belépés/regisztráció); i18n konverzió PHP → JSON; témák, egyedi CSS és színek; PWA manifest + service worker | 2–3 hét | A régi felület minden képernyője működik a Workeren |
| 6 | Haladó hitelesítés | TOTP 2FA (mentőkódokkal, kizárással); OIDC/OAuth SSO, csak-SSO mód; „emlékezz rám”; belépési rate limit (Workers Rate Limiting); CSRF a böngészős űrlapokhoz | 1 hét | A PHP biztonsági javításai (GHSA-k) mind teljesülnek |
| 7 | Statisztika+, naptár, AI | Éves költségtörténet (heti cron); iCal feed tokennel; naptárnézet; AI-javaslatok (OpenAI/Gemini, opcionálisan Workers AI) heti/havi cronnal | 1 hét | Statisztika-oldal és iCal paritás a PHP-val |
| 8 | Élesítés | Egyedi domain, Cloudflare Access/WAF az admin felülethez; D1 Time Travel + időszakos export R2-be; GitHub Actions (teszt + deploy); monitorozás; átállás a PHP példányról (import, DNS) | 0,5–1 hét | Éles forgalom a Workeren, a PHP példány leállítható |

**Hátralévő: kb. 7–9 hét** a teljes funkcióparitásig. Az API már most élesben használható meglévő kliensekkel (pl. Home Assistant integráció, mobilappok), és a meglévő adatok átköltöztethetők.

### Cron-megfeleltetés

| PHP cron | Ütemezés | Worker |
|---|---|---|
| `updatenextpayment.php` | naponta 01:00 | ✅ `0 1 * * *` |
| `updateexchange.php` | naponta 02:00 | 3. fázis |
| `sendcancellationnotifications.php` | naponta 08:00 | 3. fázis |
| `sendnotifications.php` | naponta 09:00 | 3. fázis |
| `sendverificationemails.php`, `sendresetpasswordemails.php` | 2 percenként | 3. fázis — kérésre azonnal (Queues), nem kell lekérdezni |
| `checkforupdates.php` | 6 óránként | elhagyható (a Worker verzióját a deploy adja) |
| `storetotalyearlycost.php` | hétfőnként 01:30 | 7. fázis |
| `cleanupresettokens.php` | naponta 03:00 | 3. fázis (a sessionök takarítása már kész) |
| `generaterecommendations.php` | heti/havi | 7. fázis |

## 4. Teendők a Cloudflare-fiókban (egyszeri)

Ezekhez Cloudflare-hozzáférés kell, ebből a környezetből nem futtattam őket:

```sh
cd worker
npm install
npx wrangler login
npx wrangler d1 create wallos          # a kapott database_id-t írd be a wrangler.jsonc-be
npm run db:migrate:remote
npm run deploy
```

Ezután vagy az első regisztrált felhasználó (`POST /api/auth/register`) lesz az admin, vagy importáld a meglévő PHP adatbázist (README, „Átköltözés PHP Wallosról”).
