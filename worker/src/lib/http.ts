import type { Context } from "hono";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import type { ZodError } from "zod";

/*
  Every response carries the Wallos API envelope: a boolean "success" and a
  "title", so clients written against the PHP API can read errors the same way.
*/

export function ok<T extends Record<string, unknown>>(c: Context, title: string, body: T, status: ContentfulStatusCode = 200) {
  return c.json({ success: true, title, ...body }, status);
}

export function fail(c: Context, status: ContentfulStatusCode, title: string, message?: string, extra: Record<string, unknown> = {}) {
  return c.json({ success: false, title, ...(message ? { message } : {}), ...extra }, status);
}

export function validationFailed(c: Context, error: ZodError) {
  const errors = error.issues.map((issue) => ({
    field: issue.path.join("."),
    message: issue.message,
  }));
  return fail(c, 400, "Invalid parameters", errors.map((e) => `${e.field}: ${e.message}`).join("; "), { errors });
}

/** Reads a JSON or form body into a plain object; an empty or malformed body yields {}. */
export async function readBody(c: Context): Promise<Record<string, unknown>> {
  const type = c.req.header("content-type") ?? "";
  try {
    if (type.includes("application/json")) {
      const body = await c.req.json();
      return body && typeof body === "object" && !Array.isArray(body) ? body : {};
    }
    if (type.includes("form")) {
      return (await c.req.parseBody()) as Record<string, unknown>;
    }
  } catch {
    return {};
  }
  return {};
}

export function parseId(value: string | undefined): number | null {
  if (!value || !/^\d+$/.test(value)) return null;
  const id = Number(value);
  return Number.isSafeInteger(id) && id > 0 ? id : null;
}
