import { getConfig, type Config } from "./settings";

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
}

export interface SearchProvider {
  search(query: string): Promise<SearchResult[]>;
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
        const body = (await res.json()) as { detail?: string; title?: string; code?: string; requestId?: string };
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

/**
 * Builds the configured search provider from `config.search`, or null when
 * search is disabled (`provider: "none"`, or a provider with no key). The
 * single place a search backend is selected — everything else takes a
 * `SearchProvider`.
 */
export function createSearchProvider(cfg: Config["search"] = getConfig().search): SearchProvider | null {
  switch (cfg.provider) {
    case "ceramic":
      return cfg.apiKey
        ? new CeramicSearchProvider({ apiKey: cfg.apiKey, endpoint: cfg.endpoint, maxResults: cfg.maxResults })
        : null;
    default:
      return null; // "none"
  }
}
