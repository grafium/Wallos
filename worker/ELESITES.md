# Élesítés — lépésről lépésre

Ez az útmutató a Wallos Workert a saját Cloudflare-fiókodba telepíti, átköltözteti rá a PHP Wallos adatait, és beállítja a mentést, a felügyeletet és az automatikus telepítést. A lépések sorrendben követik egymást; ami opcionális, az jelölve van.

**Amire szükség van:** Cloudflare-fiók Workers Paid csomaggal (havi 5 USD), Node 22.18+, a repó klónja (`claude/zen-goldberg-0hbajd` ág vagy a `main`, ha már be van olvasztva), e-mailhez egy Resend-fiók és egy saját domain, saját címhez egy Cloudflare-en kezelt domain.

---

## 1. Telepítés egy paranccsal

```sh
cd worker
npm install
npx wrangler login                     # böngészőben jóváhagyod
RESEND_API_KEY=re_xxx \
npm run setup:cloudflare -- \
  --location eeur \
  --email-from "Wallos <wallos@sajatdomain.hu>" \
  --app-url https://wallos.sajatdomain.hu
```

A szkript (`scripts/setup-cloudflare.ts`) újrafuttatható, és sorban:

1. ellenőrzi a bejelentkezést;
2. megkeresi vagy létrehozza a `wallos` D1 adatbázist (`--location eeur`: kelet-európai elsődleges hely; `--jurisdiction eu`: az adatok az EU-ban maradnak), és beírja az azonosítóját a `wrangler.jsonc`-be;
3. beállítja az `EMAIL_FROM` és `APP_URL` értékét;
4. megkeresi vagy létrehozza a `wallos-files` R2 bucketet;
5. lefuttatja az adatbázis-migrációkat;
6. feltölti a Workert (előtte összeállítja a felület fájljait);
7. eltárolja a környezetben megadott titkokat (`RESEND_API_KEY`, `OIDC_CLIENT_SECRET`);
8. lefuttatja a kívülről végzett ellenőrzést (`scripts/check-deployment.ts`).

`--dry-run`-nal csak kiírja, mit futtatna. **A megváltozott `wrangler.jsonc`-t commitold** (benne van az adatbázis-azonosító; nem titok), különben a GitHubról induló telepítés nem tudja, melyik adatbázist használja.

A végén kiírja a címet (pl. `https://wallos.<fiók>.workers.dev`). **Az első regisztrált felhasználó lesz az admin** — vagy előbb importáld a PHP adatbázist (4. szakasz), és akkor a régi admin marad az admin.

Ha inkább kézzel csinálnád: ROADMAP.md, 4. szakasz.

## 2. E-mail (Resend)

1. A Resendben add hozzá és hitelesítsd a domaint (DNS-rekordok; ha a domain a Cloudflare-en van, a Resend fel is tudja vinni őket).
2. Készíts API-kulcsot („Sending access” elég), és add át: `npx wrangler secret put RESEND_API_KEY` (vagy az 1. lépés `RESEND_API_KEY=` változójával).
3. Az `EMAIL_FROM` a hitelesített domainről küldjön (pl. `Wallos <wallos@sajatdomain.hu>`).
4. Próba: jelszó-visszaállítás kérése a belépési oldalon, vagy az e-mail értesítési csatorna tesztgombja a beállításokban.

E-mail nélkül minden más működik; csak a jelszó-visszaállítás, az e-mail-megerősítés és az e-mail értesítés nem.

## 3. Saját cím (opcionális)

1. A `wrangler.jsonc`-ben vedd ki a kommentből és írd át: `"routes": [{ "pattern": "wallos.sajatdomain.hu", "custom_domain": true }]`. A domainnek ugyanabban a Cloudflare-fiókban kell lennie; a DNS-rekord és a tanúsítvány a telepítéskor jön létre.
2. `APP_URL` legyen ugyanez a cím (`npm run setup:cloudflare -- --app-url https://wallos.sajatdomain.hu --skip-deploy`, vagy kézzel), majd `npm run deploy`.
3. Ha már nem kell, `"workers_dev": false` kikapcsolja a `workers.dev` címet.
4. Az admin oldalon a „Server URL” is legyen ez a cím (az e-mailes linkekhez, ha e-mail-megerősítést kérsz).

Ha a PHP Wallos ugyanezen a címen fut, ez az átállás pillanata: lásd 5. szakasz.

## 4. Adatok átköltöztetése a PHP Wallosból

1. **Állítsd le a PHP Wallos írását** (a konténer cronját is), hogy az átköltöztetés alatt ne keletkezzen új adat. Mentsd el a `db/wallos.db` fájlt és az `images/uploads/` könyvtárat.
2. Adatbázis:
   ```sh
   npm run import -- /utvonal/wallos.db -o import.sql      # jelentést ír: mi jött át, mi maradt ki, figyelmeztetések
   npx wrangler d1 execute DB --remote --file import.sql
   ```
   Ha a Workeren már próbaregisztráltál, a `--replace` kapcsoló az importálás előtt törli a meglévő felhasználókat. **Olvasd el a jelentés figyelmeztetéseit** (pl. helyi hálózati Ollama, SSO-only mód, kikapcsolt 2FA).
3. Képek (logók, ikonok, avatarok):
   ```sh
   node scripts/upload-files.ts /utvonal/a/wallos/telepiteshez   # --dry-run: csak listáz
   ```
4. Ellenőrzés: lépj be a régi jelszóval; nézd meg, hogy a főoldal havi költsége egyezik-e a PHP-ban látottal (a két szándékos eltérés a ROADMAP 4–5. kockázatában van leírva); az előfizetések logói látszanak-e.
5. Ami a címtől függ:
   - **API-kliensek** (Home Assistant, mobilapp): csak az alap URL-t kell átírni; az API-kulcsok változatlanok.
   - **OIDC:** a szolgáltatónál a visszatérési cím legyen az új Wallos-cím (pl. `https://wallos.sajatdomain.hu/`), és az admin oldalon a Redirect URL is.
   - **Web Push:** ha a cím változik, a böngészőkben újra fel kell iratkozni (a beállításokban); azonos címen a régi feliratkozások maradnak.
   - **Értesítési webhookok** változatlanul mennek; a helyi hálózati célpontokat (Gotify, ntfy a LAN-on) a Worker nem éri el — ezekhez nyilvános cím vagy Cloudflare Tunnel kell.

## 5. Átállás

- **Új cím esetén:** a régi PHP Wallos maradhat csak olvasható tartaléknak 1–2 hétig, aztán leállítható.
- **Azonos cím esetén:** töröld a régi DNS-rekordot (vagy a régi szerverre mutató proxyt), és telepítsd a Workert a 3. szakasz szerinti `routes`-szal. Ha a cím nem a Cloudflare-en volt, előbb a domain DNS-ét kell a Cloudflare-re költöztetni.
- Telepítés után: `npm run check:deployment -- https://wallos.sajatdomain.hu`.

## 6. Biztonság

- **Titkok** csak `wrangler secret put`-tal: `RESEND_API_KEY`, opcionálisan `OIDC_CLIENT_SECRET`. A `wrangler.jsonc`-ben nincs titok.
- **Beépítve:** belépés-korlátozás (cím és cím+felhasználónév szerint), kétlépcsős azonosítás, CSRF-védelem, biztonsági fejlécek (HSTS, `nosniff`, `frame-options`), a feltöltött fájlok sandbox CSP-vel.
- **Opcionális, a Cloudflare-en:**
  - *Cloudflare Access* (Zero Trust, 50 felhasználóig ingyenes) az admin felületre: `wallos.sajatdomain.hu/admin.php`, `/endpoints/admin/*`, `/api/admin/*`. Figyelem: az `/api/admin/*.php` útvonalakat API-kulccsal használó kliensek ilyenkor nem érik el.
  - *WAF Rate limiting rule* a `/login.php` és `/api/auth/login` útvonalakra (a beépített korlátozás mellé).
  - *Workers Rate Limiting* binding: a `wrangler.jsonc`-ben a `ratelimits` sor.
- Az admin felhasználó kapcsolja be a kétlépcsős azonosítást (profil oldal).

## 7. Mentés és visszaállítás

- **Heti mentés automatikusan:** vasárnap 04:00 UTC-kor a teljes adatbázis gzip-pelt SQL-dumpként az R2-be kerül (`backups/`), az utolsó 8 megmarad. Az admin oldalon („Instance backups”) kézzel is készíthető és letölthető; API: `GET/POST /api/admin/backups`. **A mentés jelszó-hasheket, API-kulcsokat és szolgáltatói titkokat tartalmaz** — a letöltött példányt biztonságban tárold.
- **Visszaállítás dumpból** (új adatbázisba, hogy a régi megmaradjon):
  ```sh
  npx wrangler d1 create wallos-restore
  #   a wrangler.jsonc-ben a d1_databases bejegyzésbe: "database_name": "wallos-restore" és a kapott database_id
  #   (a "DB" binding név innentől erre az adatbázisra mutat), majd:
  npx wrangler d1 migrations apply DB --remote
  gunzip wallos-2026-10-18.sql.gz
  npx wrangler d1 execute DB --remote --file wallos-2026-10-18.sql
  npm run deploy
  ```
  A módosított `wrangler.jsonc`-t commitold. Ha minden rendben, a régi adatbázis törölhető (`npx wrangler d1 delete wallos`).
  A bejelentkezések elvesznek (mindenki újra belép); minden más adat visszajön.
- **D1 Time Travel** (30 napra visszamenőleg, bármely percre — a gyors út egy hiba után):
  ```sh
  npx wrangler d1 time-travel info wallos
  npx wrangler d1 time-travel restore wallos --timestamp 2026-10-18T10:00:00Z
  ```
- **Képek:** az R2 nem verziózott. Ha a logókról is külön mentés kell, az R2 S3-kompatibilis API-jával (pl. `rclone sync`) másold időnként máshova.
- Kockázatos módosítás (pl. új migráció) előtt készíts kézi mentést az admin oldalon.

## 8. Automatikus telepítés GitHubról (opcionális)

1. Cloudflare → *My Profile → API Tokens → Create Token* → „Edit Cloudflare Workers” sablon, és add hozzá: *Account → D1 → Edit*. (Saját címhez: *Zone → Workers Routes → Edit* a zónára.)
2. GitHub → a repó *Settings → Secrets and variables → Actions*:
   - secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID` (a fiók azonosítója a Cloudflare kezdőoldalán);
   - variable (opcionális): `WALLOS_URL` = a Wallos címe (a telepítés utáni ellenőrzéshez).
3. A `.github/workflows/worker-deploy.yaml` telepít:
   - `worker-v*` tag pusholásakor bármely ágon: `git tag worker-v0.8.0 && git push origin worker-v0.8.0`;
   - a `main` ágra érkező, `worker/`-t érintő pushnál;
   - kézzel (*Actions → Worker deploy → Run workflow*; ez a `main` ágon lévő workflow-ból indítható).
   Minden futás: típusellenőrzés, tesztek, migrációk, telepítés, ellenőrzés.

## 9. Felügyelet

- **Naplók:** Cloudflare → *Workers & Pages → wallos → Logs* (Workers Logs be van kapcsolva), élőben `npx wrangler tail`.
- **Cron:** ugyanott *Settings → Trigger events*; minden feladat egy sort naplóz (`updatenextpayment: …`, `backup: …`).
- **Elérhetőség:** a `GET /api/health` 200-at és `"database": "ok"`-t ad; kösd be egy külső figyelőbe (pl. Cloudflare Health Checks vagy UptimeRobot).
- **Riasztás:** Cloudflare → *Notifications* (pl. Workers-hibaarány), Resend → bounce/complaint értesítések.

## 10. Ha valami elromlik

- Rossz verzió ment ki: `npx wrangler deployments list`, majd `npx wrangler rollback` (az előző verzióra; az adatbázist nem érinti).
- Adathiba: D1 Time Travel vagy a heti dump (7. szakasz).
- Senki nem tud belépni SSO-only módban: `OIDC_DISABLE_PASSWORD_LOGIN=false` változó, vagy `npx wrangler d1 execute DB --remote --command "UPDATE oauth_settings SET password_login_disabled = 0"`.
- Az admin elvesztette a 2FA-ját és a mentőkódjait: `npx wrangler d1 execute DB --remote --command "UPDATE user SET totp_enabled = 0 WHERE id = 1; DELETE FROM totp WHERE user_id = 1"`.

## 11. Élesítés utáni ellenőrzőlista

- [ ] `npm run check:deployment -- <cím>` minden pontja zöld.
- [ ] Belépés a régi jelszóval; a havi költség stimmel; a logók látszanak.
- [ ] Jelszó-visszaállító e-mail megérkezik; e-mail értesítési csatorna tesztje sikeres.
- [ ] Web Push: feliratkozás és tesztüzenet egy valódi böngészőben.
- [ ] Árfolyam-frissítés a beállításokban; logókeresés működik.
- [ ] OIDC-belépés (ha használod) a valódi szolgáltatóval.
- [ ] AI-javaslat (ha használod) a valódi szolgáltatóval; kategóriafordítás.
- [ ] Az admin oldalon kézi mentés készül és letölthető; az első vasárnapi automatikus mentés megjelenik.
- [ ] Az első hétfő után a statisztika oldalon megjelenik a költségtörténet első pontja.
- [ ] Az admin 2FA-ja be van kapcsolva.

## Költségek (tájékoztató)

A Workers Paid csomag (havi 5 USD) tartalmazza a Workers-kéréseket (havi 10 millió), a D1 és a Workers Logs alapkeretét; egy háztartásnyi Wallos bőven belefér. Az R2 havi 10 GB-ig ingyenes. A Workers AI és a Cloudflare Images opcionális, használat szerint számláz (a Workers AI-nak napi ingyenes kerete van). A Resend ingyenes csomagja havi 3000 e-mailt enged.
