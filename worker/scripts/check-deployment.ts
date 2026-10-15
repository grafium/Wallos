/*
  Checks a deployed Wallos Worker from the outside, without changing anything:
  health (database reachable, version), the web interface's static files,
  the sign-in pages, the PWA manifest, the JSON API, the security headers and the HTTPS redirect.

  Usage (Node 22.18+):
    node scripts/check-deployment.ts https://wallos.example.com [--version 0.8.0]

  Exits 1 when a check fails; used by the deploy workflow and setup-cloudflare.ts.
*/

import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({ allowPositionals: true, options: { version: { type: "string" } } });
const base = positionals[0]?.replace(/\/+$/, "");
if (!base || !/^https?:\/\//.test(base)) {
  console.log("Usage: node scripts/check-deployment.ts <https://wallos.example.com> [--version x.y.z]");
  process.exit(1);
}

let failures = 0;
async function check(name: string, run: () => Promise<string | true>) {
  try {
    const result = await run();
    if (result === true) console.log(`  ✓ ${name}`);
    else {
      failures++;
      console.log(`  ✗ ${name}: ${result}`);
    }
  } catch (error) {
    failures++;
    console.log(`  ✗ ${name}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

const get = (path: string) => fetch(`${base}${path}`, { redirect: "manual", signal: AbortSignal.timeout(20_000) });

console.log(`Checking ${base}`);

await check("health: database reachable", async () => {
  const response = await get("/api/health");
  const body = (await response.json()) as { database?: string; version?: string };
  if (response.status !== 200 || body.database !== "ok") return `HTTP ${response.status} ${JSON.stringify(body)}`;
  if (values.version && body.version !== values.version) return `version ${body.version}, expected ${values.version}`;
  console.log(`    version ${body.version}`);
  return true;
});

await check("static files (Workers Static Assets)", async () => {
  const response = await get("/styles/theme.css");
  return response.status === 200 && (response.headers.get("content-type") ?? "").includes("css") ? true : `HTTP ${response.status}`;
});

await check("home page sends visitors to sign in", async () => {
  const response = await get("/");
  const location = response.headers.get("location") ?? "";
  return response.status === 302 && /(login|registration)\.php/.test(location) ? true : `HTTP ${response.status} -> ${location}`;
});

await check("login page renders", async () => {
  const response = await get("/login.php");
  if (response.status === 302 && response.headers.get("location") === "registration.php") return true; // no account yet
  const html = await response.text();
  return response.status === 200 && html.includes('action="login.php"') ? true : `HTTP ${response.status}`;
});

await check("PWA manifest", async () => {
  const response = await get("/manifest.php");
  return response.status === 200 ? true : `HTTP ${response.status}`;
});

await check("API refuses requests without credentials", async () => {
  const response = await get("/api/subscriptions");
  return response.status === 401 ? true : `HTTP ${response.status}`;
});

await check("security headers", async () => {
  const response = await get("/api/health");
  const missing = ["strict-transport-security", "x-content-type-options", "x-frame-options"].filter((h) => !response.headers.has(h));
  return missing.length === 0 ? true : `missing ${missing.join(", ")}`;
});

if (base.startsWith("https://")) {
  await check("plain HTTP redirects to HTTPS", async () => {
    const response = await fetch(`${base.replace(/^https:/, "http:")}/login.php`, { redirect: "manual", signal: AbortSignal.timeout(20_000) });
    const location = response.headers.get("location") ?? "";
    return [301, 308].includes(response.status) && location.startsWith("https://") ? true : `HTTP ${response.status} -> ${location}`;
  });
}

await check("backups are not public", async () => {
  const response = await get("/backups/wallos-2026-01-01.sql.gz");
  return response.status !== 200 ? true : "a backup path answered 200";
});

console.log(failures ? `\n${failures} check(s) failed.` : "\nAll checks passed.");
process.exit(failures ? 1 : 0);
