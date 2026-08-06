import type { CatalogModel } from "./catalog";

/**
 * Model discovery and enrichment for providers the catalog doesn't know.
 * Ported from crush's internal/discover: the universal first pass is the
 * OpenAI-compatible `{base}/models` listing; provider types can then register
 * an Enricher that backfills metadata (context windows, pricing, reasoning)
 * from richer endpoints or richer listing payloads.
 *
 * Both stages fail soft: a discovery or enrichment error leaves the models as
 * they are rather than failing startup. Enrichers never overwrite fields the
 * operator already set inline.
 */

export interface DiscoverConfig {
  id: string;
  /** Env-resolved base URL, e.g. `https://hyper.charm.land/v1`. */
  baseUrl: string;
  /** Env-resolved API key, sent as a bearer token (listings may be public). */
  apiKey?: string;
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
}

export interface Enricher {
  /**
   * `raw` is the decoded `{base}/models` payload discovery produced. Enrichers
   * that need a *different* endpoint fetch it themselves via cfg.fetchImpl.
   */
  enrichModels(cfg: DiscoverConfig, models: CatalogModel[], raw: unknown): Promise<CatalogModel[]>;
}

const enrichers = new Map<string, Enricher>();

/** One enricher per provider type; last registration wins. */
export function registerEnricher(providerType: string, e: Enricher): void {
  enrichers.set(providerType, e);
}

export function getEnricher(providerType: string): Enricher | undefined {
  return enrichers.get(providerType);
}

/** GET `{baseUrl}{path}` with bearer auth, decoded as JSON. Soft-fails. */
async function fetchJson(cfg: DiscoverConfig, path: string): Promise<unknown | undefined> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), cfg.timeoutMs ?? 10_000);
  try {
    const headers: Record<string, string> = {};
    if (cfg.apiKey) headers.Authorization = `Bearer ${cfg.apiKey}`;
    const res = await (cfg.fetchImpl ?? fetch)(cfg.baseUrl + path, {
      headers,
      signal: ctrl.signal,
    });
    if (!res.ok) return undefined;
    return await res.json();
  } catch {
    return undefined;
  } finally {
    clearTimeout(timer);
  }
}

function emptyModel(id: string, name: string): CatalogModel {
  return {
    id,
    name,
    contextWindow: 0,
    defaultMaxTokens: 0,
    costPer1MIn: 0,
    costPer1MOut: 0,
    costPer1MInCached: 0,
    costPer1MOutCached: 0,
    canReason: false,
    reasoningLevels: [],
    supportsImages: false,
  };
}

/** Parsed id/name skeletons plus the raw listing, for enrichment. */
export interface DiscoveryResult {
  models: CatalogModel[];
  raw: unknown;
}

/**
 * Generic model listing: `{base}/models` in the OpenAI shape
 * (`{"data":[{"id":...}]}`). Returns models with only id/name populated;
 * metadata is the enrichers' job. The raw payload is returned alongside so
 * enrichers can mine it without a second round trip.
 */
export async function discoverModels(cfg: DiscoverConfig): Promise<DiscoveryResult> {
  const raw = await fetchJson(cfg, "/models");
  const data =
    raw && typeof raw === "object" && Array.isArray((raw as { data?: unknown }).data)
      ? (raw as { data: unknown[] }).data
      : [];

  const out: CatalogModel[] = [];
  for (const entry of data) {
    if (!entry || typeof entry !== "object") continue;
    const id = (entry as { id?: unknown }).id;
    if (typeof id !== "string" || id.length === 0) continue;
    const name = (entry as { name?: unknown }).name;
    out.push(emptyModel(id, typeof name === "string" && name ? name : id));
  }
  return { models: out, raw };
}

/**
 * Runs the enricher registered for `providerType`, if any. Errors are logged
 * and swallowed: un-enriched models beat no models.
 */
export async function enrichModels(
  providerType: string | undefined,
  cfg: DiscoverConfig,
  models: CatalogModel[],
  raw: unknown,
): Promise<CatalogModel[]> {
  const enricher = providerType ? enrichers.get(providerType) : undefined;
  if (!enricher || models.length === 0) return models;
  try {
    return await enricher.enrichModels(cfg, models, raw);
  } catch (err) {
    console.warn(
      `discover: enricher "${providerType}" failed (${(err as Error).message}); keeping un-enriched models`,
    );
    return models;
  }
}

/**
 * Hyper (hyper.charm.land): its `/v1/models` listing is the standard OpenAI
 * shape extended with catwalk-style metadata, so the same response the
 * discovery pass consumed doubles as the enrichment source.
 *
 * Pricing is per-million-token USD. All Hyper models are reasoning models;
 * effort levels arrive under `reasoning.effort_levels`.
 */
interface HyperModelMeta {
  id: string;
  display_name?: string;
  context_window?: number;
  max_output_tokens?: number;
  capabilities?: { vision?: boolean };
  reasoning?: {
    effort_levels?: Array<{ value: string; display?: string }>;
    default_effort_level?: string;
  };
  pricing?: {
    input?: number;
    output?: number;
    cache_create?: number;
    cache_hit?: number;
  };
}

registerEnricher("hyper", {
  async enrichModels(_cfg, models, raw) {
    const data =
      raw && typeof raw === "object" && Array.isArray((raw as { data?: unknown }).data)
        ? (raw as { data: unknown[] }).data
        : undefined;
    if (!data) return models;

    const metaById = new Map<string, HyperModelMeta>();
    for (const entry of data) {
      if (entry && typeof entry === "object" && typeof (entry as HyperModelMeta).id === "string") {
        metaById.set((entry as HyperModelMeta).id, entry as HyperModelMeta);
      }
    }

    return models.map((m) => {
      const meta = metaById.get(m.id);
      if (!meta) return m;
      // Fill only what the operator (or discovery) left empty.
      return {
        ...m,
        name: m.name === m.id && meta.display_name ? meta.display_name : m.name,
        contextWindow: m.contextWindow || meta.context_window || 0,
        defaultMaxTokens: m.defaultMaxTokens || meta.max_output_tokens || 0,
        costPer1MIn: m.costPer1MIn || meta.pricing?.input || 0,
        costPer1MOut: m.costPer1MOut || meta.pricing?.output || 0,
        costPer1MInCached: m.costPer1MInCached || meta.pricing?.cache_hit || 0,
        canReason: m.canReason || meta.reasoning !== undefined,
        reasoningLevels:
          m.reasoningLevels.length > 0
            ? m.reasoningLevels
            : (meta.reasoning?.effort_levels ?? []).map((l) => l.value),
        defaultReasoningEffort: m.defaultReasoningEffort ?? meta.reasoning?.default_effort_level,
        supportsImages: m.supportsImages || meta.capabilities?.vision === true,
      };
    });
  },
});
