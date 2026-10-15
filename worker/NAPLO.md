# Munkanapló — Wallos → Cloudflare Workers + D1

Időrendben: mit kért a megrendelő, mi készült el, milyen döntések születtek, és milyen hibákba futottunk bele. Ág: `claude/zen-goldberg-0hbajd` (PR-t nem nyitottunk). A részletes tartalmat lásd: [ROADMAP.md](./ROADMAP.md) (2.–2h. szakasz) és [ELESITES.md](./ELESITES.md) és [README.md](./README.md).

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
| Mentés a 6. fázis után | `27d5a06` | 221 | ✅ |
| 7. Éves költségtörténet, AI-javaslatok | `90c1fe1` | 233 | ✅ |
| Napló: 7. fázis commitja és CI-eredménye | `160e2f5` | 233 | ✅ |
| Mentés a 7. fázis után | `d0f9248` | 233 | ✅ |
| 8. Élesítés előkészítése (mentés, beállító, CI/CD, útmutató) | `e18df73` | 240 | ✅ |
| Napló: 8. fázis CI-eredménye | `48350f9` | 240 | ✅ |
| Élesítés a megrendelőnél: D1-azonosító (megrendelő commitja) | `6ead322` | 240 | ❌ (tesztoldali hiba) |
| Teszt javítása: a valódi D1-azonosító elfogadása | `d61a855` | 240 | ✅ |
| Napló: élesítés a workers.dev címre | `6c3fb2b` | 240 | ✅ |
| Napló: minden migráció lefutott élesben | `5b9a895` | 240 | ✅ |
| Mentés az élesítés után | `22e1f4d` | 240 | ✅ |
| Resend: `EMAIL_FROM` = `wallos@aisub.hu`, `APP_URL` | `37223ce` | 240 | ✅ |
| Napló: a Resend élesben működik | `bd7ef3a` | 240 | ✅ |
| Napló: DMARC-rekord | `a872ceb` | 240 | ✅ |
| Saját domain: `aisub.hu` | `a0c001b` | 240 | ✅ |

A fejlesztés és az élesítés 2026-10-13-án, a Resend és a saját domain beállítása 2026-10-15-én készült.

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

## 7. fázis — költségtörténet és AI-javaslatok

**Kérés:** „7. fázis mehet.”

- Felmérés: `endpoints/cronjobs/storetotalyearlycost.php` és `generaterecommendations.php`, `includes/ai_client.php`, `endpoints/ai/*` (save_settings, fetch_models, generate_recommendations, translate_categories, delete_recommendation), `includes/stats_calculations.php` (történeti grafikon), a 000032/35/39 migrációk. Az 5. fázis felülete már előre lekérdezte ezeket a táblákat, ha léteznek; ezek a feltételek most kikerültek.
- `migrations/0007_history_and_ai.sql`: `total_yearly_cost` (felhasználónként és naponként egy sor), `ai_settings` (felhasználónként egy, új `last_attempt`), `ai_recommendations`.
- `src/services/cost-history.ts` (PHP-s számítás, hétfői cron, `/api/stats/history`), `src/services/ai.ts` (hat szolgáltató, köztük Workers AI; PHP-s promptok; JSON-kinyerés kódblokkból/szöveg mellől/streamből; maszkolt kulcs; ütemezés esedékességre, óránként legfeljebb 5 felhasználó, napi újrapróbálás), `src/routes/ai.ts` (`/api/ai/*`), az `endpoints/ai/*.php` élesek, a beállítás oldal maszkolt kulccsal és Workers AI opcióval, a főoldal a javaslatokkal.
- Importáló: költségtörténet, AI-beállítások, javaslatok; figyelmeztetés helyi hálózati Ollamára.
- Ellenőrzés: 233 teszt, typecheck, böngészős füstteszt.
- **Hiba menet közben:** a régi `ui-notifications` teszt a „nem elérhető” állapotot rögzítette, és saját `ai_recommendations` táblát hozott létre, majd dobott el — ez a valódi migráció mellett ütközött volna; a blokk kikerült, az új `ai.test.ts` fedi le.
- Verzió: 0.7.0. A funkcióparitás elérve; hátra a 8. fázis (élesítés).

## Mentés (a 7. fázis után)

**Kérés:** „Ments mindet: NAPLO, SZABALYOK, ATVETEL.”

- A három dokumentum a 7. fázissal már frissült (`90c1fe1`, CI-eredmény a `160e2f5`-ben, annak CI-je is zöld). Most ez a bejegyzés, és az ATVETEL-be a nyitott ellenőrzések listája került (amit tesztkörnyezetben nem lehetett kipróbálni).
- Állapot a mentéskor: 0.7.0, 233 zöld teszt, CI zöld, munkakönyvtár tiszta, funkcióparitás elérve. Következő lépés: 8. fázis (élesítés) a megrendelő Cloudflare-fiókjával.

## 8. fázis — élesítés előkészítése

**Kérés:** „8. fázis mehet.”

- Korlát: ebből a környezetből a Cloudflare-fiók nem érhető el (nincs hozzáférés, a `*.cloudflare.com` hálózatilag tiltott), ezért a fiókban futó lépések a megrendelőnél maradnak; a repó minden mást előkészít és automatizál.
- `src/services/backup.ts`: a teljes D1 gzip-pelt SQL-dumpja az R2 `backups/` alá (INSERT OR REPLACE, létrehozási sorrend, `defer_foreign_keys`, a belépési állapot és az értesítési napló nélkül), vasárnap 04:00 UTC cron, 8 megőrzése, admin API (`/api/admin/backups`) és az admin oldalon lista, letöltés, kézi mentés.
- `scripts/setup-cloudflare.ts` (`npm run setup:cloudflare`), `scripts/lib/wrangler-config.ts` (kommentmegtartó `wrangler.jsonc`-szerkesztés), `scripts/check-deployment.ts` (`npm run check:deployment`), `.github/workflows/worker-deploy.yaml` (tag / main / kézi; teszt, migráció, telepítés, ellenőrzés).
- `wrangler.jsonc`: source mapek, `workers_dev`, saját domain kommentben; a parancsok a `DB` binding nevet használják (adatbázis-csere után is jók).
- `ELESITES.md`: a teljes útmutató.
- Ellenőrzés: 240 teszt, typecheck, `wrangler deploy --dry-run`, a beállító `--dry-run`-ja, az ellenőrző szkript a helyi `wrangler dev` ellen (8/8 zöld).
- **Hibák menet közben:** a `setVar` a `wrangler.jsonc` kommentjében szereplő `"OIDC_ENABLED"`-et írta volna át — a teszt a valódi fájlon fogta meg, javítva. A visszaállítási útmutató első változata az új adatbázist névvel (`wallos-restore`) migrálta volna, amit a wrangler a konfigurációban nem talál — átállítva a `DB` binding névre. A `?raw` import típusdeklarációja modulfájlban hatástalan volt — külön `test/raw.d.ts`. A `pkill -f "wrangler dev"` a saját parancssort is leállítja (exit 144) — a parancsokat ezért külön kell futtatni.
- Verzió: 0.8.0.

## Élesítés (a megrendelő Cloudflare-fiókjában)

**Kérés:** „Tedd ki ide a scripteket, mit indítsak el” → a megrendelő a saját gépén futtatta a lépéseket (`ELESITES.md` 1–6.); a Resend-kulcs még nincs bekötve.

- Ebből a környezetből a Cloudflare API és a `*.workers.dev` hálózatilag tiltott, Cloudflare-token nincs; az ellenőrzés a megrendelő által visszaküldött kimenetekből és a repóból történt.
- `setup:cloudflare` lefutott: D1 adatbázis `77fe2741-2dfa-43b1-9a6a-db5371ed1c87`, a megrendelő commitolta (`6ead322`).
- A CI ezen a commiton elbukott: a `deploy-config` teszt a helyőrző azonosítót várta. Ez a teszt hibája volt, nem a telepítésé; javítva (`d61a855`), a CI zöld.
- `npm run check:deployment -- https://wallos.grafium.workers.dev`: **8/8 zöld, verzió 0.8.0** (health és adatbázis, statikus fájlok, belépési átirányítás, belépési oldal, manifest, API-védelem, biztonsági fejlécek, a mentések nem publikusak).
- `npx wrangler d1 migrations list DB --remote`: **„No migrations to apply”**, tehát mind a 7 migráció lefutott (az idézőjeles táblalista-lekérdezést a macOS zsh szétszedte, ez a parancs idézőjel nélkül ugyanazt igazolja).
- Nyitott: az első admin regisztrációja, Resend (`RESEND_API_KEY`, `EMAIL_FROM`), opcionálisan saját domain, GitHub-ról telepítés, adatátköltöztetés, az `ELESITES.md` 11. ellenőrzőlistája.

## Mentés (az élesítés után)

**Kérés:** „Ments mindent: NAPLO, SZABALYOK, ATVETEL.”

- Állapot: 0.8.0 élesben a `https://wallos.grafium.workers.dev` címen, `check:deployment` 8/8, mind a 7 migráció lefutott, 240 zöld teszt, CI zöld, munkakönyvtár tiszta.
- A SZABALYOK-ba bekerültek az élesítés tanulságai: tesztben nem rögzítünk telepítésfüggő értéket; a megrendelőnek adott parancsok legyenek idézőjel nélküliek vagy másolásbiztosak; az éles ellenőrzés a megrendelő kimeneteiből megy, amíg a sandbox nem éri el a Cloudflare-t.
- Nyitott a megrendelőnél: első admin (vagy import), admin 2FA, mentés-próba, Resend, opcionálisan saját domain és GitHubról telepítés, az `ELESITES.md` 11. ellenőrzőlistája.

## Resend bekötése

**Kérés:** „Resend beállításokban segíts. Írd le pontról pontra.”

- A megrendelő a Resendben hitelesítette az `aisub.hu` domaint, létrehozta a „Sending access” API-kulcsot, és a saját gépén eltárolta: `npx wrangler secret put RESEND_API_KEY --name wallos` → „Success” (a kulcs nem került a chatbe).
- Tanulság: a `wrangler secret put` a `worker/` mappán kívül „Required Worker name missing” hibát ad; ilyenkor `--name wallos`.
- `wrangler.jsonc`: `EMAIL_FROM` = `Wallos <wallos@aisub.hu>`, `APP_URL` = `https://wallos.grafium.workers.dev`. A tesztek ettől függetlenek maradtak: a `vitest.config.ts` az `APP_URL`-t üresre rögzíti (a linkek a kérés címéből készülnek), az `EMAIL_FROM` ott eddig is rögzített volt. 240 teszt zöld.
- Nyitott a megrendelőnél: `git pull` + `npm run deploy` a `worker/` mappából, majd próba (admin oldal SMTP-szakasza, tesztlevél, Resend → Emails).
- `npm run deploy` lefutott (verzió `880039e2-eb46-419a-a3b9-dcb99fcf3156`). Az admin fiók regisztrálva (regisztrációkor nem megy levél: az első fiók az admin, ahogy a PHP-ban). **A tesztlevél megérkezett, a Resend élesben működik** — de a levélszemétbe került. A `_dmarc` rekordot a megrendelő felvette; következő: a fejlécben az SPF/DKIM/DMARC eredmény ellenőrzése, mail-tester.com, „nem levélszemét” jelölés (új domain hírneve idővel épül).

## Saját domain: aisub.hu

**Kérés:** „Workert állítsd erre a domainre: aisub.hu”

- `wrangler.jsonc`: `"routes": [{ "pattern": "aisub.hu", "custom_domain": true }]`, `APP_URL` = `https://aisub.hu`. A `workers.dev` cím egyelőre bekapcsolva marad (átmenetre és ellenőrzésre); később `"workers_dev": false`.
- Ellenőrzés: `wrangler deploy --dry-run` a helyes kötésekkel és változókkal, 240 teszt zöld.
- Feltétel: az `aisub.hu` zóna ugyanabban a Cloudflare-fiókban van, és a csúcsdomainen (`aisub.hu`) nincs más A/AAAA/CNAME rekord — ha van, a telepítés hibát ad, előbb törölni kell. A Resend rekordjai (`send`, `resend._domainkey`, `_dmarc`) nem ütköznek.
- Nyitott a megrendelőnél: `npm run deploy`, majd `npm run check:deployment -- https://aisub.hu`; ha az admin oldalon ki van töltve a „Server URL”, azt is `https://aisub.hu`-ra kell írni.
- Első telepítési kísérlet: a megrendelő a saját mappájából (`~`) futtatta a parancsokat a Mac minin → `fatal: not a git repository` és `npm error Missing script: "deploy"`. Ezen a gépen valószínűleg nincs klónozva a repó; útmutatás: `find`-dal megkeresni, vagy `git clone` / `gh repo clone`, majd a `worker/` mappából telepíteni. **Az `aisub.hu` még nem fut élesben** — a telepítés kimenete még nem érkezett meg.

## Mentés (Resend és saját domain után)

**Kérés:** „Ments mindent. NAPLO, SZABALYOK, ATVETEL.”

- Állapot: élesben a `https://wallos.grafium.workers.dev` címen fut (`880039e2…` verzió), e-mail a Resenden át `wallos@aisub.hu`-ról működik (tesztlevél megérkezett, de levélszemétbe sorolódott; `_dmarc` felvéve, a fejléc ellenőrzése még hátravan). A repóban az `aisub.hu` saját domain és az `APP_URL` már be van állítva, a telepítés a megrendelőnél függőben. 240 zöld teszt, CI zöld minden commiton (`37223ce`…`a0c001b`), munkakönyvtár tiszta.
- A SZABALYOK 7. szakasza kiegészült: a megrendelő több gépen dolgozik (MacBook Pro, Mac mini), a parancsok elé mindig `cd <repó>/worker` kell; a `wrangler secret put` a mappán kívül csak `--name wallos`-szal megy; a `wrangler.jsonc` változásai (domain, változók) csak `npm run deploy` után élnek; a tesztek nem függhetnek a `wrangler.jsonc` `vars` értékeitől.
