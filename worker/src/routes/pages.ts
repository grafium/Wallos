import { Hono } from "hono";
import type { AppBindings } from "../env";
import { escapeHtml } from "../lib/email";
import { verifyEmail } from "../services/email-flows";

/*
  The two pages e-mailed links land on. They are deliberately tiny and
  self-contained; the full web interface arrives in phase 5.
*/

function page(title: string, body: string): string {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(title)} · Wallos</title>
<style>
  :root { color-scheme: light dark; --accent: #007bff; }
  body { font: 16px/1.5 system-ui, sans-serif; margin: 0; min-height: 100vh; display: grid; place-items: center; background: Canvas; color: CanvasText; }
  main { width: min(26rem, 100% - 2rem); padding: 2rem; border: 1px solid color-mix(in srgb, CanvasText 15%, transparent); border-radius: 12px; }
  h1 { font-size: 1.4rem; margin-top: 0; }
  label { display: block; margin: 1rem 0 .3rem; }
  input { box-sizing: border-box; width: 100%; padding: .6rem; font: inherit; border-radius: 6px; border: 1px solid color-mix(in srgb, CanvasText 30%, transparent); }
  button { margin-top: 1.2rem; width: 100%; padding: .7rem; font: inherit; color: #fff; background: var(--accent); border: 0; border-radius: 6px; cursor: pointer; }
  .error { color: #c62828; } .ok { color: #2e7d32; }
</style>
</head>
<body><main>${body}</main></body>
</html>`;
}

export const pageRoutes = new Hono<AppBindings>();

pageRoutes.get("/verify-email", async (c) => {
  const email = c.req.query("email") ?? "";
  const token = c.req.query("token") ?? "";
  const verified = /^[0-9a-f]{64}$/.test(token) && email !== "" && (await verifyEmail(c.env.DB, email, token));
  return c.html(
    page(
      "E-mail verification",
      verified
        ? `<h1>E-mail confirmed</h1><p class="ok">Your e-mail address is confirmed. You can log in now.</p>`
        : `<h1>Verification failed</h1><p class="error">The link is invalid or has expired. Request a new one from the login screen.</p>`,
    ),
    verified ? 200 : 400,
  );
});

pageRoutes.get("/reset-password", (c) => {
  const email = c.req.query("email") ?? "";
  const token = c.req.query("token") ?? "";
  return c.html(
    page(
      "Reset password",
      `<h1>Choose a new password</h1>
<form id="reset">
  <input type="hidden" name="email" value="${escapeHtml(email)}">
  <input type="hidden" name="token" value="${escapeHtml(token)}">
  <label for="password">New password (at least 8 characters)</label>
  <input id="password" name="password" type="password" minlength="8" required autocomplete="new-password">
  <label for="confirm">Repeat the new password</label>
  <input id="confirm" type="password" minlength="8" required autocomplete="new-password">
  <button type="submit">Change password</button>
  <p id="result" role="status"></p>
</form>
<script>
  const form = document.getElementById("reset");
  const result = document.getElementById("result");
  form.addEventListener("submit", async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    if (data.password !== document.getElementById("confirm").value) {
      result.className = "error"; result.textContent = "The passwords do not match."; return;
    }
    const response = await fetch("/api/auth/password-reset/confirm", {
      method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(data),
    });
    const body = await response.json().catch(() => ({}));
    result.className = response.ok ? "ok" : "error";
    result.textContent = body.message || (response.ok ? "Password changed." : "Something went wrong.");
    if (response.ok) form.querySelectorAll("input, button").forEach((el) => (el.disabled = true));
  });
</script>`,
    ),
  );
});
