/*
  Copies the uploaded images of a PHP Wallos installation into the R2 bucket,
  under the same paths (images/uploads/logos/... and .../avatars/...), so the
  file names stored in the database keep pointing at them.

  Usage (Node 22.18+, from worker/):
    node scripts/upload-files.ts <wallos directory> [--bucket wallos-files] [--local] [--dry-run]

  <wallos directory> is the PHP installation (or a copy of its images/ folder's
  parent); in Docker that is the /var/www/html volume. Files are uploaded with
  `wrangler r2 object put`, to the remote bucket unless --local is given.
*/

import { execFileSync } from "node:child_process";
import { existsSync, openSync, readdirSync, readSync, closeSync, statSync } from "node:fs";
import { join, relative, sep } from "node:path";
import { parseArgs } from "node:util";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: {
    bucket: { type: "string", default: "wallos-files" },
    local: { type: "boolean", default: false },
    "dry-run": { type: "boolean", default: false },
    help: { type: "boolean", short: "h", default: false },
  },
});

const [root] = positionals;
if (values.help || !root) {
  console.log("Usage: node scripts/upload-files.ts <wallos directory> [--bucket wallos-files] [--local] [--dry-run]");
  process.exit(values.help ? 0 : 1);
}

const logosDir = join(root, "images", "uploads", "logos");
if (!existsSync(logosDir)) {
  console.error(`${logosDir} does not exist; point the script at the Wallos installation directory.`);
  process.exit(1);
}

const MAX_BYTES = 5 * 1024 * 1024;

function contentType(path: string): string | null {
  const fd = openSync(path, "r");
  const head = Buffer.alloc(12);
  readSync(fd, head, 0, 12, 0);
  closeSync(fd);
  const ascii = (start: number, length: number) => head.toString("latin1", start, start + length);
  if (head[0] === 0x89 && ascii(1, 3) === "PNG") return "image/png";
  if (head[0] === 0xff && head[1] === 0xd8) return "image/jpeg";
  if (ascii(0, 3) === "GIF") return "image/gif";
  if (ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
  if (ascii(4, 4) === "ftyp") return "image/avif";
  return null; // SVG and anything else is not served from uploads
}

function walk(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return walk(path);
    return entry.isFile() ? [path] : [];
  });
}

let uploaded = 0;
let skipped = 0;
for (const path of walk(logosDir)) {
  const key = relative(root, path).split(sep).join("/");
  const type = contentType(path);
  if (!type || statSync(path).size > MAX_BYTES || !/^images\/uploads\/logos\/(avatars\/)?[A-Za-z0-9][A-Za-z0-9._-]*$/.test(key)) {
    console.log(`skip   ${key}`);
    skipped++;
    continue;
  }
  console.log(`${values["dry-run"] ? "would " : ""}upload ${key} (${type})`);
  if (!values["dry-run"]) {
    execFileSync(
      "npx",
      ["wrangler", "r2", "object", "put", `${values.bucket}/${key}`, "--file", path, "--content-type", type, values.local ? "--local" : "--remote"],
      { stdio: ["ignore", "ignore", "inherit"] },
    );
  }
  uploaded++;
}
console.log(`\n${uploaded} file(s) ${values["dry-run"] ? "to upload" : "uploaded"}, ${skipped} skipped.`);
