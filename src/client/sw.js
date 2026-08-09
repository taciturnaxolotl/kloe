/*
 * kloe service worker — instant cold paint + offline shell, and instant chat-open.
 *
 * Three caches, all versioned (bump VERSION to purge on a logic change):
 *   shell   — the single SPA document (index.html), served stale-while-revalidate
 *             so a cold load paints from cache and refreshes in the background.
 *   assets  — content-hashed bundles (/chunk-*, /assets/*, /vendor/*, favicons):
 *             immutable, so cache-first and kept forever (per URL).
 *   tails   — conversation TAILS only (/api/conversations/:id/events?tailTurns=…),
 *             SWR + capped. This is the whole "cache messages" story: a revisit
 *             paints the last turns instantly, then the live SSE reconciles. Older
 *             history (?before=) is never cached, so this can't grow unbounded;
 *             the cap bounds it to MAX_TAILS entries.
 *
 * Never touched: the SSE stream (/stream), non-GET requests, cross-origin, and the
 * server-handled auth flows (/auth/*, /lard/*) — those must always hit the network.
 */
var VERSION = "v1";
var SHELL = "kloe-shell-" + VERSION;
var ASSETS = "kloe-assets-" + VERSION;
var TAILS = "kloe-tails-" + VERSION;
var MAX_TAILS = 50; // ceiling on cached conversation tails (LRU/FIFO eviction)

self.addEventListener("install", function (e) {
  self.skipWaiting();
  // Warm the shell so the very next load (even offline) paints instantly.
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

function isHashedAsset(p) {
  return (
    /-[A-Za-z0-9]+\.(js|css|ico|svg|png|webmanifest)$/.test(p) || // client build (chunk-*, favicon-*, …)
    p.indexOf("/assets/") === 0 || // enrich split bundle
    p.indexOf("/vendor/") === 0 // katex css + fonts
  );
}
function isTailRequest(url) {
  // Only the tail (last turns) — never backfill (?before=), so the cache is bounded.
  return (
    /^\/api\/conversations\/[^/]+\/events$/.test(url.pathname) && url.searchParams.has("tailTurns")
  );
}

self.addEventListener("fetch", function (e) {
  var req = e.request;
  if (req.method !== "GET") return; // mutations always go to the network
  var url = new URL(req.url);
  if (url.origin !== self.location.origin) return; // never touch cross-origin

  // Server-handled navigations must reach the network, not the cached shell.
  if (url.pathname.indexOf("/auth/") === 0 || url.pathname.indexOf("/lard/") === 0) return;

  if (req.mode === "navigate") {
    e.respondWith(shellSWR());
    return;
  }
  if (isHashedAsset(url.pathname)) {
    e.respondWith(cacheFirst(req));
    return;
  }
  if (isTailRequest(url)) {
    e.respondWith(tailSWR(req));
    return;
  }
  // Everything else (mutable APIs, the SSE stream, etc.): straight to the network.
});

// The SPA is one document, so every navigation is served the same cached shell.
async function shellSWR() {
  var cache = await caches.open(SHELL);
  var cached = await cache.match("/");
  var net = fetch("/")
    .then(function (res) {
      if (res && res.ok) cache.put("/", res.clone());
      return res;
    })
    .catch(function () {
      return null;
    });
  return cached || (await net) || fetch("/");
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
  // Cached tail is instant; the live SSE reconciles anything newer.
  return cached || (await net) || new Response("", { status: 504 });
}

// Cache API keys are insertion-ordered, so deleting from the front is FIFO.
async function trim(cache, max) {
  var keys = await cache.keys();
  var over = keys.length - max;
  for (var i = 0; i < over; i++) await cache.delete(keys[i]);
}
