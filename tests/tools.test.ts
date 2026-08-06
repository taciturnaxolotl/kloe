import { expect, test } from "bun:test";
import type { ToolSet } from "ai";
import { harden } from "../src/tools";

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
