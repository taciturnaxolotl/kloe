import { streamText, type LanguageModel, type ModelMessage } from "ai";
import { ProviderRegistry } from "./providers";
import { RateLimiter } from "./ratelimit";
import { loadCatalog, type LoadCatalogOptions } from "./catalog";
import { getConfig } from "./settings";
import type { RunStep } from "./actor";
import type { TokenUsage } from "./events";

/** Keeps only finite token fields; returns undefined if none reported. */
function normalizeUsage(u: {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
}): TokenUsage | undefined {
  const out: TokenUsage = {};
  if (Number.isFinite(u.inputTokens)) out.inputTokens = u.inputTokens;
  if (Number.isFinite(u.outputTokens)) out.outputTokens = u.outputTokens;
  if (Number.isFinite(u.totalTokens)) out.totalTokens = u.totalTokens;
  return Object.keys(out).length > 0 ? out : undefined;
}

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
  opts: { catalog?: LoadCatalogOptions; force?: boolean } = {},
): Promise<ProviderRegistry> {
  if (initPromise && !opts.force) return initPromise;
  initPromise = (async () => {
    const catalog = await loadCatalog(opts.catalog);
    // Providers come from the single validated config (kloe.json + env).
    const r = new ProviderRegistry(catalog, { config: { providers: getConfig().providers } });
    // Live model discovery for non-catalog providers (e.g. Hyper). Soft-fails:
    // the server boots with whatever models were declared inline.
    await r.discover();
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

/** Whether a model can accept image inputs (false for unknown refs). */
export function modelSupportsImages(modelRef: string): boolean {
  try {
    return getRegistry().listModels().find((m) => m.ref === modelRef)?.supportsImages ?? false;
  } catch {
    return false;
  }
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
  messages: ModelMessage[],
  opts: RunOptions,
): AsyncGenerator<RunStep> {
  const model = resolveModel(opts.model);
  const result = streamText({
    model,
    messages,
    temperature: opts.temperature ?? 0.7,
    abortSignal: opts.abortSignal,
  });
  for await (const chunk of result.textStream) {
    yield { kind: "text", chunk };
  }
  // The stream has drained normally (a cancel throws above and skips this):
  // real provider usage is now resolvable. Emit it as the final step so the
  // actor can stamp it onto message-end. Best-effort — a provider that reports
  // no usage simply yields nothing here.
  try {
    const usage = normalizeUsage(await result.usage);
    if (usage) yield { kind: "usage", usage };
  } catch {
    // provider didn't surface usage; leave message-end without it
  }
}
