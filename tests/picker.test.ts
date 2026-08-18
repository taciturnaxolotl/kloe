import { Database } from "bun:sqlite";
import { afterAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsBlobStore } from "../src/blobs";
import { Catalog } from "../src/catalog";
import { apiRoutes } from "../src/http";
import { setRegistry } from "../src/inference";
import { ProviderRegistry } from "../src/providers";
import { Store } from "../src/store";

function fixtureRegistry(): ProviderRegistry {
  const catalog = Catalog.fromRaw([
    {
      id: "acme",
      name: "Acme",
      type: "openai-compat",
      api_endpoint: "https://acme.test/v1",
      models: [
        { id: "acme-1", name: "Acme One", context_window: 8000 },
        { id: "acme-2", name: "Acme Two", context_window: 4000 },
      ],
    },
  ]);
  return new ProviderRegistry(catalog, {
    config: { providers: [{ id: "acme", apiKey: "$ACME_KEY" }] },
  });
}

// Each test gets a fresh store behind a real ephemeral-port server.
const servers: Array<ReturnType<typeof Bun.serve>> = [];
const tmpDirs: string[] = [];
function freshApp() {
  const tmp = mkdtempSync(join(tmpdir(), "kloe-cur-"));
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

async function json(res: Response): Promise<any> {
  return JSON.parse(await res.text());
}

const patchModels = (base: string, bodyObj: unknown) =>
  fetch(`${base}/api/models/mine`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(bodyObj),
  });

beforeEach(() => {
  setRegistry(fixtureRegistry());
});

test("everything you could pick from is listed, and nothing is in your picker yet", async () => {
  const { base } = freshApp();
  const body = await json(await fetch(`${base}/api/models/mine`));
  const refs = body.models.map((m: any) => m.ref);
  expect(refs).toContain("acme/acme-1");
  expect(refs).toContain("echo");
  // Opt-in: "every model this instance can reach" is not a dropdown.
  expect(body.models.every((m: any) => m.enabled === false)).toBe(true);
});

test("the chat picker is empty until you put something in it", async () => {
  const { base } = freshApp();
  const body = await json(await fetch(`${base}/api/models/chat`));
  expect(body.models).toEqual([]);
});

test("turning a model on puts it in the picker, renamed if you like", async () => {
  const { base } = freshApp();
  await patchModels(base, { ref: "acme/acme-1", enabled: true });
  await patchModels(base, { ref: "acme/acme-1", displayName: "Workhorse" });

  const body = await json(await fetch(`${base}/api/models/chat`));
  expect(body.models).toEqual([
    {
      ref: "acme/acme-1",
      name: "Workhorse",
      contextWindow: 8000,
      reasoningLevels: [],
      supportsImages: false,
      sortOrder: 0,
      yours: false,
    },
  ]);
});

test("a patch is partial: an order does not restate a name", async () => {
  const { base } = freshApp();
  await patchModels(base, { ref: "acme/acme-1", enabled: true, displayName: "Kept" });
  await patchModels(base, { ref: "acme/acme-1", sortOrder: 5 });
  const body = await json(await fetch(`${base}/api/models/mine`));
  const row = body.models.find((m: any) => m.ref === "acme/acme-1");
  expect(row).toMatchObject({ enabled: true, displayName: "Kept", sortOrder: 5 });
});

test("displayName:null goes back to the model's own name", async () => {
  const { base } = freshApp();
  await patchModels(base, { ref: "acme/acme-1", enabled: true, displayName: "Temp" });
  await patchModels(base, { ref: "acme/acme-1", displayName: null });
  const body = await json(await fetch(`${base}/api/models/chat`));
  expect(body.models[0].name).toBe("Acme One");
});

test("the picker is in your order, then by name", async () => {
  const { base } = freshApp();
  await patchModels(base, { ref: "acme/acme-2", enabled: true, sortOrder: 1 });
  await patchModels(base, { ref: "acme/acme-1", enabled: true, sortOrder: 2 });
  const body = await json(await fetch(`${base}/api/models/chat`));
  expect(body.models.map((m: any) => m.ref)).toEqual(["acme/acme-2", "acme/acme-1"]);
});

test("a model this instance cannot run is refused", async () => {
  const { base } = freshApp();
  const res = await patchModels(base, { ref: "acme/ghost", enabled: true });
  expect(res.status).toBe(403);
});

test("taking a model out leaves the rest of your arrangement alone", async () => {
  const { base } = freshApp();
  await patchModels(base, { ref: "acme/acme-1", enabled: true, displayName: "One" });
  await patchModels(base, { ref: "acme/acme-2", enabled: true, displayName: "Two" });
  await patchModels(base, { ref: "acme/acme-2", enabled: false });

  const body = await json(await fetch(`${base}/api/models/chat`));
  expect(body.models.map((m: any) => m.name)).toEqual(["One"]);
});

test("your picker survives a restart", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "kloe-picker-"));
  tmpDirs.push(tmp);
  const dbPath = join(tmp, "test.db");

  new Store(dbPath).setUserModel("local", "acme/acme-1", {
    enabled: true,
    displayName: "Persisted",
  });

  // A second Store over the same file is what a restart looks like from here.
  expect(new Store(dbPath).listUserModels("local")).toEqual([
    { ref: "acme/acme-1", displayName: "Persisted", sortOrder: 0 },
  ]);
});

test("a database from before the picker grew columns still opens", () => {
  const tmp = mkdtempSync(join(tmpdir(), "kloe-migrate-"));
  tmpDirs.push(tmp);
  const dbPath = join(tmp, "old.db");

  // The shape user_models had when it was a bare list of refs. CREATE TABLE IF
  // NOT EXISTS leaves an existing table exactly as it found it, so a schema
  // that grew columns only reaches an old database through a migration — and
  // forgetting one is a 500 on the first request, not a failing test.
  const old = new Database(dbPath);
  old.exec(
    `CREATE TABLE user_models (
       sub TEXT NOT NULL, model_ref TEXT NOT NULL, updated_at INTEGER NOT NULL,
       PRIMARY KEY (sub, model_ref)
     )`,
  );
  old.exec(
    "INSERT INTO user_models (sub, model_ref, updated_at) VALUES ('local', 'acme/acme-1', 1)",
  );
  old.close();

  const store = new Store(dbPath);
  expect(store.listUserModels("local")).toEqual([
    { ref: "acme/acme-1", displayName: null, sortOrder: 0 },
  ]);
  // …and it can be written to afterwards.
  store.setUserModel("local", "acme/acme-1", { enabled: true, displayName: "Renamed" });
  expect(store.listUserModels("local")[0]?.displayName).toBe("Renamed");
});
