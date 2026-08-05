import indexHTML from "./src/client/index.html";
import settingsHTML from "./src/client/settings.html";
import conversationsHTML from "./src/client/conversations.html";
import { Store } from "./src/store";
import { initInference } from "./src/inference";
import { apiRoutes, getActor, evictIdleActors } from "./src/http";
import { handleLogin, handleCallback, handleLogout, clientMetadata } from "./src/auth";
import { JobDriver } from "./src/drive";
import { createBlobStore } from "./src/blobs";
import { sweepOrphanBlobs } from "./src/gc";
import { getConfig } from "./src/settings";
import { REAP_INTERVAL_MS, BLOB_GC_GRACE_MS, BLOB_GC_INTERVAL_MS } from "./src/config";

/**
 * Web entrypoint. Bun's native `routes` serve the HTML pages (transpiled,
 * bundled, content-hashed, HMR in dev — no bundler config, no Vite) alongside
 * the framework-free API routes from src/http. Tests import `apiRoutes` directly
 * and never touch this file, so importing it never triggers frontend bundling.
 *
 * The inline drive loop shares its implementation with worker.ts via JobDriver;
 * both entrypoints run the same claim/run/checkpoint logic.
 */
if (import.meta.main) {
  // Load the catalog + provider registry before serving, so the first request
  // already has models resolvable.
  await initInference();

  const store = new Store();
  const blobs = createBlobStore();
  const driver = new JobDriver(store, (id) => getActor(id, store), blobs);

  setInterval(() => {
    void driver.driveOnce();
  }, 1000);

  // Reaper: re-queue jobs whose lease expired (worker died mid-run) so any
  // process can re-claim them from checkpoint_seq; also evict idle actors.
  setInterval(() => {
    store.reap(Date.now());
    evictIdleActors();
    store.sweepSessions();
  }, REAP_INTERVAL_MS);

  // Blob GC: reclaim orphaned blobs (no conversation references them) past the
  // grace window. Runs on its own slower cadence since it touches the byte store.
  setInterval(() => {
    void sweepOrphanBlobs(store, blobs, BLOB_GC_GRACE_MS).catch((err) =>
      console.warn(`blob gc: ${(err as Error).message}`),
    );
  }, BLOB_GC_INTERVAL_MS);

  // The favicon <link>s and the manifest are bundled straight from the HTML
  // heads (Bun hashes them and rewrites the hrefs). The manifest's own icons
  // and the OG image, though, are referenced only by absolute path (manifest
  // JSON and og:image/twitter:image meta), so the bundler never sees them —
  // serve those from ./public at the paths they name.
  const publicDir = new URL("./public/", import.meta.url);
  const file = (name: string) => () => new Response(Bun.file(new URL(name, publicDir)));
  const staticRoutes = {
    "/icon-192.png": file("icon-192.png"),
    "/icon-512.png": file("icon-512.png"),
    "/icon-512-maskable.png": file("icon-512-maskable.png"),
    "/og-image.png": file("og-image.png"),
  };

  // KaTeX's stylesheet + fonts, served straight from the installed package (no
  // vendoring, no CDN). The client injects the <link> at runtime on first math,
  // so the bundler never resolves it and nothing math-related loads until used.
  // The CSS references its fonts relatively, resolving under /vendor/fonts/.
  const katexDir = new URL("./node_modules/katex/dist/", import.meta.url);
  const vendorRoutes = {
    "/vendor/katex.min.css": () =>
      new Response(Bun.file(new URL("katex.min.css", katexDir)), {
        headers: { "Content-Type": "text/css", "Cache-Control": "public, max-age=31536000, immutable" },
      }),
    "/vendor/fonts/:name": (req: Bun.BunRequest<"/vendor/fonts/:name">) => {
      // Only a bare KaTeX font filename — never a path segment that could escape.
      if (!/^KaTeX_[\w-]+\.(woff2|woff|ttf)$/.test(req.params.name)) {
        return new Response("not found", { status: 404 });
      }
      return new Response(Bun.file(new URL("fonts/" + req.params.name, katexDir)), {
        headers: { "Cache-Control": "public, max-age=31536000, immutable" },
      });
    },
  };

  // The enrichment bundle (Shiki + KaTeX) is heavy and optional, so it must NOT
  // ride the app entry. Bun.serve's HTML bundler inlines dynamic imports, so we
  // build enrich.js as its own SPLIT bundle here (splitting DOES work in
  // Bun.build) and serve its outputs from /assets/. The client loads /assets/
  // enrich.js via a runtime URL, so the app entry never pulls these libs and
  // grammars load per-language only when a code/math block appears. Rebuilt on
  // each (re)start — `--watch` picks up enrich.js edits.
  const enrichBuild = await Bun.build({
    entrypoints: [new URL("./src/client/enrich.js", import.meta.url).pathname],
    target: "browser",
    splitting: true,
    minify: true,
  });
  const enrichAssets = new Map<string, Blob>();
  for (const out of enrichBuild.outputs) {
    enrichAssets.set(out.path.replace(/^\.?\//, ""), out);
  }
  const assetRoutes = {
    "/assets/:file": (req: Bun.BunRequest<"/assets/:file">) => {
      const a = enrichAssets.get(req.params.file);
      if (!a) return new Response("not found", { status: 404 });
      return new Response(a, {
        headers: {
          "Content-Type": a.type || "text/javascript",
          "Cache-Control": "public, max-age=31536000, immutable",
        },
      });
    },
  };

  const port = getConfig().server.port;
  // The SSE stream is intentionally long-lived and can sit idle between
  // generations. Bun's default idleTimeout is 10s — shorter than our 15s
  // keepalive — so an idle stream would be killed before the first keepalive
  // fires. Raise it to Bun's max (255s); the keepalive resets the idle clock
  // well inside that window, so streams stay open indefinitely.
  Bun.serve({
    port,
    idleTimeout: 255,
    development: process.env.NODE_ENV !== "production",
    routes: {
      "/": indexHTML,
      "/c/:id": indexHTML, // deep link to a conversation — the SPA reads the id from the path
      "/settings": settingsHTML,
      "/conversations": conversationsHTML,
      // Auth (indiko OAuth). Inert unless auth.enabled — the SPA only navigates
      // here after a 401. /client-metadata.json is the public client document.
      "/client-metadata.json": () => clientMetadata(),
      "/auth/login": (req: Request) => handleLogin(req),
      "/auth/callback": (req: Request) => handleCallback(req, store),
      "/auth/logout": (req: Request) => handleLogout(req, store),
      ...staticRoutes,
      ...vendorRoutes,
      ...assetRoutes,
      // `kick` claims a just-enqueued job immediately instead of waiting for the
      // 1s poll tick below; the poll remains as a fallback (and for the worker).
      ...apiRoutes({ store, blobs, kick: () => void driver.driveOnce() }),
    },
  });
  console.log(`kloe listening on http://localhost:${port}`);
}
