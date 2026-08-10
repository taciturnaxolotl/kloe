import { type Config, getConfig } from "./settings";

/**
 * The sandbox executor: where a side-effecting tool's command actually runs.
 * Adapter-by-type, the same spirit as providers — a tool tagged `sandbox` hands
 * its command to whatever `Executor` the deployment configured, and never runs
 * it in-process.
 *
 * One backing, `LocalDockerExecutor`, covers the whole range via config rather
 * than separate classes:
 *
 *   - Local dev: docker on this host, default runtime (shared kernel). All the
 *     sandboxed-tool plumbing is exercisable with nothing but docker.
 *   - Remote microVM: `dockerHost` points the CLI at a KVM box over the tailnet
 *     and `runtime: "kata"` boots each container in a lightweight VM there — the
 *     spec's per-chat microVM, reached through docker's own ssh transport rather
 *     than a bespoke broker. The VM and its execution stay off this host.
 *
 * `session` is the per-conversation key: calls sharing a session share a live
 * sandbox (its `/workspace` and installed packages persist across the chat),
 * torn down on idle or when the conversation is deleted. A call with no session
 * runs one-off (ephemeral container), which is all a probe/test needs.
 */

export interface ExecSpec {
  /** A shell command line, run via `sh -c`. */
  command: string;
  /** The conversation whose persistent sandbox to run in; omitted → one-off. */
  session?: string;
  /** Wall-clock cap; falls back to the configured default, clamped to the max. */
  timeoutMs?: number;
}

/**
 * What the sandbox actually is, for whoever has to describe it.
 *
 * The model's only picture of the sandbox is the `run_shell` description, and a
 * description that hardcodes what config decides is a description that lies:
 * with `network: false` (the default) a cheerful "you can `apk add` things" sends
 * the model to spend a turn on a command that cannot work. So the executor
 * reports its own shape and the tool text is written from it.
 */
export interface SandboxInfo {
  image: string;
  network: boolean;
  defaultTimeoutMs: number;
  maxTimeoutMs: number;
  memory: string;
  cpus: string;
}

export interface ExecResult {
  stdout: string;
  stderr: string;
  /** Process exit code, or -1 when it was killed (timeout/abort). */
  exitCode: number;
  timedOut: boolean;
}

/** A file drained out of the sandbox's outbox. */
export interface HarvestedFile {
  /** Path relative to the outbox root, e.g. "chart.png" or "data/out.csv". */
  path: string;
  bytes: Uint8Array;
}

export interface Executor {
  /** A short tag for logs/UI ("docker", "kata"). */
  readonly kind: string;
  /** The shape of the sandbox, so tool text can describe it truthfully. */
  readonly info: SandboxInfo;
  run(spec: ExecSpec, signal?: AbortSignal): Promise<ExecResult>;
  /**
   * Materialize bytes inside the sandbox, creating parent directories. This is
   * how a blob — a user attachment or an earlier document — becomes a file the
   * model can actually operate on.
   */
  putFile(session: string, path: string, bytes: Uint8Array, signal?: AbortSignal): Promise<void>;
  /**
   * Drain the outbox: every file under `dir`, returned and then removed.
   *
   * Removing is what makes it an outbox rather than a directory. The workspace
   * is scratch and dies with the container; a file is only durable once it has
   * been promoted to a blob, so leaving copies behind would mean re-harvesting
   * the same file on every later step.
   */
  harvest(
    session: string,
    dir: string,
    limits: { maxFiles: number; maxBytes: number },
    signal?: AbortSignal,
  ): Promise<HarvestedFile[]>;
  /** Tear down a conversation's persistent sandbox (on delete). Best-effort. */
  disposeSession(session: string): void;
}

/** Single-quote a path for `sh -c`, so a name can't break out of its command. */
function shq(s: string): string {
  return `'${s.replace(/'/g, "'\\''")}'`;
}

/** What a killed command reports back. coreutils `timeout` uses 124 already. */
const TIMEOUT_EXIT = 124;

/**
 * Wrap a command so the container kills it on time.
 *
 * Two wrinkles, both from the image being the deployment's choice. `timeout` may
 * not exist at all, and a missing binary must not turn every command into "not
 * found" — so its absence falls back to running bare, with the client-side timer
 * as the only cap. And the two implementations disagree on the exit code: GNU
 * reports 124, busybox reports 143 (128 + SIGTERM). Normalizing here means the
 * caller reads one number.
 */
function withTimeout(command: string, timeoutMs: number): string {
  const secs = Math.max(1, Math.ceil(timeoutMs / 1000));
  const inner = shq(command);
  return (
    `if command -v timeout >/dev/null 2>&1; then timeout ${secs} sh -c ${inner}; c=$?; ` +
    `[ "$c" = 143 ] && c=${TIMEOUT_EXIT}; exit $c; else sh -c ${inner}; fi`
  );
}

const MAX_OUTPUT = 100_000; // cap each stream so a runaway command can't flood the transcript
function clamp(s: string): string {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + "\n…[output truncated]" : s;
}

// A prebuilt spawn env, or undefined to inherit this process's. Set once per
// executor so every docker call targets the same (possibly remote) daemon.
type DockerEnv = Record<string, string> | undefined;

/** Run a docker CLI invocation to completion, returning its captured streams. */
async function dockerRun(
  argv: string[],
  env: DockerEnv,
  signal?: AbortSignal,
): Promise<ExecResult> {
  const proc = Bun.spawn(["docker", ...argv], { stdout: "pipe", stderr: "pipe", env, signal });
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  return { stdout, stderr, exitCode, timedOut: false };
}
/**
 * How long a control-plane docker call (inspect, rm, ps) may take before we give
 * up on it. The command itself carries the user's timeout; these are the
 * bookkeeping calls around it, and they should be instant.
 *
 * Without a cap they inherit the daemon's mood: a wedged docker leaves `docker
 * inspect` hanging forever, and since session startup awaits it, one sick daemon
 * would hang the turn rather than failing it. An unreachable daemon must look
 * like a broken sandbox, not like a model thinking.
 */
const CONTROL_TIMEOUT_MS = 10_000;

/** A docker call we need the answer to, but never enough to wait indefinitely. */
function dockerControl(argv: string[], env: DockerEnv): Promise<ExecResult | null> {
  return dockerRun(argv, env, AbortSignal.timeout(CONTROL_TIMEOUT_MS)).catch(() => null);
}

/** Fire-and-forget docker command whose output we don't need (rm, etc.). */
function dockerQuiet(argv: string[], env: DockerEnv): void {
  try {
    void Bun.spawn(["docker", ...argv], { stdout: "ignore", stderr: "ignore", env }).exited;
  } catch {
    /* daemon down */
  }
}

interface Session {
  name: string;
  ready: Promise<void>;
  lastUsed: number;
}

/** The sandbox section of config; `maxTimeoutMs` is optional for older callers. */
type SandboxConfig = Omit<Config["sandbox"], "maxTimeoutMs" | "dockerNetwork"> & {
  maxTimeoutMs?: number;
  dockerNetwork?: string;
};

const MEMORY = "512m";
const CPUS = "1";

/**
 * Root inside the container, but a root that can do very little.
 *
 * Dropping every capability and adding back only the file-ownership set keeps
 * package installs working (apk/apt need to chown and setuid the files they
 * unpack) while removing the ones a sandbox has no business holding — raw
 * sockets, module loading, mount, ptrace of anything it didn't start.
 * `no-new-privileges` closes the setuid escalation path on top.
 */
const CAPABILITIES = [
  "--cap-drop",
  "ALL",
  ...["CHOWN", "DAC_OVERRIDE", "FOWNER", "FSETID", "SETGID", "SETUID"].flatMap((c) => [
    "--cap-add",
    c,
  ]),
  "--security-opt",
  "no-new-privileges",
];

/**
 * Point the docker/OrbStack host aliases at the container's own loopback.
 *
 * With networking on, the daemon injects these names and they resolve to the
 * host, which puts whatever the host is running — ssh, postgres, a dev server —
 * one `curl` away from model-authored code. Blackholing the names is worth doing
 * because the realistic path here is a model that was talked into fetching
 * `host.docker.internal:5432`, and that now goes nowhere.
 *
 * It is NOT egress filtering, and must not be mistaken for it: the host is still
 * reachable by raw gateway IP, and the whole internet is still reachable, full
 * stop. Actually constraining egress means a firewalled network the daemon host
 * owns — which is what `dockerNetwork` is for.
 */
const HOST_BLACKHOLE = ["host.docker.internal", "host.internal", "gateway.docker.internal"].flatMap(
  (h) => ["--add-host", `${h}:127.0.0.1`],
);

/** Created up front so writing to the outbox never needs a `mkdir -p` first. */
const WORKSPACE_DIRS = ["/workspace", "/workspace/inputs", "/workspace/outputs"];

/**
 * Runs commands in docker with cpu/memory/pids caps and (by default) no network.
 * A session-scoped call runs in a long-lived container per conversation — one
 * `docker run -d` on first use, `docker exec` thereafter, so `/workspace` and
 * installed packages persist across the chat; idle containers are swept, and a
 * conversation's is removed on delete. A session-less call is a one-off
 * `docker run --rm`.
 */
export class LocalDockerExecutor implements Executor {
  readonly kind: string;
  readonly info: SandboxInfo;
  private readonly image: string;
  private readonly defaultTimeoutMs: number;
  private readonly maxTimeoutMs: number;
  private readonly network: boolean;
  private readonly dockerNetwork: string;
  private readonly idleMs: number;
  private readonly runtime: string | undefined;
  private readonly env: DockerEnv;
  private readonly sessions = new Map<string, Session>();

  constructor(cfg: SandboxConfig) {
    this.image = cfg.image;
    this.defaultTimeoutMs = cfg.timeoutMs;
    this.maxTimeoutMs = Math.max(cfg.maxTimeoutMs ?? cfg.timeoutMs, cfg.timeoutMs);
    this.network = cfg.network;
    this.dockerNetwork = cfg.dockerNetwork ?? "bridge";
    this.idleMs = cfg.idleMs;
    this.runtime = cfg.runtime;
    // "kata" et al. are more informative in logs/UI than a bare "docker".
    this.kind = cfg.runtime ?? "docker";
    this.info = {
      image: this.image,
      network: this.network,
      defaultTimeoutMs: this.defaultTimeoutMs,
      maxTimeoutMs: this.maxTimeoutMs,
      memory: MEMORY,
      cpus: CPUS,
    };
    // A remote daemon (e.g. a KVM box over the tailnet) is selected purely via
    // DOCKER_HOST; the rest of the env is inherited. Undefined → local daemon.
    this.env = cfg.dockerHost
      ? { ...(process.env as Record<string, string>), DOCKER_HOST: cfg.dockerHost }
      : undefined;
    // A previous process's containers are left running: they hold their
    // conversations' workspaces, and a restart should not cost the user their
    // files. `startContainer` adopts one when its policy still matches and
    // replaces it when it doesn't, so nothing outlives a change to the sandbox's
    // security posture. Genuinely abandoned ones are swept below.
    //
    // Best-effort and unref'd, so neither pins the process open.
    void this.sweepUnclaimed();
    const sweeper = setInterval(() => {
      this.evictIdle();
      void this.sweepUnclaimed();
    }, 60_000);
    if (typeof sweeper.unref === "function") sweeper.unref();
  }

  /**
   * A fingerprint of everything that decides what the sandbox may do — image,
   * runtime, network, capabilities, resource caps. Stamped on the container at
   * creation and re-checked before adopting one, so a container outlives a
   * restart but never outlives a change to its own security posture. Tightening
   * the policy therefore replaces existing sandboxes on next use, rather than
   * leaving a fleet of containers running yesterday's rules.
   */
  private policyHash(): string {
    const h = new Bun.CryptoHasher("sha256");
    h.update(JSON.stringify([this.image, this.runtimeArgs(), this.limits()]));
    return h.digest("hex").slice(0, 16);
  }

  /**
   * Reuse a still-valid container from a previous process, or say why not.
   * Anything other than "running under today's policy" means recreate.
   */
  private async adoptable(name: string): Promise<boolean> {
    const r = await dockerControl(
      ["inspect", "-f", '{{.State.Running}} {{index .Config.Labels "kloe-policy"}}', name],
      this.env,
    );
    if (!r || r.exitCode !== 0) return false; // no such container, or no answer
    const [running, policy] = r.stdout.trim().split(/\s+/);
    return running === "true" && policy === this.policyHash();
  }

  /**
   * Remove labelled containers no live session claims and that have been up
   * longer than the idle TTL.
   *
   * This is what collects a previous process's leftovers. Uptime stands in for
   * idleness, which is only fair because a container the user comes back to is
   * adopted and tracked from that moment — so "unclaimed and old" really does
   * mean abandoned, and the TTL it answers to is the one already documented.
   */
  private async sweepUnclaimed(): Promise<void> {
    const listed = await dockerControl(
      ["ps", "-a", "--filter", "label=kloe-sandbox=1", "--format", "{{.Names}}\t{{.State}}"],
      this.env,
    );
    if (!listed || listed.exitCode !== 0) return;
    const live = new Set([...this.sessions.values()].map((s) => s.name));
    for (const line of listed.stdout.split("\n")) {
      const [name, state] = line.trim().split("\t");
      if (!name || live.has(name)) continue;
      if (state !== "running") {
        dockerQuiet(["rm", "-f", name], this.env); // a stopped sandbox is dead weight
        continue;
      }
      const started = await dockerControl(
        ["inspect", "-f", "{{.State.StartedAt}}", name],
        this.env,
      ).then((r) => (r ? Date.parse(r.stdout.trim()) : Number.NaN));
      if (Number.isFinite(started) && Date.now() - started > this.idleMs)
        dockerQuiet(["rm", "-f", name], this.env);
    }
  }

  /** `--runtime <name>` for container-creating commands; empty for the default. */
  private runtimeArgs(): string[] {
    return this.runtime ? ["--runtime", this.runtime] : [];
  }

  private containerName(session: string): string {
    return "kloe-sbx-" + session.replace(/[^a-zA-Z0-9_.-]/g, "").slice(0, 48);
  }

  private limits(): string[] {
    return [
      "--network",
      this.network ? this.dockerNetwork : "none",
      ...HOST_BLACKHOLE,
      ...CAPABILITIES,
      "--cpus",
      CPUS,
      "--memory",
      MEMORY,
      "--pids-limit",
      "512",
      "--workdir",
      "/workspace",
    ];
  }

  private async startContainer(name: string): Promise<void> {
    // Adopt the conversation's existing sandbox when it still runs under today's
    // policy: a restart then costs nothing, and /workspace survives it.
    if (await this.adoptable(name)) return;
    // Otherwise clear whatever is in the way. AWAITED, unlike the
    // fire-and-forget this replaces — container names are deterministic per
    // conversation, so a `rm -f` racing its own `run` loses often enough to
    // brick the session with "name is already in use".
    await dockerControl(["rm", "-f", name], this.env);
    const argv = [
      "run",
      "-d",
      "--name",
      name,
      "--label",
      "kloe-sandbox=1",
      "--label",
      `kloe-policy=${this.policyHash()}`,
      ...this.runtimeArgs(),
      ...this.limits(),
      this.image,
      "sh",
      "-c",
      `mkdir -p ${WORKSPACE_DIRS.join(" ")} && exec tail -f /dev/null`,
    ];
    let r = await dockerRun(argv, this.env);
    // A name conflict is the one failure that is always recoverable and never
    // recovers on its own: the name is deterministic, so every later attempt
    // hits the same wall until something removes the container. Clear it and
    // retry once rather than leaving the conversation with a dead sandbox.
    if (r.exitCode !== 0 && /already in use/i.test(r.stderr)) {
      await dockerControl(["rm", "-f", name], this.env);
      r = await dockerRun(argv, this.env);
    }
    if (r.exitCode !== 0) {
      // The invocation, not just the complaint. Docker answers a bad flag with a
      // usage dump that names no flag ("See 'docker run --help'"), so the stderr
      // alone leaves you guessing which argument the daemon disliked — and these
      // argv are assembled from config and policy, so they DO change.
      console.error(`[sandbox] docker ${argv.join(" ")}`);
      throw new Error(
        "sandbox container failed to start: " + (r.stderr.trim() || `exit ${r.exitCode}`),
      );
    }
  }

  private ensureSession(session: string): Session {
    let s = this.sessions.get(session);
    if (!s) {
      const name = this.containerName(session);
      s = { name, ready: this.startContainer(name), lastUsed: Date.now() };
      this.sessions.set(session, s);
    }
    s.lastUsed = Date.now();
    return s;
  }

  private evictIdle(): void {
    const cutoff = Date.now() - this.idleMs;
    for (const [key, s] of this.sessions) {
      if (s.lastUsed < cutoff) {
        this.sessions.delete(key);
        dockerQuiet(["rm", "-f", s.name], this.env);
      }
    }
  }

  /**
   * Write bytes into the container over `docker exec -i`, straight down stdin
   * into `cat >`. No tar, no temp file on this host, and binary-safe: the CLI
   * pipes stdin through untouched.
   */
  async putFile(
    session: string,
    path: string,
    bytes: Uint8Array,
    signal?: AbortSignal,
  ): Promise<void> {
    const s = this.ensureSession(session);
    await s.ready;
    const dir = path.slice(0, path.lastIndexOf("/")) || "/";
    const proc = Bun.spawn(
      ["docker", "exec", "-i", s.name, "sh", "-c", `mkdir -p ${shq(dir)} && cat > ${shq(path)}`],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe", env: this.env, signal },
    );
    proc.stdin.write(bytes);
    await proc.stdin.end();
    const [code, stderr] = await Promise.all([proc.exited, new Response(proc.stderr).text()]);
    if (code !== 0) throw new Error(`could not write ${path}: ${stderr.trim() || `exit ${code}`}`);
  }

  async harvest(
    session: string,
    dir: string,
    limits: { maxFiles: number; maxBytes: number },
    signal?: AbortSignal,
  ): Promise<HarvestedFile[]> {
    const s = this.sessions.get(session);
    if (!s) return []; // no sandbox ran, so nothing to drain
    await s.ready;
    // Size-filter in `find` rather than after reading: a file too big to promote
    // shouldn't be pulled across the socket just to be discarded.
    const kb = Math.max(1, Math.floor(limits.maxBytes / 1024));
    const listed = await dockerRun(
      [
        "exec",
        s.name,
        "sh",
        "-c",
        `cd ${shq(dir)} 2>/dev/null && find . -type f -size -${kb}k | sed 's|^./||' | head -n ${limits.maxFiles}`,
      ],
      this.env,
      signal,
    );
    const paths = listed.stdout
      .split("\n")
      .map((p) => p.trim())
      .filter(Boolean);
    const out: HarvestedFile[] = [];
    for (const p of paths) {
      const proc = Bun.spawn(["docker", "exec", s.name, "cat", `${dir}/${p}`], {
        stdout: "pipe",
        stderr: "pipe",
        env: this.env,
        signal,
      });
      const [buf, code] = await Promise.all([new Response(proc.stdout).arrayBuffer(), proc.exited]);
      if (code === 0) out.push({ path: p, bytes: new Uint8Array(buf) });
    }
    // Drain only what was taken. A file that arrived mid-harvest, or was skipped
    // for size, stays for the next step rather than vanishing unpromoted.
    for (const f of out) dockerQuiet(["exec", s.name, "rm", "-f", `${dir}/${f.path}`], this.env);
    return out;
  }

  disposeSession(session: string): void {
    const s = this.sessions.get(session);
    this.sessions.delete(session);
    dockerQuiet(["rm", "-f", s ? s.name : this.containerName(session)], this.env);
  }

  // Abort on the caller's signal OR the timeout, tracking which fired.
  private timed(timeoutMs: number, signal: AbortSignal | undefined) {
    const ctl = new AbortController();
    const state = { timedOut: false };
    const onAbort = () => ctl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => {
      if (!signal?.aborted) state.timedOut = true;
      ctl.abort();
    }, timeoutMs);
    const cleanup = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    };
    return { signal: ctl.signal, state, cleanup };
  }

  async run(spec: ExecSpec, signal?: AbortSignal): Promise<ExecResult> {
    // A caller may ask for longer than the default, never longer than the max —
    // the ceiling belongs to the deployment, not to the command.
    const timeoutMs = Math.min(spec.timeoutMs ?? this.defaultTimeoutMs, this.maxTimeoutMs);
    // The client-side timer only ever abandons the docker CLI; the process it
    // started keeps running inside the container, so a `while true` would burn
    // the session's cpu until the container was swept. The cap is therefore
    // enforced INSIDE, where something can actually kill it, and the outer timer
    // stays on as a backstop for a hung daemon — a couple of seconds later, so
    // the in-container kill is the one that normally fires.
    const command = withTimeout(spec.command, timeoutMs);
    const t = this.timed(timeoutMs + 2_000, signal);
    try {
      let argv: string[];
      if (spec.session) {
        const s = this.ensureSession(spec.session);
        try {
          await s.ready;
        } catch (e) {
          this.sessions.delete(spec.session); // let the next call retry a fresh container
          throw e;
        }
        argv = ["exec", "--workdir", "/workspace", s.name, "sh", "-c", command];
      } else {
        argv = [
          "run",
          "--rm",
          "--interactive",
          "--label",
          "kloe-sandbox=1",
          ...this.runtimeArgs(),
          ...this.limits(),
          this.image,
          "sh",
          "-c",
          command,
        ];
      }
      const r = await dockerRun(argv, this.env, t.signal);
      const timedOut = t.state.timedOut || r.exitCode === TIMEOUT_EXIT;
      return {
        stdout: clamp(r.stdout),
        stderr: clamp(r.stderr),
        exitCode: timedOut ? -1 : r.exitCode,
        timedOut,
      };
    } finally {
      t.cleanup();
    }
  }
}

// Cached singleton so per-conversation containers persist across tool calls and
// runs. Tests build their own via `createExecutor(cfg)` / `new …`.
let cached: Executor | null | undefined;
export function getExecutor(): Executor | null {
  if (cached === undefined) cached = createExecutor();
  return cached;
}
export function resetExecutor(): void {
  cached = undefined;
}

/** The configured executor, or null when the sandbox is disabled/unimplemented. */
export function createExecutor(cfg: SandboxConfig = getConfig().sandbox): Executor | null {
  if (!cfg.enabled) return null;
  switch (cfg.backend) {
    case "docker":
      // Local dev or remote microVM — the difference is entirely config:
      // `dockerHost` (which daemon) and `runtime` (e.g. "kata" for a VM).
      return new LocalDockerExecutor(cfg);
    default:
      return null;
  }
}

/** Fold an exec result into the text a tool hands back to the model. */
export function formatExecResult(r: ExecResult): string {
  const parts: string[] = [];
  // A bare "[timed out]" reads as a failure of the sandbox; saying what to do
  // about it turns a dead end into the next step.
  if (r.timedOut)
    parts.push(
      "[command timed out and was killed — output above is partial. Re-run something " +
        "smaller, or pass a larger timeout_seconds if it genuinely needs the time.]",
    );
  parts.push(`exit code: ${r.exitCode}`);
  parts.push("stdout:\n" + (r.stdout.trim() || "(empty)"));
  if (r.stderr.trim()) parts.push("stderr:\n" + r.stderr.trim());
  return parts.join("\n\n");
}
