import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

/**
 * The model/provider *catalog*: universal metadata (endpoints, context windows,
 * pricing, capabilities) sourced from charmbracelet's catwalk. This layer is
 * read-only and identical across deployments — it's the "what models exist and
 * what are they like" concern, kept separate from deployment ops config
 * (which providers are enabled, secrets, rate limits) and runtime curation
 * (which models the chat UI shows).
 *
 * Sourced via live fetch with a disk cache and a vendored seed fallback, so a
 * catwalk outage or offline dev never takes kloe down.
 */

const DEFAULT_URL = "https://catwalk.charm.land/v2/providers";
const DEFAULT_CACHE = ".cache/catwalk.json";
const DEFAULT_SEED = "vendor/catwalk.seed.json";
const DEFAULT_TIMEOUT_MS = 10_000;

/**
 * Adapter family, driving which AI SDK factory the registry constructs. Kept as
 * a widened string because catwalk lists ~9 types; unknown ones fall back to
 * the OpenAI-compatible adapter.
 */
export type ProviderType =
  | "anthropic"
  | "openai"
  | "openai-compat"
  | "openrouter"
  | (string & {});

export interface CatalogModel {
  id: string;
  name: string;
  contextWindow: number;
  defaultMaxTokens: number;
  costPer1MIn: number;
  costPer1MOut: number;
  costPer1MInCached: number;
  costPer1MOutCached: number;
  canReason: boolean;
  reasoningLevels: string[];
  defaultReasoningEffort?: string;
  supportsImages: boolean;
}

export interface CatalogProvider {
  id: string;
  name: string;
  type: ProviderType;
  /** May be a "$ENV_VAR" interpolation string; resolved by the registry. */
  apiEndpoint?: string;
  /** May be a "$ENV_VAR" interpolation string; resolved by the registry. */
  apiKey?: string;
  models: CatalogModel[];
}

/** Raw catwalk JSON (snake_case), as served by the API and the vendored seed. */
export interface RawModel {
  id: string;
  name?: string;
  cost_per_1m_in?: number;
  cost_per_1m_out?: number;
  cost_per_1m_in_cached?: number;
  cost_per_1m_out_cached?: number;
  context_window?: number;
  default_max_tokens?: number;
  can_reason?: boolean;
  reasoning_levels?: string[];
  default_reasoning_effort?: string;
  supports_attachments?: boolean;
}

interface RawProvider {
  id: string;
  name: string;
  type?: string;
  api_endpoint?: string;
  api_key?: string;
  models?: RawModel[];
}

/** Requires a non-empty string, else throws — guards against garbage payloads. */
function reqStr(value: unknown, field: string): string {
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`catalog: entry has invalid "${field}" (${JSON.stringify(value)})`);
  }
  return value;
}

/**
 * Parses one model entry from raw catwalk JSON (snake_case). Exported so
 * `providers.json` can carry inline model lists for providers that aren't in
 * the catalog.
 */
export function parseModel(m: RawModel): CatalogModel {
  const id = reqStr(m.id, "model.id");
  return {
    id,
    name: typeof m.name === "string" && m.name.length > 0 ? m.name : id,
    contextWindow: m.context_window ?? 0,
    defaultMaxTokens: m.default_max_tokens ?? 0,
    costPer1MIn: m.cost_per_1m_in ?? 0,
    costPer1MOut: m.cost_per_1m_out ?? 0,
    costPer1MInCached: m.cost_per_1m_in_cached ?? 0,
    costPer1MOutCached: m.cost_per_1m_out_cached ?? 0,
    canReason: m.can_reason ?? false,
    reasoningLevels: m.reasoning_levels ?? [],
    defaultReasoningEffort: m.default_reasoning_effort,
    supportsImages: m.supports_attachments ?? false,
  };
}

function parseProvider(p: RawProvider): CatalogProvider {
  const id = reqStr(p.id, "provider.id");
  return {
    id,
    name: typeof p.name === "string" && p.name.length > 0 ? p.name : id,
    type: p.type ?? "openai-compat",
    apiEndpoint: p.api_endpoint,
    apiKey: p.api_key,
    models: (p.models ?? []).map(parseModel),
  };
}

/** Parsed, indexed view of the catalog. */
export class Catalog {
  private readonly providers = new Map<string, CatalogProvider>();
  /** `${providerId}/${modelId}` → model, for O(1) resolution. */
  private readonly models = new Map<string, CatalogModel>();

  private constructor(providers: CatalogProvider[]) {
    for (const p of providers) {
      this.providers.set(p.id, p);
      for (const m of p.models) this.models.set(`${p.id}/${m.id}`, m);
    }
  }

  /** Builds a Catalog from raw catwalk JSON (a top-level array of providers). */
  static fromRaw(raw: unknown): Catalog {
    if (!Array.isArray(raw)) {
      throw new Error("catalog: expected a top-level array of providers");
    }
    return new Catalog((raw as RawProvider[]).map(parseProvider));
  }

  getProvider(id: string): CatalogProvider | undefined {
    return this.providers.get(id);
  }

  getModel(providerId: string, modelId: string): CatalogModel | undefined {
    return this.models.get(`${providerId}/${modelId}`);
  }

  listProviders(): CatalogProvider[] {
    return [...this.providers.values()];
  }
}

export interface LoadCatalogOptions {
  url?: string;
  cachePath?: string;
  seedPath?: string;
  timeoutMs?: number;
  /** Injectable for tests. Defaults to global fetch. */
  fetchImpl?: typeof fetch;
}

async function fetchCatalog(url: string, timeoutMs: number, f: typeof fetch): Promise<unknown> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await f(url, { signal: ctrl.signal });
    if (!res.ok) throw new Error(`catwalk responded ${res.status}`);
    return await res.json();
  } finally {
    clearTimeout(timer);
  }
}

function writeCache(path: string, raw: unknown): void {
  try {
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, JSON.stringify(raw));
  } catch {
    // A read-only or missing cache dir must not fail catalog loading.
  }
}

function readJsonFile(path: string): unknown | undefined {
  if (!existsSync(path)) return undefined;
  try {
    return JSON.parse(readFileSync(path, "utf8"));
  } catch {
    return undefined;
  }
}

/**
 * Loads the catalog: live fetch → disk cache → vendored seed. Each fallback is
 * logged so a stale catalog is visible in the logs rather than silent.
 */
export async function loadCatalog(opts: LoadCatalogOptions = {}): Promise<Catalog> {
  const url = opts.url ?? process.env.CATWALK_URL ?? DEFAULT_URL;
  const cachePath = opts.cachePath ?? process.env.CATWALK_CACHE ?? DEFAULT_CACHE;
  const seedPath = opts.seedPath ?? process.env.CATWALK_SEED ?? DEFAULT_SEED;
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const fetchImpl = opts.fetchImpl ?? fetch;

  // 1. Live fetch (and refresh the cache on success).
  try {
    const raw = await fetchCatalog(url, timeoutMs, fetchImpl);
    const catalog = Catalog.fromRaw(raw);
    writeCache(cachePath, raw);
    return catalog;
  } catch (err) {
    console.warn(`catalog: live fetch failed (${(err as Error).message}); falling back to cache/seed`);
  }

  // 2. Disk cache from a previous successful fetch.
  const cached = readJsonFile(cachePath);
  if (cached !== undefined) {
    try {
      return Catalog.fromRaw(cached);
    } catch {
      // corrupt cache: keep falling back
    }
  }

  // 3. Vendored seed committed to the repo.
  const seed = readJsonFile(seedPath);
  if (seed !== undefined) {
    console.warn(`catalog: using vendored seed "${seedPath}"`);
    return Catalog.fromRaw(seed);
  }

  throw new Error(
    "catalog unavailable: live fetch failed and no usable cache or seed found",
  );
}
