import { createExecutionContext, waitOnExecutionContext } from "cloudflare:test";
import { env } from "cloudflare:workers";
import { encode } from "fast-png";
import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import worker from "../src/index";
import { classifyTextColor, cropTransparent, decodePngToRgba, removeBackground, sniffImageType, themedVariant, type Rgba } from "../src/lib/image";

type Json = Record<string, any>;

// --- images -----------------------------------------------------------------------

/** A logo: `background` everywhere, a block of `ink` in the middle. */
function logoPng(width: number, height: number, background: number[], ink: number[]): Uint8Array {
  const data = new Uint8Array(width * height * 4);
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const inside = x >= width / 4 && x < (3 * width) / 4 && y >= height / 4 && y < (3 * height) / 4;
      data.set(inside ? ink : background, (y * width + x) * 4);
    }
  }
  return encode({ width, height, data, channels: 4, depth: 8 });
}

const WHITE = [255, 255, 255, 255];
const BLACK = [10, 10, 10, 255];
const RED = [220, 30, 30, 255];

describe("image processing", () => {
  it("recognises image types by their bytes, not their names", () => {
    expect(sniffImageType(logoPng(4, 4, WHITE, BLACK))).toBe("image/png");
    expect(sniffImageType(new Uint8Array([0xff, 0xd8, 0xff, 0xe0]))).toBe("image/jpeg");
    expect(sniffImageType(new TextEncoder().encode("GIF89a......"))).toBe("image/gif");
    expect(sniffImageType(new TextEncoder().encode("RIFF....WEBPVP8 "))).toBe("image/webp");
    expect(sniffImageType(new TextEncoder().encode('<svg onload="alert(1)">'))).toBeNull();
  });

  it("removes the corner colour and crops to the content plus padding", () => {
    const image = decodePngToRgba(logoPng(40, 20, WHITE, BLACK));
    removeBackground(image);
    expect(image.data[3]).toBe(0);
    const cropped = cropTransparent(image, 2);
    expect([cropped.width, cropped.height]).toEqual([24, 14]); // 20x10 ink + 2px each side
  });

  it("classifies black and white lettering and leaves colourful logos alone", () => {
    const transparent = [0, 0, 0, 0];
    expect(classifyTextColor(decodePngToRgba(logoPng(20, 20, transparent, BLACK)))).toBe("dark");
    expect(classifyTextColor(decodePngToRgba(logoPng(20, 20, transparent, WHITE)))).toBe("light");
    expect(classifyTextColor(decodePngToRgba(logoPng(20, 20, transparent, RED)))).toBeNull();
  });

  it("inverts only grey pixels in the theme variant", () => {
    const image: Rgba = { width: 2, height: 1, data: new Uint8Array([10, 10, 10, 255, 220, 30, 30, 255]) };
    expect([...themedVariant(image).data]).toEqual([245, 245, 245, 255, 220, 30, 30, 255]);
  });
});

// --- HTTP helpers --------------------------------------------------------------------

async function call(path: string, init: RequestInit & { token?: string; json?: unknown; env?: object } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set("authorization", `Bearer ${init.token}`);
  const body = init.json === undefined ? init.body : JSON.stringify(init.json);
  if (init.json !== undefined) headers.set("content-type", "application/json");
  const ctx = createExecutionContext();
  const response = await worker.fetch(new Request(`https://wallos.test${path}`, { ...init, headers, body }), (init.env ?? env) as typeof env, ctx);
  await waitOnExecutionContext(ctx);
  const type = response.headers.get("content-type") ?? "";
  const bytes = new Uint8Array(await response.arrayBuffer());
  return {
    status: response.status,
    headers: response.headers,
    bytes,
    body: (type.includes("json") ? JSON.parse(new TextDecoder().decode(bytes)) : {}) as Json,
  };
}

function form(fields: Record<string, string | Blob>, fileName = "logo.png") {
  const data = new FormData();
  for (const [key, value] of Object.entries(fields)) {
    if (typeof value === "string") data.append(key, value);
    else data.append(key, value, fileName);
  }
  return data;
}

const pngFile = (bytes: Uint8Array) => new Blob([bytes], { type: "image/png" });

let outbound: string[] = [];
let respond: (url: string) => Response | Promise<Response> = () => new Response("not mocked", { status: 500 });

beforeEach(() => {
  outbound = [];
  vi.spyOn(globalThis, "fetch").mockImplementation(async (input: RequestInfo | URL) => {
    const url = String(input instanceof Request ? input.url : input);
    outbound.push(url);
    return respond(url);
  });
});
afterEach(() => vi.restoreAllMocks());

let counter = 0;
async function newUser(prefix = "files") {
  await env.DB.prepare("UPDATE admin SET registrations_open = 1").run();
  const username = `${prefix}${++counter}`;
  const reg = await call("/api/auth/register", { method: "POST", json: { username, email: `${username}@example.com`, password: "correct horse" } });
  const login = await call("/api/auth/login", { method: "POST", json: { username, password: "correct horse" } });
  return { id: reg.body.user_id as number, username, token: login.body.token as string };
}

async function subscription(token: string, name = "Netflix") {
  const res = await call("/api/subscriptions", { method: "POST", token, json: { name, price: 1 } });
  return res.body.subscriptionId as number;
}

const objectExists = async (key: string) => (await env.FILES.head(key)) !== null;

let adminToken: string;
beforeAll(async () => {
  await env.DB.prepare("DELETE FROM user").run();
  adminToken = (await newUser("admin")).token;
});

// --- logos ----------------------------------------------------------------------------

describe("subscription logos", () => {
  it("stores an uploaded logo in R2 and serves it at the PHP path", async () => {
    const user = await newUser();
    const id = await subscription(user.token);
    const res = await call(`/api/subscriptions/${id}/logo`, { method: "POST", token: user.token, body: form({ logo: pngFile(logoPng(40, 20, WHITE, BLACK)) }) });
    expect(res.status).toBe(200);
    expect(res.body.logo).toMatch(/^\d+-netflix-[0-9a-f]{8}\.png$/);
    expect(res.body.logo_variant).toBeNull(); // background removal is off by default

    const sub = (await call(`/api/subscriptions/${id}`, { token: user.token })).body.subscription;
    expect(sub).toMatchObject({ logo: res.body.logo, logo_path: `/images/uploads/logos/${res.body.logo}` });

    const served = await call(sub.logo_path);
    expect(served.status).toBe(200);
    expect(served.headers.get("content-type")).toBe("image/png");
    expect(served.headers.get("x-content-type-options")).toBe("nosniff");
    expect(sniffImageType(served.bytes)).toBe("image/png");

    const again = await call(sub.logo_path, { headers: { "if-none-match": served.headers.get("etag")! } });
    expect(again.status).toBe(304);

    expect((await call("/images/uploads/logos/..%2F..%2Fsecret")).status).toBe(404);
    expect((await call("/images/uploads/logos/missing.png")).status).toBe(404);
  });

  it("removes the background and makes a theme variant when the user asked for it", async () => {
    const user = await newUser();
    await call("/api/me/settings", { method: "PATCH", token: user.token, json: { remove_background: true } });
    const id = await subscription(user.token, "Dark Text");
    const res = await call(`/api/subscriptions/${id}/logo`, { method: "POST", token: user.token, body: form({ logo: pngFile(logoPng(40, 20, WHITE, BLACK)) }) });
    expect(res.body).toMatchObject({ logo_text_color: "dark", logo_variant: res.body.logo.replace(/\.png$/, "-variant.png") });

    const stored = await env.FILES.get(`images/uploads/logos/${res.body.logo}`);
    const pixels = decodePngToRgba(new Uint8Array(await stored!.arrayBuffer()));
    expect([pixels.width, pixels.height]).toEqual([24, 14]);
    expect(pixels.data[3]).toBe(0); // transparent corner
    const variant = await env.FILES.get(`images/uploads/logos/${res.body.logo_variant}`);
    const variantPixels = decodePngToRgba(new Uint8Array(await variant!.arrayBuffer()));
    const centre = (12 * 7 + 7) * 4;
    expect(variantPixels.data[centre]).toBe(245); // black ink became light
  });

  it("deletes replaced files, but not while a clone still uses them", async () => {
    const user = await newUser();
    const id = await subscription(user.token);
    const first = (await call(`/api/subscriptions/${id}/logo`, { method: "POST", token: user.token, body: form({ logo: pngFile(logoPng(8, 8, WHITE, RED)) }) })).body.logo;
    const clone = (await call(`/api/subscriptions/${id}/clone`, { method: "POST", token: user.token })).body.id;

    const second = (await call(`/api/subscriptions/${id}/logo`, { method: "POST", token: user.token, body: form({ logo: pngFile(logoPng(8, 8, WHITE, BLACK)) }) })).body.logo;
    expect(await objectExists(`images/uploads/logos/${first}`)).toBe(true); // the clone keeps it

    await call(`/api/subscriptions/${clone}`, { method: "DELETE", token: user.token });
    expect(await objectExists(`images/uploads/logos/${first}`)).toBe(false);

    await call(`/api/subscriptions/${id}`, { method: "PATCH", token: user.token, json: { logo: "" } });
    expect(await objectExists(`images/uploads/logos/${second}`)).toBe(false);
  });

  it("downloads a logo from a URL, following safe redirects only", async () => {
    const user = await newUser();
    const id = await subscription(user.token);
    const png = logoPng(10, 10, WHITE, RED);
    respond = (url) => {
      if (url === "https://cdn.example.com/start") return new Response(null, { status: 302, headers: { location: "/logo.png" } });
      if (url === "https://cdn.example.com/logo.png") return new Response(png, { headers: { "content-type": "image/png" } });
      if (url === "https://evil.example.com/") return new Response(null, { status: 302, headers: { location: "http://169.254.169.254/latest" } });
      if (url === "https://big.example.com/") return new Response(new Uint8Array(6 * 1024 * 1024));
      if (url === "https://html.example.com/") return new Response("<html>");
      return new Response("nope", { status: 404 });
    };

    const ok = await call(`/api/subscriptions/${id}/logo`, { method: "POST", token: user.token, json: { url: "https://cdn.example.com/start" } });
    expect(ok.status).toBe(200);
    expect(outbound).toEqual(["https://cdn.example.com/start", "https://cdn.example.com/logo.png"]);

    const blocked = await call(`/api/subscriptions/${id}/logo`, { method: "POST", token: user.token, json: { url: "https://evil.example.com/" } });
    expect(blocked.status).toBe(400);
    expect(blocked.body.message).toMatch(/Private IP/);
    expect(outbound).not.toContain("http://169.254.169.254/latest");

    expect((await call(`/api/subscriptions/${id}/logo`, { method: "POST", token: user.token, json: { url: "https://big.example.com/" } })).body.message).toMatch(/larger than 5 MB/);
    expect((await call(`/api/subscriptions/${id}/logo`, { method: "POST", token: user.token, json: { url: "https://html.example.com/" } })).body.message).toMatch(/Only PNG/);
  });

  it("takes a logo along when creating a subscription, and saves the subscription even if the logo fails", async () => {
    const user = await newUser();
    respond = (url) => (url.endsWith("/ok.png") ? new Response(logoPng(6, 6, WHITE, RED)) : new Response("", { status: 404 }));

    const withLogo = await call("/api/subscriptions", { method: "POST", token: user.token, json: { name: "Spotify", price: 1, logo_url: "https://cdn.example.com/ok.png", url: "https://spotify.com" } });
    expect(withLogo.status).toBe(201);
    expect(withLogo.body.subscription.logo).toMatch(/-spotify-/);
    expect(withLogo.body.subscription.url).toBe("https://spotify.com");

    const broken = await call("/api/subscriptions", { method: "POST", token: user.token, json: { name: "Broken", price: 1, logo_url: "https://cdn.example.com/gone.png" } });
    expect(broken.status).toBe(201);
    expect(broken.body.logo_warning).toMatch(/HTTP 404/);
    expect(broken.body.subscription.logo).toBe("");
  });

  it("accepts a logo file on the PHP set_subscriptions.php endpoint", async () => {
    const user = await newUser();
    const apiKey = (await call("/api/me/api-key", { token: user.token })).body.api_key;
    const res = await call("/api/subscriptions/set_subscriptions.php", {
      method: "POST",
      body: form({ api_key: apiKey, action: "add", name: "Legacy Logo", price: "3", logo: pngFile(logoPng(6, 6, WHITE, BLACK)) }),
    });
    expect(res.status).toBe(201);
    expect(res.body.subscription.logo).toMatch(/-legacy-logo-[0-9a-f]{8}\.png$/);
  });

  it("only accepts stored file names as logo values", async () => {
    const user = await newUser();
    const id = await subscription(user.token);
    expect((await call(`/api/subscriptions/${id}`, { method: "PATCH", token: user.token, json: { logo: "../../etc/passwd" } })).status).toBe(400);
  });

  it("resizes through the Images binding when it is configured", async () => {
    const user = await newUser();
    const id = await subscription(user.token);
    const small = logoPng(4, 2, WHITE, RED);
    let asked: Json | null = null;
    const IMAGES = {
      input: () => ({
        transform: (options: Json) => {
          asked = options;
          return { output: async () => ({ response: () => new Response(small) }) };
        },
      }),
    };
    const res = await call(`/api/subscriptions/${id}/logo`, { method: "POST", token: user.token, body: form({ logo: pngFile(logoPng(400, 200, WHITE, RED)) }), env: { ...env, IMAGES } });
    expect(res.status).toBe(200);
    expect(asked).toEqual({ width: 270, height: 84, fit: "scale-down" });
  });
});

// --- icons and avatars ------------------------------------------------------------------

describe("payment method icons and avatars", () => {
  it("uploads a payment method icon and removes it with the method", async () => {
    const user = await newUser();
    const method = await call("/api/payment-methods", { method: "POST", token: user.token, json: { name: "My Card" } });
    const id = method.body.item.id;
    const res = await call(`/api/payment-methods/${id}/icon`, { method: "POST", token: user.token, body: form({ icon: pngFile(logoPng(8, 8, WHITE, RED)) }, "icon.png") });
    expect(res.status).toBe(200);
    expect(await objectExists(`images/uploads/logos/${res.body.icon}`)).toBe(true);

    expect((await call(`/api/payment-methods/${id}`, { method: "PATCH", token: user.token, json: { icon: "https://evil.example.com/x.png" } })).status).toBe(400);
    await call(`/api/payment-methods/${id}`, { method: "DELETE", token: user.token });
    expect(await objectExists(`images/uploads/logos/${res.body.icon}`)).toBe(false);
  });

  it("uploads, replaces and removes avatars", async () => {
    const user = await newUser();
    expect((await call("/api/me", { token: user.token })).body.user.avatar).toBe("images/avatars/0.svg");

    const first = await call("/api/me/avatar", { method: "POST", token: user.token, body: form({ avatar: pngFile(logoPng(8, 8, WHITE, RED)) }, "me.png") });
    expect(first.body.avatar).toMatch(/^images\/uploads\/logos\/avatars\/\d+-avatars-files\d+-[0-9a-f]{8}\.png$/);
    expect((await call(`/${first.body.avatar}`)).status).toBe(200);

    const second = await call("/api/me/avatar", { method: "POST", token: user.token, body: form({ avatar: pngFile(logoPng(8, 8, WHITE, BLACK)) }, "me.png") });
    expect(await objectExists(first.body.avatar)).toBe(false);

    await call("/api/me", { method: "PATCH", token: user.token, json: { avatar: "images/avatars/3.svg" } });
    expect(await objectExists(second.body.avatar)).toBe(false);
    expect((await call("/api/me", { method: "PATCH", token: user.token, json: { avatar: "https://evil.example.com/a.png" } })).status).toBe(400);

    const third = await call("/api/me/avatar", { method: "POST", token: user.token, body: form({ avatar: pngFile(logoPng(8, 8, WHITE, BLACK)) }, "me.png") });
    await call("/api/me/avatar", { method: "DELETE", token: user.token });
    expect(await objectExists(third.body.avatar)).toBe(false);
    expect((await call("/api/me", { token: user.token })).body.user.avatar).toBe("images/avatars/0.svg");
  });
});

// --- admin ---------------------------------------------------------------------------------

describe("admin file maintenance", () => {
  it("deletes unused logos and the files of deleted users", async () => {
    await env.FILES.put("images/uploads/logos/orphan.png", logoPng(2, 2, WHITE, RED));
    const user = await newUser();
    const id = await subscription(user.token);
    const logo = (await call(`/api/subscriptions/${id}/logo`, { method: "POST", token: user.token, body: form({ logo: pngFile(logoPng(6, 6, WHITE, RED)) }) })).body.logo;

    const cleanup = await call("/api/admin/files/cleanup", { method: "POST", token: adminToken });
    expect(cleanup.body.deleted).toContain("orphan.png");
    expect(cleanup.body.deleted).not.toContain(logo);
    expect(await objectExists(`images/uploads/logos/${logo}`)).toBe(true);

    await call(`/api/admin/users/${user.id}`, { method: "DELETE", token: adminToken });
    expect(await objectExists(`images/uploads/logos/${logo}`)).toBe(false);
  });
});

// --- logo search ------------------------------------------------------------------------------

describe("logo search", () => {
  it("searches the icon catalogues", async () => {
    const user = await newUser();
    respond = (url) => {
      if (url.endsWith("selfhst/icons/index.json")) return Response.json([{ Name: "Plexamp", Reference: "plexamp", PNG: "Yes" }, { Name: "Other", Reference: "other", PNG: "Yes" }]);
      if (url.endsWith("dashboard-icons/tree.json")) return Response.json({ png: ["plexamp.png", "plexamp-dark.png", "plex.png"] });
      return new Response("", { status: 500 });
    };
    const res = await call("/api/logos/search?q=plexamp&source=icons", { token: user.token });
    expect(res.body.results.map((r: Json) => r.image)).toEqual([
      "https://cdn.jsdelivr.net/gh/selfhst/icons/png/plexamp.png",
      "https://cdn.jsdelivr.net/gh/homarr-labs/dashboard-icons/png/plexamp.png",
    ]);
  });

  it("asks DuckDuckGo with a vqd token and puts PNG sources first", async () => {
    const user = await newUser();
    respond = (url) => {
      if (url.startsWith("https://duckduckgo.com/?q=")) return new Response('<script>vqd="4-12345"</script>');
      if (url.startsWith("https://duckduckgo.com/i.js")) {
        expect(new URL(url).searchParams.get("vqd")).toBe("4-12345");
        return Response.json({ results: [
          { image: "https://a.example.com/logo.jpg", thumbnail: "https://t/1", width: 100, height: 50 },
          { image: "https://b.example.com/logo.png", thumbnail: "https://t/2", width: 200, height: 80 },
        ] });
      }
      return new Response("", { status: 500 });
    };
    const res = await call("/api/logos/search?q=zzduck&source=duckduckgo", { token: user.token });
    expect(res.body.results.map((r: Json) => r.image)).toEqual(["https://b.example.com/logo.png", "https://a.example.com/logo.jpg"]);
  });

  it("needs a SerpAPI key for Google, stored masked", async () => {
    const user = await newUser();
    expect((await call("/api/logos/search?q=x&source=google", { token: user.token })).status).toBe(502);
    expect((await call("/api/logos/google-key", { method: "PUT", token: user.token, json: { api_key: "serp-key" } })).body).toEqual({ success: true, title: "google_search", configured: true, api_key: "********" });

    respond = (url) => {
      expect(new URL(url).searchParams.get("api_key")).toBe("serp-key");
      return Response.json({ images_results: [{ original: "https://g.example.com/o.png", thumbnail: "https://g.example.com/t.png", original_width: 10, original_height: 5 }] });
    };
    const res = await call("/api/logos/search?q=zzgoogle&source=google", { token: user.token });
    expect(res.body.results).toEqual([{ thumbnail: "https://g.example.com/t.png", image: "https://g.example.com/o.png", width: 10, height: 5 }]);
  });
});
