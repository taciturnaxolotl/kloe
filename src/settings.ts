import { existsSync, readFileSync } from "node:fs";
import * as v from "valibot";

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
 * An OAuth flow a USER can run against this provider, to spend their own
 * credits instead of the deployment's key. Only hyper's device grant so far;
 * `baseUrl` is the app origin (the device endpoints live at the root, not under
 * the /v1 inference path).
 */
const ProviderOAuthSchema = v.object({
  /**
   * A flow name from src/oauthflows.ts. A plain string rather than a closed
   * list: the registry is the authority on what kloe implements, and a config
   * naming one it doesn't simply offers no Connect button — better than a
   * schema error at boot over a provider nobody uses.
   */
  flow: v.string(),
  baseUrl: v.string(),
});

/**
 * One enabled provider (the ops layer). Shape matches what ProviderRegistry
 * consumes; `maxConcurrency`/`minIntervalMs` are left undefined here so the
 * registry applies its own DEFAULTS (no double-defaulting).
 */
const ProviderSchema = v.object({
  id: v.string(),
  oauth: v.optional(ProviderOAuthSchema),
  /** Let users paste their own API key for this provider. */
  byok: v.optional(v.boolean(), true),
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
/**
 * An optional headless-browser renderer for pages the plain fetcher can't read:
 * a JS-only shell, or a page sitting behind an anti-bot challenge. Off unless
 * configured, because it is somebody's infrastructure — FlareSolverr runs a real
 * Chrome and answers on :8191.
 *
 * It is deliberately a fallback, never the default path. A render costs seconds
 * where a fetch costs milliseconds, and FlareSolverr serves one browser at a
 * time, so pointing a parallel research run at it would queue every worker
 * behind every other one.
 */
const RendererSchema = v.object({
  provider: v.optional(v.picklist(["none", "flaresolverr"]), "none"),
  endpoint: v.optional(v.string(), "http://localhost:8191/v1"),
  /** Per-page cap. FlareSolverr's own default is 60s; a challenge takes 5-15s. */
  timeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 60_000),
});

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
  renderer: section(RendererSchema),
  /**
   * Fall back to the Wayback Machine when a page can't be read live. Only ever
   * fires on failure, and only sends a URL that already didn't work.
   */
  archive: v.optional(v.boolean(), true),
});

/**
 * The sandbox executor that backs side-effecting tools (`run_shell`). Disabled
 * by default. Commands run in a docker container; `runtime: "runsc"` wraps each
 * in gVisor's userspace kernel (syscalls intercepted, not the shared host
 * kernel), so untrusted model-authored commands are strongly isolated.
 * `dockerHost` points the CLI at a remote daemon over the tailnet (e.g. a
 * dedicated box), keeping execution off this host entirely.
 */
const SandboxSchema = v.object({
  enabled: v.optional(v.boolean(), false),
  backend: v.optional(v.picklist(["docker"]), "docker"),
  /** The image each command runs in. */
  image: v.optional(v.string(), "alpine:3.20"),
  /**
   * OCI runtime to run containers under. Omit for docker's default (runc,
   * shared-kernel). "runsc" (gVisor) sandboxes each container in a userspace
   * kernel; needs the runtime registered on the daemon (see the host's config).
   */
  runtime: v.optional(v.string()),
  /**
   * Remote docker endpoint, e.g. "ssh://kloe@prattle" over the tailnet. Sets
   * DOCKER_HOST for the spawned CLI so containers run there, not on this host.
   * Omit to use the local daemon.
   */
  dockerHost: v.optional(v.string()),
  /** Per-command wall-clock cap when the caller doesn't ask for one. */
  timeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 30_000),
  /**
   * Ceiling on a command's own timeout request. The default is tight enough to
   * keep an ordinary command honest, but installing a package or crunching a
   * file legitimately takes minutes — so a command may ask for longer, up to
   * here, and nothing may exceed it.
   */
  maxTimeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 300_000),
  /** Idle time before a conversation's persistent sandbox is torn down. */
  idleMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 10 * 60_000),
  /** docker: give the container network access (off = `--network none`). */
  network: v.optional(v.boolean(), false),
  /**
   * Which docker network to attach to when `network` is on. The default bridge
   * is unfiltered: the sandbox reaches the whole internet AND whatever the
   * daemon's host is listening on (ssh, postgres, a dev server), which makes
   * model-authored code an exfiltration path and a scanner of the host.
   *
   * Egress policy cannot be enforced from this process — it is firewall state on
   * the daemon's host. So point this at a network created there with the rules
   * you want (`docker network create kloe-egress`, plus iptables/nftables on its
   * subnet: deny the host, default-deny out, allow what tasks actually need) and
   * kloe will run every sandbox inside it.
   */
  dockerNetwork: v.optional(v.string(), "bridge"),
});

/** The agentic tool loop. */
const AgentSchema = v.object({
  /**
   * Max provider round-trips per run when tools are in play (call → execute →
   * feed back → …). `0` (the default) means unlimited — the loop runs until the
   * model stops calling tools or the user cancels the run. Set a positive number
   * to cap a runaway loop.
   */
  maxToolSteps: v.optional(v.pipe(v.number(), v.integer(), v.minValue(0)), 0),
  /**
   * A small/cheap model ref (e.g. "hyper/…") for utility tasks like titling.
   * Used when set AND enabled; otherwise (unset, or the ref no longer exists)
   * the cheapest enabled model is used. Titles generate whenever any model is
   * enabled — this just steers which one.
   */
  smallModel: v.optional(v.string()),
  /**
   * A model ref that can read images, for the `read_image` tool a non-vision
   * model uses to see an attachment. Used when set AND enabled; otherwise the
   * cheapest enabled model that accepts images. With no such model the tool is
   * not offered, and images stay unreadable to a text-only model — as they were.
   */
  visionModel: v.optional(v.string()),
});

/**
 * The `deep_research` tool: a bounded research loop that runs beside the
 * conversation (see research.ts). Needs both a search provider and a fetch
 * provider; with either missing the tool is simply not offered.
 *
 * The budget is the whole safety story, so it is config rather than prompt, and
 * the defaults are set for depth: a couple of hundred sources across half a
 * dozen workers, which is what separates a report you'd act on from a summary of
 * the first page of results. It is not cheap — six workers is roughly six times
 * the tokens — so these are the dials to turn down, not up.
 */
const ResearchSchema = v.object({
  enabled: v.optional(v.boolean(), true),
  /**
   * Provider round-trips per worker.
   *
   * Usually the binding constraint, and not the obvious one: a worker spends
   * most of its steps searching, so a low cap starves the reads it was searching
   * for. A run capped at 20 managed 140 searches and 18 reads.
   *
   * Set high enough that it stops being a limit at all — what ends a worker
   * should be having answered its angle, or the shared page pool running out.
   * This is the runaway backstop, not the pacing.
   */
  maxSteps: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 400),
  /**
   * Pages the whole run may open, shared across workers. Each one is a citable
   * source, so this is the main dial between "a quick look" and "a real report".
   */
  maxSources: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 500),
  /**
   * Workers running at once, each on its own angle with its own context window.
   * This is what lets a run cover far more material than one window could hold —
   * and it costs roughly this multiple in tokens, so it's the expensive dial.
   */
  /** Workers a run may spend in total, across every round. */
  maxAgents: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(12)), 6),
  /**
   * Workers in the opening round.
   *
   * Research is iterative: a small first wave maps the ground, and what it
   * finds decides where the rest of the budget goes. Fanning the whole allowance
   * out at once means every angle is chosen before anything is known — the
   * angles that turn out to matter get one worker each, and so do the ones that
   * turn out to be dead ends.
   */
  firstWave: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(12)), 2),
  /** How many times a run may look at what it has and send someone back out. */
  maxRounds: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1), v.maxValue(6)), 3),
  /**
   * Models for the two jobs a research run contains.
   *
   * `leadModel` plans the angles, reads each round's notes to decide the next,
   * and writes the report — judgement about a whole run. `workerModel` searches
   * and reads pages, which is a great deal more tokens spent on a narrower job.
   * Anthropic measured a strong lead over cheaper subagents beating a uniform
   * strong model, so the split is worth having; unset, both fall back to the
   * model the conversation is using, which is the old behaviour exactly.
   *
   * The settings page writes the same choice into the `prefs` table, and that
   * wins over these — a value set by clicking should not be silently overridden
   * by a file the clicker may not be able to edit.
   */
  leadModel: v.optional(v.string()),
  workerModel: v.optional(v.string()),
  /**
   * Wall clock for planning, the workers, synthesis and citations together.
   * Generous on purpose: a run reading a couple of hundred pages is a job you
   * come back to, and the ceiling is there to stop a hang, not to pace the work.
   */
  timeoutMs: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1_000)), 1_800_000),
});

/** Web-search backing for the `web_search` tool. Disabled by default. */
/** One backend in a blend: the same fields as the single-provider form. */
const SearchBackendSchema = v.object({
  provider: v.picklist(["ceramic", "hackclub", "llmsolutions", "exa", "duckduckgo"]),
  apiKey: v.optional(v.string()),
  endpoint: v.optional(v.string()),
  /**
   * Exa only: its depth dial. "auto" (the default) balances relevance and
   * latency; "fast"/"instant" trade relevance for speed; "deep" and
   * "deep-reasoning" run several query variations and take seconds to tens of
   * seconds, which suits a second tier rather than every search.
   */
  searchType: v.optional(v.string()),
});

/**
 * Web search.
 *
 * Three shapes, in order of precedence. `backends: [...]` blends several
 * engines into one ranked list — different engines are good at different
 * questions, and the cost of asking two is one parallel request. A single
 * `provider` is the ordinary case. And with neither set it falls back to
 * DuckDuckGo, so a fresh checkout can search without a key; `provider: "none"`
 * is how a deployment says it wants no search at all.
 */
const SearchSchema = v.object({
  provider: v.optional(
    v.picklist(["default", "none", "ceramic", "hackclub", "llmsolutions", "exa", "duckduckgo"]),
    "default",
  ),
  apiKey: v.optional(v.string()),
  endpoint: v.optional(v.string()),
  /** Exa only — see SearchBackendSchema. */
  searchType: v.optional(v.string()),
  maxResults: v.optional(v.pipe(v.number(), v.integer(), v.minValue(1)), 5),
  /** Blend these backends instead of the single `provider` above. */
  backends: v.optional(v.array(SearchBackendSchema)),
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

/**
 * Secrets kloe holds on a user's behalf (see secrets.ts). Only `credentialKey`
 * for now: without it the deployment simply cannot store a user credential, and
 * says so rather than writing one in the clear.
 */
const SecuritySchema = v.object({
  /** Any passphrase; hashed to an AES-256 key. `openssl rand -hex 32` is a fine one. */
  credentialKey: v.optional(v.string(), ""),
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
/**
 * What a role may do, beyond chatting.
 *
 * Deliberately short. The dividing line is who pays: anything a person can
 * bring their own key for (a model, a search engine) is governed by whether
 * they brought one, not by a permission — so there is no per-tool switch and no
 * per-role research budget here. What needs a permission is what only the
 * deployment can provide and nobody can bring themselves: the sandbox, which is
 * the operator's own compute, and publishing, which is the operator's domain.
 */
const RolePolicySchema = v.object({
  /** Curation, prefs, the admin views: running the instance. */
  admin: v.optional(v.boolean(), false),
  /** May reach the shell sandbox, which is real compute on a machine you pay for. */
  sandbox: v.optional(v.boolean(), false),
  /** May mint public share links on this instance's domain. */
  publish: v.optional(v.boolean(), false),
  /**
   * Which of this instance's models the role may pick from, as `provider/model`
   * patterns — `"*"` for all, `"hyper/*"` for one provider's, or an exact ref.
   *
   * The menu, not the picker: what someone actually sees is the subset they
   * turned on for themselves. Empty means none of the instance's models, which
   * is the right default for a role that is expected to bring its own account.
   */
  models: v.optional(v.array(v.string()), []),
  /**
   * Which of this instance's search engines the role may spend — by id
   * (`"exa"`), or `"*"` for all of them. Empty means none, and a role with
   * none can still search on an engine it connects itself.
   *
   * `"duckduckgo"` works whether or not this deployment configured it: it
   * takes no key and costs nobody anything, so there is nothing to opt into.
   */
  search: v.optional(v.array(v.string()), []),
  /** Subject URLs holding this role outright. Checked before anything else. */
  subs: v.optional(v.array(v.string()), []),
  /** Provider role strings that map to this one (indiko's per-app RBAC). */
  providerRoles: v.optional(v.array(v.string()), []),
});
export type RolePolicy = v.InferOutput<typeof RolePolicySchema>;

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
  /**
   * Every role this deployment has: what it may do, and who holds it.
   *
   * Two ways to hold one, and a role can use both. `subs` names people
   * outright, which is how a small instance works and how the break-glass
   * always works. `providerRoles` maps the strings the identity provider
   * assigns (indiko does per-app RBAC) onto a role here, which is how it scales
   * past editing config for every person.
   *
   * Declaring none means the deployment has no guests: everyone who can sign in
   * is an owner, which is what a single-user instance is and what every
   * instance was before roles existed.
   */
  roles: v.optional(v.record(v.string(), RolePolicySchema), {}),
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
  agent: section(AgentSchema),
  search: section(SearchSchema),
  research: section(ResearchSchema),
  fetch: section(FetchSchema),
  sandbox: section(SandboxSchema),
  auth: section(AuthSchema),
  security: section(SecuritySchema),
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
