import bcrypt from "bcryptjs";

/*
  Password hashing.

  New hashes use PBKDF2-SHA256 from WebCrypto, which runs natively in the
  Workers runtime. 100 000 iterations is the maximum workerd accepts.

  Accounts imported from PHP Wallos carry bcrypt hashes ($2y$...). Those are
  still accepted and flagged for rehashing, so each user moves to PBKDF2 on
  their next successful login. bcrypt runs in JavaScript here and costs tens
  of milliseconds of CPU, which is why it is only a migration path.
*/

const PBKDF2_ITERATIONS = 100_000;
const PBKDF2_PREFIX = "pbkdf2_sha256";
const encoder = new TextEncoder();

function toBase64(bytes: Uint8Array): string {
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary);
}

function fromBase64(value: string): Uint8Array {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function toHex(bytes: ArrayBuffer | Uint8Array): string {
  return [...new Uint8Array(bytes)].map((b) => b.toString(16).padStart(2, "0")).join("");
}

async function pbkdf2(password: string, salt: Uint8Array, iterations: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", encoder.encode(password), "PBKDF2", false, ["deriveBits"]);
  const bits = await crypto.subtle.deriveBits({ name: "PBKDF2", hash: "SHA-256", salt, iterations }, key, 256);
  return new Uint8Array(bits);
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.byteLength !== b.byteLength) return false;
  return crypto.subtle.timingSafeEqual(a, b);
}

export async function hashPassword(password: string): Promise<string> {
  const salt = crypto.getRandomValues(new Uint8Array(16));
  const hash = await pbkdf2(password, salt, PBKDF2_ITERATIONS);
  return `${PBKDF2_PREFIX}$${PBKDF2_ITERATIONS}$${toBase64(salt)}$${toBase64(hash)}`;
}

export interface PasswordCheck {
  valid: boolean;
  /** True when the stored hash should be replaced by a fresh PBKDF2 hash. */
  needsRehash: boolean;
}

export async function verifyPassword(password: string, stored: string): Promise<PasswordCheck> {
  if (stored.startsWith(`${PBKDF2_PREFIX}$`)) {
    const [, iterations, salt, hash] = stored.split("$");
    if (!iterations || !salt || !hash) return { valid: false, needsRehash: false };
    const rounds = Number(iterations);
    const actual = await pbkdf2(password, fromBase64(salt), rounds);
    const valid = timingSafeEqual(actual, fromBase64(hash));
    return { valid, needsRehash: valid && rounds !== PBKDF2_ITERATIONS };
  }

  if (/^\$2[aby]\$/.test(stored)) {
    // PHP writes $2y$, which is the same algorithm as $2b$.
    const valid = await bcrypt.compare(password, stored.replace(/^\$2y\$/, "$2b$"));
    return { valid, needsRehash: valid };
  }

  return { valid: false, needsRehash: false };
}

/** Random hex string; 32 bytes matches PHP's bin2hex(random_bytes(32)) API keys. */
export function randomToken(bytes = 32): string {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

export async function sha256Hex(value: string): Promise<string> {
  return toHex(await crypto.subtle.digest("SHA-256", encoder.encode(value)));
}
