import { parseHTML } from "linkedom";
import { type Role, roleMaySearch } from "./auth";
import { connectedProviders, credentialFor } from "./credentials";
import { type Config, getConfig } from "./settings";
import type { Store } from "./store";

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
  /**
   * The backend honors query operators (`site:`, `A OR B`) rather than reading
   * them as words. Absent means it doesn't, which is the safe default: a query
   * the model wrote as a filter and the engine read as three literal words is
   * a search for the wrong thing, returned with no sign anything went wrong.
   */
  readonly operators?: boolean;
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

/**
 * Ceramic's own ceiling on results per request. It returns 10 unasked; the
 * request has to carry `maxResults` to get more, which is why a higher
 * `search.maxResults` used to change nothing here — we were slicing ten hits
 * down, never asking for more than ten.
 */
const CERAMIC_MAX = 50;

/** Ceramic (api.ceramic.ai) — POST /search with a bearer key; normalized here. */
export class CeramicSearchProvider implements SearchProvider {
  /** `site:` and `A OR B` are honored rather than read as words. */
  readonly operators = true;
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
      body: JSON.stringify({ query, maxResults: Math.min(this.maxResults, CERAMIC_MAX) }),
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

interface ExaOptions {
  apiKey?: string;
  endpoint?: string;
  maxResults?: number;
  /** Exa's depth dial: auto, fast, instant, deep-lite, deep, deep-reasoning. */
  searchType?: string;
  fetchImpl?: typeof fetch;
}

/**
 * Exa (api.exa.ai) — neural search, keyed by `x-api-key` rather than a bearer
 * token, and returning query-relevant HIGHLIGHTS rather than a description.
 *
 * Highlights, not full text, and that is the whole content decision. Exa will
 * return either; text is the entire page and blows up context, while highlights
 * are the passages that actually match the query — which is what a snippet is
 * supposed to be and almost never is. Their own guidance for agent workflows
 * says the same, and a run that needs the whole page can still fetch it.
 *
 * `type` defaults to "auto", which picks between neural and keyword per query.
 * The deeper modes (`deep`, `deep-reasoning`) run multiple query variations and
 * take seconds to tens of seconds; they belong in a second tier, reached when
 * the cheap search came back thin, not on the default path.
 */
export class ExaSearchProvider implements SearchProvider {
  private readonly apiKey?: string;
  private readonly endpoint: string;
  private readonly maxResults: number;
  private readonly searchType: string;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: ExaOptions = {}) {
    this.apiKey = opts.apiKey;
    this.endpoint = opts.endpoint || "https://api.exa.ai/search";
    this.maxResults = opts.maxResults ?? 5;
    this.searchType = opts.searchType || "auto";
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async search(query: string): Promise<SearchResult[]> {
    const res = await this.fetchImpl(this.endpoint, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        ...(this.apiKey ? { "x-api-key": this.apiKey } : {}),
      },
      body: JSON.stringify({
        query,
        type: this.searchType,
        numResults: this.maxResults,
        contents: { highlights: true },
      }),
    });
    if (!res.ok) {
      let detail = res.statusText;
      try {
        const body = (await res.json()) as { error?: string; message?: string };
        detail = body.error || body.message || detail;
      } catch {
        // non-JSON error body; keep the status text
      }
      throw new Error(`exa search failed: ${res.status} ${detail}`);
    }
    const data = (await res.json()) as {
      results?: Array<{ title?: string; url?: string; highlights?: string[]; text?: string }>;
    };
    return (data.results ?? []).slice(0, this.maxResults).map((r) => {
      // Several highlights are several passages from one page; joined with an
      // ellipsis so the model can see they are not continuous prose.
      const joined = (r.highlights ?? [])
        .map((h) => h.trim())
        .filter(Boolean)
        .join(" … ");
      const snippet = joined.length > SNIPPET_CHARS ? `${joined.slice(0, SNIPPET_CHARS)}…` : joined;
      const text = r.text?.trim();
      return {
        title: r.title ?? "",
        url: r.url ?? "",
        snippet,
        ...(text ? { text } : {}),
      };
    });
  }
}

/**
 * DuckDuckGo, so search works with no key at all.
 *
 * This is the fallback, and it is worth being precise about what it is: DDG
 * publishes no free web-search API, so this parses `lite.duckduckgo.com`, an
 * HTML page meant for browsers. That means no key and no signup, and also that
 * it rate-limits, degrades under load, and will break whenever the markup
 * changes. Fine as the thing that makes a fresh checkout useful; not what a
 * deployment that cares about search should run on.
 *
 * It returns links, titles and one-line snippets — no page text — so a run on
 * this backend does more fetching than one on Exa.
 */
export class DuckDuckGoSearchProvider implements SearchProvider {
  private readonly endpoint: string;
  private readonly maxResults: number;
  private readonly fetchImpl: typeof fetch;

  constructor(opts: { endpoint?: string; maxResults?: number; fetchImpl?: typeof fetch } = {}) {
    this.endpoint = opts.endpoint || "https://lite.duckduckgo.com/lite/";
    this.maxResults = opts.maxResults ?? 5;
    this.fetchImpl = opts.fetchImpl ?? fetch;
  }

  async search(query: string): Promise<SearchResult[]> {
    const url = `${this.endpoint}?q=${encodeURIComponent(query)}`;
    const res = await this.fetchImpl(url, {
      headers: {
        // A browser-ish agent, because the endpoint is a browser page. Not an
        // attempt to be undetectable — a blocked request is reported as one.
        "User-Agent": "Mozilla/5.0 (compatible; kloe/1.0; +https://kloe.dunkirk.sh)",
        Accept: "text/html",
      },
      signal: AbortSignal.timeout(15_000),
    });
    if (!res.ok) throw new Error(`duckduckgo search failed: ${res.status} ${res.statusText}`);
    const { document } = parseHTML(await res.text());
    const links = [...document.querySelectorAll("a.result-link")];
    const snippets = [...document.querySelectorAll("td.result-snippet")];
    const out: SearchResult[] = [];
    for (let i = 0; i < links.length && out.length < this.maxResults; i++) {
      const href = links[i]?.getAttribute("href") ?? "";
      const target = ddgTarget(href);
      if (!target) continue;
      out.push({
        title: (links[i]?.textContent ?? "").trim(),
        url: target,
        snippet: (snippets[i]?.textContent ?? "").trim(),
      });
    }
    return out;
  }
}

/** DDG wraps every result in a redirect; the real URL is the `uddg` parameter. */
function ddgTarget(href: string): string | null {
  if (!href) return null;
  try {
    const url = new URL(href, "https://duckduckgo.com");
    const target = url.searchParams.get("uddg");
    if (target) return target;
    // Some layouts link out directly; take it if it's a real destination.
    return /^https?:$/.test(url.protocol) && !/duckduckgo\.com$/.test(url.hostname)
      ? url.href
      : null;
  } catch {
    return null;
  }
}

/**
 * Several backends at once, merged into one ranked list.
 *
 * Different engines are good at different questions — a keyword index finds the
 * vendor's own docs, a neural one finds the post that explains them — and the
 * cost of asking both is one parallel request. What makes this worth more than
 * either alone is the merge on the way back:
 *
 *   - Ranked lists are fused by reciprocal rank fusion, so a page several
 *     engines found outranks a page one engine loved. Agreement between
 *     independent engines is evidence, and it is exactly what concatenating or
 *     interleaving discards.
 *   - The same URL from two backends is one result, and it keeps the RICHEST
 *     version: Exa's page text plus whoever had the better summary. That merge
 *     is the actual prize — one backend finds it, another explains it.
 *
 * A backend that fails is skipped with a warning. One engine being down is a
 * thinner result list, not a failed search.
 */
export class BlendSearchProvider implements SearchProvider {
  readonly operators: boolean;
  private readonly providers: SearchProvider[];
  private readonly maxResults: number;

  constructor(providers: SearchProvider[], maxResults = 5) {
    this.providers = providers;
    this.maxResults = maxResults;
    this.operators = providers.some((p) => p.operators);
  }

  async search(query: string): Promise<SearchResult[]> {
    // An operator query goes only to the backends that honor it. To the others
    // `site:docs.python.org asyncio` is four words, and the pages they return
    // for it are off-target ones that fusion would rank beside the real hits —
    // so offering the operator at all would cost more than it bought.
    const honors = this.providers.filter((p) => p.operators);
    // With no such backend the operator is just part of the query, as it was
    // before: a diluted list beats an empty one.
    const targets = hasOperator(query) && honors.length > 0 ? honors : this.providers;
    const lists = await Promise.all(
      targets.map((p) =>
        p.search(query).catch((e: Error) => {
          console.warn("[search] backend failed:", e.message);
          return [] as SearchResult[];
        }),
      ),
    );
    return blend(lists, this.maxResults);
  }
}

/**
 * Does this query carry an operator, rather than merely mention one?
 *
 * Only the two forms a backend advertises: `site:` immediately followed by a
 * domain, and `OR` as a standalone uppercase word. Lowercase `or` is prose and
 * a bare `site:` with nothing after it is a typo, so neither counts.
 */
export function hasOperator(query: string): boolean {
  return /(^|\s)site:\S/i.test(query) || /(^|\s)OR(\s|$)/.test(query);
}

/**
 * The rank constant in reciprocal rank fusion.
 *
 * 60 is Cormack et al.'s original and what every implementation since has used.
 * It sets how steeply rank matters: smaller weights the top hits far more
 * heavily, larger flattens the curve. At 60 a first-place hit scores 1/61 and a
 * tenth-place one 1/70 — close enough that agreement between engines can
 * outweigh position, which is the entire point.
 */
const RRF_K = 60;

/**
 * Merge ranked lists by reciprocal rank fusion, deduped, richest copy wins.
 *
 * Each result scores `1/(k + rank)` in every list it appears in, and those
 * scores add. The consequence worth understanding: a page both engines rank
 * third (2 × 1/63 = 0.032) beats a page one engine ranks first and the other
 * never returns (1/61 = 0.016). **Agreement between independent engines is
 * itself evidence**, and it is the signal a plain interleave throws away — the
 * earlier version of this function put both those pages in the same order they
 * arrived and treated the corroborated one as unremarkable.
 *
 * Rank rather than score, because the scores are not comparable: a keyword
 * engine's BM25 and a neural engine's cosine similarity live on different
 * scales that no normalization makes commensurate. Rank is the one thing every
 * engine agrees on the meaning of.
 *
 * RRF is not free — measured against carefully normalized score fusion on
 * benchmark datasets it loses a few percent of NDCG. That trade is right here:
 * we get no scores from these APIs at all, so the alternative isn't tuned score
 * fusion, it's the interleave this replaces.
 */
export function blend(lists: SearchResult[][], maxResults: number): SearchResult[] {
  const merged = new Map<string, { hit: SearchResult; score: number; seen: number }>();
  for (const list of lists) {
    list.forEach((hit, rank) => {
      if (!hit?.url) return;
      const key = dedupeKey(hit.url);
      const points = 1 / (RRF_K + rank + 1); // ranks are 1-based in the formula
      const found = merged.get(key);
      if (!found) {
        merged.set(key, { hit: { ...hit }, score: points, seen: 1 });
        return;
      }
      found.score += points;
      found.seen++;
      // Same page from another backend: keep whichever fields are better. One
      // engine finds it, another explains it.
      if (!found.hit.text && hit.text) found.hit.text = hit.text;
      if (hit.snippet.length > found.hit.snippet.length) found.hit.snippet = hit.snippet;
      if (!found.hit.title && hit.title) found.hit.title = hit.title;
    });
  }
  return [...merged.values()]
    .sort((a, b) => b.score - a.score)
    .slice(0, maxResults)
    .map((m) => m.hit);
}

/**
 * A URL reduced to the page it identifies, for deduping across backends.
 *
 * Conservative on purpose: scheme, `www.`, a trailing slash and tracking
 * parameters are noise, but a query string usually is not — `?id=42` and
 * `?id=43` are different pages, and merging them would silently drop a source.
 */
const TRACKING = /^(utm_|ref$|referrer$|fbclid$|gclid$|mc_[ce]id$|_hs)/i;
export function dedupeKey(raw: string): string {
  try {
    const url = new URL(raw);
    for (const k of [...url.searchParams.keys()]) {
      if (TRACKING.test(k)) url.searchParams.delete(k);
    }
    const host = url.hostname.replace(/^www\./i, "").toLowerCase();
    const path = url.pathname.replace(/\/+$/, "");
    url.searchParams.sort();
    const q = url.searchParams.toString();
    return `${host}${path}${q ? `?${q}` : ""}`;
  } catch {
    return raw;
  }
}

/**
 * Builds the configured search provider from `config.search`, or null when
 * search is disabled (`provider: "none"`, or a provider with no key). The
 * single place a search backend is selected — everything else takes a
 * `SearchProvider`.
 */
/**
 * The search a particular user gets: their own engines when they have
 * connected any, the deployment's otherwise.
 *
 * A user who brought one key gets that engine alone rather than a blend with
 * the deployment's — blending would spend the operator's Exa credits on a
 * request the user is paying for, which is the arrangement they opted out of.
 * Several of their own keys blend with each other, as a deployment's would.
 */
export async function searchProviderFor(
  store: Store,
  sub: string | undefined,
  role?: Role,
): Promise<SearchProvider | null> {
  const cfg = getConfig().search;
  const mine = connectedProviders(store, sub, "search");
  if (mine.length > 0) {
    const built: SearchProvider[] = [];
    for (const id of mine) {
      const key = await credentialFor(store, sub, "search", id);
      const p = key ? backend(id, key, undefined, cfg.maxResults) : null;
      if (p) built.push(p);
    }
    if (built.length === 1) return built[0]!;
    if (built.length > 1) return new BlendSearchProvider(built, cfg.maxResults);
    // Every one of theirs failed to resolve; fall through to the instance's.
  }
  return instanceSearchFor(role, cfg);
}

/**
 * The instance's own search, narrowed to the engines this role may spend.
 *
 * DuckDuckGo is allowed by name even where the deployment never configured it:
 * it takes no key, so there is no cost to bound and nothing for an operator to
 * have opted into. Everything else has to be both configured here and named by
 * the role.
 */
function instanceSearchFor(role: Role | undefined, cfg: Config["search"]): SearchProvider | null {
  if (!role) return createSearchProvider(cfg);
  const named = (id: string) => roleMaySearch(role, id);

  const configured = cfg.backends?.length
    ? cfg.backends.filter((b) => named(b.provider))
    : cfg.provider !== "none" && cfg.provider !== "default" && named(cfg.provider)
      ? [
          {
            provider: cfg.provider,
            apiKey: cfg.apiKey,
            endpoint: cfg.endpoint,
            searchType: cfg.searchType,
          },
        ]
      : [];

  if (configured.length > 0) {
    return createSearchProvider({ ...cfg, provider: "none", backends: configured });
  }
  // Nothing of the instance's is open to them; the keyless engine still is, if
  // the role names it.
  if (named("duckduckgo")) return new DuckDuckGoSearchProvider({ maxResults: cfg.maxResults });
  return null;
}

export function createSearchProvider(
  cfg: Config["search"] = getConfig().search,
): SearchProvider | null {
  // A blend, when one is configured: build every backend that has what it
  // needs, and fall through to the single-provider path if none of them do.
  if (cfg.backends?.length) {
    const built = cfg.backends
      .map((b) => backend(b.provider, b.apiKey, b.endpoint, cfg.maxResults, b.searchType))
      .filter((p): p is SearchProvider => p !== null);
    if (built.length === 1) return built[0]!;
    if (built.length > 1) return new BlendSearchProvider(built, cfg.maxResults);
  }
  // "default" means nobody chose: search still works, on the keyless backend.
  if (cfg.provider === "default") {
    return cfg.apiKey ? null : new DuckDuckGoSearchProvider({ maxResults: cfg.maxResults });
  }
  return backend(cfg.provider, cfg.apiKey, cfg.endpoint, cfg.maxResults, cfg.searchType);
}

/** One backend by name, or null when it lacks the key it needs. */
function backend(
  name: string,
  apiKey: string | undefined,
  endpoint: string | undefined,
  maxResults: number,
  searchType?: string,
): SearchProvider | null {
  switch (name) {
    case "ceramic":
      return apiKey ? new CeramicSearchProvider({ apiKey, endpoint, maxResults }) : null;
    case "llmsolutions":
      return apiKey ? new LlmSolutionsSearchProvider({ apiKey, endpoint, maxResults }) : null;
    case "hackclub":
      return apiKey ? new HackClubSearchProvider({ apiKey, endpoint, maxResults }) : null;
    case "exa":
      return apiKey ? new ExaSearchProvider({ apiKey, endpoint, maxResults, searchType }) : null;
    case "duckduckgo":
      return new DuckDuckGoSearchProvider({ endpoint, maxResults });
    default:
      return null; // "none"
  }
}
