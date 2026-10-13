/*
  First deployment to a Cloudflare account, in one go (and safe to run again):

    1. checks that wrangler is signed in (`npx wrangler login`, or a
       CLOUDFLARE_API_TOKEN + CLOUDFLARE_ACCOUNT_ID in the environment);
    2. finds or creates the D1 database and writes its id into wrangler.jsonc;
    3. optionally sets EMAIL_FROM / APP_URL in wrangler.jsonc;
    4. finds or creates the R2 bucket;
    5. applies the D1 migrations;
    6. deploys the Worker (the web interface's files are built first);
    7. stores the secrets given in the environment (RESEND_API_KEY,
       OIDC_CLIENT_SECRET) with `wrangler secret put`;
    8. checks the deployed Worker (scripts/check-deployment.ts).

  Usage (Node 22.18+, from worker/):
    node scripts/setup-cloudflare.ts [--location eeur] [--jurisdiction eu]
      [--email-from "Wallos <wallos@example.com>"] [--app-url https://wallos.example.com]
      [--database wallos] [--bucket wallos-files] [--skip-deploy] [--dry-run]

  --dry-run prints the commands without running them (and does not touch
  wrangler.jsonc). The step-by-step guide is ELESITES.md.
*/

import { execFileSync, spawnSync } from "node:child_process";
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseArgs } from "node:util";
import { configuredDatabaseId, databaseIdFrom, deployedUrl, PLACEHOLDER_DATABASE_ID, setDatabaseId, setVar } from "./lib/wrangler-config.ts";

const { values } = parseArgs({
  options: {
    database: { type: "string", default: "wallos" },
    bucket: { type: "string", default: "wallos-files" },
    location: { type: "string" },
    jurisdiction: { type: "string" },
    "email-from": { type: "string" },
    "app-url": { type: "string" },
    "skip-deploy": { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

if (values.help) {
  console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0]!.replace("/*", "").trim());
  process.exit(0);
}

const dryRun = values["dry-run"];
const root = join(import.meta.dirname, "..");
const configPath = join(root, "wrangler.jsonc");
const npx = process.platform === "win32" ? "npx.cmd" : "npx";

function step(title: string) {
  console.log(`\n▶ ${title}`);
}

/** Runs wrangler and returns its output; in a dry run only prints the command. */
function wrangler(args: string[], options: { input?: string; quiet?: boolean; allowFailure?: boolean } = {}): string {
  console.log(`  $ npx wrangler ${args.join(" ")}`);
  if (dryRun) return "";
  try {
    const output = execFileSync(npx, ["wrangler", ...args], {
      cwd: root,
      input: options.input,
      encoding: "utf8",
      stdio: [options.input === undefined ? "inherit" : "pipe", "pipe", options.quiet ? "pipe" : "inherit"],
    });
    if (!options.quiet) process.stdout.write(output);
    return output;
  } catch (error) {
    if (options.allowFailure) return "";
    const output = (error as { stdout?: string }).stdout ?? "";
    console.error(output);
    throw new Error(`wrangler ${args[0]} ${args[1] ?? ""} failed`);
  }
}

function editConfig(edit: (config: string) => string, what: string) {
  if (dryRun) {
    console.log(`  (would set ${what} in wrangler.jsonc)`);
    return;
  }
  const before = readFileSync(configPath, "utf8");
  const after = edit(before);
  if (after !== before) {
    writeFileSync(configPath, after);
    console.log(`  wrangler.jsonc: ${what}`);
  }
}

// 1. Signed in? ---------------------------------------------------------------------------
step("Cloudflare account");
const whoami = wrangler(["whoami"], { quiet: true, allowFailure: true });
if (!dryRun && (!whoami.trim() || /not authenticated|not logged in/i.test(whoami))) {
  console.error("  Not signed in. Run `npx wrangler login`, or set CLOUDFLARE_API_TOKEN and CLOUDFLARE_ACCOUNT_ID.");
  process.exit(1);
}

// 2. D1 database -------------------------------------------------------------------------
step(`D1 database "${values.database}"`);
let databaseId = databaseIdFrom(wrangler(["d1", "list", "--json"], { quiet: true }), values.database);
if (databaseId) {
  console.log(`  exists: ${databaseId}`);
} else {
  const args = ["d1", "create", values.database!];
  if (values.jurisdiction) args.push("--jurisdiction", values.jurisdiction);
  else if (values.location) args.push("--location", values.location);
  databaseId = databaseIdFrom(wrangler(args, { quiet: true }));
  if (!dryRun && !databaseId) throw new Error("Could not read the new database's id from wrangler's output.");
  console.log(`  created: ${databaseId ?? "(dry run)"}`);
}
if (databaseId) {
  const current = configuredDatabaseId(readFileSync(configPath, "utf8"));
  if (current && current !== PLACEHOLDER_DATABASE_ID && current !== databaseId) {
    console.warn(`  wrangler.jsonc pointed at ${current}; switching it to ${databaseId}.`);
  }
  editConfig((config) => setDatabaseId(config, databaseId!), `database_id = ${databaseId}`);
}

// 3. Variables ---------------------------------------------------------------------------
if (values["email-from"]) editConfig((c) => setVar(c, "EMAIL_FROM", values["email-from"]!), `EMAIL_FROM = ${values["email-from"]}`);
if (values["app-url"]) editConfig((c) => setVar(c, "APP_URL", values["app-url"]!.replace(/\/+$/, "")), `APP_URL = ${values["app-url"]}`);

// 4. R2 bucket ---------------------------------------------------------------------------
step(`R2 bucket "${values.bucket}"`);
const buckets = wrangler(["r2", "bucket", "list"], { quiet: true });
if (new RegExp(`(^|\\s|name:\\s*)${values.bucket}(\\s|$)`, "m").test(buckets)) {
  console.log("  exists");
} else {
  const args = ["r2", "bucket", "create", values.bucket!];
  if (values.jurisdiction) args.push("--jurisdiction", values.jurisdiction);
  wrangler(args);
}

// 5. Migrations ---------------------------------------------------------------------------
step("D1 migrations");
wrangler(["d1", "migrations", "apply", "DB", "--remote"], { input: "y\n" });

// 6. Deploy --------------------------------------------------------------------------------
let url: string | null = values["app-url"]?.replace(/\/+$/, "") ?? null;
if (!values["skip-deploy"]) {
  step("Deploy");
  console.log("  $ npm run build:assets");
  if (!dryRun) spawnSync(process.platform === "win32" ? "npm.cmd" : "npm", ["run", "build:assets"], { cwd: root, stdio: "inherit" });
  const output = wrangler(["deploy"], { quiet: false });
  url ??= deployedUrl(output);
}

// 7. Secrets -------------------------------------------------------------------------------
step("Secrets");
for (const name of ["RESEND_API_KEY", "OIDC_CLIENT_SECRET"]) {
  const value = process.env[name];
  if (value) wrangler(["secret", "put", name], { input: `${value}\n`, quiet: true });
  else console.log(`  ${name}: not in the environment, skipped (later: npx wrangler secret put ${name})`);
}

// 8. Check ----------------------------------------------------------------------------------
if (url && !dryRun && !values["skip-deploy"]) {
  step(`Checking ${url}`);
  const check = spawnSync(process.execPath, [join(root, "scripts", "check-deployment.ts"), url], { stdio: "inherit" });
  if (check.status !== 0) process.exit(check.status ?? 1);
}

console.log(`
Done.${url ? ` Open ${url} - the first account registered becomes the administrator.` : ""}
Next: import the PHP database or register, set up e-mail and a custom domain (ELESITES.md).`);
