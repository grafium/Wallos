// Browser smoke test against a running `wrangler dev`.
//
//   npm run db:migrate:local && npm run dev -- --port 8799   (fresh .wrangler/state: first run registers the admin)
//   node scripts/smoke-test.mjs
//
// Registers an admin through the form (or signs in), visits every page, then
// adds a subscription through the form, opens its details, adds a category
// and checks that the stats charts render. Reports page errors, console
// errors and HTTP >= 400 responses; exits 1 when there are any.
//
// Needs Playwright with a Chromium: `npm i -g playwright` (or set
// PLAYWRIGHT_MODULE to its path). Env: BASE (default http://localhost:8799),
// SHOTS (screenshot directory, default the OS temp dir), PAGES (comma list),
// SKIP_INTERACTIONS=1, USERNAME_SMOKE / PASSWORD_SMOKE (default admin / supersecret).
import { createRequire } from "node:module";
import { tmpdir } from "node:os";
import { execSync } from "node:child_process";

function loadPlaywright() {
  const require = createRequire(import.meta.url);
  const candidates = [process.env.PLAYWRIGHT_MODULE, "playwright"];
  try {
    candidates.push(`${execSync("npm root -g").toString().trim()}/playwright`);
  } catch {}
  for (const name of candidates.filter(Boolean)) {
    try {
      return require(name);
    } catch {}
  }
  throw new Error("Playwright not found: npm i -g playwright, or set PLAYWRIGHT_MODULE");
}

const { chromium } = loadPlaywright();
const BASE = process.env.BASE ?? "http://localhost:8799";
const SHOTS = process.env.SHOTS ?? tmpdir();
const USERNAME = process.env.USERNAME_SMOKE ?? "admin";
const PASSWORD = process.env.PASSWORD_SMOKE ?? "supersecret";

const browser = await chromium.launch();
// A real locale: headless Chromium otherwise reports the container's POSIX
// locale (en-US@posix), which Intl - and so the unchanged stats.js - rejects.
const page = await browser.newPage({ viewport: { width: 1280, height: 900 }, locale: "en-US" });
const problems = [];
const log = (...a) => console.log("  ·", ...a);
page.on("pageerror", (e) => problems.push(`pageerror on ${page.url()}: ${e.message}`));
page.on("console", (m) => m.type() === "error" && problems.push(`console on ${page.url()}: ${m.text()}`));
page.on("response", (r) => r.status() >= 400 && !r.url().includes("favicon") && problems.push(`HTTP ${r.status()} ${r.url()}`));

// --- sign in ------------------------------------------------------------------------------
await page.goto(`${BASE}/`);
if (page.url().includes("registration.php")) {
  await page.fill("#username", USERNAME);
  await page.fill("#email", `${USERNAME}@example.com`);
  await page.fill("#password", PASSWORD);
  await page.fill("#confirm_password", PASSWORD);
  await page.click('input[type="submit"]');
}
if (!page.url().match(/(\/|index\.php|subscriptions\.php)$/) || page.url().includes("login.php")) {
  await page.waitForURL(/login\.php/);
  await page.fill("#username", USERNAME);
  await page.fill("#password", PASSWORD);
  await page.click('input[type="submit"]');
}
await page.waitForLoadState("networkidle");
console.log("after login:", page.url());

// --- page tour ----------------------------------------------------------------------------
const pages = (process.env.PAGES ?? "index.php,subscriptions.php,calendar.php,stats.php,settings.php,profile.php,admin.php,about.php").split(",");
for (const p of pages) {
  const response = await page.goto(`${BASE}/${p}`);
  await page.waitForLoadState("networkidle");
  await page.screenshot({ path: `${SHOTS}/${p.replace(".php", "")}.png` });
  console.log(`${p}: ${response?.status()} -> ${page.url()}`);
}

// --- interactions -------------------------------------------------------------------------
if (!process.env.SKIP_INTERACTIONS) {
  const name = `Smoke ${Date.now()}`;
  await page.goto(`${BASE}/subscriptions.php`);
  await page.waitForLoadState("networkidle");
  // The page has two "add" buttons; one sits in the hidden empty-state block.
  await page.locator('button[onclick="addSubscription()"]:visible').first().click();
  await page.fill("#name", name);
  await page.fill("#price", "12.34");
  await page.fill("#next_payment", new Date(Date.now() + 86400000).toISOString().slice(0, 10));
  await page.click("#save-button");
  await page.waitForTimeout(1500);
  const listed = await page.locator(".subscription", { hasText: name }).count();
  log("subscription added via form:", listed);
  if (!listed) problems.push("added subscription not visible in list");
  await page.screenshot({ path: `${SHOTS}/subscriptions-after-add.png` });

  await page.goto(`${BASE}/`);
  await page.waitForLoadState("networkidle");
  const item = page.locator(".subscription-item[data-id]", { hasText: name }).first();
  if (await item.count()) {
    await item.click();
    await page.waitForTimeout(800);
    const shown = await page.locator("#details-name").textContent();
    log("details dialog:", shown);
    if (!shown?.includes(name)) problems.push(`details dialog shows "${shown}"`);
    await page.screenshot({ path: `${SHOTS}/dashboard-details.png` });
  } else problems.push("subscription missing from the dashboard");

  await page.goto(`${BASE}/settings.php`);
  await page.waitForLoadState("networkidle");
  const before = await page.locator("#categories .form-group-inline").count();
  await page.click("#addCategory");
  await page.waitForTimeout(1200);
  const after = await page.locator("#categories .form-group-inline").count();
  log("categories before/after:", before, after);
  if (!(after > before)) problems.push("adding a category did not add a row");

  await page.goto(`${BASE}/stats.php`);
  await page.waitForLoadState("networkidle");
  const charts = await page.locator(".apexcharts-canvas").count();
  log("charts rendered:", charts);
  if (!charts) problems.push("no chart rendered on stats.php");
}

await browser.close();
console.log(problems.length ? `PROBLEMS (${problems.length}):\n${problems.join("\n")}` : "no problems");
console.log(`screenshots: ${SHOTS}`);
process.exit(problems.length ? 1 : 0);
