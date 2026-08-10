import { afterEach, expect, test } from "bun:test";
import { Catalog } from "../src/catalog";
import { setRegistry } from "../src/inference";
import { ProviderRegistry } from "../src/providers";
import { loadConfig, setConfig } from "../src/settings";
import { Store } from "../src/store";
import { resolveSmallModel } from "../src/title";

afterEach(() => setConfig(null));

/** Schema defaults, with `agent.smallModel` pinned. */
function configureSmallModel(smallModel: string): void {
  const base = loadConfig({ path: "/nonexistent", env: {} });
  setConfig({ ...base, agent: { ...base.agent, smallModel } });
}

/** Two real models at different prices, alongside the built-in echo mock. */
function registry(): ProviderRegistry {
  const catalog = Catalog.fromRaw([
    {
      id: "acme",
      name: "Acme",
      type: "openai-compat",
      api_endpoint: "https://acme.test/v1",
      models: [
        {
          id: "big",
          name: "Big",
          context_window: 8000,
          cost_per_1m_in: 10,
          cost_per_1m_out: 30,
        },
        {
          id: "small",
          name: "Small",
          context_window: 8000,
          cost_per_1m_in: 1,
          cost_per_1m_out: 2,
        },
        // Nothing known about it: the catalog coerces absent pricing to zero,
        // so on cost alone it beats every real model.
        { id: "mystery", name: "Mystery" },
      ],
    },
  ]);
  return new ProviderRegistry(catalog, {
    config: { providers: [{ id: "acme", apiKey: "$ACME_KEY" }] },
  });
}

function storeWith(...visible: string[]): Store {
  const store = new Store(":memory:");
  for (const ref of visible)
    store.setModelSetting({ ref, visible: true, sortOrder: 0, displayName: null });
  return store;
}

test("the echo mock never wins the cheapest-model contest", () => {
  // It costs nothing, so it beat every real model outright — and it's
  // stream-only, so every title then failed on doGenerate.
  setRegistry(registry());
  expect(resolveSmallModel(storeWith("echo", "acme/big", "acme/small"))).toBe("acme/small");
});

test("with only the mock enabled there is no small model", () => {
  setRegistry(registry());
  expect(resolveSmallModel(storeWith("echo"))).toBeNull();
});

test("a model with no metadata does not win on its zero price", () => {
  setRegistry(registry());
  expect(resolveSmallModel(storeWith("acme/mystery", "acme/small"))).toBe("acme/small");
  expect(resolveSmallModel(storeWith("acme/mystery"))).toBeNull();
});

test("an explicitly configured small model is honored", () => {
  setRegistry(registry());
  configureSmallModel("acme/big");
  expect(resolveSmallModel(storeWith("echo", "acme/big", "acme/small"))).toBe("acme/big");
});

test("a configured model that is not enabled falls back to the cheapest real one", () => {
  setRegistry(registry());
  configureSmallModel("acme/gone");
  expect(resolveSmallModel(storeWith("echo", "acme/big", "acme/small"))).toBe("acme/small");
});
