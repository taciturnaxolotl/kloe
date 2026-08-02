import { test, expect } from "bun:test";
import { mkdtempSync, writeFileSync, existsSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Catalog, loadCatalog } from "../src/catalog";

const RAW = [
  {
    id: "acme",
    name: "Acme",
    type: "openai-compat",
    api_endpoint: "https://acme.test/v1",
    models: [
      {
        id: "acme-1",
        name: "Acme One",
        context_window: 8000,
        cost_per_1m_in: 1,
        cost_per_1m_out: 2,
        can_reason: true,
        reasoning_levels: ["low", "high"],
        supports_attachments: true,
      },
    ],
  },
];

function tmpFile(name: string, contents: string): string {
  const dir = mkdtempSync(join(tmpdir(), "kloe-catalog-"));
  const path = join(dir, name);
  writeFileSync(path, contents);
  return path;
}

function okFetch(body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
}

function failFetch(): typeof fetch {
  return (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
}

test("Catalog.fromRaw parses snake_case into camelCase and indexes models", () => {
  const catalog = Catalog.fromRaw(RAW);
  const model = catalog.getModel("acme", "acme-1");
  expect(model?.contextWindow).toBe(8000);
  expect(model?.costPer1MIn).toBe(1);
  expect(model?.supportsImages).toBe(true);
  expect(catalog.getProvider("acme")?.type).toBe("openai-compat");
});

test("Catalog.fromRaw rejects a non-array payload", () => {
  expect(() => Catalog.fromRaw({ providers: [] })).toThrow(/array of providers/);
});

test("loadCatalog fetches live and writes the disk cache", async () => {
  const cachePath = join(mkdtempSync(join(tmpdir(), "kloe-cache-")), "catwalk.json");
  const catalog = await loadCatalog({
    url: "https://ignored.test",
    cachePath,
    seedPath: "/nonexistent-seed.json",
    fetchImpl: okFetch(RAW),
  });
  expect(catalog.getProvider("acme")).toBeDefined();
  expect(existsSync(cachePath)).toBe(true);
  expect(JSON.parse(readFileSync(cachePath, "utf8"))[0].id).toBe("acme");
});

test("loadCatalog falls back to the disk cache when fetch fails", async () => {
  const cachePath = tmpFile("catwalk.json", JSON.stringify(RAW));
  const catalog = await loadCatalog({
    cachePath,
    seedPath: "/nonexistent-seed.json",
    fetchImpl: failFetch(),
  });
  expect(catalog.getProvider("acme")).toBeDefined();
});

test("loadCatalog falls back to the vendored seed when fetch and cache miss", async () => {
  const seedPath = tmpFile("seed.json", JSON.stringify(RAW));
  const catalog = await loadCatalog({
    cachePath: "/nonexistent-cache.json",
    seedPath,
    fetchImpl: failFetch(),
  });
  expect(catalog.getProvider("acme")).toBeDefined();
});

test("loadCatalog throws when fetch fails and there's no cache or seed", async () => {
  await expect(
    loadCatalog({
      cachePath: "/nonexistent-cache.json",
      seedPath: "/nonexistent-seed.json",
      fetchImpl: failFetch(),
    }),
  ).rejects.toThrow(/catalog unavailable/);
});
