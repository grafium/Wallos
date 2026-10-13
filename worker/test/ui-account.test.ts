import { env } from "cloudflare:workers";
import { encode } from "fast-png";
import { afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { browserSession, endpoint, getPage, raw, type Browser } from "./ui-helpers";

/*
  The statistics, profile and admin pages, their endpoints/user/* and
  endpoints/admin/* calls, and the PWA files.
*/

let admin: Browser;

beforeAll(async () => {
  // Start from an empty instance so the first account is user 1, the administrator.
  await env.DB.prepare("DELETE FROM user").run();
  admin = await browserSession("admin");
  expect(admin.userId).toBe(1);
});

afterEach(() => {
  vi.restoreAllMocks();
});

function png(size = 8): Uint8Array {
  const data = new Uint8Array(size * size * 4).fill(200);
  return encode({ width: size, height: size, data, channels: 4, depth: 8 });
}

const user = (browser: Browser) =>
  env.DB.prepare("SELECT * FROM user WHERE id = ?").bind(browser.userId).first<Record<string, any>>();

describe("statistics page", () => {
  it("shows the numbers of the user's subscriptions and the chart data", async () => {
    const browser = await browserSession("stats");
    const inAWeek = new Date(Date.now() + 7 * 86_400_000).toISOString().slice(0, 10);
    for (const sub of [
      { name: "Netflix", price: 15, cycle: 3, frequency: 1, next_payment: inAWeek, start_date: "2023-01-01" },
      { name: "Cloud <Box>", price: 120, cycle: 4, frequency: 1, next_payment: inAWeek, start_date: "2024-06-01", auto_renew: 0 },
      { name: "Gym", price: 5, cycle: 3, frequency: 1, next_payment: inAWeek, inactive: 1 },
    ]) {
      expect((await endpoint(browser, "/api/subscriptions", { json: sub })).status).toBe(201);
    }

    const res = await getPage(browser, "/stats.php");
    expect(res.status).toBe(200);
    const html = res.html;
    expect(html).toContain('<div class="split-header">');
    const tile = (value: string, title: string) => `<span>${value}</span><div class="title">${title}</div>`;
    expect(html).toContain(tile("2", "Active Subscriptions"));
    expect(html).toContain(tile("€25.00", "Monthly Cost"));
    expect(html).toContain(tile("€300.00", "Yearly Cost"));
    expect(html).toContain(tile("€0.82", "Cost per Day")); // 300 / 365.25
    expect(html).toContain(tile("€12.50", "Average Monthly Subscription Cost"));
    expect(html).toContain(`${tile("€15.00", "Most Expensive Subscription Cost")}<div class="subtitle">Netflix</div>`);
    expect(html).toContain(`<div class="subtitle">Cloud &lt;Box&gt;</div>`);
    expect(html).toContain(tile("1", "Manual Renewals"));
    expect(html).toContain(tile("1", "Inactive Subscriptions"));
    expect(html).toContain(tile("€5.00", "Monthly Savings (on inactive subscriptions)"));
    // Charts: ApexCharts, the PHP calls, numeric labels like JSON_NUMERIC_CHECK and "<" escaped.
    expect(html).toContain('<script src="scripts/libs/apexcharts.min.js"></script>');
    expect(html).toContain('id="cycleSplitChart"');
    expect(html).toContain('loadGraph("cycleSplitChart", [{"label":"Monthly","y":15},{"label":"Yearly","y":10}], "EUR", 1);');
    expect(html).toContain('loadBarGraph("newPerYearChart", [{"label":2023,"y":1},{"label":2024,"y":1}], "", 1, null);');
    expect(html).toContain("Cloud \\u003cBox>");
    expect(html).toContain('loadLineGraph("totalMonthlyCostChart", [], "EUR", 0);');
    expect(html).not.toContain('id="totalMonthlyCostChart"');
    expect(html).toMatch(/loadBarGraph\("projectionChart", \[\{"label":"[^"]+","y":\d/);
    expect(html).toContain('src="scripts/stats.js?');
  });

  it("filters by payment method and shows the budget", async () => {
    const browser = await browserSession("statsf");
    const methods = await env.DB.prepare('SELECT id, name FROM payment_methods WHERE user_id = ? ORDER BY "order" LIMIT 2').bind(browser.userId).all<{ id: number; name: string }>();
    const [first, second] = methods.results;
    await endpoint(browser, "/api/subscriptions", { json: { name: "A", price: 10, payment_method_id: first!.id } });
    await endpoint(browser, "/api/subscriptions", { json: { name: "B", price: 30, payment_method_id: second!.id } });
    expect((await endpoint(browser, "/endpoints/user/budget.php", { json: { monthly_budget: 20 } })).json).toMatchObject({ success: true });

    const all = await getPage(browser, "/stats.php");
    expect(all.html).toContain('<div class="title">Monthly Budget - Amount over budget</div>');
    expect(all.html).toContain('id="paymentMethidSplitChart"');
    expect(all.html).toContain(`data-paymentid="${second!.id}"`);

    const filtered = await getPage(browser, `/stats.php?payment=${second!.id}`);
    expect(filtered.html).toContain(`<span class="header-subtitle">(${second!.name})</span>`);
    expect(filtered.html).toContain("<span>€30.00</span><div class=\"title\">Monthly Cost</div>");
    expect(filtered.html).toContain(`class="filter-item selected" data-paymentid="${second!.id}"`);
    expect(filtered.html).toContain('onclick="clearFilters()"');
  });

  it("renders an empty account without charts", async () => {
    const browser = await browserSession("statse");
    const res = await getPage(browser, "/stats.php");
    expect(res.status).toBe(200);
    expect(res.html).toContain("<span>0</span><div class=\"title\">Active Subscriptions</div>");
    expect(res.html).not.toContain("apexcharts");
  });
});

describe("profile page and endpoints/user", () => {
  it("renders the user's details, avatars, API key and 2FA section", async () => {
    const browser = await browserSession("prof", { firstname: "Zoë <i>" });
    const res = await getPage(browser, "/profile.php");
    expect(res.status).toBe(200);
    const row = await user(browser);
    expect(res.html).toContain('id="userForm"');
    expect(res.html).toContain('value="Zoë &lt;i&gt;"');
    expect(res.html).toContain(`value="${row!.api_key}"`);
    expect(res.html).toContain('data-src="images/avatars/9.svg"');
    expect(res.html).toContain('id="enableTotp"');
    expect(res.html).toContain('id="delete-account"');
    expect(res.html).toMatch(/<option value="\d+" selected="">Euro<\/option>/);
    expect(res.html).toContain('<option value="hu">Magyar</option>');
    expect(res.html).toContain('src="scripts/profile.js?');
    // The administrator cannot delete their own account.
    expect((await getPage(admin, "/profile.php")).html).not.toContain('id="delete-account"');
  });

  it("saves the user details like save_user.php", async () => {
    const browser = await browserSession("save");
    const row = await user(browser);
    const base = { firstname: "Ada", lastname: "Lovelace", email: row!.email, avatar: "images/avatars/3.svg", main_currency: String(row!.main_currency), language: "en" };

    const saved = await endpoint(browser, "/endpoints/user/save_user.php", { form: { ...base, action: "save" } });
    expect(saved.json).toEqual({ success: true, message: "User details saved", reload: false });
    expect(await user(browser)).toMatchObject({ firstname: "Ada", lastname: "Lovelace", avatar: "images/avatars/3.svg" });

    // A language change asks the page to reload and sets the language cookie.
    const hu = await endpoint(browser, "/endpoints/user/save_user.php", { form: { ...base, language: "hu" } });
    expect(hu.json).toMatchObject({ success: true, reload: true });
    expect(hu.headers.get("set-cookie")).toContain("language=hu");

    expect((await endpoint(browser, "/endpoints/user/save_user.php", { form: { ...base, email: "" } })).json).toMatchObject({ success: false, message: "Kérjük, töltsön ki minden mezőt" });
    expect((await endpoint(browser, "/endpoints/user/save_user.php", { form: { ...base, email: `${admin.username}@example.com` } })).json).toMatchObject({ success: false });
    expect((await endpoint(browser, "/endpoints/user/save_user.php", { form: { ...base, password: "new password 1", confirm_password: "other" } })).json).toMatchObject({ success: false });
    expect((await endpoint(browser, "/endpoints/user/save_user.php", { form: { ...base, main_currency: "999999" } })).json).toMatchObject({ success: false });
    expect((await endpoint(browser, "/endpoints/user/save_user.php", { form: { ...base, avatar: "images/uploads/logos/avatars/someone-else.png" } })).json).toMatchObject({ success: false });

    // A new password works for the next login.
    const pw = await endpoint(browser, "/endpoints/user/save_user.php", { form: { ...base, password: "new password 1", confirm_password: "new password 1" } });
    expect(pw.json).toMatchObject({ success: true });
    const login = await raw("/api/auth/login", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ username: browser.username, password: "new password 1" }) });
    expect(login.status).toBe(200);
  });

  it("refreshes the exchange rates when the main currency changes", async () => {
    const browser = await browserSession("cur");
    const usd = await env.DB.prepare("SELECT id FROM currencies WHERE user_id = ? AND code = 'USD'").bind(browser.userId).first<{ id: number }>();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json([{ date: "2026-01-01", base: "USD", quote: "EUR", rate: 0.5 }]));
    const row = await user(browser);
    const res = await endpoint(browser, "/endpoints/user/save_user.php", {
      form: { firstname: "", lastname: "", email: row!.email, avatar: row!.avatar, main_currency: String(usd!.id), language: "en" },
    });
    expect(res.json).toMatchObject({ success: true });
    expect((await user(browser))!.main_currency).toBe(usd!.id);
    expect(fetchSpy).toHaveBeenCalled();
    const eur = await env.DB.prepare("SELECT rate FROM currencies WHERE user_id = ? AND code = 'EUR'").bind(browser.userId).first<{ rate: number }>();
    expect(eur!.rate).toBe(0.5);
  });

  it("uploads an avatar with the form and protects it from deletion while in use", async () => {
    const browser = await browserSession("avatar");
    const row = await user(browser);
    const form = new FormData();
    for (const [key, value] of Object.entries({ firstname: "", lastname: "", email: row!.email, avatar: "images/avatars/1.svg", main_currency: String(row!.main_currency), language: "en" })) {
      form.set(key, value);
    }
    form.set("profile_pic", new File([png()], "me.png", { type: "image/png" }));
    const res = await endpoint(browser, "/endpoints/user/save_user.php", { form });
    expect(res.json).toMatchObject({ success: true });
    const avatar = (await user(browser))!.avatar as string;
    expect(avatar).toMatch(/^images\/uploads\/logos\/avatars\/\d+-avatars-avatar.*\.png$/);
    expect(await env.FILES.head(avatar)).not.toBeNull();

    // Shown in the gallery with its delete button; deleting it is refused while it is the avatar.
    const filename = avatar.slice(avatar.lastIndexOf("/") + 1);
    expect((await getPage(browser, "/profile.php")).html).toContain(`<div class="avatar-container" data-src="${filename}">`);
    expect((await endpoint(browser, "/endpoints/user/delete_avatar.php", { json: { avatar: filename } })).json).toEqual({ success: false, message: "Avatar in use" });
    expect((await endpoint(browser, "/endpoints/user/delete_avatar.php", { json: { avatar: "other.png" } })).json).toMatchObject({ success: false, message: expect.stringContaining("Security Error") });
    expect((await endpoint(browser, "/endpoints/user/delete_avatar.php", { json: {} })).json).toEqual({ success: false, message: "Error" });

    // Switching back to a built-in avatar removes the unused upload.
    const back = await endpoint(browser, "/endpoints/user/save_user.php", {
      form: { firstname: "", lastname: "", email: row!.email, avatar: "images/avatars/2.svg", main_currency: String(row!.main_currency), language: "en" },
    });
    expect(back.json).toMatchObject({ success: true });
    expect(await env.FILES.head(avatar)).toBeNull();

    // Not an image.
    form.set("profile_pic", new File([new TextEncoder().encode("hello")], "x.png", { type: "image/png" }));
    expect((await endpoint(browser, "/endpoints/user/save_user.php", { form })).json).toEqual({ success: false, message: "Please fill all fields" });
  });

  it("saves the monthly and period budget like budget.php", async () => {
    const browser = await browserSession("budget");
    expect((await endpoint(browser, "/endpoints/user/budget.php", { json: { monthly_budget: 150.5 } })).json).toEqual({ success: true, message: "User details saved" });
    expect((await user(browser))!.budget).toBe(150.5);

    const period = await endpoint(browser, "/endpoints/user/budget.php", { json: { period_budget: 40, budget_period_type: "weekly", budget_period_anchor_date: "2024-05-01" } });
    expect(period.json).toMatchObject({ success: true });
    expect(await user(browser)).toMatchObject({ period_budget: 40, budget_period_type: "weekly", budget_period_anchor_date: "2024-05-01" });

    await endpoint(browser, "/endpoints/user/budget.php", { json: { period_budget: -5, budget_period_type: "hourly", budget_period_anchor_date: "nope" } });
    expect(await user(browser)).toMatchObject({ period_budget: 0, budget_period_type: "monthly", budget_period_anchor_date: new Date().toISOString().slice(0, 10) });

    expect((await endpoint(browser, "/endpoints/user/budget.php", { json: {} })).json).toEqual({ success: false, message: "Error updating user data." });
  });

  it("regenerates the API key", async () => {
    const browser = await browserSession("key");
    const before = (await user(browser))!.api_key;
    const res = await endpoint(browser, "/endpoints/user/regenerateapikey.php", { method: "POST" });
    expect(res.json).toMatchObject({ success: true, message: "User details saved" });
    expect(res.json!.apiKey).toMatch(/^[0-9a-f]{64}$/);
    expect(res.json!.apiKey).not.toBe(before);
    expect((await user(browser))!.api_key).toBe(res.json!.apiKey);
  });

  it("hands out a two-factor secret and its QR code URL (the flow is in auth.test.ts)", async () => {
    const browser = await browserSession("totp");
    const generated = (await endpoint(browser, "/endpoints/user/enable_totp.php", { json: { action: "generate" } })).json!;
    expect(generated).toMatchObject({ success: true, secret: expect.stringMatching(/^[A-Z2-7]{32}$/) });
    expect(generated.qrCodeUrl).toBe(`otpauth://totp/Wallos:${browser.username}?secret=${generated.secret}&issuer=Wallos`);
    expect((await endpoint(browser, "/endpoints/user/disable_totp.php", { json: { totpCode: "123456" } })).json).toMatchObject({ success: false, reload: true });
  });

  it("requires the session and the CSRF token", async () => {
    const browser = await browserSession("csrf");
    const without = await endpoint(browser, "/endpoints/user/regenerateapikey.php", { method: "POST", csrf: false });
    expect(without.json).toEqual({ success: false, message: "Invalid CSRF token" });
    const form = await endpoint(browser, "/endpoints/user/save_user.php", { form: { firstname: "x" }, csrf: false });
    expect(form.json).toEqual({ success: false, message: "Invalid CSRF token" });
    const anonymous = await raw("/endpoints/user/budget.php", { method: "POST", body: "{}" });
    expect(((await anonymous.json()) as Record<string, unknown>).success).toBe(false);
    expect((await getPage(null, "/profile.php")).location).toBe("login.php");
  });
});

describe("admin page and endpoints/admin", () => {
  it("is only for the administrator", async () => {
    const browser = await browserSession("notadmin");
    const page = await getPage(browser, "/admin.php");
    expect(page.status).toBe(302);
    expect(page.location).toBe(".");
    for (const path of ["adduser", "deleteuser", "saveopenregistrations", "deleteunusedlogos", "updatenotification"]) {
      expect((await endpoint(browser, `/endpoints/admin/${path}.php`, { json: { userId: admin.userId } })).json).toEqual({ success: false, message: "Error" });
    }
    expect((await endpoint(browser, "/endpoints/cronjobs/checkforupdates.php")).text).toBe("Unauthorized");
    expect(await user(admin)).not.toBeNull();
  });

  it("renders the admin page with users and settings", async () => {
    const other = await browserSession("listed");
    await env.FILES.put("images/uploads/logos/orphan-admin.png", png());
    const res = await getPage(admin, "/admin.php");
    expect(res.status).toBe(200);
    expect(res.html).toContain(`<div class="form-group-inline" data-userid="${other.userId}">`);
    expect(res.html).toContain(`onclick="removeUser(${other.userId})"`);
    expect(res.html).toContain('<input type="checkbox" id="registrations" checked=""/>');
    expect(res.html).toContain('id="smtpaddress"');
    expect(res.html).toContain('value="Wallos &lt;wallos@example.com&gt;" disabled="" data-managed-by="EMAIL_FROM"');
    expect(res.html).toMatch(/<span class="number-of-logos bold">[1-9]\d*<\/span>/);
    expect(res.html).toContain('onclick="executeCronJob(&#39;checkforupdates&#39;)"');
    expect(res.html).toContain('src="scripts/admin.js?');
  });

  it("adds and deletes users", async () => {
    const name = `added${Date.now() % 100000}`;
    const added = await endpoint(admin, "/endpoints/admin/adduser.php", { json: { username: name, email: `${name}@example.com`, password: "correct horse" } });
    expect(added.json).toEqual({ success: true, message: "Success" });
    const row = await env.DB.prepare("SELECT id FROM user WHERE username = ?").bind(name).first<{ id: number }>();
    expect(row).not.toBeNull();
    const currencies = await env.DB.prepare("SELECT COUNT(*) AS n FROM currencies WHERE user_id = ?").bind(row!.id).first<{ n: number }>();
    expect(currencies!.n).toBeGreaterThan(10);

    expect((await endpoint(admin, "/endpoints/admin/adduser.php", { json: { username: name, email: "x@example.com", password: "correct horse" } })).json).toEqual({ success: false, message: "Error" });
    expect((await endpoint(admin, "/endpoints/admin/adduser.php", { json: { username: "", email: "", password: "" } })).json).toEqual({ success: false, message: "Error" });
    expect((await endpoint(admin, "/endpoints/admin/adduser.php", { json: { username: "shortpw", email: "s@example.com", password: "x" } })).json).toMatchObject({ success: false });

    expect((await endpoint(admin, "/endpoints/admin/deleteuser.php", { json: { userId: row!.id } })).json).toEqual({ success: true, message: "Success" });
    expect(await env.DB.prepare("SELECT 1 FROM user WHERE id = ?").bind(row!.id).first()).toBeNull();
    expect(await env.DB.prepare("SELECT 1 FROM currencies WHERE user_id = ?").bind(row!.id).first()).toBeNull();
    expect((await endpoint(admin, "/endpoints/admin/deleteuser.php", { json: { userId: 1 } })).json).toEqual({ success: false, message: "Error" });
  });

  it("saves the registration settings", async () => {
    const save = (data: Record<string, unknown>) => endpoint(admin, "/endpoints/admin/saveopenregistrations.php", { json: data });
    const base = { open_registrations: 0, max_users: "5", require_email_validation: 0, server_url: "https://wallos.example.com", disable_login: 0 };
    expect((await save(base)).json).toEqual({ success: true, message: "Success" });
    expect(await env.DB.prepare("SELECT registrations_open, max_users, server_url FROM admin WHERE id = 1").first()).toEqual({
      registrations_open: 0,
      max_users: 5,
      server_url: "https://wallos.example.com",
    });
    expect((await save({ ...base, require_email_validation: 1, server_url: "" })).json).toEqual({ success: false, message: "Please fill all fields" });
    expect((await save({ ...base, disable_login: 1 })).json).toMatchObject({ success: false });
    expect((await save({ ...base, max_users: "-1" })).json).toEqual({ success: false, message: "Error" });
    expect((await save({ ...base, open_registrations: 1, max_users: 0, require_email_validation: 1 })).json).toMatchObject({ success: true });
    expect(await env.DB.prepare("SELECT registrations_open, require_email_verification FROM admin WHERE id = 1").first()).toEqual({
      registrations_open: 1,
      require_email_verification: 1,
    });
    await env.DB.prepare("UPDATE admin SET require_email_verification = 0").run();
  });

  it("deletes unused logos and toggles the update notification", async () => {
    await env.FILES.put("images/uploads/logos/orphan-delete.png", png());
    const res = await endpoint(admin, "/endpoints/admin/deleteunusedlogos.php", { method: "POST" });
    expect(res.json).toMatchObject({ success: true, message: "Success" });
    expect(res.json!.count).toBeGreaterThanOrEqual(1);
    expect(await env.FILES.head("images/uploads/logos/orphan-delete.png")).toBeNull();

    expect((await endpoint(admin, "/endpoints/admin/updatenotification.php", { json: { notificationEnabled: 1 } })).json).toEqual({ success: true, message: "Success" });
    expect((await env.DB.prepare("SELECT update_notification FROM admin WHERE id = 1").first<{ update_notification: number }>())!.update_notification).toBe(1);
    expect((await endpoint(admin, "/endpoints/cronjobs/checkforupdates.php")).text).toMatch(/^No new version available, currently on v/);
  });

  it("explains the settings the Worker does not have", async () => {
    const smtp = await endpoint(admin, "/endpoints/admin/savesmtpsettings.php", { json: { smtpaddress: "smtp.example.com", smtpport: "587" } });
    expect(smtp.json).toMatchObject({ success: true, message: expect.stringContaining("RESEND_API_KEY") });
    const noMail = await raw(
      "/endpoints/admin/savesmtpsettings.php",
      { method: "POST", headers: { cookie: admin.cookie, "x-csrf-token": admin.csrf, "content-type": "application/json" }, body: "{}" },
      { ...env, RESEND_API_KEY: undefined },
    );
    expect(((await noMail.json()) as Record<string, unknown>).success).toBe(false);
    expect((await endpoint(admin, "/endpoints/admin/savesecuritysettings.php", { json: { local_webhook_notifications_allowlist: "" } })).json).toMatchObject({ success: false });
    expect((await endpoint(admin, "/endpoints/admin/deleteuser.php", { json: { userId: 2 }, csrf: false })).json).toEqual({ success: false, message: "Invalid CSRF token" });
  });
});

describe("PWA files", () => {
  it("serves the manifest without a session, coloured by the theme cookie", async () => {
    const light = await raw("/manifest.php");
    expect(light.status).toBe(200);
    expect(light.headers.get("content-type")).toContain("application/manifest+json");
    const body = (await light.json()) as Record<string, any>;
    expect(body).toMatchObject({ short_name: "Wallos", start_url: "/", theme_color: "#FFFFFF", background_color: "#FFFFFF", display: "standalone" });
    expect(body.shortcuts.map((s: { url: string }) => s.url)).toEqual(["index.php", "subscriptions.php", "calendar.php", "stats.php", "settings.php", "about.php"]);

    const dark = (await (await raw("/manifest.php", { headers: { cookie: "theme=automatic; inUseTheme=dark" } })).json()) as Record<string, any>;
    expect(dark.theme_color).toBe("#12151C");
  });

  it("serves the service worker at the URL scripts/all.js registers", async () => {
    for (const path of ["/service-worker.php", "/service-worker.js"]) {
      const res = await raw(path);
      expect(res.status).toBe(200);
      expect(res.headers.get("content-type")).toContain("text/javascript");
      expect(res.headers.get("cache-control")).toBe("no-cache");
      const js = await res.text();
      expect(js).toMatch(/const STATIC_CACHE = 'static-cache-\d+\.\d+\.\d+';/);
      expect(js).toContain('"scripts/i18n/zh_tw.js"');
      expect(js).toContain("self.addEventListener('push'");
      expect(js).not.toContain("siteicons/svg");
    }
  });
});
