# Munkanapló — Wallos → Cloudflare Workers + D1

Időrendben: mit kért a megrendelő, mi készült el, milyen döntések születtek, és milyen hibákba futottunk bele. Ág: `claude/zen-goldberg-0hbajd` (PR-t nem nyitottunk). A részletes tartalmat lásd: [ROADMAP.md](./ROADMAP.md) (2.–2f. szakasz) és [README.md](./README.md).

| Fázis | Commit | Tesztek | CI |
|---|---|---|---|
| 1. Alap: Worker + D1 | `34cff14` | 41 | ✅ |
| 2. Importáló, fiók- és admin API | `908bb6b` | 64 | ✅ |
| 3. Értesítések, Resend e-mail, árfolyamok | `bb4b560` | 85 | ✅ |
| 4. Logók, ikonok, avatarok R2-ben, logókereső | `04bc7ea` | 103 | ✅ |
| 5. Webes felület (WIP-commitok: `dc7ca44`, `c482d21`, `fd1f024`, `03d2869`, `1b3846f`, `5bb1061`) | `a3c4ec3` | 198 | ✅ |
| Napló, szabályok, átvétel, füstteszt | `ccef85b` | 198 | ✅ |
| 6. 2FA (TOTP), OIDC SSO, belépés-korlátozás | `610c2d6` | 221 | ✅ |
| Napló: 6. fázis commitja és CI-eredménye | `2c81926` | 221 | ✅ |

Minden munka 2026-10-13-án készült.

---

## 0. Felmérés és ütemterv

**Kérés:** „A grafium/Wallos repó alapján építsd fel az itt kódolt előfizetési rendszert. Első körben hozz létre egy Cloudflare Workert és adatbázist, ha szükséges. Mérd fel a kódot és készíts ütemtervet.”

- A PHP Wallos (5.8.3) felmérése: SQLite séma, `api/**/*.php`, `endpoints/**/*.php`, cron-feladatok, i18n, JS/CSS. Eredménye a `ROADMAP.md` 1. szakasza (modultábla, nehézség, 14 kockázat/döntés), valamint egy 8 fázisos ütemterv.
- **Döntés:** Hono + TypeScript Worker, D1 a PHP-val azonos tábla- és oszlopnevekkel (így importálható), és a régi API-útvonalak megtartása.

## 1. fázis — alap Worker + D1 (`34cff14`)

- A `worker/` könyvtár: Hono app, D1 migrációk (`0001_core_schema`, `0002_reference_data`), sessionök hash-elt tokenekkel, regisztráció, belépés, API-kulcs, előfizetések CRUD a PHP szűrőivel és rendezésével, törzsadatok, statisztika, PHP-kompatibilis `api/*.php` végpontok, napi cron.
- Jelszavak: az újakat PBKDF2 hash-eli, a régi bcrypt (`$2y$`) hash-t elfogadja, és belépéskor lecseréli.
- Szándékos javítások a PHP-hoz képest: hónap-túlcsordulás vágása, egyszeri fizetések pontos számolása, a ma esedékes fizetés ma marad (ROADMAP 3–6. kockázat).
- CI: `.github/workflows/worker.yaml` (typecheck + teszt).
- **Hibák:** az npm arborist „edgesOut” hibája miatt kellett a `.npmrc legacy-peer-deps=true`. A `vitest-pool-workers` elavult, helyette a `@cloudflare/vitest-plugin` lett. A `/subscriptions/:id` útvonal ütközött a `.php` útvonalakkal, ezért a legacy útvonalak kerülnek előre.

## 2. fázis — importáló, fiókkezelés, admin (`908bb6b`)

**Kérés:** „Mehet a 2. fázis az importálóval.”

- `npm run import -- wallos.db` → SQL a D1-nek, részletes jelentéssel. Dekódolja a HTML-entitásokat, javítja a típusokat és az árva sorokat, megőrzi az azonosítókat, jelszavakat és API-kulcsokat.
- A fixture-t valódi PHP generálja (`scripts/fixtures/create-php-wallos-db.php`), és a havi költséget összevetettük a PHP API-val.
- Profil, megjelenés (egyedi színek és CSS, `0003` migráció), költségvetés és költségvetési időszakok, jelszócsere, admin API, JSON export.

## 3. fázis — értesítések, e-mail, árfolyamok (`bb4b560`)

**Kérés:** „3. fázis mehet Resend-del.”

- E-mail a Resend API-n (`RESEND_API_KEY` titok, `EMAIL_FROM`), jelszó-visszaállítás és e-mail-megerősítés azonnali küldéssel.
- 11 csatorna egy `notification_channels` táblában. Emlékeztetők óránkénti cronnal, a felhasználó időzónája szerint (09:00 fizetés, 08:00 lemondás); a `notification_log` véd a dupla küldés ellen.
- Web Push könyvtár nélkül (VAPID + RFC 8291, WebCrypto). Árfolyamok: Frankfurter, Fixer, APILayer. Migráció: `0004`.
- **Hibák:** az ECDH `public` mező típusa miatt `SubtleCryptoDeriveKeyAlgorithm` cast kellett. A PHP webhook-sablonja idézőjelnél érvénytelen JSON-t adott, ezért minden behelyettesített érték JSON-escapelve van.

## 4. fázis — fájlok és logók (`04bc7ea`)

**Kérés:** „4. fázis mehet.”

- R2 bucket (`FILES`, `wallos-files`), a kulcsok a PHP fájlútvonalai. Feltöltés fájlként vagy URL-ről; a típust a magic bytes dönti el, max. 5 MB, minden átirányítást ellenőriz.
- A képfeldolgozás GD nélkül megy: átméretezés az opcionális Images bindinggel, a háttéreltávolítás, a levágás és a témavariáns TypeScriptben (fast-png).
- Takarítás klónok figyelembevételével, logókereső (DDG, Brave, SerpAPI, selfh.st, Dashboard Icons), `scripts/upload-files.ts`. Migráció: `0005`.

## 5. fázis — webes felület (`a3c4ec3`)

**Kérés:** „Van 5 dolláros extra worker csomagom. 5. fázis mehet.” → Workers Paid csomag, így a CPU- és subrequest-korlátok gyakorlatilag nem számítanak. Utána: „mehet tovább.”

- Alapok (saját munka): Workers Static Assets (`scripts/build-assets.ts` → `public/`), i18n PHP → JSON (`scripts/convert-i18n.php`, 29 nyelv), cookie-s session + CSRF (`src/ui/session.ts`, `src/lib/auth.ts`), layout, főoldal, belépés, regisztráció, kilépés, jelszó-visszaállítás, e-mail-megerősítés.
- Az oldalakat párhuzamos agentek portolták (subscriptions, calendar, settings + értesítések + fizetési módok, stats, profile, admin, és a hozzájuk tartozó `endpoints/*.php` modulok, PWA). Közben WIP-commitok készültek `[skip ci]` jelöléssel, mert a stop hook nem engedett commitolatlan állapotot.
- Integráció: közös `deleteUserAccount()` (`src/services/files.ts`) a REST API-nak, az admin oldalnak és a profil oldalnak; iCal feed a legacy API-ban (`/api/subscriptions/get_ical_feed.php`).
- Ellenőrzés: 198 teszt, typecheck, CI zöld, és böngészős füstteszt (`scripts/smoke-test.mjs`) `wrangler dev` ellen: minden oldal betölt, előfizetés felvétele, részletek, kategória, grafikonok — JS-hiba nélkül.
- **Hibák:** a `layout.tsx`-ben szó szerint szereplő U+2028 karakter eltörte a parse-t, ezért most `String.fromCharCode` állítja elő. A `page()` típushibája miatt Hono `Context`-et fogad. A statikus fájlok tesztje `worker.fetch`-csel 404-et adott, helyette `env.ASSETS.fetch` kell. A füstteszt az első, rejtett „hozzáadás” gombra kattintott, ezért most `:visible` szelektort használ. Headless Chromiumban a `navigator.language` értéke `en-US@posix` volt, ami `Intl`-hibát okozott a változatlan `stats.js`-ben; a tesztkörnyezet hibája volt, a füstteszt ezért explicit locale-t állít be.
- Verzió: 0.5.0. A dokumentáció frissítve (ROADMAP 2e, 15. kockázat, hátralévő idő kb. 2–3 hét).

## Mentés (az 5. fázis után)

**Kérés:** „Ments mindent: NAPLO, SZABALYOK, ATVETEL.”

- Elkészült ez a napló, a [SZABALYOK.md](./SZABALYOK.md) (munka- és kódszabályok) és az [ATVETEL.md](./ATVETEL.md) (átadás-átvétel, folytatás). A füstteszt a scratchpadből bekerült a repóba (`scripts/smoke-test.mjs`).

## 6. fázis — haladó hitelesítés

**Kérés:** „6. fázis mehet.”

- Felmérés: a PHP `totp.php`, `endpoints/user/enable_totp.php` / `disable_totp.php`, `login.php`, `includes/oidc_settings.php`, `includes/oidc/*`, `checksession.php`, `logout.php`, az admin OIDC-végpontok és API-k (`get/set_oidc_settings.php`, `set_disable_password_login.php`), valamint a 000027/38/39/47/54 migrációk.
- `migrations/0006_auth.sql`: `totp`, `oauth_settings` (egy sor), `admin.oidc_oauth_enabled`, egyedi `user.oidc_sub`, `sessions.via_oidc`, `auth_flows` (várakozó 2FA-lépés és OIDC-state), `login_attempts`.
- `src/lib/totp.ts` (RFC 6238 WebCrypto-val), `src/services/two-factor.ts` (bekapcsolás/kikapcsolás tranzakcióban, zárolás, újrajátszás elleni védelem, hash-elt mentőkódok), `src/services/login-guard.ts` (belépés-korlátozás, belépési lépések), `src/services/oidc.ts` (beállítások `OIDC_*` felülírással és discoveryvel, PKCE-s authorization code flow, fiók-összekötés és -létrehozás, kijelentkezés a szolgáltatónál).
- Felület: `login.php` (SSO gomb, SSO-only, korlátozás), új `totp.php` és `oidclogin.php`, OIDC-visszatérés bármely oldalra (`src/ui/app.ts`), `logout.php` a szolgáltatónál is kiléptet, admin oldal valós OIDC-adatokkal, a profil 2FA-végpontjai élesek.
- API: `totp_code` a belépésnél, `/api/me/two-factor/*`, `/api/admin/oidc`, PHP-kompatibilis OIDC admin végpontok, `oidc_oauth_enabled` az admin beállításokban.
- Importáló: TOTP (hash-elt mentőkódok, a régi kódok működnek), OIDC-beállítások és -azonosítók; ehhez szinkron SHA-256 (`src/lib/sha256-sync.ts`), a WebCrypto-val összevetve tesztelve.
- Ellenőrzés: 221 teszt, typecheck, `wrangler deploy --dry-run`, böngészős füstteszt (2FA bekapcsolás QR-kóddal, belépés `totp.php`-n, kikapcsolás mentőkóddal).
- **Hibák menet közben:** a teszt a `/`-t nézte bejelentkezés után, de üres fióknál az átirányít — a profil oldalra cseréltem. A fordítás szövege „Two Factor Authentication is already enabled”, nem a kulcs. A füstteszt a QR-kódot láthatóként várta, de a qrcode.js elrejti a canvas-t — `state: "attached"`.
- Verzió: 0.6.0.

## Mentés (a 6. fázis után)

**Kérés:** „Ments mindent: NAPLO, SZABALYOK, ATVETEL.”

- A három dokumentum már a 6. fázissal együtt frissült (`610c2d6`, a commit-azonosító és a CI-eredmény a `2c81926`-ban). Most ez a bejegyzés és két új munkaszabály került be a SZABALYOK-ba (CI-eredmény csak ellenőrzés után; mit jelent a „Ments mindent”).
- Állapot a mentéskor: 0.6.0, 221 zöld teszt, CI zöld, munkakönyvtár tiszta. Következő lépés a megrendelő döntése: 7. fázis vagy élesítés.
