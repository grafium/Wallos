import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { browserSession, endpoint, getPage } from "./ui-helpers";

describe("web interface: frame and dashboard", () => {
  it("sends visitors without a session to the login page", async () => {
    await browserSession(); // make sure an account exists
    const res = await getPage(null, "/");
    expect(res.status).toBe(302);
    expect(res.location).toBe("login.php");
  });

  it("starts an account without subscriptions on the subscriptions page", async () => {
    const browser = await browserSession();
    const res = await getPage(browser, "/index.php");
    expect(res.location).toBe("subscriptions.php");
  });

  it("renders the dashboard in the PHP markup, translated and escaped", async () => {
    const browser = await browserSession("dash", { firstname: "Zoë <b>" });
    const tomorrow = new Date(Date.now() + 86_400_000).toISOString().slice(0, 10);
    await endpoint(browser, "/api/subscriptions", { json: { name: "Netflix & Co", price: 15.99, next_payment: tomorrow } });

    const res = await getPage(browser, "/");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toMatch(/text\/html/);
    expect(res.html.startsWith("<!DOCTYPE html>")).toBe(true);
    expect(res.html).toContain('<section class="contain dashboard">');
    expect(res.html).toContain("Hello Zoë &lt;b&gt;");
    expect(res.html).toContain("<p class=\"subscription-item-title\">Netflix &amp; Co</p>");
    expect(res.html).toContain("€15.99");
    expect(res.html).toContain(`window.csrfToken = "${browser.csrf}"`);
    expect(res.html).toContain('id="subscription-details"');
    expect(res.html).toContain("window.subscriptionLookups = ");
    expect(res.html).toContain('src="scripts/dashboard.js?');
  });

  it("speaks the user's language", async () => {
    const browser = await browserSession("hu", { language: "hu" });
    await endpoint(browser, "/api/subscriptions", { json: { name: "X", price: 1 } });
    const res = await getPage(browser, "/");
    expect(res.html).toContain("Üdvözlöm");
    expect(res.html).toContain('src="scripts/i18n/hu.js?');
  });

  it("serves the about page and the static assets", async () => {
    const browser = await browserSession();
    expect((await getPage(browser, "/about.php")).html).toContain('<div class="credits-list">');
    // The platform serves static files before the Worker runs; here through the binding.
    const css = await env.ASSETS!.fetch("https://wallos.test/styles/styles.css");
    expect(css.status).toBe(200);
    expect(await css.text()).toContain("--main-color");
  });

  it("requires the CSRF token for cookie-authenticated changes", async () => {
    const browser = await browserSession();
    const without = await endpoint(browser, "/api/subscriptions", { json: { name: "X", price: 1 }, csrf: false });
    expect(without.status).toBe(403);
    const withToken = await endpoint(browser, "/api/subscriptions", { json: { name: "X", price: 1 } });
    expect(withToken.status).toBe(201);
    // Reading needs no token.
    expect((await endpoint(browser, "/api/subscriptions", { csrf: false })).status).toBe(200);
  });

  it("ignores session cookies that are expired", async () => {
    const browser = await browserSession();
    await env.DB.prepare("UPDATE sessions SET expires_at = '2000-01-01T00:00:00Z' WHERE user_id = ?").bind(browser.userId).run();
    const res = await getPage(browser, "/");
    expect(res.location).toBe("login.php");
    expect(res.headers.get("set-cookie")).toMatch(/wallos_session=;/);
  });
});
