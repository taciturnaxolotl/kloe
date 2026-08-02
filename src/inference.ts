import { streamText, type LanguageModel } from "ai";
import { ProviderRegistry } from "./providers";
import { RateLimiter } from "./ratelimit";
import { loadCatalog, type LoadCatalogOptions } from "./catalog";

/**
 * The inference layer. Models are addressed as `provider/model` refs. Each
 * enabled provider gets its own rate limiter so a hot provider can't starve
 * the others, and 429s back off per-provider rather than globally.
 *
 * Because the catalog is loaded asynchronously (live fetch + fallback), the
 * registry is built by `initInference()` at startup rather than at module load.
 * Tests can bypass that with `setRegistry`.
 */
let registry: ProviderRegistry | null = null;
let initPromise: Promise<ProviderRegistry> | null = null;
const limiters = new Map<string, RateLimiter>();

export function setRegistry(r: ProviderRegistry): void {
  registry = r;
  initPromise = Promise.resolve(r);
  limiters.clear();
}

export function getRegistry(): ProviderRegistry {
  if (!registry) {
    throw new Error("inference not initialized: call initInference() first");
  }
  return registry;
}

/**
 * Loads the catalog and builds the provider registry. Idempotent: concurrent or
 * repeated calls share one in-flight load rather than re-fetching and clobbering
 * limiter state. Pass `force: true` to rebuild (e.g. to reload the catalog).
 */
export function initInference(
  opts: { catalog?: LoadCatalogOptions; configPath?: string; force?: boolean } = {},
): Promise<ProviderRegistry> {
  if (initPromise && !opts.force) return initPromise;
  initPromise = (async () => {
    const catalog = await loadCatalog(opts.catalog);
    const r = new ProviderRegistry(catalog, { configPath: opts.configPath });
    setRegistry(r);
    return r;
  })();
  return initPromise;
}

function limiterFor(providerName: string): RateLimiter | undefined {
  const config = getRegistry().getConfig(providerName);
  if (!config) return undefined; // echo / unknown: no limiting
  let l = limiters.get(providerName);
  if (!l) {
    l = new RateLimiter(config);
    limiters.set(providerName, l);
  }
  return l;
}

/** Resolves a model ref to a rate-limited LanguageModel. */
export function resolveModel(modelRef: string): LanguageModel {
  const model = getRegistry().resolveModel(modelRef);
  const providerName = modelRef.split("/")[0]!;
  const limiter = limiterFor(providerName);
  return limiter ? limiter.wrap(model) : model;
}

export interface RunOptions {
  model: string;
  runId: string;
  abortSignal?: AbortSignal;
  temperature?: number;
}

export async function* run(
  prompt: string,
  opts: RunOptions,
): AsyncGenerator<{ kind: "text"; chunk: string }> {
  const model = resolveModel(opts.model);
  const result = streamText({
    model,
    prompt,
    temperature: opts.temperature ?? 0.7,
    abortSignal: opts.abortSignal,
  });
  for await (const chunk of result.textStream) {
    yield { kind: "text", chunk };
  }
}
