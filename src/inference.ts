import { type JSONValue, type LanguageModel, type ModelMessage, stepCountIs, streamText } from "ai";
import type { RunStep } from "./actor";
import { type LoadCatalogOptions, loadCatalog } from "./catalog";
import type { TokenUsage } from "./events";
import { contextToText, getContext, lardConnected, lardEnabled } from "./lard";
import { buildSystemPrompt } from "./prompt";
import { ProviderRegistry } from "./providers";
import { RateLimiter } from "./ratelimit";
import { getConfig } from "./settings";
import type { Store } from "./store";
import { toolSet } from "./tools";

/**
 * True when provider reasoning metadata carries a signature — the marker of a
 * signed thinking block (Anthropic) that must be echoed back verbatim on replay.
 * Scopes preservation to genuinely signed reasoning so ordinary reasoning (which
 * carries no signature) isn't needlessly persisted and re-sent.
 */
function hasSignature(meta: Record<string, Record<string, unknown>>): boolean {
  for (const provider of Object.values(meta)) {
    if (
      provider &&
      typeof provider === "object" &&
      typeof provider.signature === "string" &&
      provider.signature.length > 0
    ) {
      return true;
    }
  }
  return false;
}

interface RawUsage {
  inputTokens?: number;
  outputTokens?: number;
  totalTokens?: number;
  inputTokenDetails?: {
    noCacheTokens?: number;
    cacheReadTokens?: number;
    cacheWriteTokens?: number;
  };
}

function finite(n: number | undefined): number {
  return Number.isFinite(n) ? n! : 0;
}

/**
 * The prompt actually sent on a step, in tokens, per the provider.
 *
 * Endpoints disagree on whether their input count already includes a prompt
 * cache hit. OpenAI's `prompt_tokens` does; the one behind hyper.charm.land does
 * not, which is why a warm turn on a 250k conversation reports 650. Crush hits
 * the same endpoint and adds the cache read back unconditionally
 * (`updateSessionTokenCounters`), because its SDK normalizes to cache-exclusive.
 *
 * The AI SDK normalizes the other way, so adding unconditionally would double
 * count on OpenAI. The tell is `noCacheTokens`, which the adapter derives as
 * `input - cacheRead`: it can only go negative when the input was already net of
 * the cache. That's the case, and the only case, where the read must be added.
 */
function promptTokens(u: RawUsage): number {
  const input = finite(u.inputTokens);
  const cacheRead = finite(u.inputTokenDetails?.cacheReadTokens);
  const noCache = u.inputTokenDetails?.noCacheTokens;
  const netOfCache = Number.isFinite(noCache) && noCache! < 0;
  return netOfCache ? input + cacheRead : input;
}

/** Rough tokens-per-character for the estimator. Coarse on purpose — the gauge
 *  is labelled approximate, and being within ~20% beats being wrong by 100x. */
const CHARS_PER_TOKEN = 4;

/**
 * What one attached image or file is worth, in estimator characters (~1.5k
 * tokens — the ballpark for a vision model's tiling of a screenshot).
 *
 * A binary part costs a flat handful of tokens, nothing like its byte length,
 * and its `data` is a Uint8Array: serializing it would count `{"0":137,"1":80…}`
 * at roughly six characters per BYTE, so a single screenshot would peg the gauge
 * and — since occupancy takes the larger of the two sources — never let go.
 */
const FILE_PART_CHARS = 6_000;

/** Size of a prompt as sent, in characters — text and tool traffic alike. */
export function promptChars(messages: ModelMessage[]): number {
  let n = 0;
  for (const m of messages) {
    if (typeof m.content === "string") {
      n += m.content.length;
      continue;
    }
    for (const part of m.content) {
      const p = part as { type?: string; text?: string };
      if (typeof p.text === "string") n += p.text.length;
      else if (p.type === "file" || p.type === "image") n += FILE_PART_CHARS;
      else n += JSON.stringify(part).length; // tool call/result: the JSON is the payload
    }
  }
  return n;
}

/**
 * The usage stamped onto message-end, from the run's total, its final step, and
 * our own measurement of the conversation.
 *
 * Three numbers, because they answer three different questions:
 *
 * `total` sums every step of a tool loop, and each step re-sends the whole
 * conversation — it's what the turn cost. `final` is the last prompt actually
 * sent plus its reply. `chars` is what we handed the provider plus what came
 * back, measured here.
 *
 * Occupancy prefers the provider — a real tokenizer beats any guess — and keeps
 * the measurement as a floor. An endpoint that reports neither a usable input
 * count nor a cache read still under-reports (caching only ever shrinks the
 * number; nothing inflates a prompt beyond what was sent), so the larger of the
 * two is right without having to sniff which endpoint we're on. When the floor
 * wins, say so: `contextEstimated` earns the gauge a `~`.
 */
export function usageFor(
  total: RawUsage,
  final?: RawUsage,
  chars?: number,
): TokenUsage | undefined {
  const out: TokenUsage = {};
  if (Number.isFinite(total.inputTokens)) out.inputTokens = total.inputTokens;
  if (Number.isFinite(total.outputTokens)) out.outputTokens = total.outputTokens;
  if (Number.isFinite(total.totalTokens)) out.totalTokens = total.totalTokens;
  if (Object.keys(out).length === 0) return undefined;
  const reported = final ? promptTokens(final) + finite(final.outputTokens) : 0;
  const measured = chars && chars > 0 ? Math.round(chars / CHARS_PER_TOKEN) : 0;
  const occupancy = Math.max(reported, measured);
  if (occupancy > 0) {
    out.contextTokens = occupancy;
    if (measured > reported) out.contextEstimated = true;
  }
  return out;
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
    return getRegistry()
      .listModels()
      .find((m) => m.ref === modelRef);
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

/** Project-scoped context to fold into a run: the pinned lard project (whose
 *  area is pulled into memory) and the project's uploaded context files. */
export interface RunProject {
  lardProject?: string;
  contextFiles?: Array<{ filename: string; body: string }>;
}

export interface RunOptions {
  model: string;
  runId: string;
  abortSignal?: AbortSignal;
  temperature?: number;
  /** For per-user lard: the run's store + the conversation owner's `sub`. */
  store?: Store;
  owner?: string;
  /** The conversation, so the sandbox binds to its persistent per-chat container. */
  conversationId?: string;
  /** Set when the conversation is filed under a project. */
  project?: RunProject;
}

export async function* run(messages: ModelMessage[], opts: RunOptions): AsyncGenerator<RunStep> {
  const model = resolveModel(opts.model);
  // Per-provider knobs from ops config: an output-token cap, and raw
  // provider-specific options (e.g. a reasoning/thinking toggle) sent under the
  // provider's key. Absent for echo/unknown providers.
  const providerName = opts.model.split("/")[0]!;
  const cfg = getRegistry().getConfig(providerName);
  // Only send tools when some are configured (e.g. web_search needs a search
  // provider) — a toolless deployment sends no `tools`, so endpoints that reject
  // an unknown tools field are unaffected.
  const tools = toolSet({
    store: opts.store,
    owner: opts.owner,
    conversationId: opts.conversationId,
  });
  const hasTools = Object.keys(tools).length > 0;
  // Output cap: an explicit provider override wins; otherwise fall back to the
  // model's own default/max from the catalog (e.g. Hyper reports 384K). Sending
  // it prevents the endpoint's low default from cutting a run off mid-reasoning
  // (which surfaced as finishReason=length with no answer text).
  const maxOutputTokens =
    cfg?.maxOutputTokens || modelInfo(opts.model)?.defaultMaxTokens || undefined;
  const maxToolSteps = getConfig().agent.maxToolSteps;
  // Per-user durable memory (lard): fold the owner's context bundle into the
  // prompt. Best-effort — a failed/absent fetch never blocks the run.
  let memory = "";
  if (opts.store && opts.owner && lardEnabled() && lardConnected(opts.store, opts.owner)) {
    // A project pins a lard project so its area is pulled alongside the profile.
    try {
      memory = contextToText(await getContext(opts.store, opts.owner, opts.project?.lardProject));
    } catch (e) {
      console.error("lard context:", (e as Error).message);
    }
  }
  // System prompt: grounds the turn in the current date, the durable memory, the
  // project's context files, and which tools it may reach for (built from the
  // set actually exposed above).
  const system = buildSystemPrompt({ tools, memory, contextFiles: opts.project?.contextFiles });
  const result = streamText({
    model,
    system,
    messages,
    temperature: opts.temperature ?? 0.7,
    abortSignal: opts.abortSignal,
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    ...(cfg?.providerOptions
      ? { providerOptions: { [providerName]: cfg.providerOptions as Record<string, JSONValue> } }
      : {}),
    // Tools + a step cap: streamText runs the agentic loop (call → execute →
    // feed back), bounded so a runaway can't loop forever.
    // 0 → unlimited: never force-stop, so the loop runs until the model stops
    // calling tools or the user cancels (abortSignal). A positive cap bounds it.
    ...(hasTools
      ? { tools, stopWhen: maxToolSteps > 0 ? stepCountIs(maxToolSteps) : () => false }
      : {}),
  });
  // Consume the FULL stream (not just textStream) so reasoning models — whose
  // answer arrives as reasoning parts — come through instead of an empty turn.
  // `error` parts are surfaced as throws so the actor records a run-error rather
  // than a silent stop.
  let textChunks = 0;
  // Everything this run adds to the conversation, measured as it goes: the next
  // prompt carries the prompt we sent PLUS this turn's answer and tool traffic,
  // and on a tool-heavy turn the tool results dwarf both. The system prompt is
  // sent on every request, so it's resident too.
  let grownChars = system.length + promptChars(messages);
  // Per-reasoning-block provider metadata (keyed by the stream's block id). The
  // signature that must be echoed on replay arrives on the reasoning parts; we
  // accumulate it and, at the block's end, emit it so the actor can persist it.
  const reasoningMeta = new Map<string, Record<string, Record<string, unknown>>>();
  for await (const part of result.fullStream) {
    if (part.type === "text-delta") {
      textChunks++;
      grownChars += part.text.length;
      yield { kind: "text", chunk: part.text };
    } else if (part.type === "reasoning-delta") {
      if (part.providerMetadata)
        reasoningMeta.set(
          part.id,
          part.providerMetadata as Record<string, Record<string, unknown>>,
        );
      yield { kind: "reasoning", chunk: part.text };
    } else if (part.type === "reasoning-end") {
      // A signed reasoning block (Anthropic thinking): preserve its metadata so
      // history() can echo it back. Only when a signature is actually present —
      // unsigned reasoning (most providers) is dropped from history as before.
      const meta =
        (part.providerMetadata as Record<string, Record<string, unknown>>) ??
        reasoningMeta.get(part.id);
      if (meta && hasSignature(meta)) yield { kind: "reasoning-signature", providerOptions: meta };
    } else if (part.type === "tool-call") {
      grownChars += JSON.stringify(part.input ?? "").length;
      yield {
        kind: "tool-call",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        input: part.input,
      };
    } else if (part.type === "tool-result") {
      grownChars += JSON.stringify(part.output ?? "").length;
      yield {
        kind: "tool-result",
        toolCallId: part.toolCallId,
        toolName: part.toolName,
        output: part.output,
      };
    } else if (part.type === "tool-error") {
      // A tool's execute threw (e.g. the search backend errored). The SDK feeds
      // it back to the model as an error result; log it too so a flaky tool is
      // visible in the server logs, not just buried in the transcript.
      console.error(`[run ${opts.runId}] tool ${part.toolName} failed:`, part.error);
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
    const usage = usageFor(await result.usage, (await result.finalStep)?.usage, grownChars);
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
