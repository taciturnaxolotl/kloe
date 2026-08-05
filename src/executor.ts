import { getConfig, type Config } from "./settings";

/**
 * The sandbox executor: where a side-effecting tool's command actually runs.
 * Adapter-by-type, the same spirit as providers — a tool tagged `sandbox` hands
 * its command to whatever `Executor` the deployment configured, and never runs
 * it in-process. Two backings are planned:
 *
 *   - `LocalDockerExecutor` — a throwaway container on this host. Works on the
 *     dev machine today (docker is all it needs), so the whole sandboxed-tool
 *     flow is exercisable without any homelab infra.
 *   - `SpindleExecutor` (later) — an HTTP/SSE client to a broker on the spindle
 *     box (terebithia) over the tailnet. The broker runs the command in a
 *     microVM via vsock; the VM never leaves that host. kloe just makes authed
 *     calls over the tailnet, so it's reachable from anywhere kloe runs.
 *
 * The interface is deliberately transport-agnostic: give it a command, get back
 * stdout/stderr/exit. That's all docker exec and a remote broker have in common,
 * and all a tool needs.
 */

export interface ExecSpec {
  /** A shell command line, run via `sh -c`. */
  command: string;
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

export interface Executor {
  /** A short tag for logs/UI ("docker", "spindle"). */
  readonly kind: string;
  run(spec: ExecSpec, signal?: AbortSignal): Promise<ExecResult>;
}

const MAX_OUTPUT = 100_000; // cap each stream so a runaway command can't flood the transcript
function clamp(s: string): string {
  return s.length > MAX_OUTPUT ? s.slice(0, MAX_OUTPUT) + "\n…[output truncated]" : s;
}

/**
 * Runs each command in a fresh `docker run --rm` container. Network is off by
 * default (matches the microVM's egress restriction), with cpu/memory caps and
 * an ephemeral `/workspace`. Disposable by construction: nothing persists
 * between calls, which is exactly what keeps it safe to hand a model.
 */
export class LocalDockerExecutor implements Executor {
  readonly kind = "docker";
  private readonly image: string;
  private readonly defaultTimeoutMs: number;
  private readonly network: boolean;
  constructor(image: string, defaultTimeoutMs: number, network: boolean) {
    this.image = image;
    this.defaultTimeoutMs = defaultTimeoutMs;
    this.network = network;
  }

  async run(spec: ExecSpec, signal?: AbortSignal): Promise<ExecResult> {
    const timeoutMs = spec.timeoutMs ?? this.defaultTimeoutMs;
    // Abort on the caller's signal OR the timeout, whichever fires first.
    const ctl = new AbortController();
    const onAbort = () => ctl.abort();
    signal?.addEventListener("abort", onAbort, { once: true });
    const timer = setTimeout(() => ctl.abort(), timeoutMs);
    let timedOut = false;
    ctl.signal.addEventListener("abort", () => { if (signal?.aborted !== true) timedOut = true; }, { once: true });

    const args = [
      "run", "--rm", "--interactive",
      "--network", this.network ? "bridge" : "none",
      "--cpus", "1", "--memory", "512m", "--pids-limit", "512",
      "--workdir", "/workspace",
      this.image, "sh", "-c", spec.command,
    ];
    const proc = Bun.spawn(["docker", ...args], { stdout: "pipe", stderr: "pipe", signal: ctl.signal });
    try {
      const [stdout, stderr, exitCode] = await Promise.all([
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
        proc.exited,
      ]);
      return { stdout: clamp(stdout), stderr: clamp(stderr), exitCode: timedOut ? -1 : exitCode, timedOut };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
    }
  }
}

/** The configured executor, or null when the sandbox is disabled/unimplemented. */
export function createExecutor(cfg: Config["sandbox"] = getConfig().sandbox): Executor | null {
  if (!cfg.enabled) return null;
  switch (cfg.backend) {
    case "docker":
      return new LocalDockerExecutor(cfg.image, cfg.timeoutMs, cfg.network);
    case "spindle":
      // Increment 2: an HTTP/SSE client to the broker route on terebithia.
      return null;
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
