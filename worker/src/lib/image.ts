import { convertIndexedToRgb, decode, encode } from "fast-png";

/*
  Image handling without GD.

  - Type detection by magic bytes; only raster formats a browser shows are
    accepted (no SVG: it can carry script).
  - Resizing and format conversion use the optional Cloudflare Images binding
    (env.IMAGES). Without it the original file is stored unchanged.
  - The pixel work of PHP Wallos - background removal
    (includes/gd_background_removal.php) and the dark/light theme variant
    (includes/logo_theme_variant.php) - runs here in plain TypeScript on
    decoded PNG pixels, with the same thresholds.
*/

export type ImageType = "image/png" | "image/jpeg" | "image/gif" | "image/webp" | "image/avif";

export const EXTENSIONS: Record<ImageType, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/avif": "avif",
};

export function sniffImageType(bytes: Uint8Array): ImageType | null {
  const ascii = (start: number, length: number) => String.fromCharCode(...bytes.subarray(start, start + length));
  if (bytes.length >= 8 && bytes[0] === 0x89 && ascii(1, 3) === "PNG") return "image/png";
  if (bytes.length >= 3 && bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff) return "image/jpeg";
  if (bytes.length >= 6 && (ascii(0, 6) === "GIF87a" || ascii(0, 6) === "GIF89a")) return "image/gif";
  if (bytes.length >= 12 && ascii(0, 4) === "RIFF" && ascii(8, 4) === "WEBP") return "image/webp";
  if (bytes.length >= 12 && ascii(4, 4) === "ftyp" && ["avif", "avis"].includes(ascii(8, 4))) return "image/avif";
  return null;
}

/** Width and height from a PNG header, without decoding the image. */
export function pngDimensions(bytes: Uint8Array): { width: number; height: number } | null {
  if (bytes.length < 24 || sniffImageType(bytes) !== "image/png") return null;
  const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  return { width: view.getUint32(16), height: view.getUint32(20) };
}

// --- Cloudflare Images binding ---------------------------------------------------

/** The subset of the Images binding this file uses. */
export interface ImagesBinding {
  input(stream: ReadableStream<Uint8Array>): {
    transform(options: { width?: number; height?: number; fit?: "scale-down" | "contain" }): {
      output(options: { format: "image/png" }): Promise<{ response(): Response }>;
    };
  };
}

function toStream(bytes: Uint8Array): ReadableStream<Uint8Array> {
  return new Response(bytes).body!;
}

/** Scales down into the box and converts to PNG; null when the binding is missing or fails. */
export async function resizeToPng(images: ImagesBinding | undefined, bytes: Uint8Array, maxWidth: number, maxHeight: number): Promise<Uint8Array | null> {
  if (!images) return null;
  try {
    const result = await images.input(toStream(bytes)).transform({ width: maxWidth, height: maxHeight, fit: "scale-down" }).output({ format: "image/png" });
    return new Uint8Array(await result.response().arrayBuffer());
  } catch (error) {
    console.warn("Images binding failed; storing the original", error);
    return null;
  }
}

// --- pixels ------------------------------------------------------------------------

export interface Rgba {
  width: number;
  height: number;
  /** 4 bytes per pixel, alpha 255 = opaque. */
  data: Uint8Array;
}

/** Larger images are stored as they are; per-pixel work on them costs too much CPU. */
export const MAX_PIXELS_FOR_PROCESSING = 1024 * 1024;

export function decodePngToRgba(bytes: Uint8Array): Rgba {
  const png = decode(bytes);
  const { width, height } = png;
  const pixels = width * height;
  let samples: ArrayLike<number> = png.data;
  let channels = png.channels;
  let max = 2 ** png.depth - 1;

  if (png.palette) {
    samples = convertIndexedToRgb(png);
    channels = samples.length / pixels;
    max = 255;
  }

  const out = new Uint8Array(pixels * 4);
  for (let i = 0; i < pixels; i++) {
    const s = i * channels;
    const scale = (v: number) => (max === 255 ? v : Math.round((v / max) * 255));
    let r: number, g: number, b: number, a = 255;
    if (channels <= 2) {
      r = g = b = scale(samples[s]!);
      if (channels === 2) a = scale(samples[s + 1]!);
    } else {
      r = scale(samples[s]!);
      g = scale(samples[s + 1]!);
      b = scale(samples[s + 2]!);
      if (channels === 4) a = scale(samples[s + 3]!);
    }
    out.set([r, g, b, a], i * 4);
  }
  return { width, height, data: out };
}

export function encodeRgbaToPng(image: Rgba): Uint8Array {
  return encode({ width: image.width, height: image.height, data: image.data, channels: 4, depth: 8 });
}

// GD's alpha runs 0 (opaque) .. 127 (transparent); "alpha >= 125" there is "a <= 5" here.
const NEARLY_TRANSPARENT = 5;

/**
 * Makes every pixel within `fuzz` of the top-left corner's colour transparent,
 * unless that corner already is (gdRemoveBackgroundColor()).
 */
export function removeBackground(image: Rgba, fuzz = 0.1): void {
  const { data } = image;
  if (data[3] === 0) return;
  const [br, bg, bb] = [data[0]!, data[1]!, data[2]!];
  const maxDelta = Math.round(255 * fuzz);
  const maxDistance = 3 * maxDelta * maxDelta;
  for (let i = 0; i < data.length; i += 4) {
    const distance = (data[i]! - br) ** 2 + (data[i + 1]! - bg) ** 2 + (data[i + 2]! - bb) ** 2;
    if (distance <= maxDistance) data.set([0, 0, 0, 0], i);
  }
}

/** Crops to the visible pixels plus `padding` (gdCropTransparent()). */
export function cropTransparent(image: Rgba, padding = 2): Rgba {
  const { width, height, data } = image;
  let top = -1, bottom = -1, left = width, right = -1;
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      if (data[(y * width + x) * 4 + 3]! > NEARLY_TRANSPARENT) {
        if (top === -1) top = y;
        bottom = y;
        if (x < left) left = x;
        if (x > right) right = x;
      }
    }
  }
  if (top === -1) return image;

  const x0 = Math.max(0, left - padding);
  const y0 = Math.max(0, top - padding);
  const w = Math.min(width - x0, right - left + 1 + padding * 2);
  const h = Math.min(height - y0, bottom - top + 1 + padding * 2);
  if (x0 === 0 && y0 === 0 && w === width && h === height) return image;

  const out = new Uint8Array(w * h * 4);
  for (let y = 0; y < h; y++) {
    out.set(data.subarray(((y0 + y) * width + x0) * 4, ((y0 + y) * width + x0 + w) * 4), y * w * 4);
  }
  return { width: w, height: h, data: out };
}

const BLACK_LIGHTNESS_MAX = 60;
const WHITE_LIGHTNESS_MIN = 200;
const MAX_CHANNEL_SPREAD = 20;
const SIGNIFICANT_RATIO = 0.05;
const DOMINANCE_RATIO = 0.3;

/**
 * "dark" when the logo's lettering is (near) black, "light" when (near)
 * white, null for colourful or two-tone logos (classifyLogoTextColor()).
 */
export function classifyTextColor(image: Rgba): "dark" | "light" | null {
  const { data } = image;
  let black = 0, white = 0, opaque = 0;
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3]! <= NEARLY_TRANSPARENT) continue;
    opaque++;
    const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
    if (Math.max(r, g, b) - Math.min(r, g, b) > MAX_CHANNEL_SPREAD) continue;
    const lightness = (r + g + b) / 3;
    if (lightness <= BLACK_LIGHTNESS_MAX) black++;
    else if (lightness >= WHITE_LIGHTNESS_MIN) white++;
  }
  if (opaque === 0) return null;
  const isDark = black / opaque >= SIGNIFICANT_RATIO;
  const isLight = white / opaque >= SIGNIFICANT_RATIO;
  if (!isDark && !isLight) return null;
  if (isDark && isLight && Math.min(black, white) / Math.max(black, white) > DOMINANCE_RATIO) return null;
  return black > white ? "dark" : "light";
}

/** Inverts the grey pixels, leaving coloured ones and alpha alone (generateThemedLogoVariant()). */
export function themedVariant(image: Rgba): Rgba {
  const data = image.data.slice();
  for (let i = 0; i < data.length; i += 4) {
    if (data[i + 3]! <= NEARLY_TRANSPARENT) continue;
    const r = data[i]!, g = data[i + 1]!, b = data[i + 2]!;
    if (Math.max(r, g, b) - Math.min(r, g, b) <= MAX_CHANNEL_SPREAD) data.set([255 - r, 255 - g, 255 - b], i);
  }
  return { width: image.width, height: image.height, data };
}
