/*
  Small, comment-preserving edits of wrangler.jsonc for scripts/setup-cloudflare.ts.
  Plain string work (no Node APIs) so the tests can run it in the Workers runtime.
*/

export const PLACEHOLDER_DATABASE_ID = "00000000-0000-0000-0000-000000000000";
export const UUID = /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

/** The database_id written in the config. */
export function configuredDatabaseId(config: string): string | null {
  return /"database_id"\s*:\s*"([^"]*)"/.exec(config)?.[1] ?? null;
}

/** Puts the real database id in place of the placeholder (or a previous id). */
export function setDatabaseId(config: string, id: string): string {
  if (!UUID.test(id)) throw new Error(`Not a D1 database id: ${id}`);
  return config.replace(/("database_id"\s*:\s*")[^"]*(")/, `$1${id}$2`);
}

/** Sets a string in "vars", keeping the rest of the file (and its comments) as it is. */
export function setVar(config: string, name: string, value: string): string {
  const escaped = JSON.stringify(value);
  // An existing setting, but not one inside a // comment (wrangler.jsonc documents optional ones that way).
  const existing = new RegExp(`("${name}"\\s*:\\s*)"(?:[^"\\\\]|\\\\.)*"`, "g");
  for (const match of config.matchAll(existing)) {
    const lineStart = config.lastIndexOf("\n", match.index) + 1;
    if (config.slice(lineStart, match.index).includes("//")) continue;
    return config.slice(0, match.index) + match[1] + escaped + config.slice(match.index + match[0].length);
  }
  const vars = /"vars"\s*:\s*\{/.exec(config);
  if (!vars) throw new Error('wrangler.jsonc has no "vars" block');
  const at = vars.index + vars[0].length;
  return `${config.slice(0, at)}\n    "${name}": ${escaped},${config.slice(at)}`;
}

/** Finds a database id in the output of `wrangler d1 create` / `d1 list --json`. */
export function databaseIdFrom(output: string, name?: string): string | null {
  try {
    const parsed = JSON.parse(output) as unknown;
    if (Array.isArray(parsed)) {
      const match = parsed.find((db) => db && typeof db === "object" && (db as { name?: string }).name === name) as { uuid?: string } | undefined;
      return match?.uuid ?? null;
    }
  } catch {
    // not JSON: take the first id in the text
  }
  return UUID.exec(output)?.[0] ?? null;
}

/** The workers.dev (or custom) URL `wrangler deploy` printed. */
export function deployedUrl(output: string): string | null {
  return /https:\/\/[a-z0-9.-]+\.workers\.dev\b/i.exec(output)?.[0] ?? null;
}
