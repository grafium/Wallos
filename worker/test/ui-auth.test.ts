import { env } from "cloudflare:workers";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { getPage, raw } from "./ui-helpers";

const form = (fields: Record<string, string>, headers: Record<string, string> = {}): RequestInit => ({
  method: "POST",
  headers: { "content-type": "application/x-www-form-urlencoded", "accept-language": "en-US", ...headers },
  body: new URLSearchParams(fields).toString(),
});

const cookieValue = (response: Response, name: string) => {
  const header = response.headers.getSetCookie().find((c) => c.startsWith(`${name}=`));
  return header ? { value: header.split(";")[0]!.slice(name.length + 1), header } : null;
};

async function register(username: string, extra: Record<string, string> = {}) {
  return raw(
    "/registration.php",
    form({ username, firstname: "", lastname: "", email: `${username}@example.com`, password: "correct horse", confirm_password: "correct horse", main_currency: "HUF", language: "en", ...extra }),
  );
}

async function login(username: string, password = "correct horse", remember = false) {
  return raw("/login.php", form({ username, password, ...(remember ? { remember: "on" } : {}) }));
}

beforeAll(async () => {
  await env.DB.prepare("DELETE FROM user").run();
  await env.DB.prepare("UPDATE admin SET registrations_open = 0, require_email_verification = 0").run();
});

afterEach(() => vi.restoreAllMocks());

describe("first run, registration and login", () => {
  it("sends a fresh instance to the registration page", async () => {
    expect((await getPage(null, "/")).location).toBe("registration.php");
    expect((await getPage(null, "/login.php")).location).toBe("registration.php");
    const page = await getPage(null, "/registration.php");
    expect(page.status).toBe(200);
    expect(page.html).toContain('<form action="registration.php" method="post" class="registration-form">');
    expect(page.html).toContain('<option value="HUF">Hungarian Forint</option>');
  });

  it("creates the admin, then logs in with a session cookie", async () => {
    const reg = await register("admin");
    expect(reg.status).toBe(302);
    expect(reg.headers.get("location")).toBe("login.php?registered=true&requireValidation=");

    const page = await getPage(null, "/login.php?registered=true");
    expect(page.html).toContain("Registration successful");
    expect(page.html).not.toContain("registration.php"); // registrations are closed now

    const bad = await login("admin", "wrong password");
    expect(bad.status).toBe(401);
    expect(await bad.text()).toContain("Login details are incorrect");

    const ok = await login("admin");
    expect(ok.status).toBe(302);
    expect(ok.headers.get("location")).toBe(".");
    const session = cookieValue(ok, "wallos_session")!;
    expect(session.header).toMatch(/HttpOnly/i);
    expect(session.header).toMatch(/SameSite=Lax/i);
    expect(session.header).not.toMatch(/Expires/i); // no "stay logged in": browser-session cookie
    expect(cookieValue(ok, "language")!.value).toBe("en");

    const home = await getPage({ cookie: `wallos_session=${session.value}` } as never, "/");
    expect(home.location).toBe("subscriptions.php"); // signed in, no subscriptions yet

    // Already signed in: the login page goes home.
    expect((await getPage({ cookie: `wallos_session=${session.value}` } as never, "/login.php")).location).toBe(".");
  });

  it("keeps the session across browser restarts only with stay logged in", async () => {
    const ok = await login("admin", "correct horse", true);
    expect(cookieValue(ok, "wallos_session")!.header).toMatch(/Expires=/i);
  });

  it("logs out by deleting the session and the cookie", async () => {
    const session = cookieValue(await login("admin"), "wallos_session")!.value;
    const out = await raw("/logout.php", { headers: { cookie: `wallos_session=${session}` } });
    expect(out.headers.get("location")).toBe("login.php");
    expect(cookieValue(out, "wallos_session")!.value).toBe("");
    expect((await getPage({ cookie: `wallos_session=${session}` } as never, "/")).location).toBe("login.php");
  });

  it("only offers registration while the admin allows it", async () => {
    expect((await getPage(null, "/registration.php")).location).toBe("login.php");
    await env.DB.prepare("UPDATE admin SET registrations_open = 1").run();

    expect((await getPage(null, "/login.php")).html).toContain('<a href="registration.php">');
    const mismatch = await register("second", { confirm_password: "something else" });
    expect(mismatch.status).toBe(400);
    expect(await mismatch.text()).toContain("Passwords do not match");

    const taken = await register("admin");
    expect(await taken.text()).toContain("Username already exists");

    expect((await register("second")).status).toBe(302);
    expect((await login("second")).status).toBe(302);
  });

  it("refuses unverified accounts when verification is required", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValue(Response.json({ id: "email_1" }));
    await env.DB.prepare("UPDATE admin SET registrations_open = 1, require_email_verification = 1").run();
    try {
      const reg = await register("unverified");
      expect(reg.headers.get("location")).toBe("login.php?registered=true&requireValidation=1");
      const res = await login("unverified");
      expect(res.status).toBe(401);
      expect(await res.text()).toContain("Your email needs to be verified");
    } finally {
      await env.DB.prepare("UPDATE admin SET require_email_verification = 0").run();
    }
  });
});

describe("language of the signed-out pages", () => {
  it("follows the language cookie, then the browser", async () => {
    expect((await getPage(null, "/login.php", { "accept-language": "hu-HU,hu;q=0.9" })).html).toContain("Bejelentkezés");
    expect((await getPage(null, "/login.php", { cookie: "language=de" })).html).toContain('dir="ltr"');
  });
});

describe("password reset pages", () => {
  it("e-mails a link whose page sets a new password", async () => {
    const sent: { text: string }[] = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (_input, init) => {
      sent.push(JSON.parse(String(init?.body)));
      return Response.json({ id: "email_1" });
    });

    const request = await raw("/passwordreset.php?submit=true", form({ email: "admin@example.com" }));
    expect(await request.text()).toContain("Reset email sent");
    const link = new URL(/https?:\/\/\S+/.exec(sent[0]!.text)![0]);
    expect(link.pathname).toBe("/passwordreset.php");

    const resetForm = await getPage(null, `${link.pathname}${link.search}`);
    expect(resetForm.html).toContain('name="confirm_password"');

    const done = await raw(
      `/passwordreset.php?submit=true`,
      form({ email: link.searchParams.get("email")!, token: link.searchParams.get("token")!, password: "a new password", confirm_password: "a new password" }),
    );
    expect(await done.text()).toContain("Password reset successful");
    expect((await login("admin")).status).toBe(401);
    expect((await login("admin", "a new password")).status).toBe(302);
  });

  it("shows a failed verification link", async () => {
    const res = await getPage(null, `/verifyemail.php?email=x@example.com&token=${"0".repeat(64)}`);
    expect(res.status).toBe(400);
    expect(res.html).toContain("Email verification failed");
  });
});
