/*
  TOTP (RFC 6238) with WebCrypto, matching what PHP Wallos used (OTPHP):
  SHA-1, 6 digits, 30-second period, base32 secrets, and a 15-second leeway
  either side of now - so a code is accepted from the step before or after
  only when the clock is within 15 seconds of the boundary.
*/

export const TOTP_PERIOD = 30;
export const TOTP_LEEWAY = 15;
const DIGITS = 6;
const ALPHABET = "ABCDEFGHIJKLMNOPQRSTUVWXYZ234567";

export function base32Encode(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = "";
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += ALPHABET[(value << (5 - bits)) & 31];
  return out;
}

/** Decodes base32 (case-insensitive, padding and spaces ignored); null when it is not base32. */
export function base32Decode(text: string): Uint8Array | null {
  const clean = text.replace(/[\s=]/g, "").toUpperCase();
  if (!clean || /[^A-Z2-7]/.test(clean)) return null;
  const out = new Uint8Array(Math.floor((clean.length * 5) / 8));
  let bits = 0;
  let value = 0;
  let index = 0;
  for (const char of clean) {
    value = (value << 5) | ALPHABET.indexOf(char);
    bits += 5;
    if (bits >= 8) {
      out[index++] = (value >>> (bits - 8)) & 255;
      bits -= 8;
    }
  }
  return out;
}

/** A new 160-bit secret, base32 encoded (32 characters), as enable_totp.php generated. */
export function generateTotpSecret(): string {
  return base32Encode(crypto.getRandomValues(new Uint8Array(20)));
}

/** True for secrets the Worker accepts: base32 of at least 80 bits. */
export function isValidTotpSecret(secret: string): boolean {
  const bytes = base32Decode(secret);
  return bytes !== null && bytes.length >= 10 && bytes.length <= 64;
}

export function otpauthUrl(username: string, secret: string): string {
  return `otpauth://totp/Wallos:${encodeURIComponent(username)}?secret=${secret}&issuer=Wallos`;
}

/** The code for a time step (HOTP, RFC 4226). */
export async function totpCode(secret: string, step: number): Promise<string> {
  const key = base32Decode(secret);
  if (!key) throw new Error("Invalid TOTP secret");
  const counter = new Uint8Array(8);
  new DataView(counter.buffer).setBigUint64(0, BigInt(step));
  const hmacKey = await crypto.subtle.importKey("raw", key, { name: "HMAC", hash: "SHA-1" }, false, ["sign"]);
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", hmacKey, counter));
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary =
    ((mac[offset]! & 0x7f) << 24) | (mac[offset + 1]! << 16) | (mac[offset + 2]! << 8) | mac[offset + 3]!;
  return String(binary % 10 ** DIGITS).padStart(DIGITS, "0");
}

export const timeStep = (unixSeconds: number) => Math.floor(unixSeconds / TOTP_PERIOD);

function sameString(a: string, b: string): boolean {
  if (a.length !== b.length) return false;
  const encoder = new TextEncoder();
  return crypto.subtle.timingSafeEqual(encoder.encode(a), encoder.encode(b));
}

/**
 * Checks a code against now - 15 s, now and now + 15 s, like totp.php.
 * Returns the time step that matched, or null.
 */
export async function matchTotp(secret: string, code: string, nowSeconds = Math.floor(Date.now() / 1000)): Promise<number | null> {
  const normalized = code.replace(/\s/g, "");
  if (!/^\d{6}$/.test(normalized)) return null;
  for (const candidate of [nowSeconds - TOTP_LEEWAY, nowSeconds, nowSeconds + TOTP_LEEWAY]) {
    if (candidate < 0) continue;
    const step = timeStep(candidate);
    if (sameString(await totpCode(secret, step), normalized)) return step;
  }
  return null;
}
