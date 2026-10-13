import { Hono, type Context } from "hono";
import { getCookie } from "hono/cookie";
import type { AppBindings } from "../env";
import { WORKER_VERSION } from "../version";
import { LANGUAGES } from "./i18n";

/*
  manifest.php and service-worker.php: the installable web app. Neither needs
  a session, as in PHP (the login page links the manifest too, and
  scripts/all.js registers "service-worker.php" on every page).

  Differences from PHP: the manifest leaves out the screenshots and the
  service worker the images/siteicons/svg/*.php files, because the Worker
  does not serve them (the icons are inlined into the pages instead).
*/

export const routes = new Hono<AppBindings>();

/** The manifest's colours follow the "theme"/"inUseTheme" cookies (includes/theme_helpers.php). */
function themeColor(c: Context): string {
  const mode = getCookie(c, "theme");
  let theme = mode === "light" || mode === "dark" || mode === "automatic" ? mode : "light";
  if (theme === "automatic") {
    const resolved = getCookie(c, "inUseTheme");
    theme = resolved === "dark" ? "dark" : "light";
  }
  return theme === "light" ? "#FFFFFF" : "#12151C";
}

const shortcut = (name: string, description: string, url: string, icon: string) => ({
  name,
  short_name: name,
  description,
  url,
  icons: [{ src: `images/siteicons/pwa/${icon}.png`, type: "image/png", sizes: "96x96" }],
});

export function manifest(color: string) {
  return {
    short_name: "Wallos",
    name: "Wallos - Subscription Tracker",
    icons: [
      { src: "images/icon/android-chrome-192x192.png", type: "image/png", sizes: "192x192" },
      { src: "images/icon/android-chrome-512x512.png", type: "image/png", sizes: "512x512" },
      { src: "images/icon/maskable_icon_x192.png", type: "image/png", sizes: "192x192", purpose: "maskable" },
      { src: "images/icon/maskable_icon_x512.png", type: "image/png", sizes: "512x512", purpose: "maskable" },
    ],
    start_url: "/",
    id: "com.wallos.app",
    shortcuts: [
      shortcut("Dashboard", "View your dashboard", "index.php", "dashboard"),
      shortcut("Subscriptions", "View your subscriptions", "subscriptions.php", "subscriptions"),
      shortcut("Calendar", "View your calendar", "calendar.php", "calendar"),
      shortcut("Stats", "View your statistics", "stats.php", "stats"),
      shortcut("Settings", "Change your settings", "settings.php", "settings"),
      shortcut("About", "More info about Wallos", "about.php", "about"),
    ],
    background_color: color,
    display: "standalone",
    scope: "/",
    theme_color: color,
    description: "Wallos is a personal subscription tracker that helps you keep track of your subscriptions and save money.",
    orientation: "portrait-primary",
    display_override: ["window-controls-overlay"],
  };
}

routes.get("/manifest.php", (c) =>
  c.body(JSON.stringify(manifest(themeColor(c)), null, 4), 200, { "content-type": "application/manifest+json; charset=utf-8" }),
);

// --- service worker ---------------------------------------------------------------------------

const PAYMENT_ICONS = [
  "paypal", "creditcard", "banktransfer", "directdebit", "money", "googlepay", "samsungpay", "applepay", "crypto", "klarna",
  "amazonpay", "sepa", "skrill", "sofort", "stripe", "affirm", "alipay", "elo", "facebookpay", "giropay", "ideal", "unionpay",
  "interac", "wechat", "paysafe", "poli", "qiwi", "shoppay", "venmo", "verifone", "webmoney",
];

const STATIC_ASSETS = [
  "styles/styles.css",
  "styles/theme.css",
  "styles/dark-theme.css",
  "styles/login.css",
  "styles/login-dark-theme.css",
  "styles/font-awesome.min.css",
  "styles/brands.css",
  "styles/barlow.css",
  ...["red", "green", "yellow", "purple"].map((name) => `styles/themes/${name}.css`),
  ...["solid-900", "brands-400", "regular-400"].flatMap((font) => [`webfonts/fa-${font}.woff2`, `webfonts/fa-${font}.ttf`]),
  ...[
    "all", "common", "dashboard", "subscriptions", "subscription-details", "password-toggle", "stats", "settings", "profile",
    "theme", "auth-theme", "notifications", "registration", "login", "admin", "calendar",
  ].map((name) => `scripts/${name}.js`),
  ...Object.keys(LANGUAGES).sort().map((code) => `scripts/i18n/${code}.js`),
  "scripts/i18n/getlang.js",
  "scripts/libs/apexcharts.min.js",
  "scripts/libs/sortable.min.js",
  "scripts/libs/qrcode.min.js",
  "images/icon/favicon.ico",
  "images/icon/favicon-16x16.png",
  "images/icon/favicon-32x32.png",
  "images/icon/android-chrome-192x192.png",
  "images/icon/android-chrome-512x512.png",
  "images/icon/maskable_icon_x192.png",
  "images/icon/maskable_icon_x512.png",
  "images/icon/apple-touch-icon-180.png",
  "images/icon/apple-touch-icon-152.png",
  "images/icon/apple-touch-icon.png",
  "images/siteicons/wallos.png",
  "images/siteicons/walloswhite.png",
  "images/siteimages/empty.png",
  "images/siteimages/mobilenav.png",
  "images/siteimages/mobilenavdark.png",
  ...Array.from({ length: 9 }, (_, i) => `images/avatars/${i + 1}.svg`),
  ...["stats", "settings", "about", "calendar", "subscriptions", "dashboard"].map((name) => `images/siteicons/pwa/${name}.png`),
  ...PAYMENT_ICONS.map((name) => `images/uploads/icons/${name}.png`),
];

const PAGES_TO_PREFETCH = ["index.php", "subscriptions.php", "profile.php", "calendar.php", "settings.php", "stats.php", "about.php", "login.php", "admin.php"];

export function serviceWorkerScript(version = WORKER_VERSION): string {
  return `// STATIC_CACHE is tied to the app version (rather than a hand-bumped literal)
// so every release invalidates stale precached assets automatically.
const STATIC_CACHE = 'static-cache-${version}';
const PAGES_CACHE = 'pages-cache-v1';
const LOGOS_CACHE = 'logos-cache-v2';

// manifest.php is intentionally not precached here: it's per-user (theme
// cookie dependent), so it falls through to the network-first handler below.
const staticAssets = ${JSON.stringify(STATIC_ASSETS, null, 4)};

const pagesToPrefetch = ${JSON.stringify(PAGES_TO_PREFETCH, null, 4)};

// Install: cache static assets in small batches.
self.addEventListener('install', function (event) {
    event.waitUntil(
        caches.open(STATIC_CACHE).then(async function (cache) {
            const BATCH_SIZE = 12;
            for (let i = 0; i < staticAssets.length; i += BATCH_SIZE) {
                await Promise.allSettled(
                    staticAssets.slice(i, i + BATCH_SIZE).map(url =>
                        fetch(url, { cache: 'reload' }).then(response => {
                            if (response.ok) return cache.put(url, response);
                        }).catch(() => {}) // silently skip missing files
                    )
                );
            }
        })
    );
    self.skipWaiting();
});

// Activate: clean up old caches
self.addEventListener('activate', function (event) {
    const validCaches = [STATIC_CACHE, PAGES_CACHE, LOGOS_CACHE];
    event.waitUntil(
        caches.keys().then(keys =>
            Promise.all(
                keys.filter(key => !validCaches.includes(key))
                    .map(key => caches.delete(key))
            )
        )
    );
    self.clients.claim();
});

// Message: prefetch pages after login
self.addEventListener('message', function (event) {
    if (event.data && event.data.type === 'PREFETCH_PAGES') {
        caches.open(PAGES_CACHE).then(cache => {
            pagesToPrefetch.forEach(url => {
                fetch(url).then(response => {
                    // Only cache if user is actually logged in (no redirect)
                    if (response.ok && !response.redirected) {
                        cache.put(url, response);
                    }
                }).catch(() => {});
            });
        });
    }
});

// Fetch: single handler for all requests
self.addEventListener('fetch', function (event) {
    const request = event.request;
    const url = new URL(request.url);

    // Never intercept non-GET requests (POST, etc.)
    if (request.method !== 'GET') return;

    // Search endpoints must always return their current JSON response.
    if (url.pathname.includes('/endpoints/logos/')) {
        event.respondWith(fetch(request));
        return;
    }

    // Logo images: cache-first, but cache only successful image responses.
    if (url.pathname.includes('images/uploads/logos')) {
        event.respondWith(
            caches.match(request).then(response => {
                return response || fetch(request).then(networkResponse => {
                    const contentType = networkResponse.headers.get('content-type') || '';
                    if (networkResponse.ok && contentType.startsWith('image/')) {
                        return caches.open(LOGOS_CACHE).then(cache => {
                            cache.put(request, networkResponse.clone());
                            return networkResponse;
                        });
                    }
                    return networkResponse;
                });
            })
        );
        return;
    }

    // Static assets: cache-first (they only change on deploy). ignoreSearch
    // because the pages request these with a "?<version>" cache-buster.
    // On a miss, fetch AND store the result.
    if (staticAssets.some(asset => url.pathname.endsWith(asset))) {
        event.respondWith(
            caches.match(request, { ignoreSearch: true }).then(cached => {
                if (cached) return cached;
                return fetch(request).then(networkResponse => {
                    if (networkResponse.ok) {
                        const clone = networkResponse.clone();
                        caches.open(STATIC_CACHE).then(cache => cache.put(request, clone));
                    }
                    return networkResponse;
                });
            })
        );
        return;
    }

    // Pages and everything else: network-first, cache as fallback
    event.respondWith(
        fetch(request).then(response => {
            if (response.ok && !response.redirected) {
                const responseClone = response.clone(); // clone before any async operation
                caches.open(PAGES_CACHE).then(cache => {
                    cache.put(request, responseClone);
                });
            }
            return response;
        }).catch(() => {
            return caches.match(request, { ignoreSearch: true });
        })
    );
});

// Web Push: the payload is {"title": ..., "body": ...} JSON, decrypted by the browser.
self.addEventListener('push', function (event) {
    let data = {};

    if (event.data) {
        try {
            data = event.data.json();
        } catch (e) {
            data = { title: 'Wallos', body: event.data.text() };
        }
    }

    const title = data.title || 'Wallos';
    const options = {
        body: data.body || '',
        icon: 'images/icon/android-chrome-192x192.png',
        badge: 'images/icon/android-chrome-192x192.png',
        data: { url: data.url || './' },
    };

    event.waitUntil(self.registration.showNotification(title, options));
});

self.addEventListener('notificationclick', function (event) {
    event.notification.close();

    const targetUrl = (event.notification.data && event.notification.data.url) || './';

    event.waitUntil(
        clients.matchAll({ type: 'window', includeUncontrolled: true }).then(function (windowClients) {
            // Focus a tab that already has the app open.
            for (const client of windowClients) {
                if (client.url.includes(self.registration.scope) && 'focus' in client) {
                    return client.focus();
                }
            }

            if (clients.openWindow) {
                return clients.openWindow(targetUrl);
            }
        })
    );
});
`;
}

const serveServiceWorker = (c: Context) =>
  c.body(serviceWorkerScript(), 200, { "content-type": "text/javascript; charset=utf-8", "cache-control": "no-cache" });

routes.get("/service-worker.php", serveServiceWorker);
routes.get("/service-worker.js", serveServiceWorker);
