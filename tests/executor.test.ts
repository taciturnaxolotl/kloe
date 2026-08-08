import { expect, test } from "bun:test";
import { createExecutor, formatExecResult, LocalDockerExecutor } from "../src/executor";

// docker isn't guaranteed in CI; probe once and skip the live cases without it.
async function dockerAvailable(): Promise<boolean> {
  try {
    return (
      (await Bun.spawn(["docker", "version"], { stdout: "ignore", stderr: "ignore" }).exited) === 0
    );
  } catch {
    return false;
  }
}
const HAS_DOCKER = await dockerAvailable();
const liveTest = HAS_DOCKER ? test : test.skip;

test("createExecutor returns null when the sandbox is disabled", () => {
  expect(
    createExecutor({
      enabled: false,
      backend: "docker",
      image: "alpine:3.20",
      timeoutMs: 30_000,
      idleMs: 600_000,
      network: false,
    }),
  ).toBeNull();
});

test("createExecutor builds a docker executor when enabled", () => {
  const e = createExecutor({
    enabled: true,
    backend: "docker",
    image: "alpine:3.20",
    timeoutMs: 30_000,
    idleMs: 600_000,
    network: false,
  });
  expect(e?.kind).toBe("docker");
});

test("createExecutor reflects the configured runtime in kind (kata → microVM)", () => {
  const e = createExecutor({
    enabled: true,
    backend: "docker",
    image: "alpine:3.20",
    runtime: "kata",
    dockerHost: "ssh://kloe@prattle",
    timeoutMs: 30_000,
    idleMs: 600_000,
    network: false,
  });
  expect(e?.kind).toBe("kata");
});

test("formatExecResult surfaces exit code, stdout, and stderr", () => {
  const out = formatExecResult({ stdout: "hello", stderr: "oops", exitCode: 3, timedOut: false });
  expect(out).toContain("exit code: 3");
  expect(out).toContain("hello");
  expect(out).toContain("oops");
});

liveTest(
  "docker executor runs a command and captures stdout + exit 0",
  async () => {
    const e = new LocalDockerExecutor("alpine:3.20", 30_000, false, 600_000);
    const r = await e.run({ command: "echo hi from sandbox" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("hi from sandbox");
    expect(r.timedOut).toBe(false);
  },
  60_000,
);

liveTest(
  "docker executor reports a nonzero exit code",
  async () => {
    const e = new LocalDockerExecutor("alpine:3.20", 30_000, false, 600_000);
    const r = await e.run({ command: "exit 7" });
    expect(r.exitCode).toBe(7);
  },
  60_000,
);

liveTest(
  "a session's /workspace persists across calls; disposeSession clears it",
  async () => {
    const e = new LocalDockerExecutor("alpine:3.20", 30_000, false, 600_000);
    const session = "test-" + Math.random().toString(36).slice(2);
    try {
      const w = await e.run({ command: "echo persisted > /workspace/note.txt", session });
      expect(w.exitCode).toBe(0);
      const r = await e.run({ command: "cat /workspace/note.txt", session });
      expect(r.stdout).toContain("persisted"); // same container → the file survived
    } finally {
      e.disposeSession(session);
    }
    // A session-less (one-off) call shares nothing with the disposed session.
    const fresh = await e.run({ command: "cat /workspace/note.txt 2>&1 || echo GONE" });
    expect(fresh.stdout).toContain("GONE");
  },
  90_000,
);
