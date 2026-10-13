import { Hono } from "hono";
import type { AppBindings } from "../env";
import { ADMIN_USER_ID } from "../env";
import { createSession, requireAuth } from "../lib/auth";
import { hashPassword, randomToken, sha256Hex, verifyPassword } from "../lib/crypto";
import { fail, ok, readBody, validationFailed } from "../lib/http";
import { loginSchema, registerSchema } from "../lib/schemas";
import { canRegister, registerUser } from "../services/accounts";
import {
  isUnverified,
  publicBaseUrl,
  requestPasswordReset,
  resetPassword,
  sendVerificationEmail,
  verificationRequired,
  verifyEmail,
} from "../services/email-flows";
import { z } from "zod";

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
  // The first account (the admin) is never held back by verification.
  if (userId !== ADMIN_USER_ID && (await verificationRequired(c.env))) {
    try {
      await sendVerificationEmail(c.env, userId, parsed.data.email, await publicBaseUrl(c.env, c.req.url));
    } catch (error) {
      console.error("verification e-mail failed", error);
      return ok(c, "Registered", { user_id: userId, is_admin: false, email_verification_required: true, warning: "The verification e-mail could not be sent; request a new one." }, 201);
    }
    return ok(c, "Registered", { user_id: userId, is_admin: false, email_verification_required: true }, 201);
  }
  return ok(c, "Registered", { user_id: userId, is_admin: userId === ADMIN_USER_ID, email_verification_required: false }, 201);
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

  if (await isUnverified(c.env.DB, user.id)) {
    return fail(c, 403, "E-mail not verified", "Confirm your e-mail address with the link we sent, or request a new one.");
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

const emailSchema = z.object({ email: z.email().max(255) });
const tokenSchema = z.object({ email: z.email().max(255), token: z.string().regex(/^[0-9a-f]{64}$/) });

authRoutes.post("/verify-email", async (c) => {
  const parsed = tokenSchema.safeParse(await readBody(c));
  if (!parsed.success) return validationFailed(c, parsed.error);
  if (!(await verifyEmail(c.env.DB, parsed.data.email, parsed.data.token))) {
    return fail(c, 400, "Verification failed", "The link is invalid or has expired; request a new one.");
  }
  return ok(c, "E-mail verified", { message: "Your e-mail address is confirmed. You can log in now." });
});

/** Sends a fresh verification link to an unverified account. Answers the same for unknown addresses. */
authRoutes.post("/verification-email", async (c) => {
  const parsed = emailSchema.safeParse(await readBody(c));
  if (!parsed.success) return validationFailed(c, parsed.error);
  // At most one new link every five minutes per account.
  const pending = await c.env.DB.prepare(
    "SELECT user_id, email FROM email_verification WHERE email = ? COLLATE NOCASE AND created_at <= datetime('now', '-5 minutes')",
  )
    .bind(parsed.data.email)
    .all<{ user_id: number; email: string }>();
  const base = await publicBaseUrl(c.env, c.req.url);
  for (const row of pending.results) {
    await sendVerificationEmail(c.env, row.user_id, row.email, base).catch((error) => console.error("verification e-mail failed", error));
  }
  return ok(c, "Verification e-mail", { message: "If that address is waiting for verification, a new link is on its way." });
});

authRoutes.post("/password-reset", async (c) => {
  const parsed = emailSchema.safeParse(await readBody(c));
  if (!parsed.success) return validationFailed(c, parsed.error);
  try {
    await requestPasswordReset(c.env, parsed.data.email, await publicBaseUrl(c.env, c.req.url));
  } catch (error) {
    // Logged, not shown: the answer must not reveal whether the address exists.
    console.error("password reset e-mail failed", error);
  }
  return ok(c, "Password reset", { message: "If an account uses that address, a reset link is on its way." });
});

authRoutes.post("/password-reset/confirm", async (c) => {
  const parsed = tokenSchema.extend({ password: z.string().min(8).max(256) }).safeParse(await readBody(c));
  if (!parsed.success) return validationFailed(c, parsed.error);
  if (!(await resetPassword(c.env.DB, parsed.data.email, parsed.data.token, parsed.data.password))) {
    return fail(c, 400, "Reset failed", "The link is invalid or has expired; request a new one.");
  }
  return ok(c, "Password changed", { message: "Your password was changed. Log in with the new one." });
});
