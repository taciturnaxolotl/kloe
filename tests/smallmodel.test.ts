import { afterEach, expect, test } from "bun:test";
import { Catalog } from "../src/catalog";
import { resolveRoleModel, resolveVisionModel, setRegistry } from "../src/inference";
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
function configureVisionModel(visionModel: string): void {
  const base = loadConfig({ path: "/nonexistent", env: {} });
  setConfig({ ...base, agent: { ...base.agent, visionModel } });
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
        // Two that can actually see, one dearer than the other.
        {
          id: "eyes",
          name: "Eyes",
          context_window: 8000,
          cost_per_1m_in: 5,
          cost_per_1m_out: 15,
          supports_attachments: true,
        },
        {
          id: "cheap-eyes",
          name: "Cheap Eyes",
          context_window: 8000,
          cost_per_1m_in: 2,
          cost_per_1m_out: 4,
          supports_attachments: true,
        },
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
    store.setModelSetting({
      ref,
      visible: true,
      allowedRoles: [],
      sortOrder: 0,
      displayName: null,
    });
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

// ---- the image reader ------------------------------------------------------
// Same selection shape as the small model, with one extra requirement that is
// the whole point: it has to be able to see.

test("the vision model is the cheapest ENABLED model that accepts images", () => {
  setRegistry(registry());
  expect(resolveVisionModel(storeWith("acme/big", "acme/eyes", "acme/cheap-eyes"))).toBe(
    "acme/cheap-eyes",
  );
  // Cheaper models that can't see are not candidates, however cheap.
  expect(resolveVisionModel(storeWith("acme/small", "acme/eyes"))).toBe("acme/eyes");
});

test("with no image-capable model enabled there is no reader", () => {
  setRegistry(registry());
  // `read_image` is then simply not offered — better than offered and broken.
  expect(resolveVisionModel(storeWith("acme/big", "acme/small"))).toBeNull();
  expect(resolveVisionModel(storeWith())).toBeNull();
});

test("a configured vision model wins, and a stale one falls back", () => {
  setRegistry(registry());
  configureVisionModel("acme/eyes");
  expect(resolveVisionModel(storeWith("acme/eyes", "acme/cheap-eyes"))).toBe("acme/eyes");

  // Configured but not enabled: fall back rather than return a ref nothing can
  // resolve.
  configureVisionModel("acme/ghost");
  expect(resolveVisionModel(storeWith("acme/eyes", "acme/cheap-eyes"))).toBe("acme/cheap-eyes");
});

// ---- research roles --------------------------------------------------------
// Which model does which job in a research run: a click in settings beats a
// line in kloe.json, and both are ignored when they name a disabled model.

test("a role prefers the clicked choice, then the config, then nothing", () => {
  setRegistry(registry());
  const store = storeWith("acme/big", "acme/small");

  // Nothing set: the run uses whatever the conversation is using.
  expect(resolveRoleModel(store, "lead")).toBeNull();

  const base = loadConfig({ path: "/nonexistent", env: {} });
  setConfig({ ...base, research: { ...base.research, leadModel: "acme/big" } });
  expect(resolveRoleModel(store, "lead")).toBe("acme/big");

  // A choice made by clicking wins over the file, which the clicker may not be
  // able to edit.
  store.setPref("research.leadModel", "acme/small");
  expect(resolveRoleModel(store, "lead")).toBe("acme/small");

  // …and a model that has since been turned off is ignored, not honoured.
  store.setPref("research.leadModel", "acme/mystery");
  expect(resolveRoleModel(store, "lead")).toBe("acme/big"); // falls back to config
});

test("the two roles are independent", () => {
  setRegistry(registry());
  const store = storeWith("acme/big", "acme/small");
  store.setPref("research.leadModel", "acme/big");
  store.setPref("research.workerModel", "acme/small");
  expect(resolveRoleModel(store, "lead")).toBe("acme/big");
  expect(resolveRoleModel(store, "worker")).toBe("acme/small");
});
