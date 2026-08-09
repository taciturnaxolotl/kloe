import { watch } from "node:fs";
import { ASSET_CACHE, buildClient, type ClientBundle, HTML_CACHE, serveAsset } from "./src/assets";
import { clientMetadata, handleCallback, handleLogin, handleLogout } from "./src/auth";
import { createBlobStore } from "./src/blobs";
import { BLOB_GC_GRACE_MS, BLOB_GC_INTERVAL_MS, REAP_INTERVAL_MS } from "./src/config";
import { JobDriver } from "./src/drive";
import { sweepOrphanBlobs } from "./src/gc";
import { apiRoutes, evictIdleActors, getActor } from "./src/http";
import { initInference } from "./src/inference";
import { handleLardCallback, handleLardConnect } from "./src/lard";
import { getConfig } from "./src/settings";
import { Store } from "./src/store";

/**
 * Web entrypoint. The client is built explicitly (see src/assets — content-hashed,
 * compressed, immutable-cached) and served alongside the framework-free API routes
 * from src/http. Tests import `apiRoutes` directly and never touch this file, so
 * importing it never triggers a frontend build.
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
        headers: {
          "Content-Type": "text/css",
          "Cache-Control": "public, max-age=31536000, immutable",
        },
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
  // grammars load per-language only when a code/math block appears.
  const enrichAssets = new Map<string, Bun.BuildArtifact>();
  async function buildEnrich() {
    const build = await Bun.build({
      entrypoints: [new URL("./src/client/enrich.js", import.meta.url).pathname],
      target: "browser",
      splitting: true,
      minify: true,
    });
    enrichAssets.clear();
    for (const out of build.outputs) enrichAssets.set(out.path.replace(/^\.?\//, ""), out);
  }
  await buildEnrich();

  // The app client (index + the satellite pages), built explicitly so we control
  // caching, compression, and asset paths (see src/assets). Held in a mutable ref
  // so the dev watcher can swap in a rebuild without re-registering routes.
  const dev = Bun.env.NODE_ENV !== "production";
  let client: ClientBundle = await buildClient(dev);

  // `bun --watch` restarts on server.ts + its imports, but the client and enrich
  // are built from paths (never imported), so their edits wouldn't otherwise
  // rebuild. In dev, watch the client sources and rebuild in place; the no-cache
  // HTML header then lets a plain browser reload pick up the new hashed assets.
  if (dev) {
    const dir = new URL("./src/client/", import.meta.url).pathname;
    let timer: ReturnType<typeof setTimeout> | null = null;
    watch(dir, { recursive: true }, (_evt, file) => {
      if (file && !/\.(js|css|html)$/.test(file)) return; // ignore editor temp files
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        Promise.all([
          buildEnrich(),
          buildClient(dev).then((c) => {
            client = c;
          }),
        ])
          .then(() => console.log("[client] rebuilt"))
          .catch((err) => console.error("[client] rebuild failed:", err));
      }, 80);
    });
  }
  const assetRoutes = {
    "/assets/:file": (req: Bun.BunRequest<"/assets/:file">) => {
      const file = req.params.file;
      const a = enrichAssets.get(file);
      if (!a) return new Response("not found", { status: 404 });
      // Chunks are content-hashed → immutable, cached forever. The entry
      // (enrich.js) keeps a fixed name but its content hash rides an ETag: the
      // browser revalidates each load (no-cache) but gets a tiny 304 when it
      // hasn't changed, and only re-downloads the body when it actually did — so
      // rebuilds propagate without re-fetching the bundle on every page load.
      const etag = `"${a.hash}"`;
      const cache = /^chunk-/.test(file) ? "public, max-age=31536000, immutable" : "no-cache";
      if (req.headers.get("If-None-Match") === etag) {
        return new Response(null, { status: 304, headers: { ETag: etag, "Cache-Control": cache } });
      }
      return new Response(a, {
        headers: {
          "Content-Type": a.type || "text/javascript",
          "Cache-Control": cache,
          ETag: etag,
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
  // An entry document, served with revalidate-caching. Reads from the mutable
  // `client` ref so a dev rebuild is reflected without re-registering the route.
  const page = (name: string) => (req: Request) => {
    const doc = client.html.get(name);
    if (!doc) return new Response("client not built", { status: 500 });
    return serveAsset(req, doc, HTML_CACHE);
  };

  Bun.serve({
    port,
    idleTimeout: 255,
    development: dev,
    // Content-hashed client assets (/chunk-*.js, /favicon-*, …) live at the root
    // under names that change each build, so they can't be static route keys;
    // this fallback serves them immutably from the current bundle by basename.
    fetch(req) {
      const name = new URL(req.url).pathname.slice(1);
      const asset = client.assets.get(name);
      if (asset) return serveAsset(req, asset, ASSET_CACHE);
      return new Response("not found", { status: 404 });
    },
    routes: {
      "/": page("index.html"),
      "/c/:id": page("index.html"), // deep link to a conversation — the SPA reads the id from the path
      "/settings": page("index.html"), // SPA route — the shell mounts the settings view
      "/conversations": page("index.html"), // SPA route — the shell mounts the conversations view
      "/projects": page("index.html"), // SPA route — the shell's router mounts the projects view
      "/p/:id": page("index.html"), // SPA route — the shell mounts the project-detail view
      // Auth (indiko OAuth). Inert unless auth.enabled — the SPA only navigates
      // here after a 401. /client-metadata.json is the public client document.
      "/client-metadata.json": () => clientMetadata(),
      "/auth/login": (req: Request) => handleLogin(req),
      "/auth/callback": (req: Request) => handleCallback(req, store),
      "/auth/logout": (req: Request) => handleLogout(req, store),
      // Per-user lard link: auth-code + PKCE to lard's (shared) authorization server.
      "/lard/connect": (req: Request) => handleLardConnect(req, store),
      "/lard/callback": (req: Request) => handleLardCallback(req, store),
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
