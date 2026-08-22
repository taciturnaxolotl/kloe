import {
  hasToolCall,
  type JSONValue,
  type LanguageModel,
  type ModelMessage,
  stepCountIs,
  streamText,
  type ToolSet,
} from "ai";
import type { RunStep } from "./actor";
import type { Role } from "./auth";
import type { BlobStore } from "./blobs";
import { type Catalog, type LoadCatalogOptions, loadCatalog } from "./catalog";
import { type Credential, credentialFor } from "./credentials";
import type { TokenUsage } from "./events";
import { contextToText, getContext, LOCAL_SUB, lardConnected, lardEnabled } from "./lard";
import { buildSystemPrompt } from "./prompt";
import { isEchoModel, ProviderRegistry } from "./providers";
import { RateLimiter } from "./ratelimit";
import { searchProviderFor } from "./search";
import { getConfig } from "./settings";
import type { Store } from "./store";
import { ASK_TOOL, type ToolContext, toolSet } from "./tools";
import { metered } from "./usage";

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

/**
 * The key the SDK namespaces provider options under, from a resolved model:
 * "anthropic.messages" → "anthropic". It is the adapter family, not the id kloe
 * knows the provider as, because that is what the adapter reads.
 */
export function providerFamily(model: LanguageModel): string {
  const id = typeof model === "string" ? model : model.provider;
  return id.split(".")[0]!;
}

/**
 * Drops reasoning blocks that a DIFFERENT provider signed. A signed thinking
 * block is a token from one endpoint to itself: Anthropic verifies the
 * signature it issued, and anyone else is handed a block it cannot account for.
 * Switching a conversation's model mid-thread is exactly how history comes to
 * hold foreign blocks, and the endpoint answers the replay with a 400 whose
 * message ("Invalid input") names nothing.
 */
export function dropForeignReasoning(messages: ModelMessage[], family: string): ModelMessage[] {
  const out: ModelMessage[] = [];
  for (const m of messages) {
    if (m.role !== "assistant" || !Array.isArray(m.content)) {
      out.push(m);
      continue;
    }
    const kept = m.content.filter(
      (p) => p.type !== "reasoning" || Object.hasOwn(p.providerOptions ?? {}, family),
    );
    if (kept.length === m.content.length) out.push(m);
    // An assistant turn that was nothing but a foreign thinking block has
    // nothing left to say; an empty message is itself a 400.
    else if (kept.length > 0) out.push({ ...m, content: kept } as ModelMessage);
  }
  return out;
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

/** The model catalog, or null before the registry is built (tests, early boot). */
export function getCatalog(): Catalog | null {
  return registry?.catalog ?? null;
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

/**
 * Candidates for the utility jobs nobody picks a model for — titling, reading
 * an image, a research role.
 *
 * The set the person owning the run keeps in their own picker, because that is
 * the list they have vouched for: a title written by a model they turned off is
 * a small surprise on their bill. Without a person (a script, a test), the
 * instance's starting selection stands in.
 */
function candidateModels(store: Store, sub?: string) {
  const chosen = new Set(store.listUserModels(sub ?? LOCAL_SUB).map((m) => m.ref));
  return getRegistry()
    .listModels()
    .filter((m) => chosen.has(m.ref));
}

/**
 * The model for utility work (titles): `agent.smallModel` when it's set AND
 * enabled, otherwise the cheapest enabled model (least in+out cost per 1M) — so
 * a configured ref that no longer exists gracefully falls back. Null when no
 * model is enabled at all.
 *
 * Two exclusions, both because "cheapest" rewards missing metadata. The echo
 * mock costs nothing, so it won outright whenever it was visible. A model with
 * no context window is one nothing is known about — the catalog coerces absent
 * pricing to zero, so an unlisted model would win the same way. A genuinely free
 * local model still wins, because discovery gives it a real window.
 *
 * An explicitly configured `agent.smallModel` skips both checks: naming it is a
 * choice, inheriting it isn't.
 */
export function resolveSmallModel(store: Store, sub?: string): string | null {
  const enabled = candidateModels(store, sub);
  if (!enabled.length) return null;
  const configured = getConfig().agent.smallModel;
  if (configured && enabled.some((m) => m.ref === configured)) return configured;
  const usable = enabled.filter((m) => !isEchoModel(m.ref) && m.contextWindow > 0);
  if (!usable.length) return null;
  return usable.reduce((a, b) =>
    b.costPer1MIn + b.costPer1MOut < a.costPer1MIn + a.costPer1MOut ? b : a,
  ).ref;
}

/**
 * The model that reads images on behalf of one that can't.
 *
 * Same shape as `resolveSmallModel` and for the same reason: a deployment
 * shouldn't have to configure anything for this to work, but should be able to.
 * `agent.visionModel` wins when set and enabled; otherwise the cheapest enabled
 * model that actually accepts images. Null when the deployment has none — the
 * `read_image` tool is then simply not offered, rather than offered and broken.
 *
 * The echo/no-window exclusions are inherited from the same reasoning: cheapest
 * rewards missing metadata, and a model nothing is known about is not a model to
 * hand a picture to. A configured ref skips them, because naming it is a choice.
 */
export function resolveVisionModel(store: Store, sub?: string): string | null {
  const enabled = candidateModels(store, sub);
  if (!enabled.length) return null;
  const configured = getConfig().agent.visionModel;
  if (configured && enabled.some((m) => m.ref === configured)) return configured;
  const usable = enabled.filter(
    (m) => m.supportsImages && !isEchoModel(m.ref) && m.contextWindow > 0,
  );
  if (!usable.length) return null;
  return usable.reduce((a, b) =>
    b.costPer1MIn + b.costPer1MOut < a.costPer1MIn + a.costPer1MOut ? b : a,
  ).ref;
}

/**
 * A model chosen for one job in a research run: the preference set in the
 * settings page, then the ops config, then nothing — which means "use whatever
 * the conversation is using".
 *
 * A ref that is no longer enabled is ignored rather than honoured, the same as
 * everywhere else: a model that has been turned off should not keep running
 * because a stale row names it.
 */
export function resolveRoleModel(
  store: Store,
  role: "lead" | "worker",
  sub?: string,
): string | null {
  const enabled = new Set(candidateModels(store, sub).map((m) => m.ref));
  const pref = store.getPref(`research.${role}Model`);
  if (pref && enabled.has(pref)) return pref;
  const cfg = role === "lead" ? getConfig().research.leadModel : getConfig().research.workerModel;
  return cfg && enabled.has(cfg) ? cfg : null;
}

/**
 * The reasoning level to actually send: the requested one, but only when the
 * model declares it.
 *
 * Providers answer an unknown effort with a 400, so an out-of-date picker, or a
 * level remembered from a different model, would fail the run rather than
 * degrade. Dropping it costs a preference; sending it costs the turn.
 */
export function effortFor(modelRef: string, requested?: string): string | null {
  if (!requested) return null;
  const levels = modelInfo(modelRef)?.reasoningLevels ?? [];
  return levels.includes(requested) ? requested : null;
}

/** Whether a model can accept image inputs (false for unknown refs). */
export function modelSupportsImages(modelRef: string): boolean {
  return modelInfo(modelRef)?.supportsImages ?? false;
}

/** Resolves a model ref to a rate-limited LanguageModel. */
export function resolveModel(modelRef: string, credential?: Credential): LanguageModel {
  const model = getRegistry().resolveModel(modelRef, credential);
  const providerName = modelRef.split("/")[0]!;
  const limiter = limiterFor(providerName);
  return limiter ? limiter.wrap(model) : model;
}

/**
 * The same, for a named user: their own credential pays when they have one for
 * the provider, and the deployment's key does when they don't.
 *
 * The rate limiter still wraps the result. Its job is to be kind to the
 * endpoint, which does not care whose credits are being spent — and a per-user
 * limiter would let ten connected users open ten times the concurrency against
 * one provider.
 */
export async function resolveModelFor(
  modelRef: string,
  who: { store?: Store; sub?: string; conversationId?: string },
): Promise<LanguageModel> {
  if (!who.store || !who.sub || isEchoModel(modelRef)) return resolveModel(modelRef);
  const providerName = modelRef.split("/")[0]!;
  const credential = await credentialFor(who.store, who.sub, "inference", providerName);
  // Metered here rather than at the turn, because this is where every model a
  // run touches comes from — the utility ones included. Whose credential
  // answered is also what says who pays, so the ledger learns it for free.
  return metered(resolveModel(modelRef, credential), modelRef, {
    store: who.store,
    sub: who.sub,
    payer: credential ? "user" : "instance",
    conversationId: who.conversationId,
  });
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
  /** The role of the conversation's owner; decides sandbox access. */
  role?: Role;
  /** Reasoning level for this run, from the levels the model declares. */
  effort?: string;
  abortSignal?: AbortSignal;
  temperature?: number;
  /** For per-user lard: the run's store + the conversation owner's `sub`. */
  store?: Store;
  /** Where a tool's output files land (agent artifacts share the upload store). */
  blobs?: BlobStore;
  owner?: string;
  /** The conversation, so the sandbox binds to its persistent per-chat container. */
  conversationId?: string;
  /** Set when the conversation is filed under a project. */
  project?: RunProject;
  /**
   * Where a long-running tool reports from mid-execution. Bypasses this
   * generator on purpose (see ConversationActor.toolProgress): while a tool runs,
   * the provider stream — and so this generator — is parked, and anything routed
   * through it would surface only once the tool had already finished.
   */
  onProgress?: ToolContext["onProgress"];
  /** Whether a person is watching: without it `ask_user` isn't offered. */
  canAsk?: boolean;
}

/**
 * When the tool loop stops.
 *
 * The step cap is the runaway guard (0 → uncapped: the loop runs until the model
 * stops calling tools, or the user cancels). `ask_user` is the other one, and it
 * is not a guard but the tool's whole mechanic: asking ENDS the turn. A model
 * that could keep generating past its own question would answer it itself —
 * the failure the tool exists to prevent — so the stop is structural here
 * rather than a line in a prompt asking nicely.
 */
function stopConditions(tools: ToolSet, maxToolSteps: number) {
  const stops = [];
  if (maxToolSteps > 0) stops.push(stepCountIs(maxToolSteps));
  if (ASK_TOOL in tools) stops.push(hasToolCall(ASK_TOOL));
  return stops.length ? stops : () => false;
}

export async function* run(messages: ModelMessage[], opts: RunOptions): AsyncGenerator<RunStep> {
  // Whose credits this run spends: the conversation's owner, when they have
  // connected something of their own. Resolved once, here, and reused for every
  // model this run touches — the utility models included, since a research
  // worker on the deployment's key would quietly undo the whole arrangement.
  const who = { store: opts.store, sub: opts.owner, conversationId: opts.conversationId };
  const model = await resolveModelFor(opts.model, who);
  // Per-provider knobs from ops config: an output-token cap, and raw
  // provider-specific options (e.g. a reasoning/thinking toggle) sent under the
  // provider's key. Absent for echo/unknown providers.
  const providerName = opts.model.split("/")[0]!;
  const cfg = getRegistry().getConfig(providerName);
  // Only send tools when some are configured (e.g. web_search needs a search
  // provider) — a toolless deployment sends no `tools`, so endpoints that reject
  // an unknown tools field are unaffected.
  // A model that can't see images gets a reader instead (the `read_image`
  // tool). Resolved here rather than in tools.ts because picking a model needs
  // the registry, which lives in this module.
  const modelReadsImages = modelSupportsImages(opts.model);
  const visionRef =
    !modelReadsImages && opts.store ? resolveVisionModel(opts.store, opts.owner) : null;
  // Research can run its lead and its workers on different models; unset, both
  // are the conversation's own model.
  const leadRef = opts.store ? resolveRoleModel(opts.store, "lead", opts.owner) : null;
  const workerRef = opts.store ? resolveRoleModel(opts.store, "worker", opts.owner) : null;
  // Whose search this run spends, on the same rule as the model: their own
  // engines when they connected any.
  const search = opts.store ? await searchProviderFor(opts.store, opts.owner, opts.role) : null;
  const tools = toolSet({
    store: opts.store,
    owner: opts.owner,
    role: opts.role,
    search: search ?? undefined,
    conversationId: opts.conversationId,
    blobs: opts.blobs,
    model, // deep_research runs its subagent on the same model as the run
    modelReadsImages,
    visionModel: visionRef ? await resolveModelFor(visionRef, who) : undefined,
    researchLead: leadRef ? await resolveModelFor(leadRef, who) : undefined,
    researchWorker: workerRef ? await resolveModelFor(workerRef, who) : undefined,
    onProgress: opts.onProgress,
    canAsk: opts.canAsk,
  });
  const hasTools = Object.keys(tools).length > 0;
  // Output cap: an explicit provider override wins; otherwise fall back to the
  // model's own default/max from the catalog (e.g. Hyper reports 384K). Sending
  // it prevents the endpoint's low default from cutting a run off mid-reasoning
  // (which surfaced as finishReason=length with no answer text).
  const maxOutputTokens =
    cfg?.maxOutputTokens || modelInfo(opts.model)?.defaultMaxTokens || undefined;
  const maxToolSteps = getConfig().agent.maxToolSteps;
  // Per-provider options, plus this run's reasoning level when one was chosen
  // and the model actually offers it. A level the model does not declare is
  // dropped rather than sent: providers answer an unknown effort with a 400,
  // and a run should not fail because a picker was out of date.
  const effort = effortFor(opts.model, opts.effort);
  const providerOpts: Record<string, JSONValue> | null =
    cfg?.providerOptions || effort
      ? {
          ...((cfg?.providerOptions ?? {}) as Record<string, JSONValue>),
          ...(effort ? { reasoning_effort: effort } : {}),
        }
      : null;
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
    messages: dropForeignReasoning(messages, providerFamily(model)),
    temperature: opts.temperature ?? 0.7,
    abortSignal: opts.abortSignal,
    ...(maxOutputTokens ? { maxOutputTokens } : {}),
    ...(providerOpts ? { providerOptions: { [providerName]: providerOpts } } : {}),
    // streamText runs the agentic loop (call → execute → feed back); see
    // stopConditions for what ends it.
    ...(hasTools ? { tools, stopWhen: stopConditions(tools, maxToolSteps) } : {}),
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
  // Set once this turn has asked the user something. A well-behaved provider
  // ends the message on that call, but some OpenAI-compatible ones emit the call
  // AND an answer to it in the same completion — text written before the model
  // could possibly know the answer. It goes nowhere: the turn ended at the
  // question.
  let asked = false;
  for await (const part of result.fullStream) {
    if (part.type === "text-delta") {
      if (asked) continue;
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
      if (part.toolName === ASK_TOOL) asked = true;
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
  // A cancelled run has no text because it was stopped, which is not a mystery
  // worth explaining — and every promise on `result` rejects once the stream is
  // aborted, so asking would only produce an AbortError dressed up as a
  // diagnostic. The signal is the one place that knows the difference.
  if (textChunks === 0 && !opts.abortSignal?.aborted) {
    try {
      const [finishReason, warnings, text, reasoning] = await Promise.all([
        result.finishReason,
        result.warnings,
        result.text,
        Promise.resolve(result.reasoningText).catch(() => undefined),
      ]);
      console.warn(
        `[run ${opts.runId}] streamed 0 text chunks — model=${opts.model}, ` +
          `finishReason=${finishReason}, text.length=${text?.length ?? 0}, ` +
          `reasoning.length=${reasoning?.length ?? 0}, warnings=${JSON.stringify(warnings ?? [])}`,
      );
    } catch (err) {
      // One line. This is a note about a note; a 25-field DOMException dumped
      // into the terminal buries the run it was meant to describe.
      const msg = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
      console.warn(`[run ${opts.runId}] streamed 0 text chunks; diagnostics unavailable (${msg})`);
    }
  }
}
