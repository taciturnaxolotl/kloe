import { streamText, stepCountIs, type LanguageModel, type ModelMessage, type JSONValue } from "ai";
import { toolSet } from "./tools";
import { MAX_TOOL_STEPS } from "./config";
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

/** Catalog metadata for a model ref, or undefined if unknown/uninitialized. */
function modelInfo(modelRef: string) {
  try {
    return getRegistry().listModels().find((m) => m.ref === modelRef);
  } catch {
    return undefined;
  }
}

/** Whether a model can accept image inputs (false for unknown refs). */
export function modelSupportsImages(modelRef: string): boolean {
  return modelInfo(modelRef)?.supportsImages ?? false;
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
  // Per-provider knobs from ops config: an output-token cap, and raw
  // provider-specific options (e.g. a reasoning/thinking toggle) sent under the
  // provider's key. Absent for echo/unknown providers.
  const providerName = opts.model.split("/")[0]!;
  const cfg = getRegistry().getConfig(providerName);
  // Only send tools when some are configured (e.g. web_search needs a search
  // provider) — a toolless deployment sends no `tools`, so endpoints that reject
  // an unknown tools field are unaffected.
  const tools = toolSet();
  const hasTools = Object.keys(tools).length > 0;
  // Output cap: an explicit provider override wins; otherwise fall back to the
  // model's own default/max from the catalog (e.g. Hyper reports 384K). Sending
  // it prevents the endpoint's low default from cutting a run off mid-reasoning
  // (which surfaced as finishReason=length with no answer text).
  const maxOutputTokens = cfg?.maxOutputTokens || modelInfo(opts.model)?.defaultMaxTokens || undefined;
  const result = streamText({
    model,
    messages,
    temperature: opts.temperature ?? 0.7,
    abortSignal: opts.abortSignal,
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    ...(cfg?.providerOptions
      ? { providerOptions: { [providerName]: cfg.providerOptions as Record<string, JSONValue> } }
      : {}),
    // Tools + a step cap: streamText runs the agentic loop (call → execute →
    // feed back), bounded so a runaway can't loop forever.
    ...(hasTools ? { tools, stopWhen: stepCountIs(MAX_TOOL_STEPS) } : {}),
  });
  // Consume the FULL stream (not just textStream) so reasoning models — whose
  // answer arrives as reasoning parts — come through instead of an empty turn.
  // `error` parts are surfaced as throws so the actor records a run-error rather
  // than a silent stop.
  let textChunks = 0;
  for await (const part of result.fullStream) {
    if (part.type === "text-delta") {
      textChunks++;
      yield { kind: "text", chunk: part.text };
    } else if (part.type === "reasoning-delta") {
      yield { kind: "reasoning", chunk: part.text };
    } else if (part.type === "tool-call") {
      yield { kind: "tool-call", toolCallId: part.toolCallId, toolName: part.toolName, input: part.input };
    } else if (part.type === "tool-result") {
      yield { kind: "tool-result", toolCallId: part.toolCallId, toolName: part.toolName, output: part.output };
    } else if (part.type === "tool-error") {
      yield {
        kind: "tool-result",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        output: String(part.error),
        isError: true,
      };
    } else if (part.type === "error") {
      throw part.error;
    }
    // Other parts (start/end markers, tool events, step boundaries) are ignored
    // here; tool support consumes them in a later slice.
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
  // A model that streamed no text at all is abnormal (a misconfigured endpoint,
  // a content filter, or a reasoning model whose output arrives outside the text
  // stream). Surface why — finish reason, any warnings, and whether text landed
  // off-stream — so it isn't a silent empty turn.
  if (textChunks === 0) {
    try {
      const [finishReason, warnings, text, reasoning] = await Promise.all([
        result.finishReason,
        result.warnings,
        result.text,
        Promise.resolve(result.reasoningText).catch(() => undefined),
      ]);
      console.warn(
        `[run ${opts.runId}] streamed 0 text chunks — finishReason=${finishReason}, ` +
          `text.length=${text?.length ?? 0}, reasoning.length=${reasoning?.length ?? 0}, ` +
          `warnings=${JSON.stringify(warnings ?? [])}`,
      );
    } catch (err) {
      console.warn(`[run ${opts.runId}] streamed 0 text chunks; diagnostics failed:`, err);
    }
  }
}
