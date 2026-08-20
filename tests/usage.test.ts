import { afterEach, expect, test } from "bun:test";
import type { LanguageModel } from "ai";
import { Catalog } from "../src/catalog";
import { setRegistry } from "../src/inference";
import { ProviderRegistry } from "../src/providers";
import { loadConfig, rolePolicy, setConfig } from "../src/settings";
import { Store } from "../src/store";
import { budgetStatus, costOf, DAY_MS, metered } from "../src/usage";

/**
 * The ledger and the budget it feeds.
 *
 * The thing worth testing hardest is the boundary between payers: a budget that
 * counted someone's own connected account would stop them spending their own
 * money, which is the opposite of the point.
 */

const SUB = "https://guest.test/";

// This file turns auth on and installs a fixture registry; both are global, so
// they go back the way they were found or the next file inherits them.
afterEach(() => {
  setConfig(null);
});

function registry(): void {
  const catalog = Catalog.fromRaw([
    {
      id: "acme",
      name: "Acme",
      type: "openai-compat",
      api_endpoint: "https://acme.test/v1",
      models: [
        {
          id: "cheap",
          name: "Cheap",
          context_window: 8000,
          cost_per_1m_in: 2,
          cost_per_1m_out: 10,
        },
        { id: "free", name: "Free", context_window: 8000 },
      ],
    },
  ]);
  setRegistry(
    new ProviderRegistry(catalog, { config: { providers: [{ id: "acme", apiKey: "$ACME_KEY" }] } }),
  );
}

function configure(policies: Record<string, ReturnType<typeof rolePolicy>>): void {
  const base = loadConfig({ path: "does-not-exist.json", env: {} });
  setConfig({
    ...base,
    auth: { ...base.auth, enabled: true, issuer: "https://idp.test", roles: policies },
  });
}

/** A model that reports the usage it was told to, over both call shapes. */
function stubModel(inputTokens: number, outputTokens: number): LanguageModel {
  const usage = { inputTokens, outputTokens, totalTokens: inputTokens + outputTokens };
  return {
    specificationVersion: "v4",
    provider: "acme",
    modelId: "cheap",
    doGenerate: async () => ({ content: [], finishReason: "stop", usage, warnings: [] }),
    doStream: async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: "finish", finishReason: "stop", usage });
          controller.close();
        },
      }),
      warnings: [],
    }),
  } as unknown as LanguageModel;
}

async function drain(model: LanguageModel): Promise<void> {
  const { stream } = await (
    model as unknown as { doStream(o: unknown): Promise<{ stream: ReadableStream }> }
  ).doStream({});
  for await (const _ of stream as unknown as AsyncIterable<unknown>) {
    // drain: the row is written when the stream ends
  }
}

test("a call is priced from the catalog, per million tokens", () => {
  registry();
  expect(costOf("acme/cheap", 1_000_000, 0)).toBeCloseTo(2, 10);
  expect(costOf("acme/cheap", 500_000, 100_000)).toBeCloseTo(2, 10);
  // A model nobody prices costs nothing, rather than throwing mid-run.
  expect(costOf("acme/free", 1_000_000, 1_000_000)).toBe(0);
  expect(costOf("nowhere/nothing", 1_000, 1_000)).toBe(0);
});

test("a streamed call lands in the ledger when the stream drains", async () => {
  registry();
  const store = new Store(":memory:");
  await drain(
    metered(stubModel(1_000_000, 100_000), "acme/cheap", { store, sub: SUB, payer: "instance" }),
  );

  const totals = store.usageTotals({ since: 0, groupBy: "model" });
  expect(totals).toHaveLength(1);
  expect(totals[0]?.key).toBe("acme/cheap");
  expect(totals[0]?.inputTokens).toBe(1_000_000);
  expect(totals[0]?.costUsd).toBeCloseTo(3, 10); // $2 in + $1 out
});

test("a generated call lands in the ledger too", async () => {
  registry();
  const store = new Store(":memory:");
  const model = metered(stubModel(1_000, 1_000), "acme/cheap", {
    store,
    sub: SUB,
    payer: "user",
    conversationId: "c1",
  });
  await (model as unknown as { doGenerate(o: unknown): Promise<unknown> }).doGenerate({});
  expect(store.usageTotals({ since: 0, groupBy: "model", payer: "user" })).toHaveLength(1);
  expect(store.usageTotals({ since: 0, groupBy: "model", payer: "instance" })).toHaveLength(0);
});

test("a budget counts the instance's spending and ignores the user's own", () => {
  registry();
  configure({
    owner: rolePolicy({ admin: true, models: ["*"], subs: ["https://me.test/"] }),
    guest: rolePolicy({ models: ["acme/*"], usdPerDay: 1 }),
  });
  const store = new Store(":memory:");
  const spend = (payer: "instance" | "user", costUsd: number) =>
    store.recordUsage({
      ts: Date.now(),
      sub: SUB,
      payer,
      service: "inference",
      providerId: "acme",
      modelRef: "acme/cheap",
      inputTokens: 1000,
      outputTokens: 100,
      costUsd,
    });

  spend("user", 50); // their own account: never counted
  expect(budgetStatus(store, SUB, "guest").ok).toBe(true);

  spend("instance", 0.9);
  expect(budgetStatus(store, SUB, "guest").ok).toBe(true);
  spend("instance", 0.2);
  const status = budgetStatus(store, SUB, "guest");
  expect(status.ok).toBe(false);
  expect(status.reason).toContain("$1.00");
  expect(status.spentUsd).toBeCloseTo(1.1, 10);

  // An owner with no budget is never stopped by one.
  expect(budgetStatus(store, SUB, "owner").ok).toBe(true);
});

test("tokens bound a role whose models are priced at zero", () => {
  registry();
  configure({
    owner: rolePolicy({ admin: true, models: ["*"], subs: ["https://me.test/"] }),
    guest: rolePolicy({ models: ["acme/*"], tokensPerDay: 5_000 }),
  });
  const store = new Store(":memory:");
  const spend = (tokens: number, ts = Date.now()) =>
    store.recordUsage({
      ts,
      sub: SUB,
      payer: "instance",
      service: "inference",
      providerId: "acme",
      modelRef: "acme/free",
      inputTokens: tokens,
      outputTokens: 0,
      costUsd: 0,
    });

  spend(4_000);
  expect(budgetStatus(store, SUB, "guest").ok).toBe(true);
  spend(2_000);
  expect(budgetStatus(store, SUB, "guest").reason).toContain("5,000 tokens");

  // The window rolls: yesterday's spending stops counting.
  const fresh = new Store(":memory:");
  fresh.recordUsage({
    ts: Date.now() - DAY_MS - 1000,
    sub: SUB,
    payer: "instance",
    service: "inference",
    providerId: "acme",
    modelRef: "acme/free",
    inputTokens: 100_000,
    outputTokens: 0,
    costUsd: 0,
  });
  expect(budgetStatus(fresh, SUB, "guest").ok).toBe(true);
});
