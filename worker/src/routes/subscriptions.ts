import { Hono, type Context } from "hono";
import type { AppBindings } from "../env";
import { fail, ok, parseId, readBody, validationFailed } from "../lib/http";
import { createSubscriptionSchema, updateSubscriptionSchema } from "../lib/schemas";
import { deleteLogosIfUnused, UploadError } from "../services/files";
import { imageFromBody, setSubscriptionLogo, storeLogoImage } from "./uploads";
import {
  cloneSubscription,
  findSubscription,
  createSubscription,
  deleteSubscription,
  getSubscription,
  listSubscriptions,
  ReferenceError,
  renewSubscription,
  updateSubscription,
  type ListOptions,
} from "../services/subscriptions";

type Ctx = Context<AppBindings>;

/*
  The handlers are exported so the PHP-compatible routes in legacy.ts answer
  with exactly the same logic and response shapes.
*/

export async function listHandler(c: Ctx, options: ListOptions) {
  const subscriptions = await listSubscriptions(c.env.DB, c.get("user"), options);
  return ok(c, "subscriptions", { subscriptions, notes: [] });
}

export async function getHandler(c: Ctx, id: number | null, convert = false) {
  if (id === null) return fail(c, 400, "Missing parameter", 'Parameter "id" is required.');
  const subscription = await getSubscription(c.env.DB, c.get("user"), id, convert);
  if (!subscription) return fail(c, 404, "Subscription not found", "Subscription not found or does not belong to you.");
  return ok(c, "subscription", { subscription, notes: [] });
}

function referenceFailure(c: Ctx, error: ReferenceError) {
  return fail(c, 400, "Invalid parameter", error.message, { fields: error.fields });
}

/**
 * A logo sent along with a subscription: a multipart "logo" file or a
 * "logo_url". Like PHP, a logo that cannot be saved does not stop the
 * subscription from being saved; the answer carries a logo_warning instead.
 */
async function attachLogo(c: Ctx, body: Record<string, unknown>, subscriptionId: number, name: string): Promise<string | null> {
  try {
    const bytes = await imageFromBody(body, "logo", ["logo_url"]);
    if (!bytes) return null;
    const logo = await storeLogoImage(c.env, c.get("user").id, bytes, "logo", name);
    await setSubscriptionLogo(c.env, c.get("user").id, subscriptionId, logo);
    return null;
  } catch (error) {
    if (error instanceof UploadError) return error.message;
    throw error;
  }
}

/** The body without an uploaded logo file, which the schema would reject as a non-string. */
function withoutFile(body: Record<string, unknown>) {
  const { logo, ...rest } = body;
  return logo instanceof File ? rest : body;
}

export async function createHandler(c: Ctx, body: Record<string, unknown>) {
  const parsed = createSubscriptionSchema.safeParse(withoutFile(body));
  if (!parsed.success) return validationFailed(c, parsed.error);
  let id: number;
  try {
    id = await createSubscription(c.env.DB, c.get("user"), parsed.data);
  } catch (error) {
    if (error instanceof ReferenceError) return referenceFailure(c, error);
    throw error;
  }
  const logoWarning = await attachLogo(c, body, id, parsed.data.name);
  const subscription = await getSubscription(c.env.DB, c.get("user"), id);
  return ok(
    c,
    "Subscription added",
    { subscriptionId: id, subscription, message: "Subscription added successfully.", ...(logoWarning ? { logo_warning: logoWarning } : {}) },
    201,
  );
}

export async function updateHandler(c: Ctx, id: number | null, body: Record<string, unknown>) {
  if (id === null) return fail(c, 400, "Missing parameter", 'Parameter "id" (or "subscriptionId") is required.');
  const parsed = updateSubscriptionSchema.safeParse(withoutFile(body));
  if (!parsed.success) return validationFailed(c, parsed.error);
  const before = await findSubscription(c.env.DB, c.get("user").id, id);
  try {
    const found = await updateSubscription(c.env.DB, c.get("user"), id, parsed.data);
    if (!found) return fail(c, 404, "Subscription not found", "Subscription not found or does not belong to you.");
  } catch (error) {
    if (error instanceof ReferenceError) return referenceFailure(c, error);
    throw error;
  }
  // A logo name set by hand replaces the file, and its themed variant no longer matches.
  if (before && parsed.data.logo !== undefined && parsed.data.logo !== before.logo) {
    await c.env.DB.prepare("UPDATE subscriptions SET logo_variant = NULL, logo_text_color = NULL WHERE id = ?").bind(id).run();
    await deleteLogosIfUnused(c.env, [before.logo, before.logo_variant]);
  }
  const logoWarning = await attachLogo(c, body, id, parsed.data.name ?? before?.name ?? "logo");
  const subscription = await getSubscription(c.env.DB, c.get("user"), id);
  return ok(c, "Subscription updated", {
    subscriptionId: id,
    subscription,
    message: "Subscription updated successfully.",
    ...(logoWarning ? { logo_warning: logoWarning } : {}),
  });
}

export async function deleteHandler(c: Ctx, id: number | null) {
  if (id === null) return fail(c, 400, "Missing parameter", 'Parameter "id" (or "subscriptionId") is required.');
  const before = await findSubscription(c.env.DB, c.get("user").id, id);
  const deleted = await deleteSubscription(c.env.DB, c.get("user").id, id);
  if (!deleted) return fail(c, 404, "Subscription not found", "Subscription not found or does not belong to you.");
  await deleteLogosIfUnused(c.env, [before?.logo, before?.logo_variant]);
  return ok(c, "Subscription deleted", { subscriptionId: id, message: "Subscription deleted successfully." });
}

export const subscriptionRoutes = new Hono<AppBindings>();

subscriptionRoutes.get("/", (c) => listHandler(c, c.req.query()));
subscriptionRoutes.post("/", async (c) => createHandler(c, await readBody(c)));
subscriptionRoutes.get("/:id", (c) => getHandler(c, parseId(c.req.param("id")), c.req.query("convert_currency") === "true"));
subscriptionRoutes.patch("/:id", async (c) => updateHandler(c, parseId(c.req.param("id")), await readBody(c)));
subscriptionRoutes.put("/:id", async (c) => updateHandler(c, parseId(c.req.param("id")), await readBody(c)));
subscriptionRoutes.delete("/:id", (c) => deleteHandler(c, parseId(c.req.param("id"))));

subscriptionRoutes.post("/:id/renew", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return fail(c, 400, "Missing parameter", 'Parameter "id" is required.');
  const result = await renewSubscription(c.env.DB, c.get("user").id, id);
  if (!result.ok) {
    return result.reason === "not_found"
      ? fail(c, 404, "Subscription not found")
      : fail(c, 409, "Not renewable", "Only subscriptions without automatic renewal can be renewed manually.");
  }
  return ok(c, "Subscription renewed", { id, next_payment: result.next_payment });
});

subscriptionRoutes.post("/:id/clone", async (c) => {
  const id = parseId(c.req.param("id"));
  if (id === null) return fail(c, 400, "Missing parameter", 'Parameter "id" is required.');
  const newId = await cloneSubscription(c.env.DB, c.get("user").id, id);
  if (newId === null) return fail(c, 404, "Subscription not found");
  return ok(c, "Subscription cloned", { id: newId }, 201);
});
