import indexHTML from "./src/client/index.html";
import settingsHTML from "./src/client/settings.html";
import conversationsHTML from "./src/client/conversations.html";
import { Store } from "./src/store";
import { initInference } from "./src/inference";
import { apiRoutes, getActor, evictIdleActors } from "./src/http";
import { JobDriver } from "./src/drive";
import { REAP_INTERVAL_MS } from "./src/config";

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
  const driver = new JobDriver(store, (id) => getActor(id, store));

  setInterval(() => {
    void driver.driveOnce();
  }, 1000);

  // Reaper: re-queue jobs whose lease expired (worker died mid-run) so any
  // process can re-claim them from checkpoint_seq; also evict idle actors.
  setInterval(() => {
    store.reap(Date.now());
    evictIdleActors();
  }, REAP_INTERVAL_MS);

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

  const port = Number(process.env.PORT ?? 3000);
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
      "/settings": settingsHTML,
      "/conversations": conversationsHTML,
      ...staticRoutes,
      ...apiRoutes({ store }),
    },
  });
  console.log(`kloe listening on http://localhost:${port}`);
}
