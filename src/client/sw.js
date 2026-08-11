/*
 * kloe service worker — instant cold paint + offline shell, and instant chat-open.
 *
 * The caching strategy mirrors the Cache-Control the server actually sends, so it
 * is correct in dev and prod alike (no dev-only kill-switch needed):
 *
 *   immutable (content-hashed: /chunk-*, /assets/chunk-*, /vendor/*, favicons)
 *     — `max-age, immutable`, so cache-first and kept forever. A rebuilt bundle is
 *       a new URL, so this can never serve stale code.
 *   mutable (the shell document, and /assets/enrich.js — both `no-cache`)
 *     — network-first with a cache fallback: always fresh online (so a rebuild is
 *       picked up on the next load, no stale bundle), and still available offline.
 *   conversation tails (/events?tailTurns=… only)
 *     — a deliberate stale-while-revalidate + cap: a revisit paints the last turns
 *       instantly and the live SSE reconciles. Older history (?before=) is never
 *       cached, so the message cache is bounded by the cap, not by history length.
 *
 * Never touched: the SSE stream (/stream), non-GET, cross-origin, and the
 * server-handled auth flows (/auth/*, /lard/*).
 */
var VERSION = "v3";
var SHELL = "kloe-shell-" + VERSION;
var ASSETS = "kloe-assets-" + VERSION;
var TAILS = "kloe-tails-" + VERSION;
var MAX_TAILS = 50; // ceiling on cached conversation tails (FIFO eviction)

self.addEventListener("install", function (e) {
  self.skipWaiting();
  // Warm the shell so an offline first load still paints.
  e.waitUntil(
    caches.open(SHELL).then(function (c) {
      return c.add("/").catch(function () {});
    }),
  );
});

self.addEventListener("activate", function (e) {
  e.waitUntil(
    (async function () {
      var keys = await caches.keys();
      await Promise.all(
        keys
          .filter(function (k) {
            return k.indexOf("kloe-") === 0 && k.lastIndexOf(VERSION) === -1;
          })
          .map(function (k) {
            return caches.delete(k);
          }),
      );
      await self.clients.claim();
    })(),
  );
});

// Content-hashed → immutable (a content change is a new URL). Mirrors the paths
// the server marks `immutable`. Notably NOT /assets/enrich.js: that keeps a fixed
// name but changes per build (served `no-cache`), so it revalidates below.
function isImmutable(p) {
  return (
    /-[A-Za-z0-9]+\.(js|css|ico|svg|png|webmanifest)$/.test(p) || // client build hashed outputs
    /^\/assets\/chunk-/.test(p) || // enrich split chunks (grammars, themes)
    p.indexOf("/vendor/") === 0 // katex css + fonts
  );
}
function isTailRequest(url) {
  return (
    /^\/api\/conversations\/[^/]+\/events$/.test(url.pathname) && url.searchParams.has("tailTurns")
  );
}

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return;
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf("/auth/") === 0 || url.pathname.indexOf("/lard/") === 0) return;
  // Share pages are a different document with a different shell. Letting them
  // through `shellNetworkFirst` would cache one under "/" and hand the app's
  // own offline fallback a published document.
  if (url.pathname.indexOf("/s/") === 0 || url.pathname.indexOf("/api/public/") === 0) return;

  if (req.mode === "navigate") {
    e.respondWith(shellNetworkFirst(req));
    return;
  }
  if (isImmutable(url.pathname)) {
    e.respondWith(cacheFirst(req));
    return;
  }
  if (isTailRequest(url)) {
    e.respondWith(tailSWR(req));
    return;
  }
  // Mutable same-origin GETs (the shell's no-cache siblings, e.g. /assets/enrich.js):
  // revalidate — fresh online, cache fallback offline.
  e.respondWith(networkFirst(req, ASSETS));
});

// The SPA is one document; serve the cached shell only as an offline fallback.
async function shellNetworkFirst(req) {
  var cache = await caches.open(SHELL);
  try {
    var res = await fetch(req);
    if (res && res.ok) cache.put("/", res.clone()); // one canonical shell for offline
    return res;
  } catch (_) {
    return (await cache.match("/")) || Response.error();
  }
}

async function networkFirst(req, cacheName) {
  var cache = await caches.open(cacheName);
  try {
    var res = await fetch(req);
    if (res && res.ok) cache.put(req, res.clone());
    return res;
  } catch (_) {
    return (await cache.match(req)) || Response.error();
  }
}

async function cacheFirst(req) {
  var cache = await caches.open(ASSETS);
  var hit = await cache.match(req);
  if (hit) return hit;
  var res = await fetch(req);
  if (res && res.ok) cache.put(req, res.clone());
  return res;
}

async function tailSWR(req) {
  var cache = await caches.open(TAILS);
  var cached = await cache.match(req);
  var net = fetch(req)
    .then(async function (res) {
      if (res && res.ok) {
        await cache.put(req, res.clone());
        await trim(cache, MAX_TAILS);
      }
      return res;
    })
    .catch(function () {
      return null;
    });
  return cached || (await net) || new Response("", { status: 504 });
}

// Cache API keys are insertion-ordered, so deleting from the front is FIFO.
async function trim(cache, max) {
  var keys = await cache.keys();
  var over = keys.length - max;
  for (var i = 0; i < over; i++) await cache.delete(keys[i]);
}
