import { expect, test } from "bun:test";
import type { ToolSet } from "ai";
import { harden, sandboxDescription } from "../src/tools";

// harden() only reads/replaces each tool's `execute`, so a minimal tool-shaped
// object exercises it without the `tool()` builder's generic gymnastics.
function toolset(execute: () => Promise<unknown>): ToolSet {
  return { t: { description: "t", inputSchema: {}, execute } } as unknown as ToolSet;
}
function run(tools: ToolSet): Promise<unknown> {
  const exec = tools.t!.execute as (i: unknown, o: unknown) => Promise<unknown>;
  return exec({}, { toolCallId: "t", messages: [] });
}

test("harden turns a thrown execute into a recoverable message, not a throw", async () => {
  const tools = harden(
    toolset(async () => {
      throw new Error("upstream 400");
    }),
  );
  const out = (await run(tools)) as string;
  expect(typeof out).toBe("string");
  expect(out).toContain('"t"');
  expect(out).toContain("upstream 400");
  expect(out).toContain("not fatal");
});

test("harden leaves a succeeding execute's result untouched", async () => {
  const tools = harden(toolset(async () => ({ ok: true, n: 42 })));
  const out = await run(tools);
  expect(out).toEqual({ ok: true, n: 42 });
});

// The sandbox description is the model's whole picture of the environment, and
// the half that config decides is the half that used to be wrong.
const INFO = {
  image: "alpine:3.20",
  network: false,
  defaultTimeoutMs: 30_000,
  maxTimeoutMs: 300_000,
  memory: "512m",
  cpus: "1",
};

test("sandboxDescription tells the truth about the network, both ways", () => {
  const off = sandboxDescription(INFO, false);
  expect(off).toContain("NO network access");
  expect(off).not.toContain("apk add …");

  const on = sandboxDescription({ ...INFO, network: true }, false);
  expect(on).toContain("apk add");
  expect(on).not.toContain("NO network access");
});

test("sandboxDescription states the image and both timeouts in seconds", () => {
  const d = sandboxDescription(INFO, false);
  expect(d).toContain("alpine:3.20");
  expect(d).toContain("killed at 30s");
  expect(d).toContain("up to 300s");
});

test("sandboxDescription mentions get_attachment only when that tool is offered", () => {
  expect(sandboxDescription(INFO, true)).toContain("get_attachment");
  expect(sandboxDescription(INFO, false)).not.toContain("get_attachment");
});
