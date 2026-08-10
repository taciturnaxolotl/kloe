import { afterEach, expect, test } from "bun:test";
import type { FetchProvider, FetchResult } from "../src/fetch";
import { bindCitations, researchBudget, runResearch, type Source } from "../src/research";
import type { SearchProvider, SearchResult } from "../src/search";
import { loadConfig, setConfig } from "../src/settings";

afterEach(() => setConfig(null));

function ledger(...urls: string[]): Source[] {
  return urls.map((url, i) => ({ n: i + 1, url, title: `Page ${i + 1}` }));
}

test("a citation that points at nothing is dropped, not shown", () => {
  // The citation pass is a model doing its best: it can invent [7] for a
  // two-source run. An invalid marker must never reach the reader.
  const out = bindCitations("Water is wet [1]. The moon is cheese [7].", ledger("a", "b"));
  expect(out.report).toBe("Water is wet [1]. The moon is cheese.");
  expect(out.sources.map((s) => s.url)).toEqual(["a"]);
});

test("cited sources are renumbered from 1 in order of appearance", () => {
  // The report leaned on the third and first pages only, so the reader sees
  // [1] and [2] rather than [3] and [1].
  const out = bindCitations("Claim A [3]. Claim B [1]. Claim C [3].", ledger("a", "b", "c"));
  expect(out.report).toBe("Claim A [1]. Claim B [2]. Claim C [1].");
  expect(out.sources).toEqual([
    { n: 1, url: "c", title: "Page 3" },
    { n: 2, url: "a", title: "Page 1" },
  ]);
});

test("several sources on one sentence survive together", () => {
  const out = bindCitations("Both agree [1][2].", ledger("a", "b"));
  expect(out.report).toBe("Both agree [1][2].");
  expect(out.sources).toHaveLength(2);
});

test("dropping a marker doesn't leave a gap before the punctuation", () => {
  const out = bindCitations("A fact [9] holds.", ledger("a"));
  expect(out.report).toBe("A fact holds.");
});

test("an uncited report keeps its text and lists no sources", () => {
  const out = bindCitations("Nothing here is attributed.", ledger("a", "b"));
  expect(out.report).toBe("Nothing here is attributed.");
  expect(out.sources).toEqual([]);
});

test("the budget comes from config, and a caller may tighten one field", () => {
  const base = loadConfig({ path: "/nonexistent", env: {} });
  setConfig({ ...base, research: { ...base.research, maxSources: 4 } });
  expect(researchBudget().maxSources).toBe(4);
  expect(researchBudget({ maxSources: 2 }).maxSources).toBe(2);
  expect(researchBudget({ maxSources: 2 }).maxSteps).toBe(base.research.maxSteps);
});

// ---- the loop, against stub providers ----------------------------------

function stubSearch(results: SearchResult[]): SearchProvider {
  return { search: async () => results };
}
function stubFetch(pages: Record<string, Partial<FetchResult>>): FetchProvider {
  return {
    fetch: async (url) => ({
      url,
      title: "T",
      content: "body",
      format: "markdown",
      truncated: false,
      ...pages[url],
    }),
  };
}

/**
 * A model that answers with a fixed script: each entry is one step's reply,
 * either tool calls or final text. Enough to drive the loop without a provider.
 */
function scriptedModel(script: Array<{ text?: string; calls?: Array<[string, unknown]> }>) {
  let step = 0;
  return {
    specificationVersion: "v4",
    provider: "test",
    modelId: "scripted",
    supportedUrls: {},
    doStream: async () => {
      const turn = script[Math.min(step++, script.length - 1)]!;
      const parts: Array<Record<string, unknown>> = [];
      for (const [name, input] of turn.calls ?? []) {
        const id = `c${parts.length}${step}`;
        parts.push({
          type: "tool-call",
          toolCallId: id,
          toolName: name,
          input: JSON.stringify(input),
        });
      }
      if (turn.text) {
        parts.push({ type: "text-start", id: "t" });
        parts.push({ type: "text-delta", id: "t", delta: turn.text });
        parts.push({ type: "text-end", id: "t" });
      }
      parts.push({
        type: "finish",
        finishReason: turn.calls?.length ? "tool-calls" : "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      });
      return {
        stream: new ReadableStream({
          start(c) {
            for (const p of parts) c.enqueue(p);
            c.close();
          },
        }),
      };
    },
  } as unknown as Parameters<typeof runResearch>[0]["model"];
}

test("the loop ledgers what it read and returns it as cited sources", async () => {
  const model = scriptedModel([
    { calls: [["read_page", { url: "https://a.test/x" }]] },
    { text: "Findings about the thing [1]." },
    { text: "Findings about the thing [1]." }, // the citation pass echoes the draft
  ]);
  const out = await runResearch({
    question: "what",
    model,
    search: stubSearch([]),
    fetcher: stubFetch({ "https://a.test/x": { title: "A page" } }),
    budget: { maxSteps: 4 },
  });
  expect(out.sources).toEqual([{ n: 1, url: "https://a.test/x", title: "A page" }]);
  expect(out.report).toContain("[1]");
  expect(out.stats.read).toBe(1);
});

test("the page-read cap is enforced by the harness, not the prompt", async () => {
  // Four reads asked for, two allowed. The third and fourth come back as a
  // budget message rather than a fetch, and never enter the ledger.
  const model = scriptedModel([
    {
      calls: [
        ["read_page", { url: "https://a.test/1" }],
        ["read_page", { url: "https://a.test/2" }],
        ["read_page", { url: "https://a.test/3" }],
        ["read_page", { url: "https://a.test/4" }],
      ],
    },
    { text: "Done." },
    { text: "Done." },
  ]);
  const out = await runResearch({
    question: "what",
    model,
    search: stubSearch([]),
    fetcher: stubFetch({}),
    budget: { maxSteps: 4, maxSources: 2 },
  });
  expect(out.stats.read).toBe(2);
});

test("a redirect onto an already-read page doesn't spend a second slot", async () => {
  const model = scriptedModel([
    {
      calls: [
        ["read_page", { url: "https://a.test/x" }],
        ["read_page", { url: "https://a.test/dupe" }],
      ],
    },
    { text: "Done." },
    { text: "Done." },
  ]);
  const out = await runResearch({
    question: "what",
    model,
    search: stubSearch([]),
    // Both requests land on the same canonical URL.
    fetcher: {
      fetch: async () => ({
        url: "https://a.test/final",
        title: "One page",
        content: "body",
        format: "markdown" as const,
        truncated: false,
      }),
    },
    budget: { maxSteps: 4, maxSources: 5 },
  });
  expect(out.stats.read).toBe(1);
});
