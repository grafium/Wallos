# Szabályok — munkamenet és kód

Ezek a szabályok a projekt eddigi menetéből és a megrendelő kéréseiből állnak össze. Aki (ember vagy agent) folytatja a munkát, ezeket kövesse. Ha valami ütközik, a megrendelő aktuális kérése az irányadó.

## 1. Együttműködés

1. **Nyelv:** a megrendelővel magyarul kommunikálunk. A dokumentáció (README, ROADMAP, napló, szabályok, átvétel) magyar; a kód, a kódkommentek és a commitüzenetek angolok.
2. **Fázisonként haladunk.** Új fázis csak a megrendelő jóváhagyására indul („mehet a N. fázis”). Az ütemterv a [ROADMAP.md](./ROADMAP.md) 3. szakasza.
3. Egy fázis akkor kész, ha:
   - `npm run typecheck` és `npm test` hibátlan, és a GitHub Actions „Worker” workflow is zöld;
   - a ROADMAP-ban van egy „Elkészült az N. fázisban” szakasz, a táblában ✅, és a hátralévő becslés frissítve van;
   - a README frissítve van (amit a felhasználónak/üzemeltetőnek tudnia kell);
   - ha a fázis telepítést érint: a `npm run check:deployment` a helyi `wrangler dev` ellen is zöld;
   - a verzió emelve van: `src/version.ts` (`WORKER_VERSION`) és `package.json` (`0.N.0`);
   - a [NAPLO.md](./NAPLO.md) bejegyzést kapott;
   - a végső commit `[skip ci]` nélkül ki van pusholva.
4. A végén rövid magyar összefoglaló: mi készült el, mi tér el a PHP-tól, mi jön a következő fázisban.
5. **„Ments mindent: NAPLO, SZABALYOK, ATVETEL”** azt jelenti: a három dokumentum tükrözze a pillanatnyi állapotot (napló-bejegyzés a kérésről is), a munkából semmi ne maradjon csak a scratchpadben (pl. segédszkriptek a repóba), minden legyen commitolva és pusholva, és a dokumentumok másolata kerüljön a session mappájába is (`/Users/xaba/Claude2026/Wallos`; a forrás a `~/Wallos/worker/`).
6. A naplóba CI-eredményt (✅) csak akkor írunk, ha a GitHub Actions futását ténylegesen ellenőriztük; a fázis commitjának azonosítója és CI-eredménye egy rövid `docs(worker): …` commitban kerül be utólag.

## 2. Git

1. Ág: **`claude/zen-goldberg-0hbajd`**. Másik ágra csak kifejezett engedéllyel pusholunk.
2. **Pull requestet nem nyitunk**, csak ha a megrendelő kéri.
3. Commitüzenet: `feat(worker): phase N - …` a fázis végén, `wip(worker): … [skip ci]` a köztes mentéseknél (a stop hook nem enged commitolatlan állapotot a válasz végén).
4. A commitüzenet végén mindig ott van:
   ```
   Co-Authored-By: Claude Opus 5.5 <noreply@anthropic.com>
   Claude-Session: https://claude.ai/code/session_018TTXfL64drKx6H8VkPHKhe
   ```
   Új sessionben az aktuális session linkje kerül ide.
5. Modellazonosító **sehova máshova** nem kerülhet (kód, komment, doksi, PR).
6. Push: `git push -u origin claude/zen-goldberg-0hbajd`; hálózati hibánál legfeljebb 4 újrapróbálás (2, 4, 8, 16 s).

## 3. PHP-kompatibilitás (nem törhető invariánsok)

1. **D1 séma:** a PHP tábla- és oszlopnevei megmaradnak, mert ezen múlik az importálhatóság. Új oszlop/tábla csak új migrációban (`migrations/000N_*.sql`) jöhet; a meglévő migrációt soha nem szerkesztjük.
2. **Régi API:** az `/api/**/*.php` útvonalak ugyanazt a JSON-t adják, mint a PHP, és az `api_key` paraméterrel működnek. A legacy útvonalak a REST útvonalak **előtt** vannak mountolva.
3. **Webes felület:** az oldalak a PHP-val azonos URL-en (`index.php` …) és azonos HTML-szerkezettel (id-k, osztályok, `onclick`-ek) készülnek, mert a PHP JS/CSS-fájljai **változatlanul** futnak rajtuk. A JS-t és a CSS-t nem írjuk át; a `build-assets` a repó gyökeréből másolja őket. Az `endpoints/**/*.php` válaszformátuma (`{success, message, …}`) pontosan a PHP-é.
4. **R2 kulcsok** = a PHP fájlútvonalai (`images/uploads/logos/…`, `…/avatars/…`). A subscriptions/payment_methods tábla a fájlnevet, a user tábla a teljes útvonalat tárolja, ahogy a PHP.
5. Ami a Workeren nem elérhető (jelszó nélküli mód, SMTP, helyi webhook-engedélylista, helyi hálózati AI-szerver), az a felületen megjelenik, de egyértelmű `{success:false, message}` üzenetet ad. Csendben nem hibázhat.
6. Ha a PHP-tól szándékosan eltérünk (hibajavítás, platformkorlát), azt a ROADMAP kockázatlistájában dokumentáljuk, és teszttel rögzítjük.

## 4. Biztonság

1. Szövegeket nyersen tárolunk, és megjelenítéskor escapelünk (a JSX automatikusan). Inline JS-be adatot csak a `js()` helperen át teszünk (`src/ui/layout.tsx`, ez a `<` és az U+2028/2029 karaktereket is escapeli).
2. Böngészős módosító kérés csak CSRF-tokennel mehet (`X-CSRF-Token` vagy `csrf_token`); a token = sha256("wallos-csrf:" + sessionToken). A session cookie HttpOnly és SameSite=Lax.
3. Kimenő HTTP (logó URL, webhook, csatornák) csak a `checkOutboundUrl` / `outboundFetch` helperen át mehet: privát címekre nem, átirányításonként újraellenőrizve.
4. Titkos mezők (tokenek, jelszavak, API-kulcsok) maszkolva jönnek vissza az API-ból. Titok csak `wrangler secret`-ben lehet, a `wrangler.jsonc`-ben és a repóban soha.
5. Feltöltésnél a típust a fájl tartalma dönti el, nem a kiterjesztés; SVG nem fogadható el; max. 5 MB.
6. Minden hivatkozásnál (kategória, deviza, fizetési mód, háztag, helyettesítő előfizetés) ellenőrizzük, hogy az adott felhasználóé-e.
7. Belépési lépés (2FA, OIDC-state) csak D1-ben, hash-elt tokennel és HttpOnly sütivel tárolható, egyszer használható és lejár (`src/services/login-guard.ts`). Új belépési útvonal a belépés-korlátozáson (`loginAllowed` / `recordLoginFailure`) megy át.
8. Mentőkódot, tokent csak hash-ként tárolunk; ami visszafejthetőnek kell maradjon (TOTP-titok, OIDC client secret, AI API-kulcs, értesítési tokenek), azt a felület és az API maszkolva (`********`) vagy egyáltalán nem mutatja; a visszaküldött maszk a tárolt értéket tartja meg.
9. Telepítési parancsok a `DB` binding nevet használják (`wrangler d1 … DB`), nem az adatbázis nevét. Mentés (dump, letöltött fájl) titkot tartalmaz: csak a nem publikus `backups/` alatt, admin-jogosultsággal érhető el.
10. Két összetartozó írás (pl. `totp_enabled` és a `totp` sor) egy `batch`-ben megy, hogy ne maradhasson ellentmondásos állapot.

## 5. Kód

1. TypeScript strict, Hono 4, Hono JSX, zod v4 validáció (`src/lib/schemas.ts`). Az új kód a környező kód stílusát követi: angol kommentek, mérsékelt kommentsűrűség, a PHP-megfelelő megnevezve (pl. „index.php's formatPrice()”).
2. Rétegek: `routes/` (HTTP) → `services/` (üzleti logika) → `lib/` (tiszta segédek). A felület a `src/ui/`-ban van; a duplikált logikát a `services/`-be emeljük (pl. `deleteUserAccount`).
3. Dátumok: UTC, a `src/lib/dates.ts` segédeivel (hónapvégre vágás). Pénz: `src/lib/pricing.ts`.
4. D1: legfeljebb 100 kötött paraméter lekérdezésenként (sok sor beszúrásához `json_each()`), több írás `batch`-ben.
5. Új függőség csak indokolt esetben; Workers runtime-ban futónak kell lennie. Telepítés: `--legacy-peer-deps` (benne van a `.npmrc`-ben).

## 6. Tesztelés

1. Vitest a valódi Workers runtime-ban (`@cloudflare/vitest-plugin`), helyi D1-gyel; a migrációkat a `test/apply-migrations.ts` alkalmazza.
2. Kimenő hívásokat `vi.spyOn(globalThis, "fetch")`-csel mockolunk, valódi külső szolgáltatást teszt nem hív.
3. Statikus fájlt `env.ASSETS.fetch`-csel tesztelünk (a `worker.fetch` megkerüli az asseteket). Felület-tesztekhez a `test/ui-helpers.ts` segédeit használjuk (`browserSession`, `getPage`, `endpoint`, `raw`).
4. Minden új végponthoz és PHP-eltéréshez teszt kell.
5. Teszt nem rögzíthet telepítésfüggő értéket (pl. a `wrangler.jsonc` adatbázis-azonosítóját): a megrendelő telepítése megváltoztatja, és a CI ettől nem pirosodhat be.
6. Ütemezett feladatot a `runScheduled(env, időpont)` hívásával, rögzített UTC-időponttal tesztelünk (pl. hétfő 01:00), a kimenő hívásokat mockolva.
7. Felületi változás után a böngészős füstteszt is fusson: `node scripts/smoke-test.mjs` (lásd [ATVETEL.md](./ATVETEL.md)).

## 7. Élesítés és üzemeltetés

1. A felhős sandbox nem éri el a Cloudflare-t (az `api.cloudflare.com` és a `*.workers.dev` tiltott, token nincs); ott az éles ellenőrzés a megrendelő által futtatott parancsok kimenetéből történik. A megrendelő Macjén futó sessionben (`~/Wallos`, bejelentkezett wrangler) a telepítés és az ellenőrzés közvetlenül futtatható — éles telepítés előtt ekkor is a megrendelő jóváhagyását kérjük. Amit nem láttunk, azt nem jelentjük késznek.
2. A megrendelőnek adott parancsok legyenek másolásbiztosak: lehetőleg idézőjel nélküliek (pl. `npx wrangler d1 migrations list DB --remote` a táblalista-SQL helyett), macOS zsh-n és Windows PowerShellen is működjenek, vagy legyen mellettük a PowerShell-változat.
3. Ha a wrangler csak a súgót írja ki, a hibaüzenet a súgó fölött van (`✘ [ERROR]`): azt kell elkérni.
4. Az éles állapotot (cím, adatbázis-azonosító, ellenőrzés eredménye, migrációk) az ATVETEL elején és a NAPLO-ban rögzítjük.
5. Titkot (tokent, API-kulcsot) soha nem kérünk be a chatben; a megrendelő `wrangler secret put`-tal vagy a környezet beállításaiban adja meg.
6. A megrendelő több gépen dolgozik (MacBook Pro, Mac mini), és nem mindegyiken van klón. Minden parancssor elé `cd <repó>/worker` kerül; ha `not a git repository` / `Missing script` / `Required Worker name missing` hiba jön, rossz mappából futott. A repó nélkül csak a `--name wallos`-os wrangler-parancsok mennek (pl. `npx wrangler secret put RESEND_API_KEY --name wallos`); telepíteni (`npm run deploy`) csak a klónból lehet.
7. A `wrangler.jsonc` változásai (domain, `vars`) csak telepítés után élnek; a commit után mindig jelezzük, hogy `git pull` + `npm run deploy` kell, és a telepítés kimenetéig az állapotot „telepítésre vár”-nak írjuk.
8. A tesztek nem függhetnek a `wrangler.jsonc` `vars` értékeitől: amit a tesztek feltételeznek (`EMAIL_FROM`, `APP_URL`), azt a `vitest.config.ts` miniflare-kötései rögzítik.
9. Új saját domain első telepítése után a resolverek akár 30 percig a korábbi negatív választ cache-elhetik („Could not resolve host”). Ez nem telepítési hiba: az authoritatív NS-sel (`dig aisub.hu @bingo.ns.cloudflare.com`) ellenőrizzük, az ellenőrző szkriptet addig a `scripts/pin-dns.mjs` előtöltővel futtatjuk, és a megrendelőnek jelezzük, hogy a böngészőben pár percen belül megjelenik.
