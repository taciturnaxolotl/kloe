import { test, expect } from "bun:test";
import { LocalDockerExecutor, createExecutor, formatExecResult } from "../src/executor";

// docker isn't guaranteed in CI; probe once and skip the live cases without it.
async function dockerAvailable(): Promise<boolean> {
  try { return (await Bun.spawn(["docker", "version"], { stdout: "ignore", stderr: "ignore" }).exited) === 0; }
  catch { return false; }
}
const HAS_DOCKER = await dockerAvailable();
const liveTest = HAS_DOCKER ? test : test.skip;

test("createExecutor returns null when the sandbox is disabled", () => {
  expect(createExecutor({ enabled: false, backend: "docker", image: "alpine:3.20", timeoutMs: 30_000, network: false })).toBeNull();
});

test("createExecutor builds a docker executor when enabled", () => {
  const e = createExecutor({ enabled: true, backend: "docker", image: "alpine:3.20", timeoutMs: 30_000, network: false });
  expect(e?.kind).toBe("docker");
});

test("createExecutor returns null for the not-yet-implemented spindle backend", () => {
  expect(createExecutor({ enabled: true, backend: "spindle", image: "alpine:3.20", timeoutMs: 30_000, network: false })).toBeNull();
});

test("formatExecResult surfaces exit code, stdout, and stderr", () => {
  const out = formatExecResult({ stdout: "hello", stderr: "oops", exitCode: 3, timedOut: false });
  expect(out).toContain("exit code: 3");
  expect(out).toContain("hello");
  expect(out).toContain("oops");
});

liveTest("docker executor runs a command and captures stdout + exit 0", async () => {
  const e = new LocalDockerExecutor("alpine:3.20", 30_000, false);
  const r = await e.run({ command: "echo hi from sandbox" });
  expect(r.exitCode).toBe(0);
  expect(r.stdout).toContain("hi from sandbox");
  expect(r.timedOut).toBe(false);
}, 60_000);

liveTest("docker executor reports a nonzero exit code", async () => {
  const e = new LocalDockerExecutor("alpine:3.20", 30_000, false);
  const r = await e.run({ command: "exit 7" });
  expect(r.exitCode).toBe(7);
}, 60_000);
