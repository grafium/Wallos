import { Hono } from "hono";
import type { AppBindings } from "../env";
import { ADMIN_USER_ID } from "../env";
import { createSession, requireAuth } from "../lib/auth";
import { hashPassword, randomToken, sha256Hex, verifyPassword } from "../lib/crypto";
import { fail, ok, readBody, validationFailed } from "../lib/http";
import { loginSchema, registerSchema } from "../lib/schemas";
import { canRegister, registerUser } from "../services/accounts";

export const authRoutes = new Hono<AppBindings>();

// A valid hash to verify against when the username does not exist, so a
// failed login takes the same time whether or not the account exists.
let dummyHash: Promise<string> | null = null;

authRoutes.post("/register", async (c) => {
  const parsed = registerSchema.safeParse(await readBody(c));
  if (!parsed.success) return validationFailed(c, parsed.error);

  const check = await canRegister(c.env.DB);
  if (!check.allowed) return fail(c, 403, "Registration not allowed", check.reason);

  const taken = await c.env.DB.prepare("SELECT 1 FROM user WHERE username = ?").bind(parsed.data.username).first();
  if (taken) return fail(c, 409, "Username taken", "That username is already in use.");

  let userId: number;
  try {
    userId = await registerUser(c.env.DB, parsed.data);
  } catch (error) {
    if (String(error).includes("UNIQUE")) return fail(c, 409, "Username taken", "That username is already in use.");
    throw error;
  }
  return ok(c, "Registered", { user_id: userId, is_admin: userId === ADMIN_USER_ID }, 201);
});

authRoutes.post("/login", async (c) => {
  const parsed = loginSchema.safeParse(await readBody(c));
  if (!parsed.success) return validationFailed(c, parsed.error);

  const user = await c.env.DB.prepare("SELECT id, username, password FROM user WHERE username = ?")
    .bind(parsed.data.username)
    .first<{ id: number; username: string; password: string }>();

  dummyHash ??= hashPassword(randomToken(16));
  const check = await verifyPassword(parsed.data.password, user?.password ?? (await dummyHash));
  if (!user || !check.valid) {
    return fail(c, 401, "Invalid credentials", "Username or password is incorrect.");
  }

  if (check.needsRehash) {
    await c.env.DB.prepare("UPDATE user SET password = ? WHERE id = ?")
      .bind(await hashPassword(parsed.data.password), user.id)
      .run();
  }

  const token = randomToken(32);
  const expiresAt = await createSession(c.env, user.id, token, c.req.header("user-agent") ?? "");
  return ok(c, "Logged in", { token, expires_at: expiresAt, user: { id: user.id, username: user.username } });
});

authRoutes.post("/logout", requireAuth, async (c) => {
  if (c.get("authMethod") !== "session") {
    return fail(c, 400, "Not a session", "Log out with the session token, not the API key.");
  }
  const token = c.req.header("authorization")!.slice(7).trim();
  await c.env.DB.prepare("DELETE FROM sessions WHERE id = ?").bind(await sha256Hex(token)).run();
  return ok(c, "Logged out", {});
});
