import type { Env } from "../env";
import {
  classifyTextColor,
  cropTransparent,
  decodePngToRgba,
  encodeRgbaToPng,
  EXTENSIONS,
  MAX_PIXELS_FOR_PROCESSING,
  pngDimensions,
  removeBackground,
  resizeToPng,
  sniffImageType,
  themedVariant,
  type ImageType,
} from "../lib/image";
import { checkOutboundUrl } from "../lib/outbound";

/*
  Uploaded images in R2.

  Object keys are the paths PHP Wallos used on disk, so the values already in
  the database keep working after an import and the files can be copied over
  as they are (scripts/upload-files.ts):

    images/uploads/logos/<file>          subscription logos, their -variant.png,
                                         uploaded payment-method icons
    images/uploads/logos/avatars/<file>  uploaded avatars

  As in PHP, subscriptions and payment methods store the bare file name and
  users store the full path. The Worker serves both prefixes itself.
*/

export const LOGO_DIR = "images/uploads/logos/";
export const AVATAR_DIR = "images/uploads/logos/avatars/";

export const MAX_UPLOAD_BYTES = 5 * 1024 * 1024;

export type ImageKind = "logo" | "icon" | "avatar";

/** Twice the size PHP Wallos rendered them at (135x42, 70x48, 80x80), for sharp HiDPI display. */
const BOX: Record<ImageKind, [number, number]> = {
  logo: [270, 84],
  icon: [140, 96],
  avatar: [160, 160],
};

export class UploadError extends Error {}

export interface ProcessedImage {
  bytes: Uint8Array;
  type: ImageType;
  /** Set for logos whose lettering is black or white: which one, and the recoloured copy. */
  textColor: "dark" | "light" | null;
  variant: Uint8Array | null;
}

export async function processImage(env: Env, input: Uint8Array, kind: ImageKind, options: { removeBackground?: boolean } = {}): Promise<ProcessedImage> {
  if (input.byteLength === 0) throw new UploadError("The file is empty.");
  if (input.byteLength > MAX_UPLOAD_BYTES) throw new UploadError(`Images may be at most ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
  const sniffed = sniffImageType(input);
  if (!sniffed) throw new UploadError("Only PNG, JPEG, GIF, WebP and AVIF images are accepted.");

  const [width, height] = BOX[kind];
  const resized = await resizeToPng(env.IMAGES, input, width, height);
  let bytes = resized ?? input;
  const type: ImageType = resized ? "image/png" : sniffed;
  let textColor: ProcessedImage["textColor"] = null;
  let variant: Uint8Array | null = null;

  const size = type === "image/png" ? pngDimensions(bytes) : null;
  if (size && size.width * size.height <= MAX_PIXELS_FOR_PROCESSING && kind !== "avatar") {
    try {
      let pixels = decodePngToRgba(bytes);
      if (options.removeBackground) removeBackground(pixels);
      pixels = cropTransparent(pixels, 2);
      // Like PHP, the theme variant rides on the "remove background" setting.
      if (kind === "logo" && options.removeBackground) {
        textColor = classifyTextColor(pixels);
        if (textColor) variant = encodeRgbaToPng(themedVariant(pixels));
      }
      bytes = encodeRgbaToPng(pixels);
    } catch (error) {
      console.warn("PNG processing failed; storing the image as it is", error);
    }
  }
  return { bytes, type, textColor, variant };
}

function slug(name: string): string {
  return (
    name
      .normalize("NFKD")
      .replace(/[^\w\s-]/g, "")
      .trim()
      .replace(/[\s_]+/g, "-")
      .toLowerCase()
      .slice(0, 40) || "image"
  );
}

async function put(env: Env, key: string, bytes: Uint8Array, type: string) {
  await env.FILES.put(key, bytes, { httpMetadata: { contentType: type, cacheControl: "public, max-age=31536000, immutable" } });
}

export interface StoredLogo {
  /** Bare file name, as subscriptions.logo / payment_methods.icon store it. */
  name: string;
  variant: string | null;
  textColor: "dark" | "light" | null;
}

/** Stores a processed logo or icon under a fresh, unguessable name. */
export async function storeLogo(env: Env, image: ProcessedImage, label: string): Promise<StoredLogo> {
  const random = crypto.getRandomValues(new Uint8Array(4)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
  const stem = `${Math.floor(Date.now() / 1000)}-${slug(label)}-${random}`;
  const name = `${stem}.${EXTENSIONS[image.type]}`;
  await put(env, LOGO_DIR + name, image.bytes, image.type);
  let variant: string | null = null;
  if (image.variant) {
    variant = `${stem}-variant.png`;
    await put(env, LOGO_DIR + variant, image.variant, "image/png");
  }
  return { name, variant, textColor: image.variant ? image.textColor : null };
}

/** Stores an avatar; returns the path users.avatar holds. */
export async function storeAvatar(env: Env, image: ProcessedImage, label: string): Promise<string> {
  const random = crypto.getRandomValues(new Uint8Array(4)).reduce((s, b) => s + b.toString(16).padStart(2, "0"), "");
  const path = `${AVATAR_DIR}${Math.floor(Date.now() / 1000)}-avatars-${slug(label)}-${random}.${EXTENSIONS[image.type]}`;
  await put(env, path, image.bytes, image.type);
  return path;
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/**
 * Deletes logo files nothing refers to any more. A clone shares its original's
 * logo, so a name is only removed when no subscription (logo or variant) or
 * payment method still uses it - across all users, as logo_cleanup.php does.
 */
export async function deleteLogosIfUnused(env: Env, names: (string | null | undefined)[]): Promise<void> {
  for (const raw of names) {
    const name = (raw ?? "").trim();
    if (!name || !SAFE_NAME.test(name) || name.startsWith("images/")) continue; // built-in icons live elsewhere
    const used = await env.DB.prepare(
      "SELECT 1 FROM subscriptions WHERE logo = ?1 OR logo_variant = ?1 UNION ALL SELECT 1 FROM payment_methods WHERE icon = ?1 LIMIT 1",
    )
      .bind(name)
      .first();
    if (!used) await env.FILES.delete(LOGO_DIR + name);
  }
}

export async function deleteAvatarIfUnused(env: Env, path: string | null | undefined): Promise<void> {
  if (!path || !path.startsWith(AVATAR_DIR) || !SAFE_NAME.test(path.slice(AVATAR_DIR.length))) return;
  const used = await env.DB.prepare("SELECT 1 FROM user WHERE avatar = ?").bind(path).first();
  if (!used) await env.FILES.delete(path);
}

/** Reads a response body up to `limit` bytes; throws when it is larger. */
async function readLimited(response: Response, limit: number): Promise<Uint8Array> {
  const declared = Number(response.headers.get("content-length") ?? "0");
  if (declared > limit) throw new UploadError(`The image is larger than ${limit / 1024 / 1024} MB.`);
  const reader = response.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (total > limit) {
      await reader.cancel();
      throw new UploadError(`The image is larger than ${limit / 1024 / 1024} MB.`);
    }
    chunks.push(value);
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
}

/** Downloads an image, following at most three redirects and checking every hop (getLogoFromUrl()). */
export async function fetchImage(url: string): Promise<Uint8Array> {
  let current = url;
  for (let hop = 0; hop <= 3; hop++) {
    const check = checkOutboundUrl(current);
    if (!check.ok) throw new UploadError(check.reason);
    let response: Response;
    try {
      response = await fetch(check.url, {
        redirect: "manual",
        headers: { "user-agent": "Mozilla/5.0 (compatible; Wallos)", accept: "image/*" },
        signal: AbortSignal.timeout(10_000),
      });
    } catch (error) {
      throw new UploadError(`Failed to fetch the image: ${error instanceof Error ? error.message : String(error)}`);
    }
    if (response.status >= 300 && response.status < 400) {
      const location = response.headers.get("location");
      if (!location) break;
      current = new URL(location, check.url).toString();
      continue;
    }
    if (response.status !== 200) throw new UploadError(`Failed to fetch the image (HTTP ${response.status}).`);
    return readLimited(response, MAX_UPLOAD_BYTES);
  }
  throw new UploadError("Failed to fetch the image: too many redirects.");
}

/** Every logo object no row refers to (deleteunusedlogos.php). */
export async function deleteUnusedLogos(env: Env): Promise<{ deleted: string[]; kept: number }> {
  const used = new Set<string>();
  const rows = await env.DB.batch<{ name: string | null }>([
    env.DB.prepare("SELECT logo AS name FROM subscriptions WHERE logo IS NOT NULL AND logo != ''"),
    env.DB.prepare("SELECT logo_variant AS name FROM subscriptions WHERE logo_variant IS NOT NULL AND logo_variant != ''"),
    env.DB.prepare("SELECT icon AS name FROM payment_methods WHERE icon IS NOT NULL AND icon != ''"),
  ]);
  for (const result of rows) for (const row of result.results) if (row.name) used.add(row.name);

  const deleted: string[] = [];
  let kept = 0;
  let cursor: string | undefined;
  do {
    const page = await env.FILES.list({ prefix: LOGO_DIR, cursor, delimiter: "/" });
    for (const object of page.objects) {
      const name = object.key.slice(LOGO_DIR.length);
      if (used.has(name)) {
        kept++;
      } else {
        await env.FILES.delete(object.key);
        deleted.push(name);
      }
    }
    cursor = page.truncated ? page.cursor : undefined;
  } while (cursor);
  return { deleted, kept };
}

/**
 * Deletes an account: every per-user table cascades from user(id), and the
 * account's logos, icons and avatar go too unless a clone elsewhere uses them.
 * Returns false when there was no such user.
 */
export async function deleteUserAccount(env: Env, userId: number): Promise<boolean> {
  const [logos, avatar] = await env.DB.batch<Record<string, string | null>>([
    env.DB.prepare(
      "SELECT logo AS name FROM subscriptions WHERE user_id = ?1 UNION SELECT logo_variant FROM subscriptions WHERE user_id = ?1 UNION SELECT icon FROM payment_methods WHERE user_id = ?1",
    ).bind(userId),
    env.DB.prepare("SELECT avatar FROM user WHERE id = ?").bind(userId),
  ]);
  const result = await env.DB.prepare("DELETE FROM user WHERE id = ?").bind(userId).run();
  if (result.meta.changes === 0) return false;
  await deleteLogosIfUnused(env, (logos?.results ?? []).map((r) => r.name));
  await deleteAvatarIfUnused(env, avatar?.results[0]?.avatar);
  return true;
}
