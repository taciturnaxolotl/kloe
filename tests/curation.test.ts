import { test, expect, beforeEach, afterAll } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store";
import { apiRoutes } from "../src/http";
import { ProviderRegistry } from "../src/providers";
import { setRegistry } from "../src/inference";
import { Catalog } from "../src/catalog";

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
  const server = Bun.serve({ port: 0, routes: apiRoutes({ store }) });
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
  fetch(`${base}/api/models`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(bodyObj),
  });

beforeEach(() => {
  setRegistry(fixtureRegistry());
});

test("GET /api/models returns all models hidden by default (opt-in)", async () => {
  const { base } = freshApp();
  const body = await json(await fetch(`${base}/api/models`));
  const refs = body.models.map((m: any) => m.ref);
  expect(refs).toContain("acme/acme-1");
  expect(refs).toContain("echo");
  expect(body.models.every((m: any) => m.visible === false)).toBe(true);
});

test("GET /api/models/chat is empty until a model is made visible", async () => {
  const { base } = freshApp();
  const body = await json(await fetch(`${base}/api/models/chat`));
  expect(body.models).toEqual([]);
});

test("PATCH /api/models makes a model visible and renames it; chat reflects it", async () => {
  const { base } = freshApp();

  const patched = await json(
    await patchModels(base, { ref: "acme/acme-1", visible: true, displayName: "Acme (fast)" }),
  );
  expect(patched).toMatchObject({
    ref: "acme/acme-1",
    visible: true,
    displayName: "Acme (fast)",
  });

  const chat = await json(await fetch(`${base}/api/models/chat`));
  expect(chat.models).toHaveLength(1);
  expect(chat.models[0]).toMatchObject({
    ref: "acme/acme-1",
    name: "Acme (fast)", // displayName override applied
    contextWindow: 8000,
  });
});

test("PATCH is partial: a second patch keeps prior fields", async () => {
  const { base } = freshApp();
  await patchModels(base, { ref: "acme/acme-1", visible: true, displayName: "Kept" });
  const result = await json(await patchModels(base, { ref: "acme/acme-1", sortOrder: 5 }));
  expect(result).toMatchObject({ visible: true, displayName: "Kept", sortOrder: 5 });
});

test("PATCH displayName:null clears the override", async () => {
  const { base } = freshApp();
  await patchModels(base, { ref: "acme/acme-1", visible: true, displayName: "Temp" });
  const cleared = await json(await patchModels(base, { ref: "acme/acme-1", displayName: null }));
  expect(cleared.displayName).toBeNull();

  const chat = await json(await fetch(`${base}/api/models/chat`));
  expect(chat.models[0].name).toBe("Acme One"); // back to catalog name
});

test("chat models are ordered by sortOrder then name", async () => {
  const { base } = freshApp();
  await patchModels(base, { ref: "acme/acme-1", visible: true, sortOrder: 10 });
  await patchModels(base, { ref: "acme/acme-2", visible: true, sortOrder: 1 });
  const chat = await json(await fetch(`${base}/api/models/chat`));
  expect(chat.models.map((m: any) => m.ref)).toEqual(["acme/acme-2", "acme/acme-1"]);
});

test("PATCH rejects an unknown model ref with 422", async () => {
  const { base } = freshApp();
  const res = await patchModels(base, { ref: "acme/ghost", visible: true });
  expect(res.status).toBe(422);
});

test("curation persists across Store re-open", async () => {
  const tmp = mkdtempSync(join(tmpdir(), "kloe-cur-persist-"));
  tmpDirs.push(tmp);
  const dbPath = join(tmp, "test.db");
  const store1 = new Store(dbPath);
  store1.setModelSetting({
    ref: "acme/acme-1",
    visible: true,
    displayName: "Persisted",
    sortOrder: 3,
  });
  store1.db.close();

  const store2 = new Store(dbPath);
  const got = store2.getModelSetting("acme/acme-1");
  expect(got).toEqual({
    ref: "acme/acme-1",
    visible: true,
    displayName: "Persisted",
    sortOrder: 3,
  });
});
