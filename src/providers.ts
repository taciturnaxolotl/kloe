import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";
import type { Catalog, CatalogModel, ProviderType } from "./catalog";
import { parseModel } from "./catalog";
import { discoverModels, enrichModels } from "./discover";
import { resolveRef } from "./settings";

/**
 * Ops config for one *enabled* provider — the deployment-specific layer. An
 * entry in kloe.json's `providers` means "this provider is turned on: here's its secret
 * and how hard to push it". Everything else (endpoint, model list, pricing,
 * capabilities) comes from the catalog, matched by `id`.
 */
export interface ProviderConfig {
  id: string;
  /** API key: a "$ENV_VAR" interpolation or a literal. Absent for keyless providers. */
  apiKey?: string;
  /** Optional endpoint override (else the catalog's); "$ENV_VAR" or literal. */
  apiEndpoint?: string;
  /** Max concurrent in-flight requests to this provider. */
  maxConcurrency: number;
  /** Minimum ms between request starts (crude token bucket). */
  minIntervalMs: number;
}

interface OpsFile {
  providers: Array<{
    id: string;
    apiKey?: string;
    apiEndpoint?: string;
    maxConcurrency?: number;
    minIntervalMs?: number;
    /**
     * Adapter type for providers the catalog doesn't know (else "openai-compat"
     * is assumed). Also selects the discovery enricher ("hyper", ...).
     */
    type?: string;
    /**
     * Only for providers the catalog doesn't know (e.g. Hyper): the model list
     * inline, in raw catwalk shape. May be omitted when `type` is set — models
     * are then discovered live from `{apiEndpoint}/models` and enriched (see
     * src/discover.ts). Explicit entries always win over discovered ones.
     */
    models?: Array<{
      id: string;
      name?: string;
      context_window?: number;
      default_max_tokens?: number;
      can_reason?: boolean;
      reasoning_levels?: string[];
      supports_attachments?: boolean;
    }>;
    /**
     * Opt in/out of live model discovery explicitly. Default: discover when
     * no inline models were given, skip when they were (crush convention).
     */
    discoverModels?: boolean;
  }>;
}

const DEFAULTS = {
  maxConcurrency: 4,
  minIntervalMs: 0,
};

/** Metadata surfaced to the UI for one available model. */
export interface ModelInfo {
  /** `provider/model` ref, as used in requests. */
  ref: string;
  providerId: string;
  modelId: string;
  name: string;
  contextWindow: number;
  costPer1MIn: number;
  costPer1MOut: number;
  reasoningLevels: string[];
  supportsImages: boolean;
}

const ECHO_MODEL: ModelInfo = {
  ref: "echo",
  providerId: "echo",
  modelId: "echo",
  name: "Echo (mock)",
  contextWindow: 0,
  costPer1MIn: 0,
  costPer1MOut: 0,
  reasoningLevels: [],
  supportsImages: false,
};

/** A cached, model-id-parameterized adapter for one provider. */
type ModelFactory = (modelId: string) => LanguageModel;

/** Cached factory plus the resolved credentials it was built with, so a
 * rotated key/endpoint rebuilds instead of serving a stale one. */
interface CachedFactory {
  apiKey: string | undefined;
  baseURL: string | undefined;
  factory: ModelFactory;
}

/** A provider declared entirely in the ops file, not backed by the catalog. */
interface InlineProvider {
  type: ProviderType;
  models: CatalogModel[];
  /** Models not yet fetched; `discover()` fills them in. */
  needsDiscovery: boolean;
}

/**
 * Registry of *enabled* providers: joins the local ops config against the
 * catalog. Construction fails loudly if an enabled provider isn't in the
 * catalog and can't stand on its own (no endpoint, and neither inline models
 * nor live discovery), so misconfiguration surfaces at startup, not at claim
 * time.
 */
export class ProviderRegistry {
  private readonly configs = new Map<string, ProviderConfig>();
  private readonly factories = new Map<string, CachedFactory>();
  private readonly catalog: Catalog;
  private readonly inline = new Map<string, InlineProvider>();
  private readonly fetchImpl?: typeof fetch;

  constructor(
    catalog: Catalog,
    opts: { config?: OpsFile; fetchImpl?: typeof fetch } = {},
  ) {
    this.catalog = catalog;
    this.fetchImpl = opts.fetchImpl;
    // Providers come pre-loaded and validated from settings (kloe.json); the
    // registry no longer reads any file itself. Absent config → echo only.
    const ops = opts.config ?? { providers: [] };
    for (const p of ops.providers) {
      if (p.id === "echo") continue; // built-in, not catalog-backed
      if (!catalog.getProvider(p.id)) {
        const models = (p.models ?? []).map(parseModel);
        // Crush convention: an empty model list implies discovery; an inline
        // list opts out unless `discoverModels` forces it. `type` only selects
        // the adapter and the enricher.
        const wantsDiscovery = p.discoverModels ?? models.length === 0;
        if (!p.apiEndpoint) {
          throw new Error(
            `enabled provider "${p.id}" is not in the catalog (available: ${catalog
              .listProviders()
              .map((c) => c.id)
              .join(", ")}) and has no "apiEndpoint" to stand on its own`,
          );
        }
        this.inline.set(p.id, {
          type: p.type ?? "openai-compat",
          models,
          needsDiscovery: wantsDiscovery,
        });
      }
      this.configs.set(p.id, {
        id: p.id,
        apiKey: p.apiKey,
        apiEndpoint: p.apiEndpoint,
        maxConcurrency: p.maxConcurrency ?? DEFAULTS.maxConcurrency,
        minIntervalMs: p.minIntervalMs ?? DEFAULTS.minIntervalMs,
      });
    }
  }

  /**
   * Live model discovery for non-catalog providers that opted in: list
   * `{apiEndpoint}/models`, then run the type's enricher. Runs after
   * construction (before serving) and fails soft: a provider that yields
   * nothing stays enabled but resolves nothing, loudly logged.
   */
  async discover(opts: { timeoutMs?: number } = {}): Promise<void> {
    const jobs: Promise<void>[] = [];
    for (const [id, inline] of this.inline) {
      if (!inline.needsDiscovery) continue;
      const config = this.configs.get(id)!;
      const baseUrl = resolveRef(config.apiEndpoint);
      if (!baseUrl) continue;
      jobs.push(
        (async () => {
          const cfg = {
            id,
            baseUrl,
            apiKey: resolveRef(config.apiKey),
            fetchImpl: this.fetchImpl,
            timeoutMs: opts.timeoutMs,
          };
          const { models: discovered0, raw } = await discoverModels(cfg);
          const discovered = await enrichModels(inline.type, cfg, discovered0, raw);
          inline.needsDiscovery = false;
          // Explicit inline entries win; discovered models append after.
          const known = new Set(inline.models.map((m) => m.id));
          inline.models = [
            ...inline.models,
            ...discovered.filter((m) => !known.has(m.id)),
          ];
          if (inline.models.length === 0) {
            console.warn(
              `discover: provider "${id}" yielded no models; it stays enabled but resolves nothing`,
            );
          }
        })(),
      );
    }
    await Promise.all(jobs);
  }

  /** Ops config for an enabled provider (echo/unknown → undefined). */
  getConfig(id: string): ProviderConfig | undefined {
    return this.configs.get(id);
  }

  /** Enabled provider ids, plus the built-in echo. */
  listProviders(): string[] {
    return ["echo", ...this.configs.keys()];
  }

  /**
   * All models available to the UI: every model of every enabled provider,
   * from the catalog (or the ops file for inline providers), plus the echo
   * mock. This is the settings/admin view; curation (which subset the chat UI
   * shows) is layered on top elsewhere.
   */
  listModels(): ModelInfo[] {
    const out: ModelInfo[] = [ECHO_MODEL];
    for (const id of this.configs.keys()) {
      const models =
        this.catalog.getProvider(id)?.models ?? this.inline.get(id)?.models ?? [];
      for (const m of models) {
        out.push({
          ref: `${id}/${m.id}`,
          providerId: id,
          modelId: m.id,
          name: m.name,
          contextWindow: m.contextWindow,
          costPer1MIn: m.costPer1MIn,
          costPer1MOut: m.costPer1MOut,
          reasoningLevels: m.reasoningLevels,
          supportsImages: m.supportsImages,
        });
      }
    }
    return out;
  }

  /**
   * Resolves a `provider/model` ref to a concrete LanguageModel. The model is
   * required (no bare/default form): a ref must name both a provider and a
   * model, both must be enabled/known, or this throws.
   */
  resolveModel(modelRef: string): LanguageModel {
    if (modelRef === "echo" || modelRef.startsWith("echo/")) {
      return createEchoModel();
    }

    const slash = modelRef.indexOf("/");
    if (slash <= 0 || slash === modelRef.length - 1) {
      throw new Error(
        `model ref must be "provider/model", got "${modelRef}"`,
      );
    }
    const providerId = modelRef.slice(0, slash);
    const modelId = modelRef.slice(slash + 1);

    const config = this.configs.get(providerId);
    if (!config) {
      throw new Error(
        `provider "${providerId}" is not enabled (enabled: ${this.listProviders().join(", ")})`,
      );
    }
    const known =
      this.catalog.getModel(providerId, modelId) ??
      this.inline.get(providerId)?.models.find((m) => m.id === modelId);
    if (!known) {
      throw new Error(`unknown model "${modelId}" for provider "${providerId}"`);
    }

    return this.factoryFor(providerId, config)(modelId);
  }

  /**
   * Builds (and caches) the AI SDK adapter for a provider. Credentials are
   * resolved from the environment on each call; the cache is invalidated if the
   * resolved key or endpoint changed (e.g. a rotated secret), so a long-running
   * process doesn't keep serving a stale key.
   */
  private factoryFor(providerId: string, config: ProviderConfig): ModelFactory {
    const catProvider = this.catalog.getProvider(providerId);
    const inline = this.inline.get(providerId);
    // Keyless is allowed when NO key is declared: it resolves to undefined and
    // the adapter omits the credential (local endpoints). But a key that WAS
    // declared yet resolves empty is a misconfig (env var forgotten), not a
    // keyless provider — flag it rather than silently sending no credential.
    const apiKey = resolveRef(config.apiKey);
    if (config.apiKey !== undefined && !apiKey) {
      throw new Error(
        `provider "${providerId}" declares an API key that resolved empty (config: ${config.apiKey}); set its env var, or remove apiKey for a keyless provider`,
      );
    }
    // Inline providers are required (at construction) to have an apiEndpoint,
    // so it always wins here via config.apiEndpoint.
    const baseURL =
      resolveRef(config.apiEndpoint) ?? resolveRef(catProvider?.apiEndpoint);

    const cached = this.factories.get(providerId);
    if (cached && cached.apiKey === apiKey && cached.baseURL === baseURL) {
      return cached.factory;
    }

    const type = catProvider?.type ?? inline?.type ?? "openai-compat";
    const factory = buildFactory(providerId, type, apiKey, baseURL);
    this.factories.set(providerId, { apiKey, baseURL, factory });
    return factory;
  }
}

/** Selects the AI SDK adapter for a provider based on its catalog `type`. */
function buildFactory(
  providerId: string,
  type: ProviderType,
  apiKey: string | undefined,
  baseURL: string | undefined,
): ModelFactory {
  // Omit the credential entirely when there isn't one, so keyless (local)
  // endpoints work and keyed ones are unchanged.
  const key = apiKey ? { apiKey } : {};
  switch (type) {
    case "anthropic": {
      const p = createAnthropic({ ...key, ...(baseURL ? { baseURL } : {}) });
      return (modelId) => p(modelId);
    }
    case "openai": {
      const p = createOpenAI({ ...key, ...(baseURL ? { baseURL } : {}) });
      return (modelId) => p(modelId);
    }
    // openai-compat, openrouter, and any other type fall back to the
    // OpenAI-compatible adapter, which requires an explicit baseURL.
    default: {
      if (!baseURL) {
        throw new Error(
          `provider "${providerId}" (type "${type}") needs an endpoint; set apiEndpoint or ensure the catalog provides one`,
        );
      }
      const p = createOpenAICompatible({ name: providerId, baseURL, ...key });
      return (modelId) => p(modelId);
    }
  }
}

/**
 * Deterministic offline mock. Streams "echo: <prompt>" token-by-token so the
 * whole pipeline is observable without a real upstream. Honors abortSignal.
 */
function createEchoModel(): LanguageModel {
  const chunkDelayMs = Number(process.env.ECHO_DELAY_MS ?? 5);
  return {
    specificationVersion: "v4",
    provider: "kloe-mock",
    modelId: "echo",
    supportedUrls: {},
    // Echo is stream-only; fail loudly rather than returning undefined if a
    // non-streaming path ever calls it.
    doGenerate: async () => {
      throw new Error("echo model is stream-only (doGenerate not supported)");
    },
    doStream: async (opts: { prompt: unknown; abortSignal?: AbortSignal }) => {
      const messages = (opts.prompt ?? []) as Array<{
        role: string;
        content: unknown;
      }>;
      const last = messages.filter((m) => m.role === "user").at(-1);
      const parts = Array.isArray(last?.content)
        ? (last!.content as Array<{ type: string; text?: string }>)
        : [];
      const userText = parts
        .filter((p) => p.type === "text")
        .map((p) => p.text)
        .join("");
      const text = `echo: ${userText}`;
      const chunks = text.split(/(?<=\s)/);
      let i = 0;
      let id = 0;
      const signal = opts.abortSignal;
      const stream = new ReadableStream<Record<string, unknown>>({
        pull: async (controller) => {
          if (signal?.aborted) {
            controller.close();
            return;
          }
          if (i === 0) {
            controller.enqueue({ type: "text-start", id: `t${id++}` });
          }
          if (i >= chunks.length) {
            controller.enqueue({ type: "text-end", id: `t${id++}` });
            controller.enqueue({
              type: "finish",
              finishReason: "stop",
              usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
            });
            controller.close();
            return;
          }
          controller.enqueue({
            type: "text-delta",
            id: `t${id++}`,
            delta: chunks[i++],
          });
          await Bun.sleep(chunkDelayMs);
        },
      });
      return { stream };
    },
  } as unknown as LanguageModel;
}
