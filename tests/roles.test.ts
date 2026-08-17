import { afterAll, afterEach, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resetAuthCache, roleFor } from "../src/auth";
import { FsBlobStore } from "../src/blobs";
import { Catalog } from "../src/catalog";
import { apiRoutes } from "../src/http";
import { setRegistry } from "../src/inference";
import { ProviderRegistry } from "../src/providers";
import { loadConfig, setConfig } from "../src/settings";
import { Store } from "../src/store";

/**
 * Roles: an owner runs the instance, a guest gets a chat. The tests that matter
 * are the ones about the boundary rather than the picker — the picker is a
 * suggestion, and a guest who names a model directly is the case worth being
 * sure about.
 */

const OWNER = "https://dunkirk.sh/";
const GUEST = "https://someone.else/";

function fixtureRegistry(): ProviderRegistry {
  const catalog = Catalog.fromRaw([
    {
      id: "acme",
      name: "Acme",
      type: "openai-compat",
      api_endpoint: "https://acme.test/v1",
      models: [
        { id: "cheap", name: "Cheap", context_window: 8000 },
        { id: "spendy", name: "Spendy", context_window: 200000 },
      ],
    },
  ]);
  return new ProviderRegistry(catalog, {
    config: { providers: [{ id: "acme", apiKey: "$ACME_KEY" }] },
  });
}

function configure(owners: string[], ownerRole = ""): void {
  const base = loadConfig({ path: "does-not-exist.json", env: {} });
  setConfig({ ...base, auth: { ...base.auth, enabled: true, owners, ownerRole } });
  resetAuthCache();
}

const servers: Array<ReturnType<typeof Bun.serve>> = [];
const tmpDirs: string[] = [];
function freshApp() {
  const tmp = mkdtempSync(join(tmpdir(), "kloe-roles-"));
  tmpDirs.push(tmp);
  const store = new Store(join(tmp, "test.db"));
  const blobs = new FsBlobStore(join(tmp, "blobs"));
  const server = Bun.serve({ port: 0, routes: apiRoutes({ store, blobs }) });
  servers.push(server);
  return { base: server.url.origin, store };
}
afterAll(() => {
  for (const s of servers) s.stop(true);
  for (const d of tmpDirs) rmSync(d, { recursive: true, force: true });
});

/** A session cookie for `sub`, so a request arrives as that person. */
let sid = 0;
function as(store: Store, sub: string, providerRole?: string): { cookie: string } {
  const id = `sid-${sub}-${sid++}`;
  store.createSession(id, sub, {}, Date.now() + 600_000, providerRole);
  return { cookie: `kloe_session=${encodeURIComponent(id)}` };
}

beforeEach(() => {
  setRegistry(fixtureRegistry());
});
afterEach(() => {
  setConfig(null);
  resetAuthCache();
});

test("an instance that names no owners has no guests", () => {
  configure([]);
  // Every instance behaved this way before roles existed; an upgrade must not
  // demote the only user of a single-user deployment.
  expect(roleFor(OWNER)).toBe("owner");
  expect(roleFor(GUEST)).toBe("owner");
  expect(roleFor(undefined)).toBe("owner");
});

test("auth off means there is nobody to be a guest to", () => {
  const base = loadConfig({ path: "does-not-exist.json", env: {} });
  setConfig({ ...base, auth: { ...base.auth, enabled: false, owners: [OWNER] } });
  resetAuthCache();
  expect(roleFor(undefined)).toBe("owner");
});

test("with owners named, everyone else is a guest", () => {
  configure([OWNER]);
  expect(roleFor(OWNER)).toBe("owner");
  expect(roleFor(GUEST)).toBe("guest");
});

test("the chat picker shows a guest only the models marked for guests", async () => {
  configure([OWNER]);
  const { base, store } = freshApp();
  store.setModelSetting({
    ref: "acme/cheap",
    visible: true,
    guestVisible: true,
    displayName: null,
    sortOrder: 0,
  });
  store.setModelSetting({
    ref: "acme/spendy",
    visible: true,
    guestVisible: false,
    displayName: null,
    sortOrder: 1,
  });

  const forOwner = await fetch(`${base}/api/models/chat`, { headers: as(store, OWNER) });
  expect(((await forOwner.json()) as any).models.map((m: any) => m.ref)).toEqual([
    "acme/cheap",
    "acme/spendy",
  ]);

  const forGuest = await fetch(`${base}/api/models/chat`, { headers: as(store, GUEST) });
  expect(((await forGuest.json()) as any).models.map((m: any) => m.ref)).toEqual(["acme/cheap"]);
});

test("a guest naming a model the picker never offered is refused", async () => {
  configure([OWNER]);
  const { base, store } = freshApp();
  store.setModelSetting({
    ref: "acme/spendy",
    visible: true,
    guestVisible: false,
    displayName: null,
    sortOrder: 0,
  });

  const prompt = (sub: string) =>
    fetch(`${base}/api/conversations/c1/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json", ...as(store, sub) },
      body: JSON.stringify({ content: "hi", model: "acme/spendy" }),
    });

  expect((await prompt(GUEST)).status).toBe(403);
  // …and the owner, on the same model, is untouched by the check.
  expect((await prompt(OWNER)).status).toBe(202);
});

test("a guest cannot read or change curation", async () => {
  configure([OWNER]);
  const { base, store } = freshApp();

  expect((await fetch(`${base}/api/models`, { headers: as(store, GUEST) })).status).toBe(403);

  const patch = (sub: string) =>
    fetch(`${base}/api/models`, {
      method: "PATCH",
      headers: { "content-type": "application/json", ...as(store, sub) },
      body: JSON.stringify({ ref: "acme/cheap", visible: true, guestVisible: true }),
    });
  expect((await patch(GUEST)).status).toBe(403);
  expect(store.getModelSetting("acme/cheap")).toBeUndefined();

  expect((await patch(OWNER)).status).toBe(200);
  expect(store.getModelSetting("acme/cheap")?.guestVisible).toBe(true);
});

test("guest visibility survives a round trip through the patch endpoint", async () => {
  configure([OWNER]);
  const { base, store } = freshApp();
  await fetch(`${base}/api/models`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...as(store, OWNER) },
    body: JSON.stringify({ ref: "acme/cheap", visible: true, guestVisible: true }),
  });
  // A later patch that says nothing about guests leaves them alone.
  await fetch(`${base}/api/models`, {
    method: "PATCH",
    headers: { "content-type": "application/json", ...as(store, OWNER) },
    body: JSON.stringify({ ref: "acme/cheap", displayName: "Cheap One" }),
  });
  expect(store.getModelSetting("acme/cheap")).toEqual({
    ref: "acme/cheap",
    visible: true,
    guestVisible: true,
    displayName: "Cheap One",
    sortOrder: 0,
  });
});

// ---- roles from the identity provider --------------------------------------
// indiko assigns a role per app and returns it in the token response, so the
// list of who runs this instance can live where the accounts already do.

test("the provider's role decides, when the deployment says which role means owner", () => {
  configure([], "operator");
  expect(roleFor("https://anyone/", "operator")).toBe("owner");
  expect(roleFor("https://anyone/", "viewer")).toBe("guest");
  // No role assigned upstream is a guest, not an error.
  expect(roleFor("https://anyone/", undefined)).toBe("guest");
});

test("naming the role is enough to bring roles into play", () => {
  // Without `owners`, an earlier version treated everyone as an owner; a
  // deployment that has said which role means owner has plainly opted in.
  configure([], "operator");
  expect(roleFor("https://anyone/", undefined)).toBe("guest");
});

test("the configured owner list outranks whatever the provider says", () => {
  configure([OWNER], "operator");
  // The break-glass: it holds when the role was never assigned, which is the
  // state every pre-registered app starts in.
  expect(roleFor(OWNER, undefined)).toBe("owner");
  expect(roleFor(OWNER, "viewer")).toBe("owner");
  expect(roleFor(GUEST, "operator")).toBe("owner");
  expect(roleFor(GUEST, undefined)).toBe("guest");
});

test("a session carries the role it was signed in with", async () => {
  configure([], "operator");
  const { base, store } = freshApp();
  store.setModelSetting({
    ref: "acme/spendy",
    visible: true,
    guestVisible: false,
    displayName: null,
    sortOrder: 0,
  });

  const me = await (
    await fetch(`${base}/api/me`, { headers: as(store, GUEST, "operator") })
  ).json();
  expect((me as any).role).toBe("owner");

  // …and the same person without the role is held to the guest set.
  const forGuest = await fetch(`${base}/api/models/chat`, {
    headers: as(store, GUEST, "viewer"),
  });
  expect(((await forGuest.json()) as any).models).toEqual([]);
});
