import { expect, test } from "bun:test";
import {
  BlendSearchProvider,
  blend,
  CeramicSearchProvider,
  createSearchProvider,
  DuckDuckGoSearchProvider,
  dedupeKey,
  HackClubSearchProvider,
  LlmSolutionsSearchProvider,
  type SearchProvider,
  type SearchResult,
} from "../src/search";
import { loadConfig, setConfig } from "../src/settings";
import { toolSet } from "../src/tools";

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
    result: {
      results: [1, 2, 3].map((n) => ({ title: `t${n}`, url: `u${n}`, description: `d${n}` })),
    },
  });
  const p = new CeramicSearchProvider({ apiKey: "k", fetchImpl, maxResults: 2 });
  expect((await p.search("q")).length).toBe(2);
});

test("a non-OK response throws", async () => {
  const p = new CeramicSearchProvider({ apiKey: "k", fetchImpl: jsonFetch({}, 500) });
  await expect(p.search("q")).rejects.toThrow(/ceramic search failed/);
});

test("a problem+json error surfaces its detail, code, and requestId", async () => {
  const body = {
    title: "Unprocessable Content",
    detail: "Query string cannot be empty.",
    code: "invalid_parameter",
    requestId: "abc-123",
  };
  const p = new CeramicSearchProvider({ apiKey: "k", fetchImpl: jsonFetch(body, 422) });
  await expect(p.search("")).rejects.toThrow(
    /Query string cannot be empty\..*invalid_parameter.*abc-123/,
  );
});

test("createSearchProvider selects the backend (and disables gracefully)", () => {
  expect(createSearchProvider({ provider: "none", maxResults: 5 })).toBeNull();
  expect(createSearchProvider({ provider: "ceramic", maxResults: 5 })).toBeNull(); // no key
  expect(createSearchProvider({ provider: "ceramic", apiKey: "k", maxResults: 5 })).toBeInstanceOf(
    CeramicSearchProvider,
  );
  expect(createSearchProvider({ provider: "hackclub", maxResults: 5 })).toBeNull(); // no key
  expect(createSearchProvider({ provider: "hackclub", apiKey: "k", maxResults: 5 })).toBeInstanceOf(
    HackClubSearchProvider,
  );
  expect(createSearchProvider({ provider: "llmsolutions", maxResults: 5 })).toBeNull(); // no key
  expect(
    createSearchProvider({ provider: "llmsolutions", apiKey: "k", maxResults: 5 }),
  ).toBeInstanceOf(LlmSolutionsSearchProvider);
});

// ---- Hack Club search ------------------------------------------------------
// A Brave-shaped API: GET, bearer key, and results grouped per cluster.

test("HackClubSearchProvider sends a GET with the key, the query, and a count", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response(
      JSON.stringify({
        web: {
          results: [
            { title: "A", url: "https://a", description: "desc a" },
            { title: "B", url: "https://b", description: "desc b" },
          ],
        },
      }),
      { status: 200 },
    );
  }) as unknown as typeof fetch;

  const p = new HackClubSearchProvider({ apiKey: "sk-hc-v1-x", fetchImpl, maxResults: 2 });
  expect(await p.search("frc brushless")).toEqual([
    { title: "A", url: "https://a", snippet: "desc a" },
    { title: "B", url: "https://b", snippet: "desc b" },
  ]);
  const got = seen as unknown as { url: string; init: RequestInit };
  const url = new URL(got.url);
  expect(url.host).toBe("search.hackclub.com");
  expect(url.pathname).toBe("/res/v1/web/search");
  expect(url.searchParams.get("q")).toBe("frc brushless");
  expect(url.searchParams.get("count")).toBe("2");
  expect((got.init.headers as Record<string, string>).Authorization).toBe("Bearer sk-hc-v1-x");
});

test("a query over the API's 400-char limit is trimmed rather than rejected", async () => {
  let asked = "";
  const fetchImpl = (async (url: string) => {
    asked = new URL(url).searchParams.get("q") ?? "";
    return new Response(JSON.stringify({ web: { results: [] } }), { status: 200 });
  }) as unknown as typeof fetch;
  await new HackClubSearchProvider({ apiKey: "k", fetchImpl }).search("x".repeat(900));
  expect(asked.length).toBe(400);
});

test("results are found wherever the response happens to cluster them", async () => {
  // A query can come back with only a news or discussions group; returning
  // nothing would read to the model as "the web has nothing about this".
  const news = new HackClubSearchProvider({
    apiKey: "k",
    fetchImpl: jsonFetch({
      web: { results: [] },
      news: { results: [{ title: "N", url: "https://n", description: "d" }] },
    }),
  });
  expect(await news.search("q")).toEqual([{ title: "N", url: "https://n", snippet: "d" }]);

  // And a flattened top-level shape parses too.
  const flat = new HackClubSearchProvider({
    apiKey: "k",
    fetchImpl: jsonFetch({ results: [{ title: "F", url: "https://f", snippet: "s" }] }),
  });
  expect(await flat.search("q")).toEqual([{ title: "F", url: "https://f", snippet: "s" }]);
});

test("an API error surfaces its reason, not a bare status", async () => {
  const p = new HackClubSearchProvider({
    apiKey: "bad",
    fetchImpl: jsonFetch({ error: "Invalid subscription token" }, 401),
  });
  await expect(p.search("q")).rejects.toThrow(/401 Invalid subscription token/);

  // The API answers a missing key in plain text; the status still gets through.
  const plain = new HackClubSearchProvider({
    apiKey: "",
    fetchImpl: (async () =>
      new Response("Authentication required", { status: 401 })) as unknown as typeof fetch,
  });
  await expect(plain.search("q")).rejects.toThrow(/hackclub search failed: 401/);
});

test("toolSet exposes web_search only when a search provider is configured", () => {
  const base = loadConfig({ path: "does-not-exist.json", env: {} });
  const noFetch = { ...base.fetch, enabled: false }; // isolate web_search (fetch_url is on by default)
  try {
    setConfig({ ...base, fetch: noFetch, search: { ...base.search, provider: "none" } });
    expect(Object.keys(toolSet())).toEqual([]);
    setConfig({
      ...base,
      fetch: noFetch,
      search: { provider: "ceramic", apiKey: "k", maxResults: 5 },
    });
    expect(Object.keys(toolSet())).toContain("web_search");
  } finally {
    setConfig(null);
  }
});

// ---- llmsolutions ----------------------------------------------------------
// The one backend that returns page text rather than a description, and the one
// with a batch endpoint that is currently unreliable.

test("LlmSolutionsSearchProvider posts the query and cuts a snippet from the page text", async () => {
  let seen: { url: string; init: RequestInit } | null = null;
  const long = "A".repeat(2000);
  const fetchImpl = (async (url: string, init: RequestInit) => {
    seen = { url, init };
    return new Response(
      JSON.stringify({
        object: "search.results",
        data: [{ query: "q", title: "T", url: "https://t.test", text: long }],
      }),
    );
  }) as unknown as typeof fetch;

  const [hit] = await new LlmSolutionsSearchProvider({ apiKey: "k", fetchImpl }).search("q");
  // The snippet is bounded: a page's worth of text per result would spend a
  // fetch's context on deciding what to fetch.
  expect(hit!.snippet.length).toBeLessThan(700);
  expect(hit!.snippet.endsWith("…")).toBe(true);
  // …while the full text stays on the result for a caller that wants it.
  expect(hit!.text).toBe(long);

  const got = seen as unknown as { url: string; init: RequestInit };
  expect(JSON.parse(String(got.init.body))).toEqual({ query: "q", max_results: 5 });
  expect((got.init.headers as Record<string, string>).Authorization).toBe("Bearer k");
});

test("a batch is sent as one request and sorted back into the order asked for", async () => {
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    const body = JSON.parse(String(init.body));
    expect(body.queries).toEqual(["alpha", "beta"]);
    // The API returns one flat list; each hit names the query it answers.
    return new Response(
      JSON.stringify({
        data: [
          { query: "beta", title: "B", url: "https://b.test", text: "b" },
          { query: "alpha", title: "A", url: "https://a.test", text: "a" },
        ],
      }),
    );
  }) as unknown as typeof fetch;

  const out = await new LlmSolutionsSearchProvider({ apiKey: "k", fetchImpl }).searchMany([
    "alpha",
    "beta",
  ]);
  expect(out.map((r) => r[0]!.title)).toEqual(["A", "B"]);
});

test("a failing batch falls back to running the queries in parallel", async () => {
  // The batch endpoint currently 503s on every multi-query call while single
  // queries succeed. A caller must not lose its searches to that.
  let calls = 0;
  const fetchImpl = (async (_url: string, init: RequestInit) => {
    calls++;
    const body = JSON.parse(String(init.body));
    if (body.queries) {
      return new Response(
        JSON.stringify({
          error: { message: "Search is unavailable right now.", code: "search_unavailable" },
        }),
        { status: 503 },
      );
    }
    return new Response(
      JSON.stringify({ data: [{ query: body.query, title: body.query, url: "https://x.test" }] }),
    );
  }) as unknown as typeof fetch;

  const out = await new LlmSolutionsSearchProvider({ apiKey: "k", fetchImpl }).searchMany([
    "one",
    "two",
  ]);
  expect(out.map((r) => r[0]!.title)).toEqual(["one", "two"]);
  expect(calls).toBe(3); // the failed batch, then one request per query
});

test("an API error surfaces the server's own message", async () => {
  const p = new LlmSolutionsSearchProvider({
    apiKey: "k",
    fetchImpl: jsonFetch(
      { error: { message: "Search is unavailable right now.", code: "search_unavailable" } },
      503,
    ),
  });
  await expect(p.search("q")).rejects.toThrow(
    /503 Search is unavailable right now\. \(search_unavailable\)/,
  );
});

// ---- blending --------------------------------------------------------------
// Two engines are good at different questions. What makes running both worth
// more than running either is what happens on the way back.

function fixed(results: Array<Partial<SearchResult>>): SearchProvider {
  return {
    search: async () =>
      results.map((r) => ({
        title: r.title ?? "",
        url: r.url ?? "",
        snippet: r.snippet ?? "",
        ...r,
      })),
  };
}

test("blend interleaves by rank so no single backend fills the list", () => {
  const a = [
    { title: "A1", url: "https://a1.test", snippet: "" },
    { title: "A2", url: "https://a2.test", snippet: "" },
  ];
  const b = [
    { title: "B1", url: "https://b1.test", snippet: "" },
    { title: "B2", url: "https://b2.test", snippet: "" },
  ];
  // Each backend's best hit lands before either backend's second.
  expect(blend([a, b], 4).map((r) => r.title)).toEqual(["A1", "B1", "A2", "B2"]);
});

test("the same page from two backends is one result carrying the best of each", () => {
  const keyword = [{ title: "Docs", url: "https://x.test/docs", snippet: "a one-line summary" }];
  const neural = [
    {
      title: "",
      url: "https://www.x.test/docs/",
      snippet: "much longer summary…",
      text: "the whole page",
    },
  ];
  const [only, ...rest] = blend([keyword, neural], 5);
  expect(rest).toHaveLength(0); // `www.` and a trailing slash are the same page
  // The prize: one backend found it, the other explains it.
  expect(only!.title).toBe("Docs");
  expect(only!.text).toBe("the whole page");
  expect(only!.snippet).toBe("much longer summary…");
});

test("dedupeKey ignores noise but never merges genuinely different pages", () => {
  expect(dedupeKey("https://www.a.test/p/?utm_source=x&fbclid=y")).toBe(
    dedupeKey("http://a.test/p"),
  );
  // A query string is usually the page's identity, so it stays.
  expect(dedupeKey("https://a.test/i?id=42")).not.toBe(dedupeKey("https://a.test/i?id=43"));
});

test("one backend failing is a thinner list, not a failed search", async () => {
  const dead: SearchProvider = {
    search: async () => {
      throw new Error("503 upstream");
    },
  };
  const live = fixed([{ title: "Live", url: "https://live.test" }]);
  const out = await new BlendSearchProvider([dead, live], 5).search("q");
  expect(out.map((r) => r.title)).toEqual(["Live"]);
});

test("search falls back to DuckDuckGo when nothing is configured, and off when told", () => {
  // A fresh checkout can search without a key…
  expect(createSearchProvider({ provider: "default", maxResults: 5 })).toBeInstanceOf(
    DuckDuckGoSearchProvider,
  );
  // …and "none" is how a deployment says it wants no search at all.
  expect(createSearchProvider({ provider: "none", maxResults: 5 })).toBeNull();
});

test("a configured blend builds every backend that has what it needs", () => {
  const p = createSearchProvider({
    provider: "default",
    maxResults: 5,
    backends: [
      { provider: "llmsolutions", apiKey: "k" },
      { provider: "duckduckgo" },
      { provider: "ceramic" }, // no key: dropped rather than failing the blend
    ],
  });
  expect(p).toBeInstanceOf(BlendSearchProvider);
  // A blend of one is just that provider — no wrapper, no interleave to do.
  const single = createSearchProvider({
    provider: "default",
    maxResults: 5,
    backends: [{ provider: "hackclub", apiKey: "k" }],
  });
  expect(single).toBeInstanceOf(HackClubSearchProvider);
});

test("DuckDuckGo parses the lite page and unwraps its redirects", async () => {
  const page = `<html><body>
    <a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fcaniuse.com%2Fwebgpu&rut=abc">Can I use WebGPU</a>
    <td class="result-snippet">Browser support tables.</td>
    <a class="result-link" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fweb.dev%2Fwebgpu">web.dev</a>
    <td class="result-snippet">Now supported.</td>
  </body></html>`;
  const fetchImpl = (async () => new Response(page)) as unknown as typeof fetch;
  const out = await new DuckDuckGoSearchProvider({ fetchImpl }).search("webgpu");
  expect(out).toEqual([
    {
      title: "Can I use WebGPU",
      url: "https://caniuse.com/webgpu",
      snippet: "Browser support tables.",
    },
    { title: "web.dev", url: "https://web.dev/webgpu", snippet: "Now supported." },
  ]);
});
