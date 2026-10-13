/*
  Dumps every non-empty table of a SQLite database to JSON (rowid order), the
  input format of buildImport(). Used to turn the PHP-generated fixture into
  test/fixtures/php-wallos.json:

    php scripts/fixtures/create-php-wallos-db.php /tmp/php-wallos.db
    node scripts/fixtures/dump-json.ts /tmp/php-wallos.db > test/fixtures/php-wallos.json
*/
import { DatabaseSync } from "node:sqlite";

const db = new DatabaseSync(process.argv[2]!, { readOnly: true });
const tables = db
  .prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name NOT LIKE 'sqlite_%' ORDER BY name")
  .all()
  .map((row) => String(row.name));

const out: Record<string, unknown[]> = {};
for (const table of tables) {
  const rows = db.prepare(`SELECT * FROM "${table}" ORDER BY rowid`).all();
  if (rows.length > 0) out[table] = rows.map((row) => ({ ...row }));
}
process.stdout.write(JSON.stringify(out, null, 1) + "\n");
