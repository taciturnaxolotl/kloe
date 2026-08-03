import indexHTML from "./src/client/index.html";
import settingsHTML from "./src/client/settings.html";
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
      ...apiRoutes({ store }),
    },
  });
  console.log(`kloe listening on http://localhost:${port}`);
}
