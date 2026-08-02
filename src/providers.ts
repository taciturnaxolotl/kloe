import { createOpenAICompatible } from "@ai-sdk/openai-compatible";
import { createOpenAI } from "@ai-sdk/openai";
import { createAnthropic } from "@ai-sdk/anthropic";
import type { LanguageModel } from "ai";
import { existsSync, readFileSync } from "node:fs";
import type { Catalog, ProviderType } from "./catalog";

/**
 * Ops config for one *enabled* provider — the deployment-specific layer. An
 * entry in providers.json means "this provider is turned on: here's its secret
 * and how hard to push it". Everything else (endpoint, model list, pricing,
 * capabilities) comes from the catalog, matched by `id`.
 */
export interface ProviderConfig {
  id: string;
  /** API key: a "$ENV_VAR" interpolation or a literal. */
  apiKey: string;
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
    apiKey: string;
    apiEndpoint?: string;
    maxConcurrency?: number;
    minIntervalMs?: number;
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

/**
 * Registry of *enabled* providers: joins the local ops config against the
 * catalog. Construction fails loudly if an enabled provider isn't in the
 * catalog, so misconfiguration surfaces at startup, not at claim time.
 */
export class ProviderRegistry {
  private readonly configs = new Map<string, ProviderConfig>();
  private readonly factories = new Map<string, ModelFactory>();
  private readonly catalog: Catalog;

  constructor(
    catalog: Catalog,
    opts: { configPath?: string; config?: OpsFile } = {},
  ) {
    this.catalog = catalog;
    const ops = opts.config ?? this.loadFile(opts.configPath ?? "providers.json");
    for (const p of ops.providers) {
      if (p.id === "echo") continue; // built-in, not catalog-backed
      if (!catalog.getProvider(p.id)) {
        throw new Error(
          `enabled provider "${p.id}" is not in the catalog (available: ${catalog
            .listProviders()
            .map((c) => c.id)
            .join(", ")})`,
        );
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

  private loadFile(path: string): OpsFile {
    if (!existsSync(path)) return { providers: [] };
    const raw = readFileSync(path, "utf8");
    try {
      return JSON.parse(raw) as OpsFile;
    } catch (err) {
      throw new Error(
        `failed to parse provider config "${path}": ${(err as Error).message}`,
      );
    }
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
   * from the catalog, plus the echo mock. This is the settings/admin view;
   * curation (which subset the chat UI shows) is layered on top elsewhere.
   */
  listModels(): ModelInfo[] {
    const out: ModelInfo[] = [ECHO_MODEL];
    for (const id of this.configs.keys()) {
      const provider = this.catalog.getProvider(id);
      if (!provider) continue;
      for (const m of provider.models) {
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
    if (!this.catalog.getModel(providerId, modelId)) {
      throw new Error(`unknown model "${modelId}" for provider "${providerId}"`);
    }

    return this.factoryFor(providerId, config)(modelId);
  }

  /** Builds (and caches) the AI SDK adapter for a provider, keyed by `type`. */
  private factoryFor(providerId: string, config: ProviderConfig): ModelFactory {
    let factory = this.factories.get(providerId);
    if (factory) return factory;

    const catProvider = this.catalog.getProvider(providerId)!;
    const apiKey = resolveEnv(config.apiKey);
    if (!apiKey) {
      throw new Error(
        `provider "${providerId}" requires an API key (config: ${config.apiKey})`,
      );
    }
    const baseURL = resolveEnv(config.apiEndpoint) ?? resolveEnv(catProvider.apiEndpoint);

    factory = buildFactory(providerId, catProvider.type, apiKey, baseURL);
    this.factories.set(providerId, factory);
    return factory;
  }
}

/** Resolves a "$ENV_VAR" interpolation to its env value; passes literals through. */
function resolveEnv(value: string | undefined): string | undefined {
  if (!value) return undefined;
  if (value.startsWith("$")) return process.env[value.slice(1)];
  return value;
}

/** Selects the AI SDK adapter for a provider based on its catalog `type`. */
function buildFactory(
  providerId: string,
  type: ProviderType,
  apiKey: string,
  baseURL: string | undefined,
): ModelFactory {
  switch (type) {
    case "anthropic": {
      const p = createAnthropic({ apiKey, ...(baseURL ? { baseURL } : {}) });
      return (modelId) => p(modelId);
    }
    case "openai": {
      const p = createOpenAI({ apiKey, ...(baseURL ? { baseURL } : {}) });
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
      const p = createOpenAICompatible({ name: providerId, baseURL, apiKey });
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
