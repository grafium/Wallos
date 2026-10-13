import { describe, expect, it } from "vitest";
import config from "../wrangler.jsonc?raw";
import { configuredDatabaseId, databaseIdFrom, deployedUrl, setDatabaseId, setVar, UUID } from "../scripts/lib/wrangler-config";

/*
  The wrangler.jsonc edits of scripts/setup-cloudflare.ts, on the real file.
*/

const id = "6f1c2a3b-4d5e-4f60-8a9b-0c1d2e3f4a5b";
const parse = (jsonc: string) => JSON.parse(jsonc.replace(/^\s*\/\/.*$/gm, "").replace(/,(\s*[}\]])/g, "$1"));

describe("wrangler.jsonc edits", () => {
  it("has a database id: the placeholder, or the real one setup-cloudflare.ts wrote", () => {
    expect(configuredDatabaseId(config)).toMatch(new RegExp(`^${UUID.source}$`, "i"));
  });

  it("sets the database id and variables, keeping comments and validity", () => {
    let edited = setDatabaseId(config, id);
    edited = setVar(edited, "EMAIL_FROM", 'Wallos "Home" <wallos@example.hu>');
    edited = setVar(edited, "APP_URL", "https://wallos.example.hu");
    edited = setVar(edited, "OIDC_ENABLED", "true");
    expect(configuredDatabaseId(edited)).toBe(id);
    expect(edited).toContain("// Uploaded logos, icons and avatars.");
    const parsed = parse(edited);
    expect(parsed.d1_databases[0].database_id).toBe(id);
    expect(parsed.vars).toMatchObject({ EMAIL_FROM: 'Wallos "Home" <wallos@example.hu>', APP_URL: "https://wallos.example.hu", OIDC_ENABLED: "true", SESSION_TTL_DAYS: "30" });
    expect(() => setDatabaseId(config, "not-an-id")).toThrow();
  });

  it("reads ids and URLs from wrangler's output", () => {
    expect(databaseIdFrom(JSON.stringify([{ name: "other", uuid: "x" }, { name: "wallos", uuid: id }]), "wallos")).toBe(id);
    expect(databaseIdFrom("[]", "wallos")).toBeNull();
    expect(databaseIdFrom(`✅ Successfully created DB 'wallos'\n{\n  "d1_databases": [{ "binding": "DB", "database_name": "wallos", "database_id": "${id}" }]\n}`)).toBe(id);
    expect(deployedUrl("Uploaded wallos\nDeployed wallos triggers\n  https://wallos.someone.workers.dev\n  schedule: 0 * * * *")).toBe("https://wallos.someone.workers.dev");
  });
});
