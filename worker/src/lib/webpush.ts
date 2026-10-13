/*
  Web Push without a library: VAPID (RFC 8292) for authentication and the
  aes128gcm content coding (RFC 8291 / RFC 8188) for the payload, all with
  WebCrypto. Port of includes/webpush_helper.php.

  The instance key pair is stored like PHP Wallos stores it - public key as
  base64url of the raw uncompressed P-256 point, private key as PEM - so the
  browsers' existing push subscriptions survive an import.
*/

const encoder = new TextEncoder();

export function base64urlEncode(bytes: ArrayBuffer | Uint8Array): string {
  let binary = "";
  for (const byte of new Uint8Array(bytes)) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function base64urlDecode(value: string): Uint8Array {
  const base64 = value.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(value.length / 4) * 4, "=");
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

function concat(...parts: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(parts.reduce((n, p) => n + p.length, 0));
  let offset = 0;
  for (const part of parts) {
    out.set(part, offset);
    offset += part.length;
  }
  return out;
}

// --- keys ------------------------------------------------------------------

export interface VapidKeys {
  /** base64url of the 65-byte uncompressed public point. */
  publicKey: string;
  /** PKCS#8 PEM. */
  privateKeyPem: string;
}

function toPem(der: ArrayBuffer, label: string): string {
  const base64 = btoa(String.fromCharCode(...new Uint8Array(der)));
  return `-----BEGIN ${label}-----\n${base64.match(/.{1,64}/g)!.join("\n")}\n-----END ${label}-----\n`;
}

function derLength(length: number): Uint8Array {
  if (length < 0x80) return Uint8Array.of(length);
  if (length < 0x100) return Uint8Array.of(0x81, length);
  return Uint8Array.of(0x82, length >> 8, length & 0xff);
}

function der(tag: number, content: Uint8Array): Uint8Array {
  return concat(Uint8Array.of(tag), derLength(content.length), content);
}

/** Wraps a SEC1 "EC PRIVATE KEY" (what older OpenSSL exports) into PKCS#8 for WebCrypto. */
function sec1ToPkcs8(sec1: Uint8Array): Uint8Array {
  const ecPublicKey = Uint8Array.of(0x06, 0x07, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x02, 0x01);
  const prime256v1 = Uint8Array.of(0x06, 0x08, 0x2a, 0x86, 0x48, 0xce, 0x3d, 0x03, 0x01, 0x07);
  return der(0x30, concat(Uint8Array.of(0x02, 0x01, 0x00), der(0x30, concat(ecPublicKey, prime256v1)), der(0x04, sec1)));
}

export async function importVapidPrivateKey(pem: string): Promise<CryptoKey> {
  const match = /-----BEGIN ([A-Z ]+)-----([\s\S]+?)-----END/.exec(pem);
  if (!match) throw new Error("VAPID private key is not PEM.");
  const body = Uint8Array.from(atob(match[2]!.replace(/\s+/g, "")), (c) => c.charCodeAt(0));
  const pkcs8 = match[1] === "EC PRIVATE KEY" ? sec1ToPkcs8(body) : body;
  return crypto.subtle.importKey("pkcs8", pkcs8, { name: "ECDSA", namedCurve: "P-256" }, false, ["sign"]);
}

export async function generateVapidKeys(): Promise<VapidKeys> {
  const pair = (await crypto.subtle.generateKey({ name: "ECDSA", namedCurve: "P-256" }, true, ["sign", "verify"])) as CryptoKeyPair;
  const raw = (await crypto.subtle.exportKey("raw", pair.publicKey)) as ArrayBuffer;
  const pkcs8 = (await crypto.subtle.exportKey("pkcs8", pair.privateKey)) as ArrayBuffer;
  return { publicKey: base64urlEncode(raw), privateKeyPem: toPem(pkcs8, "PRIVATE KEY") };
}

/** The instance's VAPID keys, created on first use. */
export async function getVapidKeys(db: D1Database): Promise<VapidKeys> {
  const row = await db.prepare("SELECT vapid_public_key, vapid_private_key FROM admin WHERE id = 1").first<{
    vapid_public_key: string | null;
    vapid_private_key: string | null;
  }>();
  if (row?.vapid_public_key && row.vapid_private_key) {
    return { publicKey: row.vapid_public_key, privateKeyPem: row.vapid_private_key };
  }
  const keys = await generateVapidKeys();
  // Only fill empty columns, so two concurrent first uses agree on one pair.
  await db
    .prepare("UPDATE admin SET vapid_public_key = ?, vapid_private_key = ? WHERE id = 1 AND (vapid_public_key IS NULL OR vapid_public_key = '')")
    .bind(keys.publicKey, keys.privateKeyPem)
    .run();
  const stored = await db.prepare("SELECT vapid_public_key, vapid_private_key FROM admin WHERE id = 1").first<{
    vapid_public_key: string;
    vapid_private_key: string;
  }>();
  return { publicKey: stored!.vapid_public_key, privateKeyPem: stored!.vapid_private_key };
}

// --- VAPID ------------------------------------------------------------------

export async function vapidAuthorization(endpoint: string, subject: string, keys: VapidKeys, now = Date.now()): Promise<string> {
  const audience = new URL(endpoint).origin;
  const header = base64urlEncode(encoder.encode(JSON.stringify({ typ: "JWT", alg: "ES256" })));
  const claims = base64urlEncode(encoder.encode(JSON.stringify({ aud: audience, exp: Math.floor(now / 1000) + 12 * 3600, sub: subject })));
  const key = await importVapidPrivateKey(keys.privateKeyPem);
  // WebCrypto signs ECDSA as raw r||s, which is exactly what JWS ES256 wants.
  const signature = await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, key, encoder.encode(`${header}.${claims}`));
  return `vapid t=${header}.${claims}.${base64urlEncode(signature)}, k=${keys.publicKey}`;
}

// --- payload encryption (RFC 8291) -------------------------------------------

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

const RECORD_SIZE = 4096;

/**
 * Encrypts one message for a push subscription. The optional ephemeral key
 * pair and salt exist for tests; in production both are fresh per message.
 */
export async function encryptPayload(
  plaintext: string,
  p256dh: string,
  auth: string,
  options: { ephemeral?: CryptoKeyPair; salt?: Uint8Array } = {},
): Promise<Uint8Array> {
  const uaPublic = base64urlDecode(p256dh);
  const authSecret = base64urlDecode(auth);
  if (uaPublic.length !== 65 || authSecret.length !== 16) throw new Error("Invalid push subscription keys.");

  const ephemeral = options.ephemeral ?? ((await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair);
  const asPublic = new Uint8Array((await crypto.subtle.exportKey("raw", ephemeral.publicKey)) as ArrayBuffer);
  const uaKey = await crypto.subtle.importKey("raw", uaPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  // The runtime takes the standard "public" member; workers-types spells it "$public".
  const ecdhParams = { name: "ECDH", public: uaKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits(ecdhParams, ephemeral.privateKey, 256));

  const keyInfo = concat(encoder.encode("WebPush: info\0"), uaPublic, asPublic);
  const ikm = await hkdf(authSecret, ecdhSecret, keyInfo, 32);
  const salt = options.salt ?? crypto.getRandomValues(new Uint8Array(16));
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);

  const data = encoder.encode(plaintext);
  if (data.length > RECORD_SIZE - 17 - 86) throw new Error("Push payload too large.");
  const padded = concat(data, Uint8Array.of(0x02)); // last-record delimiter
  const aesKey = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["encrypt"]);
  const ciphertext = new Uint8Array(await crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce }, aesKey, padded));

  const header = concat(salt, Uint8Array.of(0, 0, RECORD_SIZE >> 8, RECORD_SIZE & 0xff), Uint8Array.of(asPublic.length), asPublic);
  return concat(header, ciphertext);
}

export interface PushSubscriptionRow {
  id?: number;
  endpoint: string;
  p256dh: string;
  auth: string;
}

export interface PushResult {
  ok: boolean;
  /** The push service no longer knows this subscription; delete it. */
  gone: boolean;
  status?: number;
  error?: string;
}

export async function sendWebPush(
  subscription: PushSubscriptionRow,
  payload: string,
  keys: VapidKeys,
  subject: string,
): Promise<PushResult> {
  try {
    const body = await encryptPayload(payload, subscription.p256dh, subscription.auth);
    const response = await fetch(subscription.endpoint, {
      method: "POST",
      headers: {
        authorization: await vapidAuthorization(subscription.endpoint, subject, keys),
        "content-encoding": "aes128gcm",
        "content-type": "application/octet-stream",
        ttl: "2419200",
        urgency: "normal",
      },
      body,
      signal: AbortSignal.timeout(15_000),
    });
    if (response.status === 404 || response.status === 410) return { ok: false, gone: true, status: response.status };
    if (!response.ok) return { ok: false, gone: false, status: response.status, error: (await response.text()).slice(0, 200) };
    return { ok: true, gone: false, status: response.status };
  } catch (error) {
    return { ok: false, gone: false, error: String(error) };
  }
}
