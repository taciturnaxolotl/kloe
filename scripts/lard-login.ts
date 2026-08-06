/*
 * Connect kloe to a lard memory server via the OAuth device grant, storing the
 * token under a kloe user `sub` (default "local" — the implicit user when kloe
 * auth is disabled). With kloe auth on, users connect from the settings page;
 * this CLI covers the single-user/operator case and headless boxes.
 *
 *   bun run lard-login [--sub <sub>]
 */

import { deviceLogin, LOCAL_SUB, lardEnabled } from "../src/lard";
import { Store } from "../src/store";

const args = process.argv.slice(2);
const i = args.indexOf("--sub");
const sub = i >= 0 ? args[i + 1] : LOCAL_SUB;
if (!sub) {
  console.error("--sub needs a value");
  process.exit(1);
}

if (!lardEnabled()) {
  console.error("lard is not enabled — set lard.enabled and lard.baseUrl in kloe.json first.");
  process.exit(1);
}

const store = new Store();
try {
  const tok = await deviceLogin((d) => {
    const url = d.verificationUriComplete || d.verificationUri;
    console.log(`\n  Connect kloe to lard:\n\n    open   ${url}`);
    if (!d.verificationUriComplete) console.log(`    code   ${d.userCode}`);
    console.log("\n  Waiting for approval…\n");
  });
  store.setLardToken(sub, tok);
  console.log(`✓ lard connected for "${sub}".`);
  process.exit(0);
} catch (e) {
  console.error(`✗ ${(e as Error).message}`);
  process.exit(1);
}
