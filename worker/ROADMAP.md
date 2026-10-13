# Wallos → Cloudflare Workers + D1: felmérés és ütemterv

Állapot: 2026-10-13, 4. fázis kész · Alap: Wallos v5.8.3 (`grafium/Wallos`, `main`)

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
| Jelszó-visszaállítás, e-mail-megerősítés | `passwordreset.php`, `verifyemail.php`, cron | Resend, azonnali küldés | **kész (3. fázis)** |
| TOTP 2FA, OIDC/OAuth SSO | `totp.php`, `includes/oidc/*`, `libs/OTPHP` | WebCrypto, `fetch` | közepes |
| Árfolyam-frissítés (Fixer, apilayer, Frankfurter) | `endpoints/cronjobs/updateexchange.php`, `includes/frankfurter.php` | Cron Trigger + `fetch` | **kész (3. fázis)** |
| Értesítések (11 csatorna) | `endpoints/notifications/*`, `endpoints/cronjobs/sendnotifications.php` | Cron + `fetch`; Web Push VAPID WebCrypto-val | **kész (3. fázis)** |
| E-mail (SMTP, PHPMailer) | `libs/PHPMailer` | Resend HTTP API | **kész (3. fázis)** |
| Logók és avatarok (feltöltés, URL, webes keresés) | `endpoints/logos/*`, `includes/gd_background_removal.php` | R2 tároló; átméretezés Cloudflare Images-szel; háttéreltávolítás és témavariáns tiszta JS-ben | **kész (4. fázis)** |
| Statisztika-oldal, éves költségtörténet | `stats.php`, `storetotalyearlycost.php` | Worker + D1 + Cron | könnyű |
| Naptár és iCal feed | `calendar.php`, `includes/ical_helper.php` | Worker | könnyű |
| AI-javaslatok (OpenAI, Gemini, Ollama…) | `endpoints/ai/*`, `includes/ai_client.php` | `fetch` vagy Workers AI | könnyű |
| Admin (felhasználók, regisztráció, SMTP, OIDC, mentés/visszaállítás) | `admin.php`, `endpoints/admin/*`, `endpoints/db/*` | Worker + D1 export | **felhasználók, regisztráció, export kész (2. fázis)**; SMTP a 3., OIDC a 6. fázisban |
| Profil, beállítások, jelszócsere | `profile.php`, `settings.php`, `endpoints/user/*`, `api/settings/*`, `api/users/*` | Worker + D1 | **kész (2. fázis)** |
| Adatmigráció PHP → D1 | — | Node CLI + `wrangler d1 execute` | **kész (2. fázis)** |
| Webes felület (8 fő oldal), témák, egyedi CSS, PWA | `*.php`, `scripts/`, `styles/` | Workers Static Assets + Hono JSX SSR | **nagy** |
| Többnyelvűség | `includes/i18n/*.php`, `scripts/i18n/*.js` | PHP tömbök → JSON (szkripttel) | könnyű |

### Kockázatok, döntések

1. **Jelszó-hashek.** A PHP `password_hash()` bcryptet használ. A Worker az új jelszavakat PBKDF2-SHA256-tal hash-eli (natív WebCrypto, 100 000 iteráció), a régi bcrypt hasheket elfogadja, és sikeres belépéskor lecseréli. A bcrypt JS-ben fut, néhányszor 10 ms CPU — az ingyenes Workers csomag 10 ms-os CPU-limitjébe nem mindig fér bele, ezért **Workers Paid csomag ajánlott** (havi 5 USD), legalább a migrációs időszakra. *(Megvan: a fizetős csomag 30 s CPU-t és 1000 kimenő hívást ad kérésenként/cron-futásonként, így a 1., 13. és 14. pont korlátai gyakorlatilag nem számítanak.)*
2. **HTML-escapelt adatok.** A PHP a neveket `htmlspecialchars`-szal menti (`includes/inputvalidation.php`), tehát a régi adatbázisban `&amp;` szerepel `&` helyett. Az új Worker nyers szöveget tárol és megjelenítéskor escapel; az importálónak dekódolnia kell.
3. **Hónap-túlcsordulás.** A PHP `DateInterval` jan. 31. + 1 hónapot márc. 2-re/3-ra teszi, és utána el is csúszik. A Worker a hónap utolsó napjára vágja (jan. 31. → feb. 29. → márc. 31.). Ez szándékos javítás, a tesztek rögzítik.
4. **Egyszeri fizetések.** A PHP havi költség-számítása az egyszeri (cycle 5) tételt havi ismétlődőként számolja, a költségvetés-számítás pedig soha nem számolja. A Worker mindkét helyen pontosan egyszer, a saját hónapjában/időszakában számolja.
5. **Devizaváltás frissítés előtt.** A PHP addig nem vált át devizát, amíg nem futott le árfolyam-frissítés; a Worker mindig a tárolt árfolyammal számol (alapból 1). Az importált adatbázison ez a két pont az egyetlen eltérés a PHP havi költségéhez képest (a tesztek rögzítik).
6. **Ma esedékes fizetés.** A PHP cron a ma esedékes fizetést időnként (az aktuális óra miatt) a következő ciklusra léptette. A Worker a ma esedékest ma hagyja.
7. **Időzóna.** A PHP a konténer `TZ` változóját használja. A Worker a dátumokat UTC-ben számolja, az emlékeztetőket viszont a felhasználó saját időzónája (`user.timezone`) szerint küldi 09:00-kor és 08:00-kor (3. fázis).
8. **D1-korlátok.** Max. 100 kötött paraméter/lekérdezés, 10 GB/adatbázis, a batch tranzakcionális. Az alapértelmezett adatokat ezért `json_each()`-csel, egy paraméterrel szúrjuk be. Wallos-méretű adatnál ezek nem szűk keresztmetszetek.
9. **Helyi hálózati elérés.** A felhőben futó Worker nem éri el a helyi Ollamát (AI-javaslatok), Gotify-t vagy ntfy-t. Ezekhez Cloudflare Tunnel kell, a „local webhook allowlist” funkció pedig értelmét veszti.
10. **E-mail.** A Workers nem tud kényelmesen SMTP-t, ezért az e-mail a Resend HTTP API-ján megy, egyetlen példányszintű feladóval (`RESEND_API_KEY`, `EMAIL_FROM`) a PHP felhasználónkénti SMTP-beállításai helyett. A „TLS-hibák figyelmen kívül hagyása” opció megszűnt: a Worker mindig ellenőrzi a tanúsítványt.
11. **API-kulcsok** a régi adatbázisban titkosítatlanok. A kompatibilitás miatt egyelőre így maradnak (egyenlőségvizsgálat), később hash-elhetők, ha a régi klienseket már nem kell támogatni.
12. **Webhook-sablon.** A PHP csak a jegyzetet escapelte a webhook JSON-sablonjában, így egy idézőjeles név (`Say "hi"`) érvénytelen JSON-t adott. A Worker minden behelyettesített értéket JSON-escapel.
13. **Cron-korlátok.** Az ingyenes Workers csomag egy cron-futásban 50 kimenő hívást enged (fizetős: 1000). Sok felhasználónál a fizetős csomag kell, nagyon sok felhasználónál a küldést Cloudflare Queues-ra érdemes tenni.
14. **Képek GD nélkül.** A Workersben nincs GD; az átméretezést a Cloudflare Images binding végzi (opcionális, külön díjköteles a havi ingyenes kereten felül). Nélküle a feltöltött kép eredeti méretben kerül tárolásra, és a pixelműveletek (háttér, variáns) csak legfeljebb 1 megapixeles PNG-n futnak, a CPU-korlát miatt.
15. **Felület változatlan JS-sel.** A PHP JavaScriptje a böngészőben változatlan, ezért a HTML-szerkezetet és az `endpoints/*.php` válaszformátumait pontosan követni kell; a PHP-ban frissülő JS/CSS-t a `build-assets` minden buildnél újramásolja, a sablonváltozásokat viszont kézzel kell átvezetni a JSX-oldalakra.
16. **SSO-only kizárás.** Ha az admin csak OIDC-belépést enged, és a szolgáltató elérhetetlen, senki nem tud belépni; ilyenkor `OIDC_DISABLE_PASSWORD_LOGIN=false` változóval vagy egy D1-paranccsal kapcsolható vissza a jelszó (README). A 2FA-t elvesztett felhasználó mentőkóddal léphet be; ha az sincs, az admin D1-ben kapcsolhatja ki (`UPDATE user SET totp_enabled = 0 …; DELETE FROM totp …`).

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

## 2c. Elkészült a 3. fázisban

- **E-mail Resenden:** egy példányszintű feladó (`RESEND_API_KEY` titok, `EMAIL_FROM`); jelszó-visszaállítás (1 órás link, a többi session kijelentkezik) és e-mail-megerősítés azonnali küldéssel, hash-elt tokenekkel, egyszerű céloldalakkal (`/reset-password`, `/verify-email`).
- **11 értesítési csatorna** egyetlen `notification_channels` táblában: e-mail, Discord, Gotify, Telegram, Pushover, ntfy, webhook, Mattermost, PushPlus, ServerChan, Web Push. A titkos mezők maszkolva jönnek vissza, minden csatornához van tesztküldés és előnézet.
- **Emlékeztetők:** óránkénti cron, a felhasználó időzónája szerint 09:00-kor (fizetés, a PHP-val azonos üzenetszöveggel, házastagonként csoportosítva, költségvetési-időszak összesítővel) és 08:00-kor (lemondás). A `notification_log` napló miatt egy nap egyszer megy ki, akkor is, ha a cron kétszer fut.
- **Web Push** könyvtár nélkül: VAPID (ES256 JWT) és RFC 8291 aes128gcm titkosítás WebCrypto-val; a megszűnt feliratkozások (404/410) törlődnek. A PHP-ban tárolt VAPID-kulcsok (PKCS#8 és SEC1 PEM) is használhatók.
- **Árfolyamok:** Frankfurter (alapértelmezett, kulcs nélkül, a 422-es elutasítás után egy újrapróbálás a visszautasított kódok nélkül), Fixer.io és APILayer (EUR-alapú átszámítással); napi cron és kézi frissítés.
- **Importáló:** az értesítési táblák, push-feliratkozások, VAPID-kulcsok, árfolyam-szolgáltató és utolsó frissítés is átjön.
- **PHP-kompatibilis végpontok:** `get_notification_settings.php`, `get_fixer.php`, `set_fixer.php`.
- **Tesztek:** 85 teszt (kimenő hívások mockolva: Resend, csatornák, Frankfurter, Fixer, push szolgáltatás; a push-titkosítás oda-vissza visszafejtéssel ellenőrizve).

## 2d. Elkészült a 4. fázisban

- **R2 tároló** a logóknak, feltöltött fizetésimód-ikonoknak és avataroknak, a PHP fájlútvonalaival azonos kulcsokkal; a Worker ugyanazon a címen szolgálja ki őket (`/images/uploads/logos/...`, ETag/304, `nosniff`, sandbox CSP). Az importált adatbázis-értékek így változatlanul érvényesek.
- **Feltöltés:** multipart fájl vagy URL; a típust a fájl tartalma dönti el (PNG, JPEG, GIF, WebP, AVIF; SVG nem), max. 5 MB. URL-ről legfeljebb 3 átirányítást követ, mindegyik lépést ellenőrizve (privát címekre nem megy).
- **Képfeldolgozás GD nélkül:** átméretezés az opcionális Cloudflare Images bindinggel; a PHP háttéreltávolítása, a szélek levágása és a sötét/világos témához készülő logóvariáns tiszta TypeScriptben, ugyanazokkal a küszöbökkel.
- **Takarítás:** logócserekor, előfizetés/fizetési mód/felhasználó törlésekor a fájl is törlődik, ha más (pl. egy klón) már nem használja; admin végpont a sehol nem használt logókra.
- **Logókereső:** DuckDuckGo, Brave, Google (SerpAPI-kulccsal) és a selfh.st / Dashboard Icons katalógusok, Cache API-s gyorsítótárral.
- **Átköltözés:** `scripts/upload-files.ts` a PHP `images/uploads/logos` könyvtárát R2-be másolja; az importáló a SerpAPI-kulcsot is átveszi, és listázza a hivatkozott logókat, variánsokat és ikonokat.
- **Tesztek:** 103 teszt (képfeldolgozás pixelszinten, R2-feltöltés és -kiszolgálás, átirányítás-védelem, takarítás klónokkal, Images binding, logókereső).

## 2e. Elkészült az 5. fázisban

- **Webes felület a Workeren**, ugyanazokon a címeken, mint a PHP-ban (`index.php`, `subscriptions.php`, `calendar.php`, `stats.php`, `settings.php`, `profile.php`, `admin.php`, `about.php`, `login.php`, `registration.php`, `passwordreset.php`, `verifyemail.php`, `logout.php`). Az oldalak Hono JSX-ben, szerveroldalon renderelődnek, a PHP-val azonos HTML-szerkezettel (id-k, osztályok), így a PHP változatlan CSS- és JS-fájljai működnek rajtuk.
- **Workers Static Assets:** a `scripts/build-assets.ts` a repó `styles/`, `scripts/`, `images/` és `libs/` könyvtárát a `public/`-ba másolja (a `dev`, `test`, `deploy` előtt automatikusan lefut); a Worker csak a dinamikus kéréseket kapja meg.
- **Böngészős session:** HttpOnly, SameSite=Lax `wallos_session` cookie (a „maradjak bejelentkezve” 30 napos lejáratot ad, nélküle böngészőzárásig él), CSRF-token minden módosító kéréshez (`X-CSRF-Token` fejléc vagy `csrf_token` mező). Az API Bearer tokenje és az API-kulcs ugyanúgy működik tovább.
- **`endpoints/**/*.php` kompatibilitási réteg** a PHP JavaScriptjeinek: előfizetések (felvétel, szerkesztés, klónozás, megújítás, törlés, logókeresés és -feltöltés, lista szűrés/rendezés), beállítások (kategóriák, háztartás, fizetési módok, devizák, költségvetés, téma, színek, egyedi CSS, megjelenés), értesítések (mind a 11 csatorna mentése és tesztje), profil (avatar, jelszó, API-kulcs, fióktörlés), admin (felhasználók, regisztráció, logótakarítás), mentés.
- **i18n:** a 29 nyelv PHP-tömbjei JSON-ba konvertálva (`scripts/convert-i18n.php`), a nyelv a felhasználó beállításából, kijelentkezve a `language` cookie-ból vagy az `Accept-Language` fejlécből jön; RTL nyelvek támogatva.
- **Statisztika, naptár:** a PHP grafikonjai (ApexCharts) és kiegészítő mutatói, havi naptárnézet; **iCal feed** (`/api/subscriptions/get_ical_feed.php?api_key=…`, és a naptár oldal letöltése).
- **PWA:** `manifest.php`, `service-worker.js` (offline gyorsítótár a statikus fájlokra).
- **Tesztek:** 198 teszt; böngészős (Playwright) végigjárás `wrangler dev` ellen: regisztráció és belépés az űrlapon, minden oldal betöltése JS-hiba nélkül, előfizetés felvétele az űrlapon, részletek megnyitása, kategória felvétele, grafikonok renderelése.

**Eltérések a PHP felülettől:**
- TOTP és OIDC gombjai megvannak, de „még nem elérhető” üzenetet adnak (6. fázis); a „belépés kikapcsolása” (jelszó nélküli mód) nincs.
- AI-javaslatok beállításai megjelennek, a mentés „még nem elérhető” (7. fázis).
- A mentés az admin oldalon zip-be csomagolt JSON-export (nincs SQLite-fájl); visszaállítás és PHP-adatbázis importja az importáló CLI-vel megy.
- SMTP-beállítás helyett Resend (titokként), a helyi webhook-engedélylista nem alkalmazható; a cron-gombok csak jelzik, hogy a feladat az óránkénti triggeren fut.

## 2f. Elkészült a 6. fázisban

- **Kétlépcsős azonosítás (TOTP, RFC 6238)** könyvtár nélkül, WebCrypto HMAC-SHA1-gyel, az OTPHP-val azonos paraméterekkel (6 jegy, 30 s, ±15 s türelem). Bekapcsolás a profil oldalon a PHP változatlan JS-ével (QR-kód, 10 mentőkód), a belépés második lépése a `totp.php` oldalon, rövid életű, HttpOnly sütiben tartott várakozó lépéssel (`auth_flows` tábla). Öt hibás kód után 30 s zárolás fiókonként, egy kód (időlépés) csak egyszer fogadható el, a mentőkód egyszer használható. API: `totp_code` a belépésnél, `/api/me/two-factor` végpontok.
- **OIDC egyszeri bejelentkezés:** authorization code flow PKCE-vel (S256), egyszer használható `state`; a visszatérés bármelyik oldalra érkezhet `?code&state`-tel (mint a PHP `checksession.php`-nál). Fiók-összekötés azonosítóval, majd megerősített e-maillel; automatikus fiók-létrehozás a szolgáltató nevével és nyelvével; kijelentkezés a szolgáltatónál is. Admin oldal és végpontok, PHP-kompatibilis admin API, `OIDC_*` változók (discovery `OIDC_ISSUER`-rel). SSO-only mód az űrlapon, az API-n és a regisztrációnál is.
- **Belépés-korlátozás** (a PHP-ban nem volt): D1-számlálók cím és cím+felhasználónév szerint (10/30 hiba 15 percen belül → 15 perc tiltás), a jelszó-visszaállítás kérése címenként 15 percenként 10; opcionális Workers Rate Limiting binding.
- **Importáló:** a `totp` tábla (a mentőkódok hash-elve), az `oauth_settings`, az `admin.oidc_oauth_enabled` és a fiókok `oidc_sub` mezője is átjön; a lehetetlen állapotot (2FA bekapcsolva titok nélkül) és az ütköző OIDC-azonosítókat javítja és jelzi.
- **Tesztek:** 221 teszt (RFC 6238 tesztvektorok, a teljes 2FA- és OIDC-folyamat kimenő hívásokkal mockolva, zárolás, újrajátszás, SSO-only, változós felülírás, import); a böngészős füstteszt a 2FA bekapcsolását, a kétlépcsős belépést és a mentőkódos kikapcsolást is végigjátssza.

**Eltérések a PHP-tól:** a mentőkódokat csak SHA-256 hash-ként tároljuk; a 2FA be- és kikapcsolása egy tranzakció; az OIDC-folyamat PKCE-t is küld; a client secret az admin oldalon és az API-ban maszkolva látszik (`********`; visszaküldve megmarad); a `OIDC_CLIENT_SECRET_FILE` helyett Worker-titok (`OIDC_CLIENT_SECRET`) használható; a „Disable login” (jelszó nélküli mód) továbbra sincs.

## 2g. Elkészült a 7. fázisban

- **Éves költségtörténet:** hétfőnként UTC 01:00-kor minden felhasználó aktív előfizetéseinek éves költsége fődevizában (a PHP-val azonos számítással: 30 nap / 4,35 hét egy hónap, az egyszeri vásárlás 0) a `total_yearly_cost` táblába kerül, naponta legfeljebb egy pont. A statisztika oldal „Total Monthly Cost” grafikonja ebből rajzol; API: `/api/stats/history`.
- **AI-javaslatok:** a PHP `ai_client.php` és `endpoints/ai/*` portja – ChatGPT, Gemini, OpenRouter, Ollama, OpenAI-kompatibilis szerverek, plusz **Cloudflare Workers AI** (opcionális `ai` binding, kulcs nélkül). A PHP promptjai változatlanok (a magyar felhasználó magyar javaslatot kap), a modell válaszából a JSON-t kódblokkból, magyarázó szöveg mellől és streamelt válaszból is kiszedi. Javaslatok a főoldalon, törlés, modellek listázása, kategórianevek fordítása (a „Nincs kategória” helyőrző kivételével).
- **Ütemezés:** a heti/havi futás óránkénti cronnal megy, amikor esedékes (heti: 7 nappal a legutóbbi siker után, havi: naptári hónaponként egyszer); legfeljebb 5 felhasználó óránként, hibás szolgáltatónál naponta egy újrapróbálás (`last_attempt`).
- **Importáló:** az éves költségtörténet, az AI-beállítások (felhasználónként egy, ahogy a PHP kliens is az elsőt használta) és a meglévő javaslatok is átjönnek; a helyi hálózati Ollamára figyelmeztet.
- **Tesztek:** 233 teszt (költségszámítás devizával és egyszeri tétellel, hétfői cron, grafikon; minden szolgáltató kérés- és válaszformátuma mockolva, hibák, streamelt válasz, Workers AI, fordítás, ütemezés újrapróbálással, import).

**Eltérések a PHP-tól:** az API-kulcs a felületen és az API-ban maszkolva (`********`), visszaküldve megmarad; felhasználónként egy AI-beállítás; a heti/havi futás „esedékességre” megy fix nap helyett (az első futás a beállítás után egy órán belül); Ollama/saját szerver csak nyilvános címen; a költségtörténet naponta egy pont, 2 tizedesre kerekítve.

## 3. Ütemterv

Becslés egy fejlesztőre, teljes munkaidőben. A fázisok sorrendje függőségi sorrend; a 3. és 4. párhuzamosítható.

| # | Fázis | Tartalom | Becslés | Kész, ha |
|---|---|---|---|---|
| 0 | Felmérés | Kódbázis, séma, cron, API feltérképezése | — | ✅ ez a dokumentum |
| 1 | **Alap: Worker + D1** | Lásd 2. szakasz | — | ✅ |
| 2 | **Adatmigráció és fiókkezelés** ✅ | `wallos.db` → D1 importáló szkript (HTML-dekódolás, típusjavítás, duplikátumok); profil és beállítások API (téma, nyelv, költségvetés és költségvetési időszakok, `budget_period_*`); jelszócsere; admin API (felhasználók listája, törlése, regisztráció nyitása, `max_users`); JSON export/mentés | — | ✅ (lásd 2b) |
| 3 | **Árfolyamok, értesítések, e-mail** ✅ | Árfolyam-cron (Frankfurter alapból, Fixer/apilayer kulccsal); értesítési táblák migrációja; HTTP-csatornák: Discord, Telegram, Gotify, Pushover, ntfy, webhook, Mattermost, PushPlus, ServerChan; e-mail HTTP-szolgáltatón; Web Push (VAPID); lemondási értesítések; e-mail-megerősítés és jelszó-visszaállítás; felhasználónkénti időzóna; „teszt” végpontok | — | ✅ (lásd 2c) |
| 4 | **Fájlok és logók** ✅ | R2 a logóknak és avatároknak; feltöltés méret- és típusellenőrzéssel; logó letöltése URL-ről SSRF-védelemmel; logókereső; törléskor a fájl takarítása; Cloudflare Images átméretezés (háttéreltávolítás opcionális) | — | ✅ (lásd 2d) |
| 5 | **Webes felület** ✅ | Workers Static Assets a meglévő CSS/JS/képekhez; az oldalak portolása Hono JSX SSR-re (főoldal/előfizetések, statisztika, naptár, beállítások, profil, admin, belépés/regisztráció); i18n konverzió PHP → JSON; témák, egyedi CSS és színek; PWA manifest + service worker; cookie-s session CSRF-védelemmel, „emlékezz rám” | — | ✅ (lásd 2e) |
| 6 | **Haladó hitelesítés** ✅ | TOTP 2FA (mentőkódokkal, kizárással); OIDC/OAuth SSO, csak-SSO mód; belépési rate limit | — | ✅ (lásd 2f) |
| 7 | **Költségtörténet, AI** ✅ | Éves költségtörténet (heti cron) a statisztika-oldal történeti grafikonjához; AI-javaslatok (OpenAI/Gemini/OpenRouter/Ollama/OpenAI-kompatibilis, opcionálisan Workers AI) heti/havi cronnal. (Naptárnézet és iCal feed az 5. fázisban elkészült.) | — | ✅ (lásd 2g) |
| 8 | Élesítés | Egyedi domain, Cloudflare Access/WAF az admin felülethez; D1 Time Travel + időszakos export R2-be; GitHub Actions (teszt + deploy); monitorozás; átállás a PHP példányról (import, DNS) | 0,5–1 hét | Éles forgalom a Workeren, a PHP példány leállítható |

**Funkcióparitás elérve** (a fenti, dokumentált eltérésekkel). **Hátralévő: kb. 0,5–1 hét** – csak a 8. fázis, az élesítés (Cloudflare-fiók, domain, mentések, CI/CD, átállás).

### Cron-megfeleltetés

| PHP cron | Ütemezés | Worker |
|---|---|---|
| `updatenextpayment.php` | naponta 01:00 | ✅ óránkénti trigger, UTC 01:00 |
| `updateexchange.php` | naponta 02:00 | ✅ UTC 02:00, naponta egyszer felhasználónként |
| `sendcancellationnotifications.php` | naponta 08:00 | ✅ 08:00 a felhasználó időzónájában |
| `sendnotifications.php` | naponta 09:00 | ✅ 09:00 a felhasználó időzónájában |
| `sendverificationemails.php`, `sendresetpasswordemails.php` | 2 percenként | ✅ nincs cron: a levél a kéréskor azonnal megy |
| `checkforupdates.php` | 6 óránként | elhagyható (a Worker verzióját a deploy adja) |
| `storetotalyearlycost.php` | hétfőnként 01:30 | ✅ hétfőnként UTC 01:00 |
| `cleanupresettokens.php` | naponta 03:00 | ✅ UTC 03:00 (plusz 90 napnál régebbi értesítési napló) |
| `generaterecommendations.php` | heti/havi | ✅ óránként, amikor esedékes (legfeljebb 5 felhasználó/óra) |

## 4. Teendők a Cloudflare-fiókban (egyszeri)

Ezekhez Cloudflare-hozzáférés kell, ebből a környezetből nem futtattam őket:

```sh
cd worker
npm install
npx wrangler login
npx wrangler d1 create wallos          # a kapott database_id-t írd be a wrangler.jsonc-be
npx wrangler r2 bucket create wallos-files
npm run db:migrate:remote
npx wrangler secret put RESEND_API_KEY # és az EMAIL_FROM a wrangler.jsonc-ben, hitelesített domainnel
npm run deploy
```

Ezután vagy az első regisztrált felhasználó (`POST /api/auth/register`) lesz az admin, vagy importáld a meglévő PHP adatbázist (README, „Átköltözés PHP Wallosról”).
