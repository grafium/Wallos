import { env } from "cloudflare:workers";
import { encode } from "fast-png";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { browserSession, endpoint, getPage, type Browser } from "./ui-helpers";

/*
  settings.php and the endpoints its scripts call (settings.js, theme.js,
  profile.js' account deletion).
*/

const db = env.DB;

let outbound: { url: string; headers: Headers }[] = [];
let respond: (url: string) => Response | Promise<Response> = () => new Response("not mocked", { status: 500 });

beforeEach(() => {
  outbound = [];
  respond = () => new Response("not mocked", { status: 500 });
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    outbound.push({ url, headers: new Headers(init?.headers) });
    return respond(url);
  });
});

afterEach(() => {
  vi.restoreAllMocks();
});

function png(width = 12, height = 8): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([200, 30, 30, 255], i);
  return encode({ width, height, data, channels: 4, depth: 8 });
}

const ids = async (sql: string, ...binds: unknown[]) => (await db.prepare(sql).bind(...binds).all<{ id: number }>()).results.map((r) => r.id);
const one = <T = Record<string, any>>(sql: string, ...binds: unknown[]) => db.prepare(sql).bind(...binds).first<T>();

async function subscription(browser: Browser, fields: Record<string, unknown>) {
  const res = await endpoint(browser, "/api/subscriptions", { json: { name: "Sub", price: 5, ...fields } });
  expect(res.status).toBe(201);
}

const post = (browser: Browser, path: string, form: Record<string, string>) => endpoint(browser, path, { form });

describe("settings page", () => {
  it("requires a session", async () => {
    await browserSession();
    const res = await getPage(null, "/settings.php");
    expect(res.status).toBe(302);
    expect(res.location).toBe("login.php");
  });

  it("renders every section with the user's data, escaped", async () => {
    const browser = await browserSession("set");
    const userId = browser.userId;
    await db.prepare("UPDATE user SET budget = 300, period_budget = 75.5, budget_period_type = 'weekly', budget_period_anchor_date = '2026-01-05' WHERE id = ?").bind(userId).run();
    const member = await post(browser, "/endpoints/household/household.php", { action: "add" });
    await post(browser, "/endpoints/household/household.php", { action: "edit", memberId: String(member.json!.householdId), name: "Ann <i>", email: "ann@example.com" });
    const cats = await ids("SELECT id FROM categories WHERE user_id = ? ORDER BY id", userId);
    await db.prepare("UPDATE categories SET name = 'Fun & <Games>' WHERE id = ?").bind(cats[1]).run();
    await subscription(browser, { category_id: cats[1] });
    await db.batch([
      db.prepare("UPDATE settings SET dark_theme = 1, color_theme = 'purple', monthly_price = 1, upcoming_payments_limit = 10 WHERE user_id = ?").bind(userId),
      db.prepare("INSERT INTO custom_colors (user_id, main_color, accent_color, hover_color) VALUES (?, '#112233', '#445566', '#778899')").bind(userId),
      db.prepare("INSERT INTO custom_css_style (user_id, css) VALUES (?, 'body { color: red; }')").bind(userId),
      db.prepare("INSERT INTO google_search (user_id, api_key) VALUES (?, 'serp-key')").bind(userId),
      db.prepare("INSERT INTO last_exchange_update (user_id, date) VALUES (?, '2026-10-01')").bind(userId),
      db.prepare("UPDATE notification_settings SET days = 3, period_summary_at_period_start = 1 WHERE user_id = ?").bind(userId),
      db
        .prepare("INSERT INTO notification_channels (user_id, channel, enabled, config) VALUES (?, 'discord', 1, ?), (?, 'telegram', 0, ?), (?, 'webhook', 1, ?)")
        .bind(
          userId,
          JSON.stringify({ webhook_url: "https://discord.example/hook", bot_username: "Bot" }),
          userId,
          JSON.stringify({ bot_token: "secret-token", chat_id: "42" }),
          userId,
          JSON.stringify({ url: "https://hook.example", request_method: "PUT", payload: "{\"a\":1}", headers: "X-Key: secret" }),
        ),
      db.prepare("INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, user_agent) VALUES (?, 'https://push.example/1', 'p', 'a', 'Firefox <Linux>')").bind(userId),
    ]);

    const res = await getPage(browser, "/settings.php");
    expect(res.status).toBe(200);
    const html = res.html;
    expect(html).toContain('<section class="contain settings">');
    // Budgets
    expect(html).toMatch(/id="monthly_budget"[^>]*value="300"/);
    expect(html).toMatch(/id="period_budget"[^>]*value="75.5"/);
    expect(html).toMatch(/<option value="weekly" selected="">/);
    expect(html).toContain('value="2026-01-05"');
    expect(html).toContain('<label for="monthly_budget">€</label>');
    // Household: the owner first, without e-mail input and not deletable
    expect(html).toContain(`data-memberid="${member.json!.householdId}"`);
    expect(html).toContain('value="Ann &lt;i&gt;"');
    expect(html).toContain('value="ann@example.com"');
    expect(html).toContain("Can&#39;t delete main member");
    // Categories: "No category" hidden, the used one cannot be deleted
    expect(html).not.toContain(`data-categoryid="${cats[0]}"`);
    expect(html).toContain('value="Fun &amp; &lt;Games&gt;"');
    expect(html).toMatch(new RegExp(`data-categoryid="${cats[1]}"[\\s\\S]*?image-button medium disabled`));
    expect(html).toContain(`onclick="removeCategory(${cats[2]})"`);
    // Currencies: main currency protected
    const eur = (await one<{ id: number }>("SELECT id FROM currencies WHERE user_id = ? AND code = 'EUR'", userId))!.id;
    expect(html).toMatch(new RegExp(`data-currencyid="${eur}"[\\s\\S]*?name="code"[^>]*disabled=""`));
    expect(html).toContain("2026-10-01");
    // Exchange rates: new accounts use Frankfurter, so conversion is available
    expect(html).toContain('<option value="2" selected="">frankfurter.dev</option>');
    expect(html).not.toMatch(/id="convertcurrency"[^>]*disabled/);
    expect(html).toMatch(/id="googleSearchKey"[^>]*value="serp-key"/);
    // AI section renders unconfigured
    expect(html).toContain('id="ai_enabled" name="ai_enabled"');
    expect(html).toMatch(/id="runAiRecommendations" class="secondary-button thin mobile-grow-force hidden"/);
    expect(html).not.toContain('id="translateCategories"');
    // Payment methods, built-in icons keep their path
    expect(html).toContain('<img src="images/uploads/icons/paypal.png" alt="Logo"/>');
    expect(html).toContain('contenteditable="true"');
    expect(html).toContain('id="payments-form"');
    // Theme
    expect(html).toMatch(/class="dark-theme-button capitalize selected" onclick="setDarkTheme\(&#39;1&#39;\)"/);
    expect(html).toMatch(/id="theme-purple" value="purple" onclick="setTheme\(&#39;purple&#39;\)" checked=""/);
    expect(html).toContain('value="#112233"');
    expect(html).toContain("body { color: red; }</textarea>");
    expect(html).toMatch(/id="monthlyprice"[^>]*checked=""/);
    expect(html).toMatch(/<option value="10" selected="">10<\/option>/);
    // Notifications from notification_channels / notification_settings
    expect(html).toMatch(/<option value="3" selected="">/);
    expect(html).toMatch(/id="period_summary_at_period_start"[^>]*checked=""/);
    expect(html).toMatch(/id="discordenabled"[^>]*checked=""/);
    expect(html).toContain('value="https://discord.example/hook"');
    expect(html).toMatch(/id="telegrambottoken"[^>]*value="\*\*\*\*\*\*\*\*"/);
    expect(html).not.toContain("secret-token");
    expect(html).toContain('value="42"');
    expect(html).toMatch(/<option value="PUT" selected="">PUT<\/option>/);
    expect(html).toContain("{&quot;a&quot;:1}</textarea>");
    expect(html).not.toContain("X-Key: secret");
    expect(html).toContain("Firefox &lt;Linux&gt;");
    expect(html).toContain('id="smtpaddress"');
    expect(html).toMatch(/window.vapidPublicKey = "[A-Za-z0-9_-]{40,}"/);
    // Scripts
    for (const script of ["scripts/libs/sortable.min.js", "scripts/settings.js?", "scripts/theme.js?", "scripts/notifications.js?"]) expect(html).toContain(script);
  });

  it("shows the default webhook payload when no webhook is set up", async () => {
    const browser = await browserSession("set");
    const html = (await getPage(browser, "/settings.php")).html;
    expect(html).toContain("&quot;name&quot;: &quot;{{subscription_name}}&quot;");
    expect(html).toContain('<p id="noPushDevices" class="push-no-devices">');
  });

  it("disables conversion when no exchange-rate provider is set", async () => {
    const browser = await browserSession("set");
    await db.prepare("DELETE FROM fixer WHERE user_id = ?").bind(browser.userId).run();
    expect((await getPage(browser, "/settings.php")).html).toMatch(/id="convertcurrency"[^>]*disabled=""/);
  });
});

describe("categories endpoint", () => {
  it("adds, renames, sorts and deletes categories", async () => {
    const browser = await browserSession("cat");
    const added = await post(browser, "/endpoints/categories/category.php", { action: "add" });
    expect(added.json).toMatchObject({ success: true, categoryId: expect.any(Number) });
    const id = added.json!.categoryId;
    expect((await one("SELECT name, user_id FROM categories WHERE id = ?", id))).toMatchObject({ name: "Category", user_id: browser.userId });

    expect((await post(browser, "/endpoints/categories/category.php", { action: "edit", categoryId: String(id), name: "Streaming" })).json).toEqual({
      success: true,
      message: "Category saved",
    });
    expect((await one("SELECT name FROM categories WHERE id = ?", id))!.name).toBe("Streaming");
    expect((await post(browser, "/endpoints/categories/category.php", { action: "edit", categoryId: String(id), name: "" })).json).toEqual({
      success: false,
      message: "Please fill all fields",
    });

    const all = await ids("SELECT id FROM categories WHERE user_id = ? ORDER BY id", browser.userId);
    const form = new FormData();
    const reordered = [id, ...all.slice(1).filter((x) => x !== id)];
    for (const x of reordered) form.append("categoryIds[]", String(x));
    form.append("action", "sort");
    expect((await endpoint(browser, "/endpoints/categories/category.php", { form })).json).toEqual({ success: true, message: "Sort order saved" });
    expect(await ids('SELECT id FROM categories WHERE user_id = ? ORDER BY "order", id', browser.userId)).toEqual([all[0], ...reordered]);

    expect((await post(browser, "/endpoints/categories/category.php", { action: "delete", categoryId: String(id) })).json).toMatchObject({ success: true });
    expect(await one("SELECT id FROM categories WHERE id = ?", id)).toBeNull();
    expect((await post(browser, "/endpoints/categories/category.php", { action: "bogus" })).json).toEqual({ success: false, message: "Error" });
  });

  it("protects categories in use and the account's No category", async () => {
    const browser = await browserSession("cat");
    const all = await ids("SELECT id FROM categories WHERE user_id = ? ORDER BY id", browser.userId);
    await subscription(browser, { category_id: all[2] });
    const inUse = await post(browser, "/endpoints/categories/category.php", { action: "delete", categoryId: String(all[2]) });
    expect(inUse.json).toMatchObject({ success: false, message: expect.stringMatching(/in use/i) });
    const first = await post(browser, "/endpoints/categories/category.php", { action: "delete", categoryId: String(all[0]) });
    expect(first.json).toMatchObject({ success: false });
    expect(await ids("SELECT id FROM categories WHERE id IN (?, ?)", all[0], all[2])).toHaveLength(2);
  });
});

describe("household endpoint", () => {
  it("adds, edits and deletes members; the owner and members in use stay", async () => {
    const browser = await browserSession("hh");
    const added = await post(browser, "/endpoints/household/household.php", { action: "add" });
    expect(added.json).toMatchObject({ success: true, householdId: expect.any(Number) });
    const id = added.json!.householdId;
    const edit = await post(browser, "/endpoints/household/household.php", { action: "edit", memberId: String(id), name: "Bob", email: "bob@example.com" });
    expect(edit.json).toEqual({ success: true, message: "Member saved" });
    expect(await one("SELECT name, email FROM household WHERE id = ?", id)).toEqual({ name: "Bob", email: "bob@example.com" });

    const owner = (await ids("SELECT id FROM household WHERE user_id = ? ORDER BY id", browser.userId))[0];
    expect((await post(browser, "/endpoints/household/household.php", { action: "delete", memberId: String(owner) })).json).toMatchObject({ success: false });

    await subscription(browser, { payer_user_id: id });
    const used = await post(browser, "/endpoints/household/household.php", { action: "delete", memberId: String(id) });
    expect(used.json).toEqual({ success: false, message: "Household member is in use in subscriptions and can't be removed" });

    const spare = (await post(browser, "/endpoints/household/household.php", { action: "add" })).json!.householdId;
    expect((await post(browser, "/endpoints/household/household.php", { action: "delete", memberId: String(spare) })).json).toMatchObject({ success: true });
    expect(await one("SELECT id FROM household WHERE id = ?", spare)).toBeNull();
  });
});

describe("currencies endpoint", () => {
  it("adds, edits and deletes currencies, protecting the main one and those in use", async () => {
    const browser = await browserSession("cur");
    const added = await post(browser, "/endpoints/currency/currency.php", { action: "add" });
    expect(added.json).toMatchObject({ success: true, currencyId: expect.any(Number) });
    const id = added.json!.currencyId;
    const edit = await post(browser, "/endpoints/currency/currency.php", { action: "edit", currencyId: String(id), name: "Bitcoin", symbol: "₿", code: "BTC" });
    expect(edit.json).toEqual({ success: true, message: "Bitcoin was saved." });
    expect(await one("SELECT name, symbol, code FROM currencies WHERE id = ?", id)).toEqual({ name: "Bitcoin", symbol: "₿", code: "BTC" });
    expect((await post(browser, "/endpoints/currency/currency.php", { action: "edit", currencyId: String(id), name: "", symbol: "x" })).json).toEqual({
      success: false,
      message: "Some fields are missing",
    });

    const main = (await one<{ main_currency: number }>("SELECT main_currency FROM user WHERE id = ?", browser.userId))!.main_currency;
    expect((await post(browser, "/endpoints/currency/currency.php", { action: "delete", currencyId: String(main) })).json).toEqual({
      success: false,
      message: "Currency is set as main currency and can't be deleted.",
    });
    await subscription(browser, { currency_id: id });
    expect((await post(browser, "/endpoints/currency/currency.php", { action: "delete", currencyId: String(id) })).json).toEqual({
      success: false,
      message: "Currency is in use in subscriptions and can't be deleted.",
    });
    const spare = (await post(browser, "/endpoints/currency/currency.php", { action: "add" })).json!.currencyId;
    expect((await post(browser, "/endpoints/currency/currency.php", { action: "delete", currencyId: String(spare) })).json).toMatchObject({ success: true });
  });
});

describe("exchange rates", () => {
  it("saves Frankfurter without a request and keeps the stored key", async () => {
    const browser = await browserSession("fx");
    await db.prepare("UPDATE fixer SET provider = 0, api_key = 'old-key' WHERE user_id = ?").bind(browser.userId).run();
    const res = await post(browser, "/endpoints/currency/fixer_api_key.php", { api_key: "", provider: "2" });
    expect(res.json).toEqual({ success: true, message: "Currency provider saved successfully" });
    expect(outbound).toHaveLength(0);
    expect(await one("SELECT provider, api_key FROM fixer WHERE user_id = ?", browser.userId)).toEqual({ provider: 2, api_key: "old-key" });
  });

  it("validates a Fixer or APILayer key before storing it", async () => {
    const browser = await browserSession("fx");
    respond = () => Response.json({ success: false, error: { type: "invalid_access_key" } });
    expect((await post(browser, "/endpoints/currency/fixer_api_key.php", { api_key: "bad", provider: "0" })).json).toEqual({ success: false, message: "Invalid API Key." });
    expect(await one("SELECT provider FROM fixer WHERE user_id = ?", browser.userId)).toEqual({ provider: 2 });
    expect(outbound[0]!.url).toBe("http://data.fixer.io/api/latest?access_key=bad");

    respond = () => Response.json({ success: true, rates: { EUR: 0.9 } });
    expect((await post(browser, "/endpoints/currency/fixer_api_key.php", { api_key: "good", provider: "1" })).json).toEqual({
      success: true,
      message: "API key saved successfully",
    });
    expect(outbound[1]!.url).toContain("api.apilayer.com/fixer/latest");
    expect(outbound[1]!.headers.get("apikey")).toBe("good");
    expect(await one("SELECT provider, api_key FROM fixer WHERE user_id = ?", browser.userId)).toEqual({ provider: 1, api_key: "good" });
    expect((await endpoint(browser, "/endpoints/settings/fixer_usage.php")).json).toEqual({ success: false });
  });

  it("refreshes the rates on demand", async () => {
    const browser = await browserSession("fx");
    await post(browser, "/endpoints/currency/currency.php", { action: "add" }).then((r) =>
      post(browser, "/endpoints/currency/currency.php", { action: "edit", currencyId: String(r.json!.currencyId), name: "X", symbol: "x", code: "XYZ" }),
    );
    respond = (url) =>
      url.startsWith("https://api.frankfurter.dev/")
        ? Response.json([
            { date: "2026-10-12", base: "EUR", quote: "USD", rate: 1.1 },
            { date: "2026-10-12", base: "EUR", quote: "GBP", rate: 0.85 },
          ])
        : new Response("", { status: 404 });
    const res = await post(browser, "/endpoints/currency/update_exchange.php", { force: "true" });
    expect(res.text).toMatch(/^Rates updated successfully! Not priced, so left unchanged: .*XYZ/);
    expect((await one("SELECT rate FROM currencies WHERE user_id = ? AND code = 'USD'", browser.userId))!.rate).toBe(1.1);
    expect((await post(browser, "/endpoints/currency/update_exchange.php", {})).text).toBe("Rates are current, no need to update.");

    respond = () => new Response(JSON.stringify({ message: "down" }), { status: 500 });
    expect((await post(browser, "/endpoints/currency/update_exchange.php", { force: "true" })).text).toMatch(/^Exchange rates update failed/);
    await db.prepare("DELETE FROM fixer WHERE user_id = ?").bind(browser.userId).run();
    expect((await post(browser, "/endpoints/currency/update_exchange.php", { force: "true" })).text).toBe(
      "Exchange rates update skipped. No fixer.io api key provided",
    );
  });
});

describe("Google search key", () => {
  it("checks, stores, reports usage and clears the SerpAPI key", async () => {
    const browser = await browserSession("gs");
    respond = () => Response.json({ error: "Invalid API key." }, { status: 401 });
    expect((await post(browser, "/endpoints/settings/google_search.php", { api_key: "nope" })).json).toEqual({ success: false, message: "Invalid API Key." });
    expect(await one("SELECT api_key FROM google_search WHERE user_id = ?", browser.userId)).toBeNull();
    expect((await endpoint(browser, "/endpoints/settings/google_search_usage.php")).json).toEqual({ success: false });

    respond = () => Response.json({ this_month_usage: 12, searches_per_month: 100, plan_searches_left: 88 });
    expect((await post(browser, "/endpoints/settings/google_search.php", { api_key: "serp" })).json).toEqual({ success: true, message: "API key saved successfully" });
    expect(outbound.at(-1)!.url).toBe("https://serpapi.com/account?api_key=serp");
    expect((await endpoint(browser, "/endpoints/settings/google_search_usage.php")).json).toEqual({ success: true, used: 12, total: 100, left: 88 });

    expect((await post(browser, "/endpoints/settings/google_search.php", { api_key: "" })).json).toEqual({ success: true, message: "Success" });
    expect(await one("SELECT api_key FROM google_search WHERE user_id = ?", browser.userId)).toBeNull();
  });
});

describe("payment methods endpoints", () => {
  it("adds a method with an uploaded icon and serves the list fragment", async () => {
    const browser = await browserSession("pay");
    const form = new FormData();
    form.append("paymentname", "Wise <b>");
    form.append("icon-url", "");
    form.append("paymenticon", new Blob([png()], { type: "image/png" }), "wise.png");
    form.append("action", "add");
    const res = await endpoint(browser, "/endpoints/payments/add.php", { form });
    expect(res.json).toEqual({ success: true, message: "Payment method added successfully" });
    const row = (await one<{ id: number; icon: string; order: number }>('SELECT id, icon, "order" FROM payment_methods WHERE user_id = ? AND name = ?', browser.userId, "Wise <b>"))!;
    expect(row.icon).toMatch(/^\d+-wise-b-[0-9a-f]{8}\.png$/);
    expect(row.order).toBe(32);
    expect(await env.FILES.get(`images/uploads/logos/${row.icon}`)).not.toBeNull();

    const fragment = await endpoint(browser, "/endpoints/payments/get.php");
    expect(fragment.headers.get("content-type")).toMatch(/text\/html/);
    expect(fragment.text).toContain(`<img src="images/uploads/logos/${row.icon}" alt="Logo"/>`);
    expect(fragment.text).toContain("Wise &lt;b&gt;");
    expect(fragment.text).toContain(`onclick="event.stopPropagation(); deletePaymentMethod(${row.id})"`);
    expect(fragment.text.trim().startsWith('<div class="payments-payment"')).toBe(true);

    // Deleting removes the uploaded file as well.
    const del = await endpoint(browser, `/endpoints/payments/delete.php?id=${row.id}`, { json: { id: row.id } });
    expect(del.json).toEqual({ success: true, message: "Payment method removed" });
    expect(await env.FILES.get(`images/uploads/logos/${row.icon}`)).toBeNull();
  });

  it("adds a method with an icon from a URL and rejects incomplete or non-image uploads", async () => {
    const browser = await browserSession("pay");
    respond = (url) => (url === "https://img.example.com/icon.png" ? new Response(png(), { headers: { "content-type": "image/png" } }) : new Response("", { status: 404 }));
    const ok = await endpoint(browser, "/endpoints/payments/add.php", { form: { paymentname: "Revolut", "icon-url": "https://img.example.com/icon.png" } });
    expect(ok.json).toMatchObject({ success: true });
    const missing = await endpoint(browser, "/endpoints/payments/add.php", { form: { paymentname: "Nothing", "icon-url": "" } });
    expect(missing.json).toEqual({ success: false, message: "Please fill all fields" });
    const broken = await endpoint(browser, "/endpoints/payments/add.php", { form: { paymentname: "Broken", "icon-url": "https://img.example.com/404.png" } });
    expect(broken.json).toMatchObject({ success: false, message: expect.stringMatching(/HTTP 404/) });
    const notImage = new FormData();
    notImage.append("paymentname", "Text");
    notImage.append("paymenticon", new Blob(["hello"], { type: "text/plain" }), "a.png");
    expect((await endpoint(browser, "/endpoints/payments/add.php", { form: notImage })).json).toEqual({ success: false, message: "Please fill all fields" });
    expect(await ids("SELECT id FROM payment_methods WHERE user_id = ? AND name IN ('Nothing', 'Broken', 'Text')", browser.userId)).toEqual([]);
  });

  it("renames, toggles, sorts and protects methods in use", async () => {
    const browser = await browserSession("pay");
    const methods = await ids('SELECT id FROM payment_methods WHERE user_id = ? ORDER BY "order", id', browser.userId);
    const [a, b, c] = methods as [number, number, number];

    const rename = new FormData();
    rename.append("paymentId", String(a));
    rename.append("name", "  My Card  ");
    expect((await endpoint(browser, "/endpoints/payments/rename.php", { form: rename })).json).toEqual({ success: true, message: "Payment method renamed" });
    expect((await one("SELECT name FROM payment_methods WHERE id = ?", a))!.name).toBe("My Card");
    expect((await post(browser, "/endpoints/payments/rename.php", { paymentId: String(a), name: "" })).json).toEqual({ success: false, message: "Some fields are missing" });

    expect((await post(browser, "/endpoints/payments/toggle.php", { paymentId: String(b), enabled: "0" })).json).toEqual({ success: true, message: "disabled" });
    expect((await one("SELECT enabled FROM payment_methods WHERE id = ?", b))!.enabled).toBe(0);
    expect((await post(browser, "/endpoints/payments/toggle.php", { paymentId: String(b), enabled: "1" })).json).toEqual({ success: true, message: "enabled" });

    const sort = new FormData();
    for (const x of [c, a, b, ...methods.slice(3)]) sort.append("paymentMethodIds[]", String(x));
    sort.append("action", "sort");
    expect((await endpoint(browser, "/endpoints/payments/sort.php", { form: sort })).json).toEqual({ success: true, message: "Sort order saved" });
    expect((await ids('SELECT id FROM payment_methods WHERE user_id = ? ORDER BY "order", id', browser.userId)).slice(0, 3)).toEqual([c, a, b]);

    await subscription(browser, { payment_method_id: c });
    expect((await post(browser, "/endpoints/payments/toggle.php", { paymentId: String(c), enabled: "0" })).json).toEqual({
      success: false,
      message: "Can't disable used payment method",
    });
    expect((await endpoint(browser, "/endpoints/payments/delete.php", { json: { id: c } })).json).toMatchObject({ success: false });
    expect(await one("SELECT id FROM payment_methods WHERE id = ?", c)).not.toBeNull();
    expect((await getPage(browser, "/settings.php")).html).toContain(`data-in-use="yes" data-paymentid="${c}"`);
  });

  it("searches the web for icons", async () => {
    const browser = await browserSession("pay");
    respond = (url) => {
      if (url.startsWith("https://duckduckgo.com/?")) return new Response('<script>vqd="4-123"</script>');
      if (url.startsWith("https://duckduckgo.com/i.js")) return Response.json({ results: [{ image: "https://img.example.com/wise.png", thumbnail: "https://t.example.com/1" }] });
      return new Response("", { status: 404 });
    };
    const term = `wise${Math.random().toString(36).slice(2, 8)}`;
    expect((await endpoint(browser, `/endpoints/payments/search.php?search=${term}`)).json).toEqual({ imageUrls: ["https://img.example.com/wise.png"] });
    respond = () => new Response("", { status: 500 });
    expect((await endpoint(browser, `/endpoints/payments/search.php?search=${term}x`)).json).toEqual({ error: "Failed to fetch images from DuckDuckGo and Brave." });
    expect((await endpoint(browser, "/endpoints/payments/search.php")).json).toEqual({ error: "Invalid request." });
  });
});

describe("settings/* endpoints", () => {
  it("stores the display toggles and validates their values", async () => {
    const browser = await browserSession("tog");
    const toggles: [string, string][] = [
      ["monthly_price", "monthly_price"],
      ["convert_currency", "convert_currency"],
      ["remove_background", "remove_background"],
      ["hide_disabled", "hide_disabled"],
      ["disabled_to_bottom", "disabled_to_bottom"],
      ["show_original_price", "show_original_price"],
      ["mobile_navigation", "mobile_nav"],
      ["subscription_progress", "show_subscription_progress"],
      ["week_starts_sunday", "week_starts_sunday"],
    ];
    for (const [name, column] of toggles) {
      expect((await endpoint(browser, `/endpoints/settings/${name}.php`, { json: { value: true } })).json).toEqual({ success: true, message: "Success" });
      expect((await one(`SELECT ${column} AS v FROM settings WHERE user_id = ?`, browser.userId))!.v).toBe(1);
      expect((await endpoint(browser, `/endpoints/settings/${name}.php`, { json: { value: "yes" } })).json).toEqual({ success: false, message: "Error" });
      await endpoint(browser, `/endpoints/settings/${name}.php`, { json: { value: false } });
      expect((await one(`SELECT ${column} AS v FROM settings WHERE user_id = ?`, browser.userId))!.v).toBe(0);
    }
    expect((await endpoint(browser, "/endpoints/settings/upcoming_payments_limit.php", { json: { value: 20 } })).json).toMatchObject({ success: true });
    expect((await one("SELECT upcoming_payments_limit AS v FROM settings WHERE user_id = ?", browser.userId))!.v).toBe(20);
    expect((await endpoint(browser, "/endpoints/settings/upcoming_payments_limit.php", { json: { value: 7 } })).json).toMatchObject({ success: false });
  });

  it("persists theme, colour theme, custom colours and custom CSS, and the page reflects them", async () => {
    const browser = await browserSession("thm");
    expect((await endpoint(browser, "/endpoints/settings/theme.php", { json: { theme: "0" } })).json).toEqual({ success: true, message: "Success" });
    expect((await endpoint(browser, "/endpoints/settings/theme.php", { json: { theme: 5 } })).json).toMatchObject({ success: false });
    expect((await endpoint(browser, "/endpoints/settings/colortheme.php", { json: { color: "green" } })).json).toMatchObject({ success: true });
    expect((await endpoint(browser, "/endpoints/settings/colortheme.php", { json: { color: "pink" } })).json).toMatchObject({ success: false });
    expect((await endpoint(browser, "/endpoints/settings/customtheme.php", { json: { mainColor: "#123456", accentColor: "#123456", hoverColor: "#000000" } })).json).toEqual({
      success: false,
      message: "Main and accent color can't be the same",
    });
    expect((await endpoint(browser, "/endpoints/settings/customtheme.php", { json: { mainColor: "red", accentColor: "#123456", hoverColor: "#000000" } })).json).toMatchObject({
      success: false,
    });
    expect((await endpoint(browser, "/endpoints/settings/customtheme.php", { json: { mainColor: "#aa0000", accentColor: "#00bb00", hoverColor: "#0000cc" } })).json).toMatchObject({
      success: true,
    });
    expect((await endpoint(browser, "/endpoints/settings/customcss.php", { json: { customCss: ".x { color: blue; } </style><script>" } })).json).toMatchObject({ success: true });

    const html = (await getPage(browser, "/settings.php")).html;
    expect(html).toContain('<body class="light ltr ');
    expect(html).toMatch(/<link rel="stylesheet" href="styles\/themes\/green.css\?[^"]*" id="green-theme"\/>/);
    expect(html).toContain('id="custom_theme_colors"');
    expect(html).toContain("--main-color: #aa0000");
    expect(html).toContain('value="#00bb00"');
    expect(html).toContain(".x { color: blue; } &lt;/style&gt;&lt;script&gt;</textarea>");
    expect(html).not.toContain("</style><script>");

    expect((await endpoint(browser, "/endpoints/settings/resettheme.php", { form: { action: "reset" } })).json).toMatchObject({ success: true });
    expect(await one("SELECT * FROM custom_colors WHERE user_id = ?", browser.userId)).toBeNull();
  });
});

describe("account deletion", () => {
  it("deletes the signed-in account with its files, and nothing else", async () => {
    const other = await browserSession("keep");
    const browser = await browserSession("gone");
    const form = new FormData();
    form.append("paymentname", "Mine");
    form.append("paymenticon", new Blob([png()], { type: "image/png" }), "mine.png");
    await endpoint(browser, "/endpoints/payments/add.php", { form });
    const icon = (await one<{ icon: string }>("SELECT icon FROM payment_methods WHERE user_id = ? AND name = 'Mine'", browser.userId))!.icon;

    expect((await endpoint(browser, "/endpoints/settings/deleteaccount.php", { json: { userId: other.userId } })).json).toEqual({ success: false, message: "Error" });
    expect((await endpoint(browser, "/endpoints/settings/deleteaccount.php", { json: { userId: 1 } })).json).toEqual({ success: false, message: "Error" });

    const res = await endpoint(browser, "/endpoints/settings/deleteaccount.php", { json: { userId: browser.userId } });
    expect(res.json).toEqual({ success: true, message: "Success" });
    expect(await one("SELECT id FROM user WHERE id = ?", browser.userId)).toBeNull();
    expect(await one("SELECT COUNT(*) AS n FROM payment_methods WHERE user_id = ?", browser.userId)).toEqual({ n: 0 });
    expect(await one("SELECT COUNT(*) AS n FROM sessions WHERE user_id = ?", browser.userId)).toEqual({ n: 0 });
    expect(await env.FILES.get(`images/uploads/logos/${icon}`)).toBeNull();
    expect(await one("SELECT id FROM user WHERE id = ?", other.userId)).not.toBeNull();
    // The session is gone with the account.
    expect((await endpoint(browser, "/endpoints/settings/theme.php", { json: { theme: 1 } })).json).toMatchObject({ success: false });
  });
});

describe("isolation and CSRF", () => {
  it("never touches another user's rows", async () => {
    const owner = await browserSession("own");
    const intruder = await browserSession("int");
    const category = (await ids("SELECT id FROM categories WHERE user_id = ? ORDER BY id", owner.userId))[3]!;
    const member = (await post(owner, "/endpoints/household/household.php", { action: "add" })).json!.householdId;
    const currency = (await post(owner, "/endpoints/currency/currency.php", { action: "add" })).json!.currencyId;
    const method = (await ids("SELECT id FROM payment_methods WHERE user_id = ? ORDER BY id", owner.userId))[0]!;

    expect((await post(intruder, "/endpoints/categories/category.php", { action: "edit", categoryId: String(category), name: "Hacked" })).json).toMatchObject({ success: false });
    expect((await post(intruder, "/endpoints/categories/category.php", { action: "delete", categoryId: String(category) })).json).toMatchObject({ success: false });
    expect((await post(intruder, "/endpoints/household/household.php", { action: "delete", memberId: String(member) })).json).toMatchObject({ success: false });
    expect((await post(intruder, "/endpoints/currency/currency.php", { action: "delete", currencyId: String(currency) })).json).toMatchObject({ success: false });
    expect((await post(intruder, "/endpoints/payments/rename.php", { paymentId: String(method), name: "Hacked" })).json).toMatchObject({ success: false });
    expect((await post(intruder, "/endpoints/payments/toggle.php", { paymentId: String(method), enabled: "0" })).json).toMatchObject({ success: false });
    expect((await endpoint(intruder, "/endpoints/payments/delete.php", { json: { id: method } })).json).toMatchObject({ success: false });
    const sort = new FormData();
    sort.append("paymentMethodIds[]", String(method));
    await endpoint(intruder, "/endpoints/payments/sort.php", { form: sort });

    expect(await one("SELECT name FROM categories WHERE id = ?", category)).not.toMatchObject({ name: "Hacked" });
    expect(await one("SELECT id FROM household WHERE id = ?", member)).not.toBeNull();
    expect(await one("SELECT id FROM currencies WHERE id = ?", currency)).not.toBeNull();
    expect(await one('SELECT name, enabled, "order" AS o FROM payment_methods WHERE id = ?', method)).toEqual({ name: "PayPal", enabled: 1, o: 1 });
    expect((await endpoint(intruder, "/endpoints/payments/get.php")).text).not.toContain(`data-paymentid="${method}"`);
  });

  it("refuses changes without the CSRF token or a session", async () => {
    const browser = await browserSession("csrf");
    const res = await endpoint(browser, "/endpoints/settings/colortheme.php", { json: { color: "red" }, csrf: false });
    expect(res.json).toEqual({ success: false, message: "Invalid CSRF token" });
    expect((await one("SELECT color_theme FROM settings WHERE user_id = ?", browser.userId))!.color_theme).toBe("blue");
    const add = await endpoint(browser, "/endpoints/categories/category.php", { form: { action: "add" }, csrf: false });
    expect(add.json).toMatchObject({ success: false });
    const anonymous = await endpoint({ ...browser, cookie: "" }, "/endpoints/payments/get.php");
    expect(anonymous.json).toMatchObject({ success: false });
  });
});
