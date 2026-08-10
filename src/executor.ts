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
  /** Wall-clock cap; falls back to the executor's configured default. */
  timeoutMs?: number;
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
  private readonly image: string;
  private readonly defaultTimeoutMs: number;
  private readonly network: boolean;
  private readonly idleMs: number;
  private readonly runtime: string | undefined;
  private readonly env: DockerEnv;
  private readonly sessions = new Map<string, Session>();

  constructor(
    image: string,
    defaultTimeoutMs: number,
    network: boolean,
    idleMs: number,
    runtime?: string,
    dockerHost?: string,
  ) {
    this.image = image;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.network = network;
    this.idleMs = idleMs;
    this.runtime = runtime;
    // "kata" et al. are more informative in logs/UI than a bare "docker".
    this.kind = runtime ?? "docker";
    // A remote daemon (e.g. a KVM box over the tailnet) is selected purely via
    // DOCKER_HOST; the rest of the env is inherited. Undefined → local daemon.
    this.env = dockerHost
      ? { ...(process.env as Record<string, string>), DOCKER_HOST: dockerHost }
      : undefined;
    // Reap containers a prior run left behind (a crash skips teardown), then
    // sweep idle ones periodically. Both best-effort; unref'd so neither pins
    // the process open.
    dockerQuiet(["container", "prune", "-f", "--filter", "label=kloe-sandbox=1"], this.env);
    const sweeper = setInterval(() => this.evictIdle(), 60_000);
    if (typeof sweeper.unref === "function") sweeper.unref();
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
      this.network ? "bridge" : "none",
      "--cpus",
      "1",
      "--memory",
      "512m",
      "--pids-limit",
      "512",
      "--workdir",
      "/workspace",
    ];
  }

  private async startContainer(name: string): Promise<void> {
    dockerQuiet(["rm", "-f", name], this.env); // clear a stale same-named container first
    const argv = [
      "run",
      "-d",
      "--name",
      name,
      "--label",
      "kloe-sandbox=1",
      ...this.runtimeArgs(),
      ...this.limits(),
      this.image,
      "sh",
      "-c",
      "mkdir -p /workspace && exec tail -f /dev/null",
    ];
    const r = await dockerRun(argv, this.env);
    if (r.exitCode !== 0)
      throw new Error(
        "sandbox container failed to start: " + (r.stderr.trim() || `exit ${r.exitCode}`),
      );
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
    const timeoutMs = spec.timeoutMs ?? this.defaultTimeoutMs;
    const t = this.timed(timeoutMs, signal);
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
        argv = ["exec", "--workdir", "/workspace", s.name, "sh", "-c", spec.command];
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
          spec.command,
        ];
      }
      const r = await dockerRun(argv, this.env, t.signal);
      return {
        stdout: clamp(r.stdout),
        stderr: clamp(r.stderr),
        exitCode: t.state.timedOut ? -1 : r.exitCode,
        timedOut: t.state.timedOut,
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
export function createExecutor(cfg: Config["sandbox"] = getConfig().sandbox): Executor | null {
  if (!cfg.enabled) return null;
  switch (cfg.backend) {
    case "docker":
      // Local dev or remote microVM — the difference is entirely config:
      // `dockerHost` (which daemon) and `runtime` (e.g. "kata" for a VM).
      return new LocalDockerExecutor(
        cfg.image,
        cfg.timeoutMs,
        cfg.network,
        cfg.idleMs,
        cfg.runtime,
        cfg.dockerHost,
      );
    default:
      return null;
  }
}

/** Fold an exec result into the text a tool hands back to the model. */
export function formatExecResult(r: ExecResult): string {
  const parts: string[] = [];
  if (r.timedOut) parts.push("[command timed out]");
  parts.push(`exit code: ${r.exitCode}`);
  parts.push("stdout:\n" + (r.stdout.trim() || "(empty)"));
  if (r.stderr.trim()) parts.push("stderr:\n" + r.stderr.trim());
  return parts.join("\n\n");
}
