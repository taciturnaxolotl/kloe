import { type Config, getConfig } from "./settings";

/**
 * Web search, behind a swappable provider interface so the `web_search` tool
 * isn't coupled to any one vendor's API. Add a provider by implementing
 * `SearchProvider` and wiring it into `createSearchProvider`; the tool and the
 * rest of the app only see normalized `SearchResult`s.
 */

/** One normalized result — the shape the tool hands back to the model. */
export interface SearchResult {
  title: string;
  url: string;
  snippet: string;
  /**
   * Page text, when the backend returns it with the result.
   *
   * Deliberately NOT part of what the tool hands the model: five results with
   * five thousand characters each is a fetched page's worth of context spent on
   * deciding which page to fetch. It is here because a search that already
   * carries the text is a read the researcher may not have to pay for, and that
   * is worth building on top of.
   */
  text?: string;
}

export interface SearchProvider {
  search(query: string): Promise<SearchResult[]>;
  /**
   * Several queries in one round trip, where the backend supports it.
   *
   * Optional, and every caller must cope without it: the default below simply
   * runs them in parallel, which is the same answer a request later.
   */
  searchMany?(queries: string[]): Promise<SearchResult[][]>;
}

interface CeramicOptions {
  apiKey?: string;
  endpoint?: string;
  maxResults?: number;
  fetchImpl?: typeof fetch;
}

/** Ceramic (api.ceramic.ai) — POST /search with a bearer key; normalized here. */
export class CeramicSearchProvider implements SearchProvider {
  private readonly apiKey?: string;
  private readonly endpoint: string;
  private readonly maxResults: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: CeramicOptions = {}) {
    this.apiKey = opts.apiKey;
    this.endpoint = opts.endpoint || "https://api.ceramic.ai/search";
    this.maxResults = opts.maxResults ?? 5;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async search(query: string): Promise<SearchResult[]> {
    const res = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify({ query }),
    });
    if (!res.ok) {
      // Ceramic returns RFC 7807 problem+json on errors — surface its `detail`
      // (and `code`/`requestId`) instead of a bare status, so the model and the
      // logs get the actual reason (e.g. "Query string cannot be empty").
      let detail = res.statusText;
      try {
        const body = (await res.json()) as {
          detail?: string;
          title?: string;
          code?: string;
          requestId?: string;
        };
        const msg = body.detail || body.title;
        if (msg) detail = msg;
        if (body.code) detail += ` (${body.code})`;
        if (body.requestId) detail += ` [req ${body.requestId}]`;
      } catch {
        // non-JSON error body; keep the status text
      }
      throw new Error(`ceramic search failed: ${res.status} ${detail}`);
    }
    const data = (await res.json()) as {
      result?: { results?: Array<{ title?: string; url?: string; description?: string }> };
    };
    const results = data.result?.results ?? [];
    return results.slice(0, this.maxResults).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      snippet: r.description ?? "",
    }));
  }
}

interface HackClubOptions {
  apiKey?: string;
  endpoint?: string;
  maxResults?: number;
  fetchImpl?: typeof fetch;
}

/**
 * Hack Club Search (search.hackclub.com) — a Brave-shaped API, GET with the key
 * as a bearer token.
 *
 * Brave-shaped means the interesting results are nested per cluster: a query
 * can come back with `web`, `news`, `videos` and `discussions` groups, and which
 * ones appear depends on the query rather than on anything we asked for. So the
 * parse takes `web.results` first and then falls back — to a flattened
 * top-level `results`, then to news and discussions — because a query that
 * matched only a news cluster still has answers in it, and returning nothing
 * would look to the model like "the web has nothing about this".
 */
export class HackClubSearchProvider implements SearchProvider {
  private readonly apiKey?: string;
  private readonly endpoint: string;
  private readonly maxResults: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: HackClubOptions = {}) {
    this.apiKey = opts.apiKey;
    this.endpoint = opts.endpoint || "https://search.hackclub.com/res/v1/web/search";
    this.maxResults = opts.maxResults ?? 5;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async search(query: string): Promise<SearchResult[]> {
    // The API caps a query at 400 characters and rejects longer ones outright,
    // so trim rather than spend a request learning that again.
    const q = query.trim().slice(0, 400);
    const url = new URL(this.endpoint);
    url.searchParams.set("q", q);
    url.searchParams.set("count", String(Math.min(20, Math.max(1, this.maxResults))));
    const res = await this.fetchImpl(url.toString(), {
      headers: {
        Accept: "application/json",
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
    });
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const body = (await res.json()) as { error?: string; message?: string; detail?: string };
        detail = body.error || body.message || body.detail || detail;
      } catch {
        // non-JSON error body (the API answers a missing key in plain text)
      }
      throw new Error(`hackclub search failed: ${res.status} ${detail}`);
    }
    const data = (await res.json()) as HackClubResponse;
    const groups = [data.web?.results, data.results, data.news?.results, data.discussions?.results];
    const hits = groups.find((g) => Array.isArray(g) && g.length) ?? [];
    return hits.slice(0, this.maxResults).map((r) => ({
      title: r.title ?? "",
      url: r.url ?? "",
      // `description` is Brave's field; `snippet` is the obvious alternative
      // name, and `extra_snippets` carries the fuller passages when asked for.
      snippet: r.description ?? r.snippet ?? r.extra_snippets?.[0] ?? "",
    }));
  }
}

interface HackClubHit {
  title?: string;
  url?: string;
  description?: string;
  snippet?: string;
  extra_snippets?: string[];
}
interface HackClubResponse {
  web?: { results?: HackClubHit[] };
  news?: { results?: HackClubHit[] };
  discussions?: { results?: HackClubHit[] };
  results?: HackClubHit[];
}

interface LlmSolutionsOptions {
  apiKey?: string;
  endpoint?: string;
  maxResults?: number;
  fetchImpl?: typeof fetch;
}

/** How much of a returned page becomes the snippet the model reads. */
const SNIPPET_CHARS = 600;

/**
 * llmsolutions.top — POST /v1/search, bearer key, and it returns page TEXT
 * rather than a one-line description.
 *
 * That changes what a search result is worth here. The other backends hand back
 * a sentence, which is a reason to open a page; this one hands back enough of
 * the page to often settle the question. The snippet is cut from that text, and
 * the full text is carried on the result for a caller that wants it — capped
 * either way, because the point of a search result is still to choose what to
 * read.
 *
 * The API also accepts `queries: [...]` for several searches in one request.
 * That path is implemented and currently answers 503 on every multi-query call
 * while single queries succeed, so `searchMany` falls back to running them in
 * parallel. When the endpoint recovers, the batch is used with no change here.
 */
export class LlmSolutionsSearchProvider implements SearchProvider {
  private readonly apiKey?: string;
  private readonly endpoint: string;
  private readonly maxResults: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: LlmSolutionsOptions = {}) {
    this.apiKey = opts.apiKey;
    this.endpoint = opts.endpoint || "https://llmsolutions.top/v1/search";
    this.maxResults = opts.maxResults ?? 5;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async search(query: string): Promise<SearchResult[]> {
    const data = await this.post({ query, max_results: this.maxResults });
    return this.normalize(data);
  }

  async searchMany(queries: string[]): Promise<SearchResult[][]> {
    if (queries.length <= 1) return [await this.search(queries[0] ?? "")];
    try {
      const data = await this.post({ queries, max_results: this.maxResults });
      // Results carry the query they answer, so they sort back into the order
      // asked for rather than the order returned.
      return queries.map((q) => this.normalize(data.filter((d) => d.query === q)));
    } catch (e) {
      // The batch endpoint is currently unreliable; one failed round trip must
      // not cost the caller its searches.
      console.warn("[search] batch failed, falling back to parallel:", (e as Error).message);
      return Promise.all(queries.map((q) => this.search(q)));
    }
  }

  private async post(body: Record<string, unknown>): Promise<LlmSolutionsHit[]> {
    const res = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey ? { Authorization: `Bearer ${this.apiKey}` } : {}),
      },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const err = (await res.json()) as { error?: { message?: string; code?: string } };
        if (err.error?.message) detail = err.error.message;
        if (err.error?.code) detail += ` (${err.error.code})`;
      } catch {
        // non-JSON error body; keep the status text
      }
      throw new Error(`llmsolutions search failed: ${res.status} ${detail}`);
    }
    const data = (await res.json()) as { data?: LlmSolutionsHit[] };
    return data.data ?? [];
  }

  private normalize(hits: LlmSolutionsHit[]): SearchResult[] {
    return hits.slice(0, this.maxResults).map((h) => {
      const text = (h.text ?? "").trim();
      return {
        title: h.title ?? "",
        url: h.url ?? "",
        // The returned text is the page, elisions and all. A snippet is the
        // first readable stretch of it, not the whole thing.
        snippet: text.length > SNIPPET_CHARS ? `${text.slice(0, SNIPPET_CHARS).trimEnd()}…` : text,
        ...(text ? { text } : {}),
      };
    });
  }
}

interface LlmSolutionsHit {
  query?: string;
  title?: string;
  url?: string;
  text?: string;
}

/**
 * Builds the configured search provider from `config.search`, or null when
 * search is disabled (`provider: "none"`, or a provider with no key). The
 * single place a search backend is selected — everything else takes a
 * `SearchProvider`.
 */
export function createSearchProvider(
  cfg: Config["search"] = getConfig().search,
): SearchProvider | null {
  switch (cfg.provider) {
    case "ceramic":
      return cfg.apiKey
        ? new CeramicSearchProvider({
            apiKey: cfg.apiKey,
            endpoint: cfg.endpoint,
            maxResults: cfg.maxResults,
          })
        : null;
    case "llmsolutions":
      return cfg.apiKey
        ? new LlmSolutionsSearchProvider({
            apiKey: cfg.apiKey,
            endpoint: cfg.endpoint,
            maxResults: cfg.maxResults,
          })
        : null;
    case "hackclub":
      return cfg.apiKey
        ? new HackClubSearchProvider({
            apiKey: cfg.apiKey,
            endpoint: cfg.endpoint,
            maxResults: cfg.maxResults,
          })
        : null;
    default:
      return null; // "none"
  }
}
