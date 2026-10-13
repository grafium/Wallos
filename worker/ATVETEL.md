# Átadás-átvétel — hol tart a projekt, hogyan lehet folytatni

Állapot: **2026-10-13, 0.8.0 verzió, élesítve:** `https://wallos.grafium.workers.dev` (D1: `77fe2741-2dfa-43b1-9a6a-db5371ed1c87`; `check:deployment` 8/8 zöld; mind a 7 migráció lefutott). Hátravan: első admin, Resend, opcionálisan saját domain és adatátköltöztetés ([ELESITES.md](./ELESITES.md)). Ág: `claude/zen-goldberg-0hbajd` a `grafium/Wallos` repóban; PR nincs. Előzmények: [NAPLO.md](./NAPLO.md); szabályok: [SZABALYOK.md](./SZABALYOK.md); ütemterv: [ROADMAP.md](./ROADMAP.md).

## 1. Mi működik

- **Webes felület** a PHP-val azonos címeken: főoldal, előfizetések, naptár, statisztika, beállítások (értesítésekkel és fizetési módokkal), profil, admin, névjegy, belépés, regisztráció, jelszó-visszaállítás, e-mail-megerősítés, 29 nyelv, PWA.
- **Statisztika és AI:** heti éves költség-pillanatkép (történeti grafikon), AI-javaslatok hat szolgáltatóval (köztük opcionálisan Cloudflare Workers AI), kategóriafordítás, kézi/heti/havi futtatás.
- **Hitelesítés:** jelszó (bcrypt → PBKDF2), kétlépcsős azonosítás (TOTP + mentőkódok, `totp.php`), OIDC egyszeri bejelentkezés (SSO-only móddal), belépés-korlátozás, CSRF-védett cookie-s session, API-kulcs.
- **JSON API** (`/api/...`) Bearer tokennel vagy API-kulccsal, valamint a PHP `api/**/*.php` végpontjai kompatibilis formában (Home Assistant, mobilappok).
- **Háttérfeladatok:** óránkénti cron — emlékeztetők a felhasználó időzónájában, következő fizetési dátumok, árfolyamok, takarítás.
- **Fájlok** R2-ben, e-mail Resenden, Web Push.
- **Átköltözés PHP-ról:** `npm run import -- wallos.db` és `node scripts/upload-files.ts /path/to/wallos`.

## 2. Mi hiányzik még

| Fázis | Teendő | Hol kell hozzányúlni |
|---|---|---|
| 8 | Éles telepítés a fiókban | [ELESITES.md](./ELESITES.md): `npm run setup:cloudflare`, a `wrangler.jsonc` commitolása, Resend, saját domain, adatátköltöztetés, GitHub secrets, ellenőrzőlista |

Hátralévő: csak a fiókban elvégzendő lépések (kb. 1–2 óra, plusz az adatátköltöztetés és az ellenőrzőlista). A kód a 8. fázissal kész (ROADMAP 2h).

### Nyitott ellenőrzések (tesztkörnyezetben nem próbálható)

Ezek a tesztekben mockolt hívásokkal működnek, valódi szolgáltatóval az élesítéskor érdemes egyszer kipróbálni:

- AI-javaslat egy valódi szolgáltatóval (pl. Workers AI vagy ChatGPT-kulcs), és a kategóriafordítás.
- OIDC-belépés a valódi identitásszolgáltatóval (redirect URL = a Wallos címe).
- E-mail a Resenden át (jelszó-visszaállítás, értesítés), Web Push egy valódi böngészővel.
- Árfolyam-frissítés és logókereső élő hálózaton; a cron első hétfői futása (költségtörténet).

## 3. Élesítés (megtörtént a `workers.dev` címre — útmutató a további lépésekhez: [ELESITES.md](./ELESITES.md))

A Cloudflare-fiókban egyszer kell elvégezni (ebből a környezetből nem futtatható, mert a Cloudflare API elérése tiltott):

```sh
cd worker && npm install
npx wrangler login
npx wrangler d1 create wallos            # a database_id-t írd a wrangler.jsonc-be (most 00000000-… helyőrző!)
npx wrangler r2 bucket create wallos-files
npm run db:migrate:remote
npx wrangler secret put RESEND_API_KEY   # EMAIL_FROM és APP_URL a wrangler.jsonc vars-ban
npm run deploy
```

Opcionális: a Cloudflare Images binding bekapcsolása (`wrangler.jsonc`, `images`). Átköltözés: README, „Átköltözés PHP Wallosról”.

## 4. Fejlesztői környezet

- Node **22.18+** kell (`node:sqlite`, TS-szkriptek közvetlen futtatása). `npm install` a `worker/`-ben (a `.npmrc` miatt `legacy-peer-deps`).
- `npm run dev` (http://localhost:8787), `npm test`, `npm run typecheck`. Mindhárom előtt automatikusan lefut a `build:assets`, ami a `public/`-ba másol (a `public/` gitignore-olt, generált).
- Helyi adatbázis: `npm run db:migrate:local`; tiszta lap: `rm -rf .wrangler/state`.
- **Böngészős füstteszt:**
  ```sh
  rm -rf .wrangler/state && npm run db:migrate:local
  npx wrangler dev --port 8799 --local &
  node scripts/smoke-test.mjs        # Playwright kell (npm i -g playwright); SHOTS=<könyvtár> a képernyőképeknek
  ```
  Első futáskor regisztrálja az admint, később belép vele. Hiba esetén 1-es kóddal lép ki.

## 5. Ismert buktatók

- **npm:** ha `edgesOut` hibát kapsz, egyesével, `--legacy-peer-deps`-szel telepítsd a csomagokat.
- **Headless Chromium** `en-US@posix` nyelvet ad, amitől a változatlan `stats.js` `Intl`-hibát dob. Ez tesztkörnyezeti hiba; a füstteszt ezért locale-t állít be.
- **`wrangler dev`** a sandboxban sikertelenül próbál telemetriát küldeni (`sparrow.cloudflare.com`, `workers.cloudflare.com`). Ártalmatlan.
- **Stop hook:** a session nem fejezhető be commitolatlan változással, ezért köztes állapotot `wip(worker): … [skip ci]` committal mentünk.
- A teljes tesztcsomag egyszer egy párhuzamos agent futásában 2 átmeneti hibát mutatott, ami nem volt reprodukálható (azóta több teljes futás és a CI is zöld). Ha újra előjön, a megosztott helyi D1-állapot (tesztsorrend) a gyanús.
- A wrangler `database_id` helyőrző: amíg nincs kitöltve, remote parancs nem működik.
- **SSO-only kizárás:** ha csak OIDC-belépés engedélyezett és a szolgáltató nem elérhető, a jelszavas belépés a `OIDC_DISABLE_PASSWORD_LOGIN=false` változóval vagy `UPDATE oauth_settings SET password_login_disabled = 0` D1-paranccsal kapcsolható vissza.
- **Elveszett 2FA:** mentőkóddal lehet belépni; ha az sincs: `UPDATE user SET totp_enabled = 0 WHERE id = …; DELETE FROM totp WHERE user_id = …` (D1).
- **OIDC redirect URL:** a szolgáltatónál a Wallos címét kell visszatérési címként megadni (pl. `https://wallos.example.com/`); a Worker bármely oldalra érkező `?code&state`-et OIDC-visszatérésként kezel.
- **Migrációk ellenőrzése idézőjelek nélkül:** `npx wrangler d1 migrations list DB --remote` („No migrations to apply” = minden lefutott). Az idézőjeles SQL-parancsokat a macOS zsh másoláskor könnyen elrontja (a wrangler ilyenkor csak a súgót írja ki).
- **A sandbox nem éri el a Cloudflare-t:** az `api.cloudflare.com` és a `*.workers.dev` tiltott, token nincs. Az éles ellenőrzés a megrendelő által visszaküldött kimenetekből megy, amíg a környezet beállításaiban ezeket nem engedélyezik (Network access → Allowed domains, plusz `CLOUDFLARE_API_TOKEN` és `CLOUDFLARE_ACCOUNT_ID`).
- **AI és helyi hálózat:** Ollama vagy saját OpenAI-kompatibilis szerver csak nyilvános címen működik (a Worker nem látja a LAN-t); Cloudflare Tunnel vagy Workers AI (`"ai": { "binding": "AI" }` a `wrangler.jsonc`-ben) a megoldás.
- **Ütemezett AI:** óránként legfeljebb 5 esedékes felhasználó; sok felhasználónál a heti futás több órán át tart, ez szándékos (egy kérés akár percekig tarthat).
- `pkill -f "wrangler dev"` a saját parancssort is leállítja, ha az is tartalmazza ezt a szöveget (exit 144); a `wrangler dev` leállítását külön parancsban futtasd.
- A `setup:cloudflare` a `wrangler.jsonc`-t módosítja (adatbázis-azonosító, változók): utána commitolni kell, különben a GitHubról induló telepítés a helyőrzőn megáll.
- A füstteszt 2FA-része a második belépésnél megvárja a következő 30 másodperces időlépést, így kb. fél percig tart; `SKIP_2FA=1` kihagyja.

## 6. Folytatás új sessionben

1. `git fetch origin claude/zen-goldberg-0hbajd && git checkout claude/zen-goldberg-0hbajd`
2. Olvasd el: `worker/SZABALYOK.md`, `worker/ATVETEL.md` (ez), `worker/ROADMAP.md` 3. szakasz.
3. `cd worker && npm install && npm run typecheck && npm test` — a kiinduló állapot: 240 zöld teszt.
4. A fejlesztés a 8. fázissal lezárult. Ha az éles telepítés közben valami elakad, a hibaüzenettel és az ELESITES.md lépésének számával érdemes folytatni; új funkció új fázisként kerül a ROADMAP-ba.
