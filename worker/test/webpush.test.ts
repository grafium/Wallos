import { describe, expect, it } from "vitest";
import { checkOutboundUrl, parseHeaders } from "../src/lib/outbound";
import { base64urlDecode, base64urlEncode, encryptPayload, generateVapidKeys, vapidAuthorization } from "../src/lib/webpush";

const encoder = new TextEncoder();

async function hkdf(salt: Uint8Array, ikm: Uint8Array, info: Uint8Array, length: number) {
  const key = await crypto.subtle.importKey("raw", ikm, "HKDF", false, ["deriveBits"]);
  return new Uint8Array(await crypto.subtle.deriveBits({ name: "HKDF", hash: "SHA-256", salt, info }, key, length * 8));
}

/** What the browser does with an aes128gcm push message (RFC 8291, receiver side). */
async function decrypt(body: Uint8Array, ua: CryptoKeyPair, authSecret: Uint8Array): Promise<string> {
  const salt = body.slice(0, 16);
  const idLength = body[20]!;
  const asPublic = body.slice(21, 21 + idLength);
  const ciphertext = body.slice(21 + idLength);
  const uaPublic = new Uint8Array((await crypto.subtle.exportKey("raw", ua.publicKey)) as ArrayBuffer);

  const asKey = await crypto.subtle.importKey("raw", asPublic, { name: "ECDH", namedCurve: "P-256" }, false, []);
  const params = { name: "ECDH", public: asKey } as unknown as SubtleCryptoDeriveKeyAlgorithm;
  const secret = new Uint8Array(await crypto.subtle.deriveBits(params, ua.privateKey, 256));
  const info = new Uint8Array([...encoder.encode("WebPush: info\0"), ...uaPublic, ...asPublic]);
  const ikm = await hkdf(authSecret, secret, info, 32);
  const cek = await hkdf(salt, ikm, encoder.encode("Content-Encoding: aes128gcm\0"), 16);
  const nonce = await hkdf(salt, ikm, encoder.encode("Content-Encoding: nonce\0"), 12);
  const key = await crypto.subtle.importKey("raw", cek, "AES-GCM", false, ["decrypt"]);
  const padded = new Uint8Array(await crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce }, key, ciphertext));
  expect(padded.at(-1)).toBe(2);
  return new TextDecoder().decode(padded.slice(0, -1));
}

describe("web push payload encryption", () => {
  it("round-trips through the receiver's decryption", async () => {
    const ua = (await crypto.subtle.generateKey({ name: "ECDH", namedCurve: "P-256" }, true, ["deriveBits"])) as CryptoKeyPair;
    const authSecret = crypto.getRandomValues(new Uint8Array(16));
    const p256dh = base64urlEncode((await crypto.subtle.exportKey("raw", ua.publicKey)) as ArrayBuffer);

    const message = JSON.stringify({ title: "Wallos Notification", body: "Netflix for €15.99 (Tomorrow) ✓" });
    const body = await encryptPayload(message, p256dh, base64urlEncode(authSecret));

    expect(new DataView(body.buffer).getUint32(16)).toBe(4096);
    expect(await decrypt(body, ua, authSecret)).toBe(message);
  });

  it("rejects malformed subscription keys", async () => {
    await expect(encryptPayload("x", "AAAA", "AAAA")).rejects.toThrow(/Invalid push subscription keys/);
  });
});

describe("VAPID", () => {
  it("signs an ES256 JWT for the push service origin that verifies with the public key", async () => {
    const keys = await generateVapidKeys();
    expect(base64urlDecode(keys.publicKey)).toHaveLength(65);
    expect(keys.privateKeyPem).toMatch(/^-----BEGIN PRIVATE KEY-----/);

    const header = await vapidAuthorization("https://fcm.googleapis.com/fcm/send/abc", "mailto:a@example.com", keys, Date.UTC(2026, 0, 1));
    const [, jwt, k] = /^vapid t=([^,]+), k=(.+)$/.exec(header)!;
    expect(k).toBe(keys.publicKey);

    const [h, c, s] = jwt!.split(".");
    expect(JSON.parse(new TextDecoder().decode(base64urlDecode(c!)))).toEqual({
      aud: "https://fcm.googleapis.com",
      exp: Date.UTC(2026, 0, 1) / 1000 + 12 * 3600,
      sub: "mailto:a@example.com",
    });
    const publicKey = await crypto.subtle.importKey("raw", base64urlDecode(keys.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    const valid = await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, base64urlDecode(s!), encoder.encode(`${h}.${c}`));
    expect(valid).toBe(true);
  });

  it("accepts the SEC1 PEM that older OpenSSL builds of PHP Wallos wrote", async () => {
    // openssl ecparam -name prime256v1 -genkey -noout
    const keys = {
      publicKey: "BMB_W0uudUoFMy8YyeOar_R2C7J7F_hy_NDyCbgAJDLpAvYAYrag0tZqiN_vHOWaM5mEPotp3W_zeHi-vBQxIFg",
      privateKeyPem: `-----BEGIN EC PRIVATE KEY-----
MHcCAQEEII4SIYyu5mqB0DC1p+p0nUYxWZSuVzczhj00rHzGSlqsoAoGCCqGSM49
AwEHoUQDQgAEwH9bS651SgUzLxjJ45qv9HYLsnsX+HL80PIJuAAkMukC9gBitqDS
1mqI3+8c5ZozmYQ+i2ndb/N4eL68FDEgWA==
-----END EC PRIVATE KEY-----`,
    };
    const header = await vapidAuthorization("https://push.example.com/x", "mailto:a@example.com", keys);
    const [h, c, s] = /t=([^,]+)/.exec(header)![1]!.split(".");
    const publicKey = await crypto.subtle.importKey("raw", base64urlDecode(keys.publicKey), { name: "ECDSA", namedCurve: "P-256" }, false, ["verify"]);
    expect(await crypto.subtle.verify({ name: "ECDSA", hash: "SHA-256" }, publicKey, base64urlDecode(s!), encoder.encode(`${h}.${c}`))).toBe(true);
  });
});

describe("outbound URL checks", () => {
  it("allows public http(s) URLs and refuses local targets", () => {
    expect(checkOutboundUrl("https://discord.com/api/webhooks/1/x").ok).toBe(true);
    expect(checkOutboundUrl("http://ntfy.example.org:8080/topic").ok).toBe(true);
    for (const bad of ["ftp://x.org", "http://localhost:8080", "http://127.0.0.1", "http://192.168.1.10", "http://10.0.0.1", "http://[::1]/", "http://user:pw@example.com", "http://nas.local"]) {
      expect(checkOutboundUrl(bad).ok, bad).toBe(false);
    }
  });

  it("parses the header formats PHP Wallos stored", () => {
    expect(parseHeaders('{"Authorization":"Bearer x","X-N":1}')).toEqual({ Authorization: "Bearer x", "X-N": "1" });
    expect(parseHeaders('["Authorization: Bearer x", "X-A: b"]')).toEqual({ Authorization: "Bearer x", "X-A": "b" });
    expect(parseHeaders("Authorization: Bearer x\nX-A: b")).toEqual({ Authorization: "Bearer x", "X-A": "b" });
    expect(parseHeaders("")).toEqual({});
  });
});
