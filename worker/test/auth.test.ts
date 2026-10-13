import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { sha256Hex } from "../src/lib/crypto";
import { sha256HexSync } from "../src/lib/sha256-sync";
import { base32Decode, base32Encode, matchTotp, timeStep, totpCode } from "../src/lib/totp";
import { clearOidcDiscoveryCache } from "../src/services/oidc";
import { browserSession, endpoint, getPage, raw, type Browser, type Json } from "./ui-helpers";

/*
  Phase 6: two-factor authentication, login throttling, OIDC single sign-on.
*/

const PASSWORD = "correct horse";
let ipCounter = 0;
/** A fresh client address per test, so throttle counters do not leak between tests. */
const freshIp = () => `198.51.100.${++ipCounter}`;

function cookieFrom(response: Response, name: string): string | null {
  const header = response.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
  return header ? header.split(";")[0]!.slice(name.length + 1) : null;
}

const form = (fields: Record<string, string>, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", "accept-language": "en-US", ...headers },
  body: new URLSearchParams(fields).toString(),
});

async function apiLogin(username: string, extra: Record<string, unknown> = {}, ip = freshIp()) {
  const response = await raw("/api/auth/login", {
    method: "POST",
    headers: { "content-type": "application/json", "cf-connecting-ip": ip },
    body: JSON.stringify({ username, password: PASSWORD, ...extra }),
  });
  return { status: response.status, body: (await response.json()) as Json };
}

async function api(token: string, path: string, json?: unknown, method = json === undefined ? "GET" : "POST") {
  const response = await raw(path, {
    method,
    headers: { authorization: `Bearer ${token}`, ...(json === undefined ? {} : { "content-type": "application/json" }) },
    body: json === undefined ? undefined : JSON.stringify(json),
  });
  return { status: response.status, body: (await response.json()) as Json };
}

const currentCode = (secret: string, offset = 0) => totpCode(secret, timeStep(Math.floor(Date.now() / 1000)) + offset);

/** Turns 2FA on for a browser session through the profile endpoints; returns the secret and backup codes. */
async function enrol(browser: Browser) {
  const generated = (await endpoint(browser, "/endpoints/user/enable_totp.php", { json: { action: "generate" } })).json!;
  const verified = (await endpoint(browser, "/endpoints/user/enable_totp.php", { json: { action: "verify", totpSecret: generated.secret, totpCode: await currentCode(generated.secret) } })).json!;
  expect(verified).toMatchObject({ success: true });
  // The enrolment code's time step counts as used; let the current one be used for a login.
  await env.DB.prepare("UPDATE totp SET last_totp_used = 0 WHERE user_id = ?").bind(browser.userId).run();
  return { secret: generated.secret as string, backupCodes: verified.backupCodes as string[] };
}

let admin: Browser;

beforeAll(async () => {
  await env.DB.prepare("DELETE FROM user").run();
  admin = await browserSession("admin");
  expect(admin.userId).toBe(1);
});

afterEach(async () => {
  vi.restoreAllMocks();
  clearOidcDiscoveryCache();
});

describe("TOTP primitives", () => {
  const secret = base32Encode(new TextEncoder().encode("12345678901234567890"));

  it("matches the RFC 6238 test vectors (SHA-1, last six digits)", async () => {
    expect(secret).toBe("GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ");
    expect(await totpCode(secret, timeStep(59))).toBe("287082");
    expect(await totpCode(secret, timeStep(1111111109))).toBe("081804");
    expect(await totpCode(secret, timeStep(1234567890))).toBe("005924");
    expect(await totpCode(secret, timeStep(2000000000))).toBe("279037");
  });

  it("round-trips base32 and rejects other text", () => {
    const bytes = crypto.getRandomValues(new Uint8Array(20));
    expect(base32Decode(base32Encode(bytes))).toEqual(bytes);
    expect(base32Decode("not base32!")).toBeNull();
  });

  it("accepts the neighbouring step only within 15 seconds of the boundary, as OTPHP did", async () => {
    const next = await totpCode(secret, 2);
    expect(await matchTotp(secret, next, 59)).toBe(2); // 59 + 15 is in step 2
    expect(await matchTotp(secret, next, 40)).toBeNull();
    expect(await matchTotp(secret, "28 70 82", 59)).toBe(1);
    expect(await matchTotp(secret, "abcdef", 59)).toBeNull();
  });

  it("hashes the same with the importer's synchronous SHA-256", async () => {
    for (const text of ["", "abc", "a".repeat(55), "b".repeat(56), "c".repeat(64), "árvíztűrő tükörfúrógép 🔑", `wallos-backup:${"0f".repeat(10)}`]) {
      expect(sha256HexSync(text)).toBe(await sha256Hex(text));
    }
  });
});

describe("two-factor login in the browser", () => {
  it("asks for the code after the password and signs in only with a valid, unused one", async () => {
    const user = await browserSession("tfa");
    const { secret } = await enrol(user);
    expect((await getPage(user, "/profile.php")).html).toContain('id="disableTotp"');
    const ip = freshIp();

    const login = await raw("/login.php", form({ username: user.username, password: PASSWORD }, { "cf-connecting-ip": ip }));
    expect(login.status).toBe(302);
    expect(login.headers.get("location")).toBe("totp.php");
    expect(cookieFrom(login, "wallos_session")).toBeNull();
    const pending = cookieFrom(login, "wallos_2fa")!;
    const cookie = `wallos_2fa=${pending}`;

    const pageView = await getPage(null, "/totp.php", { cookie });
    expect(pageView.status).toBe(200);
    expect(pageView.html).toContain('name="one-time-code"');
    expect((await getPage(null, "/totp.php")).location).toBe("login.php"); // no pending login

    const wrong = await raw("/totp.php", form({ "one-time-code": "000000" }, { cookie, "cf-connecting-ip": ip }));
    expect(wrong.status).toBe(401);
    expect(await wrong.text()).toContain("TOTP code is incorrect");

    const code = await currentCode(secret);
    const right = await raw("/totp.php", form({ "one-time-code": code }, { cookie, "cf-connecting-ip": ip }));
    expect(right.status).toBe(302);
    expect(right.headers.get("location")).toBe(".");
    const session = cookieFrom(right, "wallos_session")!;
    expect((await getPage({ cookie: `wallos_session=${session}` } as Browser, "/profile.php")).status).toBe(200);

    // The pending step is used up, and the same code cannot open a second login.
    expect((await getPage(null, "/totp.php", { cookie })).location).toBe("login.php");
    const again = cookieFrom(await raw("/login.php", form({ username: user.username, password: PASSWORD }, { "cf-connecting-ip": ip })), "wallos_2fa")!;
    const replay = await raw("/totp.php", form({ "one-time-code": code }, { cookie: `wallos_2fa=${again}`, "cf-connecting-ip": ip }));
    expect(replay.status).toBe(401);
  });

  it("accepts each backup code once, case-insensitively", async () => {
    const user = await browserSession("backup");
    const { backupCodes } = await enrol(user);
    expect(backupCodes).toHaveLength(10);
    expect(backupCodes[0]).toMatch(/^[0-9a-f]{20}$/);
    const stored = await env.DB.prepare("SELECT backup_codes FROM totp WHERE user_id = ?").bind(user.userId).first<{ backup_codes: string }>();
    expect(stored!.backup_codes).not.toContain(backupCodes[0]); // only hashes are kept

    const ip = freshIp();
    const step = async () => `wallos_2fa=${cookieFrom(await raw("/login.php", form({ username: user.username, password: PASSWORD }, { "cf-connecting-ip": ip })), "wallos_2fa")}`;
    const first = await raw("/totp.php", form({ "one-time-code": backupCodes[0]!.toUpperCase() }, { cookie: await step(), "cf-connecting-ip": ip }));
    expect(first.status).toBe(302);
    const second = await raw("/totp.php", form({ "one-time-code": backupCodes[0]! }, { cookie: await step(), "cf-connecting-ip": ip }));
    expect(second.status).toBe(401);
  });

  it("locks the second step for 30 seconds after five wrong codes, per account", async () => {
    const user = await browserSession("lock");
    const { secret } = await enrol(user);
    for (let i = 0; i < 5; i++) {
      // A new password step each time: the counter is kept on the account, not the attempt.
      const ip = freshIp();
      const cookie = `wallos_2fa=${cookieFrom(await raw("/login.php", form({ username: user.username, password: PASSWORD }, { "cf-connecting-ip": ip })), "wallos_2fa")}`;
      const res = await raw("/totp.php", form({ "one-time-code": "999999" }, { cookie, "cf-connecting-ip": ip }));
      expect(res.status).toBe(i < 4 ? 401 : 429);
    }
    const ip = freshIp();
    const cookie = `wallos_2fa=${cookieFrom(await raw("/login.php", form({ username: user.username, password: PASSWORD }, { "cf-connecting-ip": ip })), "wallos_2fa")}`;
    const locked = await raw("/totp.php", form({ "one-time-code": await currentCode(secret) }, { cookie, "cf-connecting-ip": ip }));
    expect(locked.status).toBe(429);
    expect(await locked.text()).toContain("Too many failed attempts");

    await env.DB.prepare("UPDATE totp SET lockout_until = 0 WHERE user_id = ?").bind(user.userId).run();
    expect((await raw("/totp.php", form({ "one-time-code": await currentCode(secret) }, { cookie, "cf-connecting-ip": ip }))).status).toBe(302);
  });

  it("refuses to enable twice or with a wrong code, and disables with a code", async () => {
    const user = await browserSession("toggle");
    const generated = (await endpoint(user, "/endpoints/user/enable_totp.php", { json: { action: "generate" } })).json!;
    const bad = await endpoint(user, "/endpoints/user/enable_totp.php", { json: { action: "verify", totpSecret: generated.secret, totpCode: "000000" } });
    expect(bad.json).toMatchObject({ success: false, message: "TOTP code is incorrect" });
    const { secret, backupCodes } = await enrol(user);
    const twice = await endpoint(user, "/endpoints/user/enable_totp.php", { json: { action: "verify", totpSecret: secret, totpCode: await currentCode(secret) } });
    expect(twice.json).toMatchObject({ success: false, message: "Two Factor Authentication is already enabled" });

    expect((await endpoint(user, "/endpoints/user/disable_totp.php", { json: { totpCode: "000000" } })).json).toMatchObject({ success: false, reload: false });
    expect((await endpoint(user, "/endpoints/user/disable_totp.php", { json: { totpCode: backupCodes[3] } })).json).toMatchObject({ success: true, reload: true });
    const row = await env.DB.prepare("SELECT u.totp_enabled, (SELECT COUNT(*) FROM totp WHERE user_id = u.id) AS rows FROM user u WHERE u.id = ?").bind(user.userId).first<Json>();
    expect(row).toEqual({ totp_enabled: 0, rows: 0 });
    // Without 2FA the password alone signs in again.
    expect((await raw("/login.php", form({ username: user.username, password: PASSWORD }, { "cf-connecting-ip": freshIp() }))).headers.get("location")).toBe(".");
  });
});

describe("two-factor in the JSON API", () => {
  it("wants totp_code with the password", async () => {
    const user = await browserSession("apitfa");
    const { secret } = await enrol(user);
    const missing = await apiLogin(user.username);
    expect(missing.status).toBe(401);
    expect(missing.body).toMatchObject({ success: false, two_factor_required: true });
    expect((await apiLogin(user.username, { totp_code: "123456" })).status).toBe(401);
    const ok = await apiLogin(user.username, { totp_code: await currentCode(secret) });
    expect(ok.status).toBe(200);
    expect(ok.body.token).toMatch(/^[0-9a-f]{64}$/);
  });

  it("manages 2FA under /api/me/two-factor, from a session only", async () => {
    const user = await browserSession("apime");
    expect((await api(user.token, "/api/me/two-factor")).body).toMatchObject({ enabled: false, backup_codes_remaining: 0 });
    const setup = await api(user.token, "/api/me/two-factor/setup", {});
    expect(setup.body.otpauth_url).toContain(setup.body.secret);
    const enabled = await api(user.token, "/api/me/two-factor/enable", { secret: setup.body.secret, code: await currentCode(setup.body.secret) });
    expect(enabled.status).toBe(200);
    expect(enabled.body.backup_codes).toHaveLength(10);
    expect((await api(user.token, "/api/me/two-factor")).body).toMatchObject({ enabled: true, backup_codes_remaining: 10 });

    const apiKey = (await env.DB.prepare("SELECT api_key FROM user WHERE id = ?").bind(user.userId).first<{ api_key: string }>())!.api_key;
    expect((await api(apiKey, "/api/me/two-factor/disable", { code: enabled.body.backup_codes[0] })).status).toBe(403);
    expect((await api(user.token, "/api/me/two-factor/disable", { code: "000000" })).status).toBe(400);
    expect((await api(user.token, "/api/me/two-factor/disable", { code: enabled.body.backup_codes[0] })).status).toBe(200);
  });
});

describe("login throttling", () => {
  it("blocks a username from an address after ten failures, but not other addresses", async () => {
    const user = await browserSession("throttle");
    const ip = freshIp();
    for (let i = 0; i < 10; i++) {
      const res = await raw("/login.php", form({ username: user.username, password: "wrong" }, { "cf-connecting-ip": ip }));
      expect(res.status).toBe(401);
    }
    const blocked = await raw("/login.php", form({ username: user.username, password: PASSWORD }, { "cf-connecting-ip": ip }));
    expect(blocked.status).toBe(429);
    expect(await blocked.text()).toContain("Too many failed attempts");
    expect((await apiLogin(user.username, {}, ip)).status).toBe(429);

    expect((await raw("/login.php", form({ username: user.username, password: PASSWORD }, { "cf-connecting-ip": freshIp() }))).status).toBe(302);
  });

  it("blocks an address after thirty failures across usernames", async () => {
    const ip = freshIp();
    for (let i = 0; i < 30; i++) await raw("/login.php", form({ username: `nobody${i}`, password: "wrong" }, { "cf-connecting-ip": ip }));
    expect((await apiLogin(admin.username, {}, ip)).status).toBe(429);
  });

  it("limits password reset requests per address", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ id: "email_1" }));
    const ip = freshIp();
    const request = () =>
      raw("/api/auth/password-reset", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": ip }, body: JSON.stringify({ email: "x@example.com" }) });
    for (let i = 0; i < 10; i++) expect((await request()).status).toBe(200);
    expect((await request()).status).toBe(429);
  });
});

describe("OIDC single sign-on", () => {
  const settings = {
    oidcName: "Authentik",
    oidcClientId: "wallos-client",
    oidcClientSecret: "s3cret",
    oidcAuthUrl: "https://idp.example.com/authorize",
    oidcTokenUrl: "https://idp.example.com/token",
    oidcUserInfoUrl: "https://idp.example.com/userinfo",
    oidcRedirectUrl: "https://wallos.test/",
    oidcLogoutUrl: "https://idp.example.com/logout",
    oidcUserIdentifierField: "sub",
    oidcScopes: "openid email profile",
    oidcAuthStyle: "auto",
    oidcAutoCreateUser: 0,
    oidcPasswordLoginDisabled: 0,
    oidcRequireEmailVerified: 1,
  };

  async function configure(overrides: Record<string, unknown> = {}) {
    expect((await endpoint(admin, "/endpoints/admin/saveoidcsettings.php", { json: { ...settings, ...overrides } })).json).toMatchObject({ success: true });
    expect((await endpoint(admin, "/endpoints/admin/enableoidc.php", { json: { oidcEnabled: 1 } })).json).toMatchObject({ success: true });
  }

  function provider(userInfo: Record<string, unknown>) {
    const calls: { url: string; body: string; headers: Headers }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const url = String(input instanceof Request ? input.url : input);
      calls.push({ url, body: String(init?.body ?? ""), headers: new Headers(init?.headers) });
      if (url === settings.oidcTokenUrl) return Response.json({ access_token: "provider-access-token", token_type: "Bearer" });
      if (url === settings.oidcUserInfoUrl) return Response.json(userInfo);
      return new Response("unexpected", { status: 500 });
    });
    return calls;
  }

  /** Starts a login at oidclogin.php and comes back from the provider; returns the final response. */
  async function roundTrip(stateOverride?: string) {
    const start = await raw("/oidclogin.php");
    expect(start.status).toBe(302);
    const location = new URL(start.headers.get("location")!);
    const cookie = `wallos_oidc=${cookieFrom(start, "wallos_oidc")}`;
    const state = stateOverride ?? location.searchParams.get("state")!;
    return { location, response: await raw(`/?code=auth-code&state=${state}`, { headers: { cookie } }) };
  }

  it("is configured on the admin page, with the client secret masked", async () => {
    await configure();
    const page = await getPage(admin, "/admin.php");
    expect(page.html).toContain('id="oidcEnabled" checked=""');
    expect(page.html).toContain('value="https://idp.example.com/token"');
    expect(page.html).toContain('id="oidcClientSecret" placeholder="Client Secret" autocomplete="off" value="********"');
    expect(page.html).not.toContain("s3cret");

    // Saving the mask back keeps the secret.
    await configure({ oidcClientSecret: "********" });
    expect((await env.DB.prepare("SELECT client_secret FROM oauth_settings WHERE id = 1").first<{ client_secret: string }>())!.client_secret).toBe("s3cret");

    const unsafe = await endpoint(admin, "/endpoints/admin/saveoidcsettings.php", { json: { ...settings, oidcTokenUrl: "http://127.0.0.1/token" } });
    expect(unsafe.json).toMatchObject({ success: false, message: expect.stringContaining("Token URL") });
    const nonAdmin = await browserSession("plain");
    expect((await endpoint(nonAdmin, "/endpoints/admin/enableoidc.php", { json: { oidcEnabled: 0 } })).json).toMatchObject({ success: false });
  });

  it("shows the provider button and sends the browser there with state and PKCE", async () => {
    await configure();
    const login = await getPage(null, "/login.php");
    expect(login.html).toContain('<a class="button secondary-button" href="oidclogin.php">Login with Authentik</a>');
    expect(login.html).toContain('<span class="or-separator">or</span>');
    expect(login.html).toContain('name="password"');

    const { location } = await roundTrip("ignored");
    expect(location.origin + location.pathname).toBe("https://idp.example.com/authorize");
    expect(Object.fromEntries(location.searchParams)).toMatchObject({
      response_type: "code",
      client_id: "wallos-client",
      redirect_uri: "https://wallos.test/",
      scope: "openid email profile",
      code_challenge_method: "S256",
    });
    expect(location.searchParams.get("state")).toMatch(/^[0-9a-f]{32}$/);
  });

  it("links a verified e-mail to the existing account and signs in", async () => {
    await configure();
    const adminEmail = (await env.DB.prepare("SELECT email FROM user WHERE id = 1").first<{ email: string }>())!.email;
    const calls = provider({ sub: "idp-admin", email: adminEmail, email_verified: true });
    const { response } = await roundTrip();
    expect(response.status).toBe(302);
    expect(response.headers.get("location")).toBe(".");
    const session = cookieFrom(response, "wallos_session")!;
    expect(session).toMatch(/^[0-9a-f]{64}$/);
    expect(response.headers.getSetCookie().find((c) => c.startsWith("wallos_session="))).toMatch(/Expires=/i);

    const tokenCall = calls.find((call) => call.url === settings.oidcTokenUrl)!;
    const sent = new URLSearchParams(tokenCall.body);
    expect(sent.get("grant_type")).toBe("authorization_code");
    expect(sent.get("code")).toBe("auth-code");
    expect(sent.get("client_secret")).toBe("s3cret");
    expect(sent.get("code_verifier")).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(calls.find((call) => call.url === settings.oidcUserInfoUrl)!.headers.get("authorization")).toBe("Bearer provider-access-token");
    expect((await env.DB.prepare("SELECT oidc_sub FROM user WHERE id = 1").first<{ oidc_sub: string }>())!.oidc_sub).toBe("idp-admin");

    // Logging out of that session also logs out at the provider.
    const out = await raw("/logout.php", { headers: { cookie: `wallos_session=${session}` } });
    expect(out.headers.get("location")).toBe(`https://idp.example.com/logout?post_logout_redirect_uri=${encodeURIComponent("https://wallos.test/")}`);
  });

  it("rejects a wrong or reused state", async () => {
    await configure();
    provider({ sub: "idp-admin" });
    const { response } = await roundTrip("0".repeat(32));
    expect(response.headers.get("location")).toBe("login.php?error=oidc_invalid_state");
    expect((await raw("/?code=x&state=y")).headers.get("location")).toBe("login.php?error=oidc_invalid_state");
    expect((await getPage(null, "/login.php?error=oidc_invalid_state")).html).toContain("Login details are incorrect");
  });

  it("does not link an unverified e-mail, and creates accounts only when allowed", async () => {
    await configure();
    provider({ sub: "stranger", email: "stranger@example.com", email_verified: false });
    expect((await roundTrip()).response.headers.get("location")).toBe("login.php?error=oidc_email_not_verified");
    vi.restoreAllMocks();

    provider({ sub: "newcomer", email: "newcomer@example.com", email_verified: true, preferred_username: "new comer!", name: "New Comer", locale: "hu-HU" });
    expect((await roundTrip()).response.headers.get("location")).toBe("login.php?error=oidc_user_not_found");

    await configure({ oidcAutoCreateUser: 1 });
    const created = await roundTrip();
    expect(created.response.headers.get("location")).toBe(".");
    const row = await env.DB.prepare("SELECT username, firstname, lastname, language, oidc_sub FROM user WHERE email = 'newcomer@example.com'").first<Json>();
    expect(row).toEqual({ username: "newcomer", firstname: "New", lastname: "Comer", language: "hu", oidc_sub: "newcomer" });
    // Next time the subject alone finds the account.
    expect((await roundTrip()).response.headers.get("location")).toBe(".");
    expect((await env.DB.prepare("SELECT COUNT(*) AS n FROM user WHERE email = 'newcomer@example.com'").first<{ n: number }>())!.n).toBe(1);
  });

  it("enforces SSO-only on the form, the API and registration", async () => {
    await configure({ oidcPasswordLoginDisabled: 1 });
    await env.DB.prepare("UPDATE admin SET registrations_open = 1").run();
    const page = await getPage(null, "/login.php");
    expect(page.html).not.toContain('name="password"');
    expect(page.html).not.toContain('href="registration.php"');
    expect(page.html).toContain('href="oidclogin.php"');
    const post = await raw("/login.php", form({ username: admin.username, password: PASSWORD }, { "cf-connecting-ip": freshIp() }));
    expect(post.status).toBe(401);
    expect((await apiLogin(admin.username)).status).toBe(403);
    expect((await getPage(null, "/registration.php")).location).toBe("login.php");

    // A Worker variable overrides the stored switch (and pins it on the admin page).
    const override = { ...env, OIDC_DISABLE_PASSWORD_LOGIN: "false" };
    const allowed = await raw("/api/auth/login", { method: "POST", headers: { "content-type": "application/json", "cf-connecting-ip": freshIp() }, body: JSON.stringify({ username: admin.username, password: PASSWORD }) }, override);
    expect(allowed.status).toBe(200);
    const adminPage = await raw("/admin.php", { headers: { cookie: admin.cookie } }, override);
    expect(await adminPage.text()).toContain('data-managed-by="OIDC_DISABLE_PASSWORD_LOGIN"');

    await configure({ oidcPasswordLoginDisabled: 0 });
  });

  it("reads the endpoints from OIDC_ISSUER discovery", async () => {
    await configure({ oidcAuthUrl: "", oidcTokenUrl: "", oidcUserInfoUrl: "" });
    expect((await getPage(null, "/login.php")).html).not.toContain("oidclogin.php"); // not configured without endpoints
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url === "https://sso.example.com/realms/home/.well-known/openid-configuration") {
        return Response.json({ authorization_endpoint: "https://sso.example.com/auth", token_endpoint: "https://sso.example.com/token", userinfo_endpoint: "https://sso.example.com/me" });
      }
      return new Response("unexpected", { status: 500 });
    });
    const withIssuer = { ...env, OIDC_ISSUER: "https://sso.example.com/realms/home/" };
    const start = await raw("/oidclogin.php", {}, withIssuer);
    expect(start.headers.get("location")).toMatch(/^https:\/\/sso\.example\.com\/auth\?/);
    await configure();
  });

  it("answers the PHP admin API, with the secret masked", async () => {
    await configure();
    const apiKey = (await env.DB.prepare("SELECT api_key FROM user WHERE id = 1").first<{ api_key: string }>())!.api_key;
    const get = await raw(`/api/admin/get_oidc_settings.php?api_key=${apiKey}`);
    const body = (await get.json()) as Json;
    expect(body).toMatchObject({ success: true, title: "oidc_settings", oidc_enabled: 1, oidc_settings: { name: "Authentik", client_secret: "********" } });

    const post = (fields: Record<string, string>) =>
      raw(`/api/admin/${fields.path}`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ api_key: apiKey, ...fields }).toString() });
    expect(((await (await post({ path: "set_disable_password_login.php", disable: "1" })).json()) as Json).message).toBe("Password login has been disabled.");
    expect(((await (await post({ path: "set_disable_password_login.php", disable: "2" })).json()) as Json).success).toBe(false);
    expect(((await (await post({ path: "set_oidc_settings.php", oidc_enabled: "0", password_login_disabled: "0", name: "Keycloak" })).json()) as Json).success).toBe(true);
    const after = await env.DB.prepare("SELECT o.name, o.password_login_disabled, a.oidc_oauth_enabled FROM oauth_settings o, admin a").first<Json>();
    expect(after).toEqual({ name: "Keycloak", password_login_disabled: 0, oidc_oauth_enabled: 0 });
  });
});
