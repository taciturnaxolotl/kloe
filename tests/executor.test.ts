import { expect, test } from "bun:test";
import {
  createExecutor,
  formatExecResult,
  isDaemonDown,
  isMissingContainer,
  LocalDockerExecutor,
} from "../src/executor";

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

const SANDBOX = {
  enabled: true,
  backend: "docker",
  image: "alpine:3.20",
  timeoutMs: 30_000,
  maxTimeoutMs: 300_000,
  idleMs: 600_000,
  network: false,
} as const;
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
    maxTimeoutMs: 300_000,
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
    maxTimeoutMs: 300_000,
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
    const e = new LocalDockerExecutor(SANDBOX);
    const r = await e.run({ command: "echo hi from sandbox" });
    expect(r.exitCode).toBe(0);
    expect(r.stdout).toContain("hi from sandbox");
    expect(r.timedOut).toBe(false);
  },
  60_000,
);

liveTest(
  "a runaway command is killed inside the container, on time",
  async () => {
    const e = new LocalDockerExecutor(SANDBOX);
    const session = "test-" + Math.random().toString(36).slice(2);
    try {
      const started = Date.now();
      const r = await e.run({ command: "sleep 60", session, timeoutMs: 2_000 });
      expect(r.timedOut).toBe(true);
      // The in-container `timeout` fires before the client-side backstop, so the
      // process is actually dead rather than merely abandoned by the CLI.
      expect(Date.now() - started).toBeLessThan(4_000);
      // `[s]leep` so this probe's own command line doesn't match itself.
      const still = await e.run({ command: "ps -o args= | grep -c '[s]leep 60'", session });
      expect(still.stdout.trim()).toBe("0");
    } finally {
      e.disposeSession(session);
    }
  },
  90_000,
);

liveTest(
  "a session's timeout may be raised, never past the configured max",
  async () => {
    const e = new LocalDockerExecutor({ ...SANDBOX, timeoutMs: 1_000, maxTimeoutMs: 3_000 });
    const session = "test-" + Math.random().toString(36).slice(2);
    try {
      // Longer than the default and under the max: honored.
      expect((await e.run({ command: "sleep 2", session, timeoutMs: 5_000 })).timedOut).toBe(false);
      // Asking past the max is clamped to it, so this still dies.
      expect((await e.run({ command: "sleep 10", session, timeoutMs: 60_000 })).timedOut).toBe(
        true,
      );
    } finally {
      e.disposeSession(session);
    }
  },
  90_000,
);

liveTest(
  "a session starts with the inbox and outbox already there",
  async () => {
    const e = new LocalDockerExecutor(SANDBOX);
    const session = "test-" + Math.random().toString(36).slice(2);
    try {
      // No `mkdir -p` first: writing a file to keep is a one-liner, as the tool
      // description promises.
      const r = await e.run({ command: "echo kept > outputs/note.txt && ls inputs", session });
      expect(r.exitCode).toBe(0);
      const got = await e.harvest(session, "/workspace/outputs", { maxFiles: 5, maxBytes: 1e6 });
      expect(got.map((f) => f.path)).toEqual(["note.txt"]);
    } finally {
      e.disposeSession(session);
    }
  },
  90_000,
);

liveTest(
  "a restart adopts the conversation's sandbox, but a policy change replaces it",
  async () => {
    const session = "test-" + Math.random().toString(36).slice(2);
    const first = new LocalDockerExecutor(SANDBOX);
    try {
      await first.run({ command: "echo kept > /workspace/notes.txt", session });
      // A new executor over the same conversation is exactly what a server
      // restart looks like: the workspace should still be there.
      const restarted = new LocalDockerExecutor(SANDBOX);
      expect(
        (await restarted.run({ command: "cat /workspace/notes.txt", session })).stdout,
      ).toContain("kept");
      // Change what the sandbox is allowed to do and the old container is no
      // longer fit to adopt, however convenient its contents.
      const tightened = new LocalDockerExecutor({ ...SANDBOX, network: true });
      const r = await tightened.run({
        command: "cat /workspace/notes.txt 2>/dev/null || echo RECREATED",
        session,
      });
      expect(r.stdout).toContain("RECREATED");
    } finally {
      first.disposeSession(session);
    }
  },
  120_000,
);

liveTest(
  "a networked sandbox cannot reach the daemon host by its docker aliases",
  async () => {
    // The realistic path to the host is a model talked into fetching
    // `host.docker.internal:5432`, so the names go nowhere. This is name-level
    // only and deliberately so: the raw gateway IP and the open internet are
    // still reachable, and constraining those is firewall state on the daemon's
    // host (see `dockerNetwork`), not something this process can enforce.
    const e = new LocalDockerExecutor({ ...SANDBOX, network: true });
    const session = "test-" + Math.random().toString(36).slice(2);
    try {
      const r = await e.run({
        command:
          "for h in host.docker.internal host.internal gateway.docker.internal; do " +
          'echo "$h=$(getent hosts $h | cut -d" " -f1)"; done',
        session,
      });
      for (const line of r.stdout.trim().split("\n")) expect(line).toContain("=127.0.0.1");
    } finally {
      e.disposeSession(session);
    }
  },
  90_000,
);

liveTest(
  "the sandbox drops capabilities without breaking package installs",
  async () => {
    const e = new LocalDockerExecutor(SANDBOX);
    const session = "test-" + Math.random().toString(36).slice(2);
    try {
      // The effective capability set, read straight from the kernel, so this
      // asserts what the drop actually changed. Docker's default set is
      // 0xa80425fb; ours is 0xdb — chown, dac_override, fowner, fsetid, setgid,
      // setuid and nothing else. (An earlier version of this test asserted that
      // `mount` fails, which proved nothing: CAP_SYS_ADMIN was never in the
      // default set, so it failed before the hardening too.)
      const caps = await e.run({
        command: "grep -E 'CapEff|NoNewPrivs' /proc/self/status",
        session,
      });
      expect(caps.stdout).toContain("00000000000000db");
      expect(caps.stdout).toMatch(/NoNewPrivs:\s*1/);
      // ...while the file-ownership caps a package manager needs survive, which
      // is the whole reason the drop isn't a blanket one.
      const unpacked = await e.run({
        command:
          "mkdir -p /tmp/c && echo x > /tmp/c/f && chown 1000:1000 /tmp/c/f && " +
          "chmod u+s /tmp/c/f && echo CAPS-OK",
        session,
      });
      expect(unpacked.stdout).toContain("CAPS-OK");
    } finally {
      e.disposeSession(session);
    }
  },
  90_000,
);

liveTest(
  "docker executor reports a nonzero exit code",
  async () => {
    const e = new LocalDockerExecutor(SANDBOX);
    const r = await e.run({ command: "exit 7" });
    expect(r.exitCode).toBe(7);
  },
  60_000,
);

liveTest(
  "a session's /workspace persists across calls; disposeSession clears it",
  async () => {
    const e = new LocalDockerExecutor(SANDBOX);
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

liveTest(
  "a blob written in comes back out byte-identical, including binary",
  async () => {
    const e = new LocalDockerExecutor(SANDBOX);
    const session = "test-" + Math.random().toString(36).slice(2);
    // Bytes that would not survive a text round-trip: NUL, high bytes, a lone
    // 0xff. `docker exec -i` pipes stdin through untouched, which is the whole
    // reason this path uses `cat >` rather than a tar or a base64 hop.
    const bytes = new Uint8Array([0, 1, 2, 255, 254, 10, 13, 0, 65, 66]);
    try {
      await e.putFile(session, "/workspace/inputs/blob.bin", bytes);
      const r = await e.run({ command: "wc -c < /workspace/inputs/blob.bin", session });
      expect(r.stdout.trim()).toBe(String(bytes.length));

      // Promotion: the outbox is drained, not merely read.
      await e.run({
        command:
          "mkdir -p /workspace/outputs && cp /workspace/inputs/blob.bin /workspace/outputs/out.bin",
        session,
      });
      const got = await e.harvest(session, "/workspace/outputs", {
        maxFiles: 10,
        maxBytes: 1_000_000,
      });
      expect(got).toHaveLength(1);
      expect(got[0]!.path).toBe("out.bin");
      expect(Array.from(got[0]!.bytes)).toEqual(Array.from(bytes));
      // Drained: a second harvest finds nothing, so a later step can't re-promote it.
      expect(
        await e.harvest(session, "/workspace/outputs", { maxFiles: 10, maxBytes: 1e6 }),
      ).toEqual([]);

      // Nested files keep their path relative to the outbox. Promotion names a
      // document by that whole path, so two `notes.md` in different folders stay
      // two documents instead of collapsing into versions of each other.
      await e.run({
        command:
          "mkdir -p /workspace/outputs/a /workspace/outputs/b && " +
          "echo one > /workspace/outputs/a/notes.md && echo two > /workspace/outputs/b/notes.md",
        session,
      });
      const nested = await e.harvest(session, "/workspace/outputs", {
        maxFiles: 10,
        maxBytes: 1e6,
      });
      expect(nested.map((f) => f.path).sort()).toEqual(["a/notes.md", "b/notes.md"]);
    } finally {
      e.disposeSession(session);
    }
  },
  120_000,
);

liveTest(
  "harvesting a workspace with no outbox is empty, not an error",
  async () => {
    const e = new LocalDockerExecutor(SANDBOX);
    const session = "test-" + Math.random().toString(36).slice(2);
    try {
      await e.run({ command: "true", session });
      expect(
        await e.harvest(session, "/workspace/outputs", { maxFiles: 5, maxBytes: 1e6 }),
      ).toEqual([]);
    } finally {
      e.disposeSession(session);
    }
  },
  90_000,
);

liveTest(
  "readFile classifies what it found, not just whether it worked",
  async () => {
    const e = new LocalDockerExecutor(SANDBOX);
    const session = "test-" + Math.random().toString(36).slice(2);
    try {
      await e.putFile(session, "/workspace/notes.md", new TextEncoder().encode("one\ntwo\n"));
      expect(await e.readFile(session, "/workspace/notes.md")).toMatchObject({
        kind: "file",
        text: "one\ntwo\n",
      });

      // The three ways a read fails are three different mistakes, and the tool
      // above phrases a different fix for each.
      expect((await e.readFile(session, "/workspace/nope.md")).kind).toBe("missing");
      expect((await e.readFile(session, "/workspace")).kind).toBe("directory");

      // Bytes that were never text: refused rather than mangled into a string.
      await e.putFile(session, "/workspace/blob.bin", new Uint8Array([0, 1, 2, 0, 255]));
      expect((await e.readFile(session, "/workspace/blob.bin")).kind).toBe("binary");

      // A file too big to inline is a different answer from a file that failed.
      await e.run({
        command: "head -c 300000 /dev/zero | tr '\\0' 'x' > /workspace/big.txt",
        session,
      });
      expect((await e.readFile(session, "/workspace/big.txt")).kind).toBe("too-large");
    } finally {
      e.disposeSession(session);
    }
  },
  120_000,
);

test("a stopped daemon is told apart from a container that wouldn't start", () => {
  // The real message from a Mac with OrbStack shut down.
  expect(
    isDaemonDown(
      "failed to connect to the docker API at unix:///var/run/docker.sock; check if the path is correct and if the daemon is running: dial unix /var/run/docker.sock: connect: no such file or directory",
    ),
  ).toBe(true);
  expect(isDaemonDown("Cannot connect to the Docker daemon at unix:///var/run/docker.sock.")).toBe(
    true,
  );
  // A container that genuinely failed is a different problem with a different
  // answer, and must keep its own message.
  expect(isDaemonDown("Error response from daemon: No such image: alpine:9.99")).toBe(false);
  expect(isDaemonDown("invalid CapDrop: unknown capability")).toBe(false);
});

liveTest(
  "the daemon-down answer tells the model to stop trying",
  async () => {
    // Pointed at a socket that cannot exist: what a stopped runtime looks like.
    const e = new LocalDockerExecutor({ ...SANDBOX, dockerHost: "unix:///nope/docker.sock" });
    const r = await e.run({ command: "echo hi", session: "test-down" }).catch((err: Error) => err);
    expect(r).toBeInstanceOf(Error);
    const msg = (r as Error).message;
    expect(msg).toContain("sandbox is unavailable");
    expect(msg).toContain("do not retry");
  },
  60_000,
);

test("a removed container is recognised, and the daemon being down is not it", () => {
  expect(isMissingContainer("Error response from daemon: No such container: kloe-sbx-abc")).toBe(
    true,
  );
  expect(isMissingContainer("exec failed: no such file or directory")).toBe(false);
});

liveTest(
  "a container removed behind the executor's back is rebuilt, not reported to the model",
  async () => {
    // What a restart used to do: the startup sweep culled a container the
    // conversation had just adopted, and every later call in that turn handed
    // the model "No such container" as if the command had said it.
    const e = new LocalDockerExecutor(SANDBOX);
    const session = "test-" + Math.random().toString(36).slice(2);
    try {
      expect((await e.run({ command: "echo hi > /workspace/note.txt", session })).exitCode).toBe(0);
      const name = (e as unknown as { containerName(s: string): string }).containerName(session);
      await Bun.spawn(["docker", "rm", "-f", name], { stdout: "ignore", stderr: "ignore" }).exited;

      const r = await e.run({ command: "echo alive", session });
      expect(r.stderr).not.toContain("No such container");
      expect(r.exitCode).toBe(0);
      expect(r.stdout).toContain("alive");
      // The workspace was in the container, so it is genuinely gone. That is
      // the honest outcome; a dead session for the rest of the turn is not.
      expect((await e.readFile(session, "/workspace/note.txt")).kind).toBe("missing");
    } finally {
      e.disposeSession(session);
    }
  },
  120_000,
);

liveTest(
  "a restart adopts the containers it finds instead of sweeping them at boot",
  async () => {
    // The container outlived the process, so by uptime it is always older than
    // the idle TTL. Culling on that at boot cost every open conversation its
    // workspace, which is the opposite of what surviving a restart is for.
    const name = "kloe-sbx-test-" + Math.random().toString(36).slice(2);
    await Bun.spawn(
      [
        "docker",
        "run",
        "-d",
        "--name",
        name,
        "--label",
        "kloe-sandbox=1",
        SANDBOX.image,
        "sh",
        "-c",
        "exec tail -f /dev/null",
      ],
      { stdout: "ignore", stderr: "ignore" },
    ).exited;
    try {
      // Old by uptime, which is the only thing a fresh process can measure, and
      // the thing the boot sweep used to cull on.
      const idleMs = 3_000;
      await Bun.sleep(idleMs + 1_000);
      new LocalDockerExecutor({ ...SANDBOX, idleMs });
      await Bun.sleep(1_000); // let the constructor's sweep finish
      const alive = await Bun.spawn(["docker", "inspect", "-f", "{{.State.Running}}", name], {
        stdout: "pipe",
        stderr: "ignore",
      });
      expect((await new Response(alive.stdout).text()).trim()).toBe("true");
    } finally {
      await Bun.spawn(["docker", "rm", "-f", name], { stdout: "ignore", stderr: "ignore" }).exited;
    }
  },
  120_000,
);
