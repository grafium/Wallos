# Átadás-átvétel — hol tart a projekt, hogyan lehet folytatni

Állapot: **2026-10-13, 0.5.0 verzió, az 5. fázis kész** (`a3c4ec3`, a CI zöld). Ág: `claude/zen-goldberg-0hbajd` a `grafium/Wallos` repóban; PR nincs. Előzmények: [NAPLO.md](./NAPLO.md); szabályok: [SZABALYOK.md](./SZABALYOK.md); ütemterv: [ROADMAP.md](./ROADMAP.md).

## 1. Mi működik

- **Webes felület** a PHP-val azonos címeken: főoldal, előfizetések, naptár, statisztika, beállítások (értesítésekkel és fizetési módokkal), profil, admin, névjegy, belépés, regisztráció, jelszó-visszaállítás, e-mail-megerősítés, 29 nyelv, PWA.
- **JSON API** (`/api/...`) Bearer tokennel vagy API-kulccsal, valamint a PHP `api/**/*.php` végpontjai kompatibilis formában (Home Assistant, mobilappok).
- **Háttérfeladatok:** óránkénti cron — emlékeztetők a felhasználó időzónájában, következő fizetési dátumok, árfolyamok, takarítás.
- **Fájlok** R2-ben, e-mail Resenden, Web Push.
- **Átköltözés PHP-ról:** `npm run import -- wallos.db` és `node scripts/upload-files.ts /path/to/wallos`.

## 2. Mi hiányzik még

| Fázis | Teendő | Hol kell hozzányúlni |
|---|---|---|
| 6 | TOTP 2FA (mentőkódok, kizárás) | `src/ui/endpoints/user.ts` (`TOTP_UNAVAILABLE`, `enable_totp.php` / `disable_totp.php`), `src/ui/pages/auth.tsx` (`/totp.php` most a loginra irányít), a `user.totp_enabled` oszlop már létezik; az importálónak át kell vennie a PHP `totp` tábláját |
| 6 | OIDC/OAuth SSO, csak-SSO mód | `src/ui/endpoints/admin.ts` (`OIDC_UNAVAILABLE`), `src/ui/pages/admin.tsx`, a login oldal |
| 6 | Belépési rate limit | Workers Rate Limiting binding a `wrangler.jsonc`-ben, a login útvonalakon (`src/routes/auth.ts`, `src/ui/pages/auth.tsx`) |
| 7 | Éves költségtörténet (heti cron, PHP: `storetotalyearlycost.php`) | új migráció + `src/cron/`, a statisztika-oldal történeti grafikonja (`src/ui/pages/stats-extra.ts`) |
| 7 | AI-javaslatok (OpenAI/Gemini/Workers AI) | `src/ui/endpoints/ai.ts` (`AI_NOT_AVAILABLE`); a beállítás-felület kész (`src/ui/pages/settings.tsx`) |
| 8 | Élesítés | lásd a 3. szakaszt; plusz egyedi domain, Access/WAF, D1 Time Travel + export R2-be, deploy a GitHub Actionsből |

Hátralévő becslés: kb. 2–3 hét (ROADMAP 3. szakasz).

## 3. Élesítés (még nem történt meg)

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

## 6. Folytatás új sessionben

1. `git fetch origin claude/zen-goldberg-0hbajd && git checkout claude/zen-goldberg-0hbajd`
2. Olvasd el: `worker/SZABALYOK.md`, `worker/ATVETEL.md` (ez), `worker/ROADMAP.md` 3. szakasz.
3. `cd worker && npm install && npm run typecheck && npm test` — a kiinduló állapot: 198 zöld teszt.
4. Javasolt indító üzenet a megrendelőtől: „Mehet a 6. fázis” (TOTP, OIDC, rate limit), vagy „élesítsük” (3. szakasz).
