/*
  Converts a PHP Wallos database (db/wallos.db) into a SQL file for D1.

  Usage (Node 22.18+):
    node scripts/import-wallos.ts <wallos.db> [-o import.sql] [--replace] [--json-report report.json]

  Then:
    npx wrangler d1 migrations apply wallos --remote
    npx wrangler d1 execute wallos --remote --file import.sql

  Run it against a freshly migrated, empty database. With --replace the file
  starts by deleting every existing user and all of their data.
*/

import { writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { parseArgs } from "node:util";
import { buildImport, type SourceTables } from "../src/import/wallos-import.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    out: { type: "string", short: "o", default: "import.sql" },
    replace: { type: "boolean", default: false },
    "json-report": { type: "string" },
    help: { type: "boolean", short: "h", default: false },
  },
});

const [databasePath] = positionals;
if (values.help || !databasePath) {
  console.log("Usage: node scripts/import-wallos.ts <wallos.db> [-o import.sql] [--replace] [--json-report report.json]");
  process.exit(values.help ? 0 : 1);
}

const db = new DatabaseSync(databasePath, { readOnly: true });

const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((row) => String(row.name));

const source: SourceTables = {};
for (const table of tables) {
  source[table] = db.prepare(`SELECT * FROM "${table.replace(/"/g, '""')}" ORDER BY rowid`).all() as SourceTables[string];
}
db.close();

if (!source.user) {
  console.error(`${databasePath} does not look like a Wallos database (no "user" table).`);
  process.exit(1);
}

const { statements, report } = buildImport(source, { replace: values.replace });

const header = [
  `-- Wallos import generated ${new Date().toISOString()} from ${databasePath}`,
  "-- Apply to a migrated D1 database: npx wrangler d1 execute wallos --remote --file <this file>",
  "",
];
writeFileSync(values.out!, header.join("\n") + statements.join("\n") + "\n");

if (values["json-report"]) {
  writeFileSync(values["json-report"], JSON.stringify(report, null, 2) + "\n");
}

console.log(`Wrote ${statements.length} statements to ${values.out}\n`);
console.log("Imported rows:");
for (const [table, n] of Object.entries(report.imported)) console.log(`  ${table.padEnd(20)} ${n}`);
if (Object.keys(report.skipped).length) {
  console.log("\nSkipped rows (orphaned or duplicate):");
  for (const [table, n] of Object.entries(report.skipped)) console.log(`  ${table.padEnd(20)} ${n}`);
}
if (Object.keys(report.notImported).length) {
  console.log("\nNot imported yet (arrives in a later phase):");
  for (const [table, { rows, phase }] of Object.entries(report.notImported)) {
    console.log(`  ${table.padEnd(26)} ${String(rows).padStart(5)} row(s)  phase ${phase}`);
  }
}
const files = report.files.logos.length + report.files.avatars.length;
if (files) {
  console.log(`\n${report.files.logos.length} logo(s) and ${report.files.avatars.length} avatar(s) are referenced; copy them to R2 with: node scripts/upload-files.ts <wallos directory>`);
}
if (report.warnings.length) {
  console.log(`\nWarnings (${report.warnings.length}):`);
  for (const warning of report.warnings) console.log(`  - ${warning}`);
}
