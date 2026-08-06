import { ConversationActor } from "./src/actor";
import { createBlobStore } from "./src/blobs";
import { REAP_INTERVAL_MS } from "./src/config";
import { JobDriver } from "./src/drive";
import { initInference } from "./src/inference";
import { Store } from "./src/store";

/**
 * Standalone worker process: claim → run → heartbeat → checkpoint → done, via
 * the shared JobDriver (same code the server's inline loop runs). Run with
 * `bun worker.ts` alongside the server for crash isolation (a crash in either
 * tier doesn't take the other down). Both processes may poll the same job
 * table; the SQL claim is atomic and single-writer per conversation.
 */
if (import.meta.main) {
  // Build the provider registry (catalog + ops config) before claiming work.
  await initInference();

  const store = new Store();
  const blobs = createBlobStore();
  // One actor per claimed conversation. Each job is fully executed before the
  // next is claimed, so a plain map keyed by conversation is sufficient.
  const actors = new Map<string, ConversationActor>();
  const driver = new JobDriver(
    store,
    (id) => {
      let a = actors.get(id);
      if (!a) {
        a = new ConversationActor(id, store);
        actors.set(id, a);
      }
      return a;
    },
    blobs,
  );

  // Reclaim any jobs whose lease expired while we were down, then poll.
  store.reap(Date.now());
  setInterval(() => {
    store.reap(Date.now());
  }, REAP_INTERVAL_MS);
  setInterval(() => {
    void driver.driveOnce();
  }, 1000);

  console.log("kloe worker started");
}
