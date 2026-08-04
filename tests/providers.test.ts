import { test, expect } from "bun:test";
import { ProviderRegistry } from "../src/providers";
import type { ProviderConfig } from "../src/providers";
import { RateLimiter } from "../src/ratelimit";
import { Catalog } from "../src/catalog";

/** A small in-memory catalog fixture (raw catwalk shape). */
function fixtureCatalog(): Catalog {
  return Catalog.fromRaw([
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
    {
      id: "anthropic",
      name: "Anthropic",
      type: "anthropic",
      models: [{ id: "claude-x", name: "Claude X", context_window: 200000 }],
    },
  ]);
}

/** ProviderConfig for RateLimiter tests (only concurrency/interval matter). */
function limiterConfig(over: Partial<ProviderConfig> = {}): ProviderConfig {
  return {
    id: "test",
    apiKey: "$TEST_KEY",
    maxConcurrency: 2,
    minIntervalMs: 0,
    ...over,
  };
}

function registry(): ProviderRegistry {
  return new ProviderRegistry(fixtureCatalog(), {
    config: {
      providers: [
        { id: "acme", apiKey: "$ACME_KEY", maxConcurrency: 2, minIntervalMs: 0 },
        { id: "anthropic", apiKey: "$ANTH_KEY" },
      ],
    },
  });
}

// --- registry: resolution ---

test("registry resolves the built-in echo model", () => {
  const model = registry().resolveModel("echo");
  expect((model as any).provider).toBe("kloe-mock");
});

test("registry resolves echo/variant", () => {
  const model = registry().resolveModel("echo/anything");
  expect((model as any).provider).toBe("kloe-mock");
});

test("registry requires a fully-qualified provider/model ref", () => {
  expect(() => registry().resolveModel("acme")).toThrow(/provider\/model/);
});

test("registry throws when the provider isn't enabled", () => {
  expect(() => registry().resolveModel("openai/gpt-4")).toThrow(/not enabled/);
});

test("registry throws on a model absent from the catalog", () => {
  expect(() => registry().resolveModel("acme/ghost")).toThrow(/unknown model/);
});

test("registry throws when an enabled provider isn't in the catalog", () => {
  expect(
    () =>
      new ProviderRegistry(fixtureCatalog(), {
        config: { providers: [{ id: "ghost", apiKey: "$X" }] },
      }),
  ).toThrow(/not in the catalog/);
});

// --- registry: inline (non-catalog) providers ---

/** A provider the catalog doesn't know, declared entirely in the ops file. */
function inlineConfig(over: Record<string, unknown> = {}) {
  return {
    id: "hyper",
    apiKey: "$HYPER_KEY",
    apiEndpoint: "https://hyper.test/v1",
    models: [
      { id: "hyper-1", name: "Hyper One", context_window: 32000 },
    ],
    ...over,
  };
}

test("inline provider: model list and resolution come from the ops file", () => {
  process.env.HYPER_KEY = "sk-hyper";
  const reg = new ProviderRegistry(fixtureCatalog(), {
    config: { providers: [inlineConfig()] },
  });
  const refs = reg.listModels().map((m) => m.ref);
  expect(refs).toContain("hyper/hyper-1");
  expect(reg.resolveModel("hyper/hyper-1")).toBeDefined();
});

test("inline provider: metadata defaults fill in like the catalog does", () => {
  const reg = new ProviderRegistry(fixtureCatalog(), {
    config: { providers: [inlineConfig()] },
  });
  const m = reg.listModels().find((x) => x.ref === "hyper/hyper-1")!;
  expect(m.contextWindow).toBe(32000);
  expect(m.costPer1MIn).toBe(0);
  expect(m.reasoningLevels).toEqual([]);
});

test("inline provider: unknown model still throws", () => {
  const reg = new ProviderRegistry(fixtureCatalog(), {
    config: { providers: [inlineConfig()] },
  });
  expect(() => reg.resolveModel("hyper/ghost")).toThrow(/unknown model/);
});

test("inline provider: missing apiEndpoint fails at construction", () => {
  const noEndpoint = inlineConfig({ apiEndpoint: undefined });
  const noEndpointNoModels = inlineConfig({ apiEndpoint: undefined, models: [] });
  expect(
    () => new ProviderRegistry(fixtureCatalog(), { config: { providers: [noEndpoint] } }),
  ).toThrow(/apiEndpoint/);
  expect(
    () =>
      new ProviderRegistry(fixtureCatalog(), {
        config: { providers: [noEndpointNoModels] },
      }),
  ).toThrow(/apiEndpoint/);
});

test("inline provider: requires its API key at resolve time", () => {
  delete process.env.HYPER_KEY;
  const reg = new ProviderRegistry(fixtureCatalog(), {
    config: { providers: [inlineConfig()] },
  });
  expect(() => reg.resolveModel("hyper/hyper-1")).toThrow(/API key/);
});

test("resolveModel requires the provider's API key env var", () => {
  delete process.env.ACME_KEY;
  expect(() => registry().resolveModel("acme/acme-1")).toThrow(/API key/);
});

test("a provider that declares NO apiKey resolves keyless", () => {
  // No apiKey field at all → intentional keyless (local endpoint), not a
  // misconfig; the adapter is built without a credential.
  const keyless = inlineConfig();
  delete (keyless as { apiKey?: string }).apiKey;
  const reg = new ProviderRegistry(fixtureCatalog(), {
    config: { providers: [keyless] },
  });
  expect(reg.resolveModel("hyper/hyper-1")).toBeDefined();
});

test("resolveModel builds an adapter when the key is present", () => {
  process.env.ACME_KEY = "sk-test";
  process.env.ANTH_KEY = "sk-anthropic";
  const reg = registry();
  expect(reg.resolveModel("acme/acme-1")).toBeDefined();
  expect(reg.resolveModel("anthropic/claude-x")).toBeDefined();
});

test("credentials are re-resolved per call, not cached forever", () => {
  process.env.ACME_KEY = "sk-first";
  const reg = registry();
  expect(reg.resolveModel("acme/acme-1")).toBeDefined();
  // Rotate the secret away: a subsequent resolve must re-read the env and fail,
  // proving the factory cache doesn't serve a stale/invalid credential blindly.
  delete process.env.ACME_KEY;
  expect(() => reg.resolveModel("acme/acme-1")).toThrow(/API key/);
});

// --- registry: introspection ---

test("listModels includes echo plus every enabled provider's models", () => {
  const models = registry().listModels();
  const refs = models.map((m) => m.ref);
  expect(refs).toContain("echo");
  expect(refs).toContain("acme/acme-1");
  expect(refs).toContain("anthropic/claude-x");
});

test("listModels carries catalog metadata for the UI", () => {
  const acme = registry()
    .listModels()
    .find((m) => m.ref === "acme/acme-1")!;
  expect(acme.contextWindow).toBe(8000);
  expect(acme.costPer1MIn).toBe(1);
  expect(acme.reasoningLevels).toEqual(["low", "high"]);
  expect(acme.supportsImages).toBe(true);
});

test("getConfig returns ops config for enabled providers only", () => {
  const reg = registry();
  expect(reg.getConfig("acme")?.maxConcurrency).toBe(2);
  expect(reg.getConfig("echo")).toBeUndefined();
});

// --- rate limiter ---

test("rate limiter enforces concurrency", async () => {
  const limiter = new RateLimiter(limiterConfig({ maxConcurrency: 2 }));
  let active = 0;
  let maxActive = 0;
  const task = async () => {
    await limiter.acquire();
    active++;
    maxActive = Math.max(maxActive, active);
    await Bun.sleep(10);
    active--;
    limiter.release();
  };
  await Promise.all([task(), task(), task(), task(), task()]);
  expect(maxActive).toBeLessThanOrEqual(2);
});

test("rate limiter never over-admits when a release and a fresh acquire race", async () => {
  // Regression: a woken waiter must not re-increment `active` while a fresh
  // synchronous acquire() slips into the microtask gap after release(). With
  // maxConcurrency=1 the count must never exceed 1 no matter the interleaving.
  const limiter = new RateLimiter(limiterConfig({ maxConcurrency: 1 }));
  let active = 0;
  let maxActive = 0;

  await limiter.acquire();
  active++;
  maxActive = Math.max(maxActive, active);

  const critical = async () => {
    await limiter.acquire();
    active++;
    maxActive = Math.max(maxActive, active);
    await Bun.sleep(20);
    active--;
    limiter.release();
  };

  const waiter = critical();
  active--;
  limiter.release(); // hands permit to `waiter`
  const intruder = critical();

  await Promise.all([waiter, intruder]);
  expect(maxActive).toBe(1);
});

test("rate limiter enforces min interval", async () => {
  const limiter = new RateLimiter(
    limiterConfig({ maxConcurrency: 10, minIntervalMs: 50 }),
  );
  const times: number[] = [];
  const task = async () => {
    await limiter.acquire();
    times.push(Date.now());
    limiter.release();
  };
  await task();
  await task();
  await task();
  for (let i = 1; i < times.length; i++) {
    expect(times[i]! - times[i - 1]!).toBeGreaterThanOrEqual(45);
  }
});

test("rate limiter backs off on 429", () => {
  const limiter = new RateLimiter(limiterConfig({ minIntervalMs: 10 }));
  const limiterAny = limiter as any;
  expect(limiterAny.minIntervalMs).toBe(10);
  limiter.onRateLimit();
  expect(limiterAny.minIntervalMs).toBeGreaterThan(10);
  const afterFirst = limiterAny.minIntervalMs;
  limiter.onRateLimit();
  expect(limiterAny.minIntervalMs).toBeGreaterThan(afterFirst);
});

/** Minimal streaming model whose doStream yields the given chunks then closes. */
function fakeStreamingModel(chunks: unknown[]): any {
  return {
    doStream: async () => ({
      stream: new ReadableStream({
        start(c) {
          for (const ch of chunks) c.enqueue(ch);
          c.close();
        },
      }),
    }),
  };
}

test("wrap releases the permit after the stream is fully drained", async () => {
  const limiter = new RateLimiter(limiterConfig({ maxConcurrency: 1 }));
  const wrapped = limiter.wrap(fakeStreamingModel(["a", "b"])) as any;
  const { stream } = await wrapped.doStream();
  expect((limiter as any).active).toBe(1); // permit held during streaming
  const reader = stream.getReader();
  while (!(await reader.read()).done) {
    /* drain */
  }
  expect((limiter as any).active).toBe(0); // released on completion
});

test("wrap releases the permit when the stream is cancelled early", async () => {
  const limiter = new RateLimiter(limiterConfig({ maxConcurrency: 1 }));
  const wrapped = limiter.wrap(fakeStreamingModel(["a", "b", "c"])) as any;
  const { stream } = await wrapped.doStream();
  const reader = stream.getReader();
  await reader.read();
  await reader.cancel();
  expect((limiter as any).active).toBe(0);
});

test("echo model rejects doGenerate (stream-only)", async () => {
  process.env.ACME_KEY = "sk-test";
  const model = registry().resolveModel("echo") as any;
  await expect(model.doGenerate()).rejects.toThrow(/stream-only/);
});
