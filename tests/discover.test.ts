import { expect, test } from "bun:test";
import { Catalog } from "../src/catalog";
import { discoverModels, enrichModels } from "../src/discover";
import { ProviderRegistry } from "../src/providers";

/** One model in hyper.charm.land's extended OpenAI listing shape. */
const HYPER_LISTING = {
  object: "list",
  data: [
    {
      id: "deepseek-v4-pro",
      object: "model",
      display_name: "DeepSeek-V4-Pro",
      context_window: 1000000,
      max_output_tokens: 384000,
      capabilities: { vision: false },
      reasoning: {
        effort_levels: [
          { value: "high", display: "High" },
          { value: "low", display: "Low" },
        ],
        default_effort_level: "high",
      },
      pricing: { input: 2.4, output: 4.8, cache_create: 0, cache_hit: 0.2 },
    },
    { id: "bare-model", object: "model" },
  ],
};

/** fetch mock serving the listing for every URL it's asked for. */
function listingFetch(body: unknown): typeof fetch {
  return (async () =>
    new Response(JSON.stringify(body), { status: 200 })) as unknown as typeof fetch;
}

const cfg = {
  id: "hyper",
  baseUrl: "https://hyper.charm.land/v1",
};

// --- generic discovery ---

test("discoverModels parses the OpenAI {data:[...]} listing", async () => {
  const { models, raw } = await discoverModels({
    ...cfg,
    fetchImpl: listingFetch(HYPER_LISTING),
  });
  expect(models.map((m) => m.id)).toEqual(["deepseek-v4-pro", "bare-model"]);
  // Only id/name are populated here; metadata is enrichment's job.
  expect(models[0]!.contextWindow).toBe(0);
  // The raw payload comes along for enrichers.
  expect(raw).toEqual(HYPER_LISTING);
});

test("discoverModels fails soft on network error or bad shape", async () => {
  const down = (async () => {
    throw new Error("network down");
  }) as unknown as typeof fetch;
  expect((await discoverModels({ ...cfg, fetchImpl: down })).models).toEqual([]);
  expect(
    (await discoverModels({ ...cfg, fetchImpl: listingFetch({ nope: true }) })).models,
  ).toEqual([]);
});

// --- hyper enricher ---

test("hyper enricher backfills metadata from the listing payload", async () => {
  const { models, raw } = await discoverModels({
    ...cfg,
    fetchImpl: listingFetch(HYPER_LISTING),
  });
  const enriched = await enrichModels("hyper", cfg, models, raw);
  const m = enriched.find((x) => x.id === "deepseek-v4-pro")!;
  expect(m.name).toBe("DeepSeek-V4-Pro");
  expect(m.contextWindow).toBe(1000000);
  expect(m.defaultMaxTokens).toBe(384000);
  expect(m.costPer1MIn).toBe(2.4);
  expect(m.costPer1MOut).toBe(4.8);
  expect(m.costPer1MInCached).toBe(0.2);
  expect(m.canReason).toBe(true);
  expect(m.reasoningLevels).toEqual(["high", "low"]);
  expect(m.defaultReasoningEffort).toBe("high");
  expect(m.supportsImages).toBe(false);
});

test("hyper enricher never overwrites operator-set fields", async () => {
  const preset = [
    {
      id: "deepseek-v4-pro",
      name: "My Name",
      contextWindow: 42,
      defaultMaxTokens: 0,
      costPer1MIn: 9,
      costPer1MOut: 0,
      costPer1MInCached: 0,
      costPer1MOutCached: 0,
      canReason: false,
      reasoningLevels: ["custom"],
      supportsImages: false,
    },
  ];
  const enriched = await enrichModels("hyper", cfg, preset, HYPER_LISTING);
  const m = enriched[0]!;
  expect(m.name).toBe("My Name");
  expect(m.contextWindow).toBe(42);
  expect(m.costPer1MIn).toBe(9);
  expect(m.reasoningLevels).toEqual(["custom"]);
  // Zero fields still get filled in.
  expect(m.costPer1MOut).toBe(4.8);
});

test("enrichModels passes models through for unknown types", async () => {
  const models = [{ id: "x" }] as any;
  expect(await enrichModels("nope", cfg, models, null)).toBe(models);
});

test("hyper enricher fails soft on a missing or malformed payload", async () => {
  const { models } = await discoverModels({
    ...cfg,
    fetchImpl: listingFetch(HYPER_LISTING),
  });
  // No listing payload: input comes back un-enriched, not thrown.
  expect(await enrichModels("hyper", cfg, models, null)).toEqual(models);
  expect(await enrichModels("hyper", cfg, models, { data: "junk" })).toEqual(models);
});

// --- registry integration ---

test("registry discovers models for a typed non-catalog provider", async () => {
  process.env.HYPER_KEY = "sk-hyper-test";
  const reg = new ProviderRegistry(Catalog.fromRaw([]), {
    config: {
      providers: [
        {
          id: "hyper",
          apiKey: "$HYPER_KEY",
          apiEndpoint: "https://hyper.charm.land/v1",
          type: "hyper",
        },
      ],
    },
    fetchImpl: listingFetch(HYPER_LISTING),
  });
  // Before discovery: enabled but model-less.
  expect(reg.listModels().map((m) => m.ref)).toEqual(["echo"]);
  await reg.discover();
  const refs = reg.listModels().map((m) => m.ref);
  expect(refs).toContain("hyper/deepseek-v4-pro");
  expect(reg.resolveModel("hyper/deepseek-v4-pro")).toBeDefined();
  const info = reg.listModels().find((m) => m.ref === "hyper/deepseek-v4-pro")!;
  expect(info.contextWindow).toBe(1000000);
});

test("registry discovery appends after explicit inline models when forced", async () => {
  const reg = new ProviderRegistry(Catalog.fromRaw([]), {
    config: {
      providers: [
        {
          id: "hyper",
          apiKey: "$K",
          apiEndpoint: "https://hyper.charm.land/v1",
          type: "hyper",
          discoverModels: true,
          models: [{ id: "deepseek-v4-pro", name: "Mine", context_window: 1 }],
        },
      ],
    },
    fetchImpl: listingFetch(HYPER_LISTING),
  });
  await reg.discover();
  const refs = reg.listModels().map((m) => m.ref);
  // Inline entry wins over the discovered duplicate; the rest is appended.
  expect(refs).toEqual(["echo", "hyper/deepseek-v4-pro", "hyper/bare-model"]);
  const m = reg.listModels().find((x) => x.ref === "hyper/deepseek-v4-pro")!;
  expect(m.name).toBe("Mine");
  expect(m.contextWindow).toBe(1);
});

test("registry skips discovery when inline models are given", async () => {
  let fetched = 0;
  const reg = new ProviderRegistry(Catalog.fromRaw([]), {
    config: {
      providers: [
        {
          id: "hyper",
          apiKey: "$K",
          apiEndpoint: "https://hyper.charm.land/v1",
          type: "hyper",
          models: [{ id: "just-this", name: "Just This" }],
        },
      ],
    },
    fetchImpl: (async () => {
      fetched++;
      return new Response("{}", { status: 200 });
    }) as unknown as typeof fetch,
  });
  await reg.discover();
  expect(fetched).toBe(0);
  expect(reg.listModels().map((m) => m.ref)).toEqual(["echo", "hyper/just-this"]);
});

test("registry stays up when discovery yields nothing", async () => {
  const reg = new ProviderRegistry(Catalog.fromRaw([]), {
    config: {
      providers: [
        {
          id: "hyper",
          apiKey: "$K",
          apiEndpoint: "https://hyper.charm.land/v1",
          type: "hyper",
        },
      ],
    },
    fetchImpl: (async () => {
      throw new Error("offline");
    }) as unknown as typeof fetch,
  });
  await reg.discover();
  expect(reg.listModels()).toHaveLength(1); // echo only
  expect(() => reg.resolveModel("hyper/anything")).toThrow(/unknown model/);
});
