import { Hono, type Context } from "hono";
import type { AppBindings, Env } from "../env";
import { fail, ok, parseId, readBody } from "../lib/http";
import {
  AVATAR_DIR,
  deleteAvatarIfUnused,
  deleteLogosIfUnused,
  fetchImage,
  LOGO_DIR,
  MAX_UPLOAD_BYTES,
  processImage,
  storeAvatar,
  storeLogo,
  UploadError,
  type ImageKind,
  type StoredLogo,
} from "../services/files";

type Ctx = Context<AppBindings>;

/*
  Serving and uploading images. Files are served at the paths PHP Wallos used
  (/images/uploads/logos/...), so stored values and old links keep working.
*/

// --- serving ----------------------------------------------------------------

export const fileRoutes = new Hono<AppBindings>();

async function serve(c: Ctx, key: string) {
  const object = await c.env.FILES.get(key, { onlyIf: c.req.raw.headers });
  if (!object) return c.text("Not found", 404);
  const headers = new Headers();
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  headers.set("x-content-type-options", "nosniff");
  headers.set("content-security-policy", "default-src 'none'; sandbox");
  if (!headers.has("cache-control")) headers.set("cache-control", "public, max-age=86400");
  // onlyIf matched If-None-Match: the object has no body.
  if (!("body" in object) || !object.body) return new Response(null, { status: 304, headers });
  return new Response(object.body, { headers });
}

const NAME = "{[A-Za-z0-9][A-Za-z0-9._-]*}";
fileRoutes.get(`/images/uploads/logos/avatars/:name${NAME}`, (c) => serve(c, AVATAR_DIR + c.req.param("name")));
fileRoutes.get(`/images/uploads/logos/:name${NAME}`, (c) => serve(c, LOGO_DIR + c.req.param("name")));

// --- reading an upload ----------------------------------------------------------

/**
 * The image of a request: a file in `field` (multipart), else a URL in the
 * first non-empty of `urlFields`. Null when the request carries neither.
 */
export async function imageFromBody(body: Record<string, unknown>, field: string, urlFields: string[]): Promise<Uint8Array | null> {
  const file = body[field];
  if (file instanceof File) {
    if (file.size > MAX_UPLOAD_BYTES) throw new UploadError(`Images may be at most ${MAX_UPLOAD_BYTES / 1024 / 1024} MB.`);
    return new Uint8Array(await file.arrayBuffer());
  }
  const url = urlFields.map((f) => body[f]).find((v) => typeof v === "string" && v.trim() !== "") as string | undefined;
  return url ? fetchImage(url.trim()) : null;
}

async function removeBackgroundEnabled(env: Env, userId: number): Promise<boolean> {
  const row = await env.DB.prepare("SELECT remove_background FROM settings WHERE user_id = ?").bind(userId).first<{ remove_background: number }>();
  return Boolean(row?.remove_background);
}

export async function storeLogoImage(env: Env, userId: number, bytes: Uint8Array, kind: Exclude<ImageKind, "avatar">, label: string): Promise<StoredLogo> {
  const image = await processImage(env, bytes, kind, { removeBackground: await removeBackgroundEnabled(env, userId) });
  return storeLogo(env, image, label);
}

/** Puts a stored logo on a subscription and removes the files it replaces. */
export async function setSubscriptionLogo(env: Env, userId: number, subscriptionId: number, logo: StoredLogo | null): Promise<boolean> {
  const old = await env.DB.prepare("SELECT logo, logo_variant FROM subscriptions WHERE id = ? AND user_id = ?")
    .bind(subscriptionId, userId)
    .first<{ logo: string | null; logo_variant: string | null }>();
  if (!old) return false;
  await env.DB.prepare(
    "UPDATE subscriptions SET logo = ?, logo_variant = ?, logo_text_color = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ? AND user_id = ?",
  )
    .bind(logo?.name ?? "", logo?.variant ?? null, logo?.textColor ?? null, subscriptionId, userId)
    .run();
  await deleteLogosIfUnused(env, [old.logo, old.logo_variant]);
  return true;
}

function uploadFailure(c: Ctx, error: unknown) {
  if (error instanceof UploadError) return fail(c, 400, "Invalid image", error.message);
  throw error;
}

// --- endpoints under /api -----------------------------------------------------------

export const uploadRoutes = new Hono<AppBindings>();

/** Logo of a subscription: multipart "logo" file, or "url"/"logo_url". */
uploadRoutes.post("/subscriptions/:id/logo", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return fail(c, 400, "Missing parameter", 'Parameter "id" is required.');
  const user = c.get("user");
  const row = await c.env.DB.prepare("SELECT name FROM subscriptions WHERE id = ? AND user_id = ?").bind(id, user.id).first<{ name: string }>();
  if (!row) return fail(c, 404, "Subscription not found");

  try {
    const bytes = await imageFromBody(await readBody(c), "logo", ["url", "logo_url"]);
    if (!bytes) return fail(c, 400, "Missing parameter", 'Send a "logo" file or a "url".');
    const logo = await storeLogoImage(c.env, user.id, bytes, "logo", row.name);
    await setSubscriptionLogo(c.env, user.id, id, logo);
    return ok(c, "Logo saved", { logo: logo.name, logo_variant: logo.variant, logo_text_color: logo.textColor, url: `/${LOGO_DIR}${logo.name}` });
  } catch (error) {
    return uploadFailure(c, error);
  }
});

uploadRoutes.delete("/subscriptions/:id/logo", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return fail(c, 400, "Missing parameter", 'Parameter "id" is required.');
  if (!(await setSubscriptionLogo(c.env, c.get("user").id, id, null))) return fail(c, 404, "Subscription not found");
  return ok(c, "Logo removed", { id });
});

/** Icon of a payment method: multipart "icon" file, or "url"/"icon_url". */
uploadRoutes.post("/payment-methods/:id/icon", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return fail(c, 400, "Missing parameter", 'Parameter "id" is required.');
  const user = c.get("user");
  const row = await c.env.DB.prepare("SELECT name, icon FROM payment_methods WHERE id = ? AND user_id = ?").bind(id, user.id).first<{ name: string; icon: string | null }>();
  if (!row) return fail(c, 404, "Payment method not found");

  try {
    const bytes = await imageFromBody(await readBody(c), "icon", ["url", "icon_url"]);
    if (!bytes) return fail(c, 400, "Missing parameter", 'Send an "icon" file or a "url".');
    const icon = await storeLogoImage(c.env, user.id, bytes, "icon", row.name);
    await c.env.DB.prepare("UPDATE payment_methods SET icon = ? WHERE id = ? AND user_id = ?").bind(icon.name, id, user.id).run();
    await deleteLogosIfUnused(c.env, [row.icon]);
    return ok(c, "Icon saved", { icon: icon.name, url: `/${LOGO_DIR}${icon.name}` });
  } catch (error) {
    return uploadFailure(c, error);
  }
});

export const DEFAULT_AVATAR = "images/avatars/0.svg";

/** Uploaded avatar: multipart "avatar" file, or "url". */
uploadRoutes.post("/me/avatar", async (c) => {
  const user = c.get("user");
  try {
    const bytes = await imageFromBody(await readBody(c), "avatar", ["url", "avatar_url"]);
    if (!bytes) return fail(c, 400, "Missing parameter", 'Send an "avatar" file or a "url".');
    const path = await storeAvatar(c.env, await processImage(c.env, bytes, "avatar"), user.username);
    const old = await c.env.DB.prepare("SELECT avatar FROM user WHERE id = ?").bind(user.id).first<{ avatar: string | null }>();
    await c.env.DB.prepare("UPDATE user SET avatar = ? WHERE id = ?").bind(path, user.id).run();
    await deleteAvatarIfUnused(c.env, old?.avatar);
    return ok(c, "Avatar saved", { avatar: path, url: `/${path}` });
  } catch (error) {
    return uploadFailure(c, error);
  }
});

uploadRoutes.delete("/me/avatar", async (c) => {
  const user = c.get("user");
  const old = await c.env.DB.prepare("SELECT avatar FROM user WHERE id = ?").bind(user.id).first<{ avatar: string | null }>();
  await c.env.DB.prepare("UPDATE user SET avatar = ? WHERE id = ?").bind(DEFAULT_AVATAR, user.id).run();
  await deleteAvatarIfUnused(c.env, old?.avatar);
  return ok(c, "Avatar removed", { avatar: DEFAULT_AVATAR });
});
