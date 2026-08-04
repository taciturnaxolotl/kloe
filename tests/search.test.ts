import { test, expect } from "bun:test";
import { CeramicSearchProvider, createSearchProvider } from "../src/search";
import { toolSet } from "../src/tools";
import { setConfig, loadConfig } from "../src/settings";

function jsonFetch(body: unknown, status = 200): typeof fetch {
  return (async () => new Response(JSON.stringify(body), { status })) as unknown as typeof fetch;
}

test("CeramicSearchProvider normalizes results and sends the bearer key + query", async () => {
  let seen: { url: unknown; init: RequestInit } | null = null;
  const fetchImpl = (async (url: unknown, init: RequestInit) => {
    seen = { url, init };
    return new Response(
      JSON.stringify({
        result: {
          results: [
            { title: "A", url: "https://a", description: "desc a" },
            { title: "B", url: "https://b", description: "desc b" },
          ],
        },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const p = new CeramicSearchProvider({ apiKey: "sk-x", fetchImpl });
  const results = await p.search("rental laws");
  expect(results).toEqual([
    { title: "A", url: "https://a", snippet: "desc a" },
    { title: "B", url: "https://b", snippet: "desc b" },
  ]);
  expect(String(seen!.url)).toContain("api.ceramic.ai/search");
  expect((seen!.init.headers as Record<string, string>).Authorization).toBe("Bearer sk-x");
  expect(JSON.parse(seen!.init.body as string).query).toBe("rental laws");
});

test("maxResults caps how many results come back", async () => {
  const fetchImpl = jsonFetch({
    result: { results: [1, 2, 3].map((n) => ({ title: `t${n}`, url: `u${n}`, description: `d${n}` })) },
  });
  const p = new CeramicSearchProvider({ apiKey: "k", fetchImpl, maxResults: 2 });
  expect((await p.search("q")).length).toBe(2);
});

test("a non-OK response throws", async () => {
  const p = new CeramicSearchProvider({ apiKey: "k", fetchImpl: jsonFetch({}, 500) });
  await expect(p.search("q")).rejects.toThrow(/ceramic search failed/);
});

test("createSearchProvider selects the backend (and disables gracefully)", () => {
  expect(createSearchProvider({ provider: "none", maxResults: 5 })).toBeNull();
  expect(createSearchProvider({ provider: "ceramic", maxResults: 5 })).toBeNull(); // no key
  expect(createSearchProvider({ provider: "ceramic", apiKey: "k", maxResults: 5 })).toBeInstanceOf(
    CeramicSearchProvider,
  );
});

test("toolSet exposes web_search only when a search provider is configured", () => {
  const base = loadConfig({ path: "does-not-exist.json", env: {} });
  try {
    setConfig({ ...base, search: { ...base.search, provider: "none" } });
    expect(Object.keys(toolSet())).toEqual([]);
    setConfig({ ...base, search: { provider: "ceramic", apiKey: "k", maxResults: 5 } });
    expect(Object.keys(toolSet())).toContain("web_search");
  } finally {
    setConfig(null);
  }
});
