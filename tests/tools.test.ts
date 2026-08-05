import { test, expect } from "bun:test";
import { tool, jsonSchema, type ToolSet } from "ai";
import { harden } from "../src/tools";

const emptyInput = jsonSchema<Record<string, never>>({ type: "object", additionalProperties: false, properties: {} });

function run(tools: ToolSet, name: string) {
  const exec = tools[name]!.execute!;
  return exec({}, { toolCallId: "t", messages: [] });
}

test("harden turns a thrown execute into a recoverable message, not a throw", async () => {
  const tools: ToolSet = {
    boom: tool({ description: "always throws", inputSchema: emptyInput, execute: async () => { throw new Error("upstream 400"); } }),
  };
  harden(tools);
  const out = await run(tools, "boom");
  expect(typeof out).toBe("string");
  expect(out as string).toContain("boom");
  expect(out as string).toContain("upstream 400");
  expect(out as string).toContain("not fatal");
});

test("harden leaves a succeeding execute's result untouched", async () => {
  const tools: ToolSet = {
    ok: tool({ description: "returns an object", inputSchema: emptyInput, execute: async () => ({ ok: true, n: 42 }) }),
  };
  harden(tools);
  const out = await run(tools, "ok");
  expect(out).toEqual({ ok: true, n: 42 });
});
