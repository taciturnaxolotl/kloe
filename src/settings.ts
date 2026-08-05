import * as v from "valibot";
import { existsSync, readFileSync } from "node:fs";

/**
 * The single source of truth for kloe's deployment config. One `kloe.json`,
 * validated by one valibot schema, from which `kloe.schema.json` is generated
 * (see scripts/gen-schema.ts) so the file gets editor autocomplete + validation.
 *
 * Three layers, lowest precedence first:
 *   1. schema defaults (below)
 *   2. `kloe.json` on disk (path via `KLOE_CONFIG`, default `./kloe.json`)
 *   3. environment overrides (a small, documented map — `applyEnvOverrides`)
 *
 * String values may interpolate env vars — `$VAR`, `${VAR}`, `${VAR:-default}`
 * — resolved at load time. This replaces the old unvalidated
 * `JSON.parse(...) as OpsFile` cast and the scattered `process.env.*` reads;
 * everything deployment-shaped now flows through `getConfig()`.
 *
 * Internal tuning constants (batch sizes, lease/heartbeat timings) stay in
 * config.ts — they're implementation tuning, not deployment config.
 */

// ---- schema ------------------------------------------------------------

/** A model declared inline for a provider the catwalk catalog doesn't know. */
const ProviderModelSchema = v.object({
  id: v.string(),
  name: v.optional(v.string()),
  context_window: v.optional(v.number()),
  default_max_tokens: v.optional(v.number()),
  can_reason: v.optional(v.boolean()),
  reasoning_levels: v.optional(v.array(v.string())),
  supports_attachments: v.optional(v.boolean()),
});

/**
 * One enabled provider (the ops layer). Shape matches what ProviderRegistry
 * consumes; `maxConcurrency`/`minIntervalMs` are left undefined here so the
 * registry applies its own DEFAULTS (no double-defaulting).
 */
const ProviderSchema = v.object({
  id: v.string(),
  // Optional: keyless providers (local endpoints) need no credential. Providers
  // that do need one fail at request time via the upstream's own auth error.
  apiKey: v.optional(v.string()),
  apiEndpoint: v.optional(v.string()),
  type: v.optional(v.string()),
  maxConcurrency: v.optional(v.number()),
  minIntervalMs: v.optional(v.number()),
  maxOutputTokens: v.optional(v.number()),
  providerOptions: v.optional(v.record(v.string(), v.unknown())),
  models: v.optional(v.array(ProviderModelSchema)),
  discoverModels: v.optional(v.boolean()),
});

const S3Schema = v.object({
  bucket: v.optional(v.string()),
  endpoint: v.optional(v.string()),
  region: v.optional(v.string()),
  accessKeyId: v.optional(v.string()),
  secretAccessKey: v.optional(v.string()),
  prefix: v.optional(v.string(), "blobs/"),
  virtualHostedStyle: v.optional(v.boolean()),
});

const BlobsSchema = v.object({
  backend: v.optional(v.picklist(["fs", "s3"]), "fs"),
  path: v.optional(v.string(), "data/blobs"),
  maxBytes: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 25 * 1024 * 1024),
  s3: section(S3Schema),
});

const CatwalkSchema = v.object({
  url: v.optional(v.string()),
  cachePath: v.optional(v.string()),
  seedPath: v.optional(v.string()),
});

/**
 * The `fetch_url` tool: fetch a page and return its main content as markdown.
 * Enabled by default (no credential needed). `allowPrivate` lets a homelab read
 * its own internal services — off by default, since it disables the SSRF guard.
 */
const FetchSchema = v.object({
  enabled: v.optional(v.boolean(), true),
  /** Cap on bytes downloaded per page. */
  maxBytes: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 2 * 1024 * 1024),
  /** Cap on markdown chars returned to the model. */
  maxChars: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 50_000),
  timeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 15_000),
  /** Allow fetching private/reserved addresses (disables SSRF protection). */
  allowPrivate: v.optional(v.boolean(), false),
  userAgent: v.optional(v.string(), "Mozilla/5.0 (compatible; kloe/1.0; +https://kloe.dunkirk.sh)"),
});

/** Web-search backing for the `web_search` tool. Disabled by default. */
const SearchSchema = v.object({
  provider: v.optional(v.picklist(["none", "ceramic"]), "none"),
  apiKey: v.optional(v.string()),
  endpoint: v.optional(v.string()),
  maxResults: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 5),
});

/**
 * Optional integration with a lard memory server (../lard). Deployment-level:
 * WHICH lard and WHICH OAuth client to be. Per-user device-grant tokens and
 * project pins live in the DB keyed by the kloe user `sub` — never here, never in
 * the event log. Disabled by default; when enabled, each user connects their own
 * lard account (device grant) before any memory behaviour applies to them.
 */
const LardSchema = v.object({
  enabled: v.optional(v.boolean(), false),
  /** lard server base URL, e.g. https://lard.dunkirk.sh */
  baseUrl: v.optional(v.string(), ""),
  /** OAuth client id for lard. Empty → reuse kloe's own auth client (its clientId/CIMD). */
  clientId: v.optional(v.string(), ""),
  /** Secret for a confidential lard clientId. Empty → reuse kloe's auth.clientSecret (or public). */
  clientSecret: v.optional(v.string(), ""),
  /** Scopes requested at login; `offline_access` yields a refresh token. */
  scopes: v.optional(v.string(), "profile offline_access"),
  /** Collector name stamped on ingested sessions. */
  collector: v.optional(v.string(), "kloe"),
  /** Push a conversation to lard once it has sat idle this long (ms); 0 disables ingest. */
  ingestIdleMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 180_000),
  timeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 15_000),
});

const ServerSchema = v.object({
  port: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(65535)), 3000),
  dbPath: v.optional(v.string(), "data/kloe.db"),
});

/**
 * OAuth/OIDC auth via an indiko-style server. Disabled by default (local dev and
 * single-user setups need no login). When enabled, `/api/*` requires a session
 * and the client redirects to `/auth/login`. Two client styles are supported:
 *   - Default (public/dynamic): the `client_id` is kloe's own
 *     /client-metadata.json document (a Client ID Metadata Document), PKCE, no
 *     secret. Just set `issuer` + `baseUrl`.
 *   - Pre-registered: set `clientId` (and optionally `clientSecret`) to a client
 *     you registered with the provider. PKCE is still used; a secret, if given,
 *     is sent at the token endpoint (client_secret_post).
 * `redirectUri` is always /auth/callback (derived from `baseUrl`). `allowedSubs`
 * empty → any authenticated user; otherwise only those subject URLs may sign in.
 */
const AuthSchema = v.object({
  enabled: v.optional(v.boolean(), false),
  /** The OIDC issuer origin, e.g. https://indiko.dunkirk.sh */
  issuer: v.optional(v.string(), ""),
  /** kloe's own public origin, e.g. https://kloe.dunkirk.sh (used to derive the client_id + redirect). */
  baseUrl: v.optional(v.string(), ""),
  /** Pre-registered client_id. Empty → derive the /client-metadata.json doc from baseUrl. */
  clientId: v.optional(v.string(), ""),
  /** Client secret for a confidential pre-registered client. Empty → public client (PKCE only). */
  clientSecret: v.optional(v.string(), ""),
  /** Allowed subject URLs (indiko `me`/`sub`); empty = any authenticated user. */
  allowedSubs: v.optional(v.array(v.string()), []),
  sessionTtlDays: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 30),
  appName: v.optional(v.string(), "kloe"),
  logoUri: v.optional(v.string(), ""),
});

/**
 * System-prompt persona/preferences. Rendered into `prompt.tpl` per run (see
 * prompt.ts). All freeform and optional — an empty config yields a sane default
 * assistant grounded in the current date and the exposed tools.
 */
const PromptSchema = v.object({
  name: v.optional(v.string(), "Kloe"),
  tagline: v.optional(v.string()),
  personality: v.optional(v.string()),
  preferences: v.optional(v.string()),
  boundaries: v.optional(v.string()),
  /** The client renders LaTeX (KaTeX), so math is advertised by default. */
  math: v.optional(v.boolean(), true),
  noEmoji: v.optional(v.boolean(), false),
  platform: v.optional(v.string()),
  /** Files whose contents are injected into the <memory> block (missing ones skipped). */
  contextFiles: v.optional(v.array(v.string()), []),
  /** Override the bundled template; absent → the built-in prompt.tpl. */
  templatePath: v.optional(v.string()),
});

export const ConfigSchema = v.object({
  $schema: v.optional(v.string()),
  server: section(ServerSchema),
  blobs: section(BlobsSchema),
  catwalk: section(CatwalkSchema),
  search: section(SearchSchema),
  fetch: section(FetchSchema),
  auth: section(AuthSchema),
  lard: section(LardSchema),
  prompt: section(PromptSchema),
  providers: v.optional(v.array(ProviderSchema), []),
});
export type Config = v.InferOutput<typeof ConfigSchema>;

/** A sub-object that defaults to its own filled defaults when the key is absent. */
function section<TSchema extends v.ObjectSchema<any, any>>(schema: TSchema) {
  return v.optional(schema, () => v.parse(schema, {}));
}

// ---- interpolation -----------------------------------------------------

/**
 * Resolves a WHOLE-VALUE reference — `$VAR`, `${VAR}`, `${VAR:-default}` — to
 * its env value, or undefined if unset with no default; passes literals
 * through. Used for provider credentials, where "unset" must stay undefined
 * (not empty string) so callers can skip a provider with no key.
 */
export function resolveRef(
  value: string | undefined,
  env: Record<string, string | undefined> = process.env,
): string | undefined {
  if (!value) return undefined;
  const m = value.match(/^\$\{?(\w+)(?::-([^}]*))?\}?$/);
  if (!m) return value;
  const resolved = env[m[1]!];
  return resolved !== undefined && resolved !== "" ? resolved : m[2];
}

const EMBEDDED = /\$\{(\w+)(?::-([^}]*))?\}|\$(\w+)/g;

/**
 * Resolves EMBEDDED references anywhere in a string (`https://host/${TOKEN}`),
 * substituting "" for an unset var with no default. Used for config file
 * string values other than provider credentials.
 */
export function interpolate(
  value: string,
  env: Record<string, string | undefined> = process.env,
): string {
  return value.replace(EMBEDDED, (_m, braced, def, bare) => {
    const resolved = env[(braced ?? bare) as string];
    return resolved !== undefined && resolved !== "" ? resolved : (def ?? "");
  });
}

/** Interpolates every string in a value, recursively. */
function interpolateDeep(node: unknown, env: Record<string, string | undefined>): unknown {
  if (typeof node === "string") return interpolate(node, env);
  if (Array.isArray(node)) return node.map((n) => interpolateDeep(n, env));
  if (node && typeof node === "object") {
    return Object.fromEntries(
      Object.entries(node).map(([k, val]) => [k, interpolateDeep(val, env)]),
    );
  }
  return node;
}

// ---- loading -----------------------------------------------------------

type Env = Record<string, string | undefined>;

function readConfigFile(path: string): Record<string, unknown> {
  if (!existsSync(path)) return {};
  const raw = readFileSync(path, "utf8");
  try {
    return JSON.parse(raw) as Record<string, unknown>;
  } catch (err) {
    throw new Error(`config "${path}" is not valid JSON: ${(err as Error).message}`);
  }
}

/** Writes a value at a nested key path, creating intermediate objects. */
function setPath(obj: Record<string, any>, keys: string[], value: unknown): void {
  let o = obj;
  for (let i = 0; i < keys.length - 1; i++) {
    o[keys[i]!] ??= {};
    o = o[keys[i]!];
  }
  o[keys[keys.length - 1]!] = value;
}

/**
 * The documented env → config-path map. Env wins over the file (highest
 * precedence). This is the ONLY place these vars are read, replacing the
 * scattered `process.env.*` fallbacks across modules.
 */
function applyEnvOverrides(raw: Record<string, unknown>, env: Env): Record<string, unknown> {
  const cfg = structuredClone(raw);
  const put = (keys: string[], value: unknown) => setPath(cfg, keys, value);
  if (env.PORT) put(["server", "port"], Number(env.PORT));
  if (env.KLOE_DB) put(["server", "dbPath"], env.KLOE_DB);
  if (env.KLOE_BLOB_BACKEND) put(["blobs", "backend"], env.KLOE_BLOB_BACKEND);
  if (env.KLOE_BLOBS) put(["blobs", "path"], env.KLOE_BLOBS);
  if (env.KLOE_S3_PREFIX) put(["blobs", "s3", "prefix"], env.KLOE_S3_PREFIX);
  if (env.CATWALK_URL) put(["catwalk", "url"], env.CATWALK_URL);
  if (env.CATWALK_CACHE) put(["catwalk", "cachePath"], env.CATWALK_CACHE);
  if (env.CATWALK_SEED) put(["catwalk", "seedPath"], env.CATWALK_SEED);
  return cfg;
}

export interface LoadOptions {
  path?: string;
  env?: Env;
}

/**
 * Loads, layers, interpolates, and validates the config. Pure over its inputs
 * (path + env), so tests can drive it without touching the process env. The
 * `providers` subtree is left un-interpolated on purpose: provider credentials
 * are resolved lazily by the registry (via `resolveRef`), preserving its
 * rotate-rebuild behavior and its direct-injection test path.
 */
export function loadConfig(opts: LoadOptions = {}): Config {
  const env = opts.env ?? process.env;
  const path = opts.path ?? env.KLOE_CONFIG ?? "kloe.json";
  const withEnv = applyEnvOverrides(readConfigFile(path), env);

  const { providers, ...rest } = withEnv;
  const resolved = { ...(interpolateDeep(rest, env) as object), providers };

  try {
    return v.parse(ConfigSchema, resolved);
  } catch (err) {
    if (err instanceof v.ValiError) {
      const details = err.issues
        .map((i) => {
          const p = v.getDotPath(i);
          return p ? `${p}: ${i.message}` : i.message;
        })
        .join("; ");
      throw new Error(`invalid config "${path}": ${details}`);
    }
    throw err;
  }
}

let cached: Config | null = null;

/** The process-wide config, loaded once from `kloe.json` + env on first use. */
export function getConfig(): Config {
  return (cached ??= loadConfig());
}

/** Overrides the cached config (tests); pass null to force a reload next call. */
export function setConfig(config: Config | null): void {
  cached = config;
}
