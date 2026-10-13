import { env } from "cloudflare:workers";
import { encode } from "fast-png";
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderNotesMarkdown, icalFold } from "../src/ui/endpoints/subscriptions";
import { browserSession, endpoint, getPage, raw, type Browser, type Json } from "./ui-helpers";

/*
  subscriptions.php, calendar.php and the endpoints/*.php their scripts call.
*/

const day = (offset: number) => new Date(Date.now() + offset * 86_400_000).toISOString().slice(0, 10);

async function lookups(browser: Browser) {
  const first = (sql: string) => env.DB.prepare(sql).bind(browser.userId).first<{ id: number }>().then((r) => r!.id);
  return {
    currency: await first("SELECT id FROM currencies WHERE user_id = ? ORDER BY id LIMIT 1"),
    usd: await first("SELECT id FROM currencies WHERE user_id = ? AND code = 'USD'"),
    category: await first('SELECT id FROM categories WHERE user_id = ? ORDER BY "order", id LIMIT 1'),
    category2: await first('SELECT id FROM categories WHERE user_id = ? ORDER BY "order", id LIMIT 1 OFFSET 1'),
    member: await first("SELECT id FROM household WHERE user_id = ? ORDER BY id LIMIT 1"),
    method: await first('SELECT id FROM payment_methods WHERE user_id = ? ORDER BY "order", id LIMIT 1'),
  };
}

/** Submits the add/edit form like scripts/subscriptions.js (FormData + X-CSRF-Token). */
async function submit(browser: Browser, fields: Record<string, string | Blob>, options: { csrf?: boolean } = {}) {
  const ids = await lookups(browser);
  const form = new FormData();
  const values: Record<string, string | Blob> = {
    name: "Netflix",
    price: "15.99",
    currency_id: String(ids.currency),
    frequency: "1",
    cycle: "3",
    auto_renew: "on",
    start_date: day(-30),
    next_payment: day(5),
    payment_method_id: String(ids.method),
    payer_user_id: String(ids.member),
    category_id: String(ids.category),
    notes: "",
    url: "",
    "logo-url": "",
    id: "",
    replacement_subscription_id: "0",
    cancellation_date: "",
    ...fields,
  };
  for (const [key, value] of Object.entries(values)) {
    if (value === "__omit__") continue;
    if (typeof value === "string") form.append(key, value);
    else form.append(key, value, "logo.png");
  }
  return endpoint(browser, "/endpoints/subscription/add.php", { form, csrf: options.csrf });
}

async function add(browser: Browser, fields: Record<string, string | Blob> = {}) {
  const res = await submit(browser, fields);
  expect(res.json).toMatchObject({ status: "Success" });
  const row = await env.DB.prepare("SELECT id FROM subscriptions WHERE user_id = ? ORDER BY id DESC LIMIT 1").bind(browser.userId).first<{ id: number }>();
  return row!.id;
}

const row = (id: number) => env.DB.prepare("SELECT * FROM subscriptions WHERE id = ?").bind(id).first<Json>();

/** The position of each name in an HTML document. */
const order = (html: string, names: string[]) => names.map((n) => html.indexOf(`data-name="${n}"`)).every((pos, i, all) => pos > -1 && (i === 0 || pos > all[i - 1]!));

function png(width = 40, height = 20): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let i = 0; i < data.length; i += 4) data.set([220, 30, 30, 255], i);
  return encode({ width, height, data, channels: 4, depth: 8 });
}

afterEach(() => vi.restoreAllMocks());

describe("subscriptions.php", () => {
  it("shows the empty page to an account without subscriptions", async () => {
    const browser = await browserSession("subs");
    const res = await getPage(browser, "/subscriptions.php");
    expect(res.status).toBe(200);
    expect(res.html).toContain('<header class="main-actions hidden" id="main-actions">');
    expect(res.html).toContain('<div class="empty-page">');
    expect(res.html).toContain('<form action="endpoints/subscription/add.php" method="post" id="subs-form">');
    expect(res.html).toContain('src="scripts/subscriptions.js?');
    expect(res.html).toContain('id="subscription-details"');
    expect(res.html).not.toContain("addSubscription();</script>");
    expect((await getPage(browser, "/subscriptions.php?add")).html).toContain("<script>addSubscription();</script>");
  });

  it("redirects visitors without a session", async () => {
    await browserSession();
    expect((await getPage(null, "/subscriptions.php")).location).toBe("login.php");
  });

  it("lists subscriptions in the PHP markup, escaped, with the form filled from the user's data", async () => {
    const browser = await browserSession("list");
    const ids = await lookups(browser);
    const id = await add(browser, { name: 'Net"flix <b>&', price: "15.99" });
    await add(browser, { name: "Manual", auto_renew: "__omit__", next_payment: day(3) });
    await add(browser, { name: "Lifetime", cycle: "5", next_payment: day(1) });

    const { html } = await getPage(browser, "/subscriptions.php");
    expect(html).toContain('<header class="main-actions" id="main-actions">');
    expect(html).not.toContain('<div class="empty-page">');
    expect(html).toContain(`data-id="${id}" data-name="Net&quot;flix &lt;b&gt;&amp;"`);
    expect(html).toContain(`onclick="showSubscriptionDetails(event, ${id})"`);
    expect(html).toContain('<span class="name ">Net&quot;flix &lt;b&gt;&amp;</span>');
    expect(html).toContain("€15.99");
    expect(html).toContain('<span class="cycle" title="Automatically renews">');
    expect(html).toContain('<span class="cycle" title="Manual Renewal">');
    // Only manual subscriptions can be renewed by hand; one-time purchases sit at the bottom.
    expect(html.match(/<li class="renew"/g)?.length).toBe(1);
    expect(html).toContain('<div class="subscription-list-title">Lifetime purchases</div>');
    expect(html.indexOf("Lifetime purchases")).toBeGreaterThan(html.indexOf('data-name="Manual"'));
    // The form.
    expect(html).toContain(`<option value="${ids.currency}" selected="">`);
    expect(html).toContain('<option value="366">366</option>');
    expect(html).toContain('<option value="3" selected="">');
    expect(html).toContain(`<option value="${id}">Net&quot;flix &lt;b&gt;&amp;</option>`);
    expect(html).toContain('<option value="-1">Default value from settings</option>');
    // Filter menu and sort options.
    expect(html).toContain('<div class="filtermenu-submenu-content" id="filter-category">');
    expect(html).toContain(`data-categoryid="${ids.category}"`);
    expect(html).toContain('<li class="selected" onclick="setSortOption(&#39;next_payment&#39;)" id="sort-next_payment">');
    expect(html).toContain('id="sort-inactive"');
  });

  it("filters by the query string and sorts by the sortOrder cookie", async () => {
    const browser = await browserSession("sort");
    const ids = await lookups(browser);
    await add(browser, { name: "Item 10", price: "1", category_id: String(ids.category2) });
    await add(browser, { name: "item 9", price: "30" });
    await add(browser, { name: "Item 100", price: "5" });

    const filtered = await getPage(browser, `/subscriptions.php?category=${ids.category2}`);
    expect(filtered.html).toContain('data-name="Item 10"');
    expect(filtered.html).not.toContain('data-name="item 9"');
    expect(filtered.html).toContain(`<div class="filter-item selected" data-categoryid="${ids.category2}">`);

    const page = (sort: string) => getPage(browser, "/subscriptions.php", { cookie: `${browser.cookie}; sortOrder=${sort}` }).then((r) => r.html);
    expect(order(await page("price"), ["item 9", "Item 100", "Item 10"])).toBe(true);
    expect(order(await page("alphanumeric"), ["item 9", "Item 10", "Item 100"])).toBe(true);
    const byCategory = await page("category_id");
    expect(byCategory).toContain('<div class="subscription-list-title">No category</div>');
    expect(byCategory).toContain('<li class="selected" onclick="setSortOption(&#39;category_id&#39;)" id="sort-category_id">');

    // Hidden disabled subscriptions leave the list and the state filter.
    await add(browser, { name: "Old", inactive: "on" });
    expect((await page("next_payment")).includes('data-name="Old"')).toBe(true);
    await env.DB.prepare("UPDATE settings SET hide_disabled = 1 WHERE user_id = ?").bind(browser.userId).run();
    const hidden = await page("next_payment");
    expect(hidden).not.toContain('data-name="Old"');
    expect(hidden).not.toContain('id="sort-inactive"');
  });

  it("applies the display settings: converted, monthly and original prices, progress, mobile actions", async () => {
    const browser = await browserSession("settings");
    const ids = await lookups(browser);
    await env.DB.prepare("UPDATE currencies SET rate = 2 WHERE id = ?").bind(ids.usd).run();
    await env.DB.prepare(
      "UPDATE settings SET convert_currency = 1, monthly_price = 1, show_original_price = 1, show_subscription_progress = 1, mobile_nav = 1 WHERE user_id = ?",
    )
      .bind(browser.userId)
      .run();
    await add(browser, { name: "Yearly", price: "240", currency_id: String(ids.usd), cycle: "4" });
    const { html } = await getPage(browser, "/subscriptions.php");
    expect(html).toContain("€10.00"); // 240 USD / 2 / 12
    expect(html).toContain('<span class="original_price">($240.00)</span>');
    expect(html).toContain('<div class="subscription-progress-container">');
    expect(html).toContain('<div class="mobile-actions"');
    expect(html).toContain('class="actions-expand mobileNavigationHideOnMobile"');
  });
});

describe("endpoints/subscription/add.php", () => {
  it("adds and edits from the form, answering like PHP", async () => {
    const browser = await browserSession("add");
    const res = await submit(browser, { name: "Spotify", notes: "**Family** plan", url: "https://spotify.com", notifications: "on", notify_days_before: "3" });
    expect(res.json).toEqual({ status: "Success", message: "Subscription added successfully" });
    const id = (await env.DB.prepare("SELECT id FROM subscriptions WHERE user_id = ?").bind(browser.userId).first<{ id: number }>())!.id;
    expect(await row(id)).toMatchObject({ name: "Spotify", price: 15.99, cycle: 3, frequency: 1, auto_renew: 1, notify: 1, notify_days_before: 3, notes: "**Family** plan" });

    const edit = await submit(browser, { id: String(id), name: "Spotify Duo", price: "9", auto_renew: "__omit__", frequency: "100", cycle: "1" });
    expect(edit.json).toEqual({ status: "Success", message: "Subscription updated successfully" });
    expect(await row(id)).toMatchObject({ name: "Spotify Duo", price: 9, auto_renew: 0, frequency: 100, cycle: 1, notify: 0 });
  });

  it("rejects missing fields and another user's references", async () => {
    const browser = await browserSession("addbad");
    const other = await browserSession("addother");
    expect((await submit(browser, { name: "" })).json).toEqual({ status: "Error", message: "Please fill all fields" });
    expect((await submit(browser, { next_payment: "soon" })).json?.status).toBe("Error");
    const foreign = await lookups(other);
    expect((await submit(browser, { category_id: String(foreign.category) })).json).toEqual({
      status: "Error",
      message: "The specified category does not exist or does not belong to you.",
    });
    expect((await submit(browser, { currency_id: String(foreign.currency) })).json?.message).toMatch(/currency/);
    const count = await env.DB.prepare("SELECT COUNT(*) AS n FROM subscriptions WHERE user_id = ?").bind(browser.userId).first<{ n: number }>();
    expect(count!.n).toBe(0);
  });

  it("cannot edit another user's subscription", async () => {
    const owner = await browserSession("owner");
    const intruder = await browserSession("intruder");
    const id = await add(owner, { name: "Mine" });
    const res = await submit(intruder, { id: String(id), name: "Stolen" });
    expect(res.json?.status).toBe("Error");
    expect((await row(id))!.name).toBe("Mine");
  });

  it("stores an uploaded logo in R2 and a picked web logo", async () => {
    const browser = await browserSession("logo");
    const id = await add(browser, { name: "Logo Co", logo: new Blob([png()], { type: "image/png" }) });
    const logo = (await row(id))!.logo as string;
    expect(logo).toMatch(/^\d+-logo-co-[0-9a-f]{8}\.png$/);
    expect(await env.FILES.head(`images/uploads/logos/${logo}`)).not.toBeNull();
    const { html } = await getPage(browser, "/subscriptions.php");
    expect(html).toContain(`<img src="images/uploads/logos/${logo}" class=""/>`);
    expect(html).toContain('<span class="name hideOnMobile">Logo Co</span>');

    // Editing with a web logo replaces the file and removes the old one.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response(png(30, 30), { headers: { "content-type": "image/png" } }));
    const edit = await submit(browser, { id: String(id), name: "Logo Co", "logo-url": "https://example.com/logo.png" });
    expect(edit.json).toMatchObject({ status: "Success" });
    const replaced = (await row(id))!.logo as string;
    expect(replaced).not.toBe(logo);
    expect(await env.FILES.head(`images/uploads/logos/${logo}`)).toBeNull();

    // A URL that fails still saves the subscription, with a warning.
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => new Response("nope", { status: 404 }));
    const warned = await submit(browser, { name: "No Logo", "logo-url": "https://example.com/missing.png" });
    expect(warned.json).toMatchObject({ status: "Success" });
    expect(warned.json?.logo_warning).toMatch(/^Error fetching image/);

    // A file that is not an image is refused outright.
    const bad = await submit(browser, { name: "Bad", logo: new Blob(["<svg onload=alert(1)>"], { type: "image/png" }) });
    expect(bad.text).toBe("Please fill all fields");
  });

  it("requires the CSRF token", async () => {
    const browser = await browserSession("csrf");
    const res = await submit(browser, { name: "X" }, { csrf: false });
    expect(res.json).toEqual({ success: false, message: "Invalid CSRF token" });
    const id = await add(browser);
    expect((await endpoint(browser, "/endpoints/subscription/delete.php", { json: { id }, csrf: false })).json?.message).toBe("Invalid CSRF token");
    expect(await row(id)).not.toBeNull();
    // Without a session at all.
    const anonymous = await raw("/endpoints/subscription/get.php?id=1");
    expect(((await anonymous.json()) as Json).message).toBe("Your session expired. Please login again");
  });
});

describe("endpoints/subscription/*.php", () => {
  it("get.php returns the form fields with rendered, safe notes", async () => {
    const browser = await browserSession("get");
    const other = await browserSession("getother");
    const id = await add(browser, { name: "Tom & Jerry", notes: "**Bold** _it_ <script>x</script>\n- one\n- [link](javascript:alert(1))", url: "example.com" });
    const res = await endpoint(browser, `/endpoints/subscription/get.php?id=${id}`);
    expect(res.json).toMatchObject({ id, name: "Tom & Jerry", price: 15.99, cycle: 3, frequency: 1, url: "example.com", replacement_subscription_id: null });
    const notes = res.json!.notes_html as string;
    expect(notes).toContain("<strong>Bold</strong> <em>it</em> &lt;script&gt;x&lt;/script&gt;");
    expect(notes).toContain("<ul>\n<li>one</li>\n<li><a href=\"javascript%3Aalert(1)\">link</a></li>\n</ul>");
    expect((await endpoint(other, `/endpoints/subscription/get.php?id=${id}`)).text).toBe("Error");
  });

  it("delete.php, clone.php and renew.php act only on the user's own subscriptions", async () => {
    const browser = await browserSession("act");
    const other = await browserSession("actother");
    const manual = await add(browser, { name: "Manual", auto_renew: "__omit__", next_payment: day(-2), cycle: "2" });
    const auto = await add(browser, { name: "Auto" });

    const clone = await endpoint(browser, "/endpoints/subscription/clone.php", { json: { id: manual } });
    expect(clone.json).toMatchObject({ success: true, message: "Success" });
    expect(await row(clone.json!.id)).toMatchObject({ name: "Manual", user_id: browser.userId });
    expect((await endpoint(other, "/endpoints/subscription/clone.php", { json: { id: manual } })).json).toEqual({ success: false, message: "Error" });

    const renew = await endpoint(browser, "/endpoints/subscription/renew.php", { json: { id: manual } });
    expect(renew.json).toEqual({ success: true, message: "Success", id: manual });
    expect((await row(manual))!.next_payment).toBe(day(5));
    expect((await endpoint(browser, "/endpoints/subscription/renew.php", { json: { id: auto } })).json?.success).toBe(false);
    expect((await endpoint(other, "/endpoints/subscription/renew.php", { json: { id: manual } })).json?.success).toBe(false);

    expect((await endpoint(other, "/endpoints/subscription/delete.php", { json: { id: manual } })).json?.success).toBe(false);
    expect(await row(manual)).not.toBeNull();
    const del = await endpoint(browser, "/endpoints/subscription/delete.php", { json: { id: manual } });
    expect(del.json?.success).toBe(true);
    expect(await row(manual)).toBeNull();
  });

  it("exportcalendar.php builds an iCalendar event, getcalendar.php the details", async () => {
    const browser = await browserSession("ics");
    const id = await add(browser, {
      name: "Cal; Sub, Inc",
      price: "1234.5",
      notes: "Line one\nLine two that is quite long so the description is folded at seventy-five octets",
      notifications: "on",
      notify_days_before: "-1",
    });
    const res = await endpoint(browser, "/endpoints/subscription/exportcalendar.php", { json: { id } });
    expect(res.json).toMatchObject({ success: true, name: "Cal; Sub, Inc" });
    const ics = res.json!.ics as string;
    expect(ics.startsWith("BEGIN:VCALENDAR\nVERSION:2.0\n")).toBe(true);
    expect(ics.endsWith("END:VEVENT\nEND:VCALENDAR")).toBe(true);
    expect(ics).toContain(`UID:wallos-subscription-${id}@wallos`);
    expect(ics).toContain("SUMMARY:Cal\\; Sub\\, Inc");
    expect(ics).toContain("DESCRIPTION:Price: €1,234.50\\nCategory: No category");
    expect(ics).toContain(`DTSTART;VALUE=DATE:${day(5).replace(/-/g, "")}`);
    expect(ics).toContain("TRIGGER:-P1D");
    expect(ics).toContain("\r\n ");
    expect(ics.split("\n").every((line) => new TextEncoder().encode(line.replace(/\r$/, "")).length <= 75)).toBe(true);

    const other = await browserSession("icsother");
    expect((await endpoint(other, "/endpoints/subscription/exportcalendar.php", { json: { id } })).json).toEqual({ success: false, message: "Subscription not found" });

    const details = await endpoint(browser, "/endpoints/subscription/getcalendar.php", { json: { id } });
    expect(details.json).toMatchObject({ success: true, data: { id, price: "1,234.50", currency: "€", category: "No category" } });
  });
});

describe("endpoints/subscriptions/*.php", () => {
  it("get.php returns the list fragment for the scripts' filters", async () => {
    const browser = await browserSession("frag");
    await add(browser, { name: "Remind", notifications: "on", notify_days_before: "1" });
    await add(browser, { name: "Once", cycle: "5" });
    await add(browser, { name: "Paused", inactive: "on" });

    const all = await endpoint(browser, "/endpoints/subscriptions/get.php");
    expect(all.headers.get("content-type")).toMatch(/text\/html/);
    expect(all.text).not.toContain("<html");
    expect(all.text).toContain('data-name="Remind"');
    expect(all.text).toContain('<div class="subscription inactive"');

    const onetime = await endpoint(browser, "/endpoints/subscriptions/get.php?renewalType=onetime");
    expect(onetime.text).toContain('data-name="Once"');
    expect(onetime.text).not.toContain('data-name="Remind"');
    const reminders = await endpoint(browser, "/endpoints/subscriptions/get.php?notifications=reminder&state=0");
    expect(reminders.text).toContain('data-name="Remind"');
    expect(reminders.text).not.toContain('data-name="Once"');
    const none = await endpoint(browser, "/endpoints/subscriptions/get.php?categories=999999");
    expect(none.text).toContain('<div class="no-matching-subscriptions">');
    expect(none.text).toContain("Clear Filters");

    // Another user sees nothing of it.
    const other = await browserSession("fragother");
    expect((await endpoint(other, "/endpoints/subscriptions/get.php")).text).not.toContain("Remind");
  });

  it("export.php lists the subscriptions with names", async () => {
    const browser = await browserSession("export");
    await add(browser, { name: "A, B", frequency: "2", cycle: "2" });
    const res = await endpoint(browser, "/endpoints/subscriptions/export.php");
    expect(res.json).toEqual({
      success: true,
      subscriptions: [
        expect.objectContaining({ Name: "A  B", "Payment Cycle": "Every 2 Weeks", Renewal: "Automatic", Category: "No category", Price: "€15.99", State: "Enabled", Active: "Yes" }),
      ],
    });
  });
});

describe("calendar.php", () => {
  it("shows the month's payments, totals and the feed key", async () => {
    const browser = await browserSession("cal");
    const ids = await lookups(browser);
    const today = new Date();
    const y = today.getUTCFullYear();
    const m = today.getUTCMonth() + 1;
    const nextMonth = m === 12 ? [y + 1, 1] : [y, m + 1];
    const date = (yy: number, mm: number, dd: number) => `${yy}-${String(mm).padStart(2, "0")}-${String(dd).padStart(2, "0")}`;
    await add(browser, { name: "Weekly <W>", cycle: "2", start_date: date(y, m, 1), next_payment: date(y, m, 1), price: "10" });
    await add(browser, { name: "Once", cycle: "5", next_payment: date(nextMonth[0]!, nextMonth[1]!, 15), price: "50" });
    await add(browser, { name: "Paused", inactive: "on", next_payment: date(y, m, 2) });
    await add(browser, { name: "Dollars", currency_id: String(ids.usd), next_payment: date(y, m, 3), start_date: "" });
    await env.DB.prepare("UPDATE user SET api_key = 'feed-key' WHERE id = ?").bind(browser.userId).run();

    const res = await getPage(browser, "/calendar.php");
    expect(res.status).toBe(200);
    const html = res.html;
    expect(html).toContain('<div class="calendar">');
    expect(html).toContain(`<h2>${["January", "February", "March", "April", "May", "June", "July", "August", "September", "October", "November", "December"][m - 1]} ${y}</h2>`);
    expect(html).toContain(`id="prev" onclick="prevMonth(${m}, ${y})" disabled=""`);
    expect(html.match(/title="Weekly &lt;W&gt;"/g)!.length).toBeGreaterThanOrEqual(4);
    expect(html).not.toContain('title="Paused"');
    expect(html).not.toContain('title="Once"');
    expect(html).toContain('title="Dollars"');
    expect(html).toContain('<input type="hidden" id="apiKey" value="feed-key"/>');
    // Two currencies and no exchange-rate provider configured.
    await env.DB.prepare("DELETE FROM fixer WHERE user_id = ?").bind(browser.userId).run();
    expect((await getPage(browser, "/calendar.php")).html).toContain('<div class="error-box">');
    expect(html).toContain('src="scripts/calendar.js?');
    expect(html).toContain('<div class="calendar-cell">Mon</div>');

    const next = await getPage(browser, `/calendar.php?month=${nextMonth[1]}&year=${nextMonth[0]}`);
    expect(next.html).toContain('title="Once"');
    expect(next.html).toContain('onclick="currentMoth()"');
    expect(next.html).not.toContain('disabled=""><i class="fa-solid fa-chevron-left">');
    // Past months show the current one.
    const past = await getPage(browser, `/calendar.php?month=${m}&year=${y - 1}`);
    expect(past.html).toContain(`prevMonth(${m}, ${y})`);
  });

  it("starts the week on Sunday when configured", async () => {
    const browser = await browserSession("sunday");
    await env.DB.prepare("UPDATE settings SET week_starts_sunday = 1 WHERE user_id = ?").bind(browser.userId).run();
    const { html } = await getPage(browser, "/calendar.php");
    expect(html.indexOf("<div class=\"calendar-cell\">Sun</div>")).toBeLessThan(html.indexOf("<div class=\"calendar-cell\">Mon</div>"));
  });
});

describe("endpoints/logos/*.php", () => {
  it("icon_search.php filters the catalogues per source", async () => {
    const browser = await browserSession("icons");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.includes("selfhst")) return Response.json([{ Name: "Zedflix", Reference: "zedflix", PNG: "Yes" }, { Name: "Other", Reference: "other", PNG: "Yes" }]);
      if (url.includes("dashboard-icons")) return Response.json({ png: ["zedflix.png", "zedflix-dark.png", "zedflix-plus.png"] });
      return new Response("not mocked", { status: 500 });
    });
    const selfhst = await endpoint(browser, "/endpoints/logos/icon_search.php?search=zedflix&source=selfhst");
    expect(selfhst.json).toEqual({ results: [{ thumbnail: "https://cdn.jsdelivr.net/gh/selfhst/icons/png/zedflix.png", image: "https://cdn.jsdelivr.net/gh/selfhst/icons/png/zedflix.png", width: null, height: null }] });
    const dashboard = await endpoint(browser, "/endpoints/logos/icon_search.php?search=zedflix&source=dashboardicons");
    expect((dashboard.json!.results as Json[]).map((r) => r.image)).toEqual([
      "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/zedflix.png",
      "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/zedflix-plus.png",
    ]);
    expect((await endpoint(browser, "/endpoints/logos/icon_search.php")).json).toEqual({ error: "Invalid request." });
  });

  it("search.php queries DuckDuckGo and reports failures like PHP", async () => {
    const browser = await browserSession("ddg");
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
      const url = String(input instanceof Request ? input.url : input);
      if (url.startsWith("https://duckduckgo.com/?q=")) return new Response('<script>vqd="4-123"</script>');
      if (url.startsWith("https://duckduckgo.com/i.js")) {
        return Response.json({ results: [{ image: "https://img.example/a.jpg", thumbnail: "https://t.example/a" }, { image: "https://img.example/b.png", thumbnail: "https://t.example/b" }] });
      }
      return new Response("blocked", { status: 429 });
    });
    const res = await endpoint(browser, "/endpoints/logos/search.php?search=Uniqueflix&source=duckduckgo");
    expect((res.json!.results as Json[]).map((r) => r.image)).toEqual(["https://img.example/b.png", "https://img.example/a.jpg"]);
    const brave = await endpoint(browser, "/endpoints/logos/search.php?search=Uniqueflix&source=brave");
    expect(brave.json).toEqual({ error: "Brave returned no results or rate-limited the request. Try again in a minute." });
    expect((await endpoint(browser, "/endpoints/logos/search.php")).json).toEqual({ error: "Invalid request." });
  });

  it("google_search.php needs the user's SerpAPI key", async () => {
    const browser = await browserSession("google");
    expect((await endpoint(browser, "/endpoints/logos/google_search.php?search=x")).json).toEqual({ error: "Google search is not configured." });
    expect((await getPage(browser, "/subscriptions.php")).html).not.toContain("data-google-search");
    await env.DB.prepare("INSERT INTO google_search (user_id, api_key) VALUES (?, 'serp')").bind(browser.userId).run();
    vi.spyOn(globalThis, "fetch").mockImplementation(async () => Response.json({ images_results: [{ original: "https://g.example/logo.png", thumbnail: "https://g.example/t", original_width: 100, original_height: 50 }] }));
    const res = await endpoint(browser, "/endpoints/logos/google_search.php?search=googleonly");
    expect(res.json).toEqual({ results: [{ thumbnail: "https://g.example/t", image: "https://g.example/logo.png", width: 100, height: 50 }] });
    expect((await getPage(browser, "/subscriptions.php")).html).toContain('data-google-search="1"');
  });
});

describe("helpers", () => {
  it("renders the notes Markdown subset safely", () => {
    expect(renderNotesMarkdown("a\nb\n\n# Title\n1. x\n2. y")).toBe("<p>a<br />\nb</p>\n<h1>Title</h1>\n<ol>\n<li>x</li>\n<li>y</li>\n</ol>");
    expect(renderNotesMarkdown('see https://example.com/a?b=1&c="2"')).toBe('<p>see <a href="https://example.com/a?b=1&amp;c=&quot;2&quot;">https://example.com/a?b=1&amp;c=&quot;2&quot;</a></p>');
    expect(renderNotesMarkdown("`<b>` [x](https://a.example \"t\")")).toContain("<code>&lt;b&gt;</code>");
  });

  it("folds iCalendar lines on character boundaries", () => {
    const folded = icalFold(`SUMMARY:${"é".repeat(60)}`);
    expect(folded.split("\r\n ").every((part) => new TextEncoder().encode(part).length <= 75)).toBe(true);
    expect(folded.replace(/\r\n /g, "")).toBe(`SUMMARY:${"é".repeat(60)}`);
  });
});
