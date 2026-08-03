import { test, expect } from "bun:test";
import { validate, withBody } from "../src/validate";
import { PromptBody, ModelPatchBody } from "../src/schemas";

test("validate accepts a well-formed prompt body and infers the type", async () => {
  const r = await validate(PromptBody, { content: "hi", model: "openai/gpt-4" });
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.value.model).toBe("openai/gpt-4");
    expect(r.value.runId).toBeUndefined();
  }
});

test("validate rejects a missing model with 422 + issues", async () => {
  const r = await validate(PromptBody, { content: "hi" });
  expect(r.ok).toBe(false);
  if (!r.ok) {
    expect(r.status).toBe(422);
    expect(r.issues.length).toBeGreaterThan(0);
  }
});

test("validate rejects an empty model string (minLength)", async () => {
  const r = await validate(PromptBody, { content: "hi", model: "" });
  expect(r.ok).toBe(false);
});

test("validate rejects a wrong-typed field", async () => {
  const r = await validate(ModelPatchBody, { ref: "echo", visible: "yes" });
  expect(r.ok).toBe(false);
});

test("ModelPatchBody allows partial fields and an explicit null displayName", async () => {
  const r = await validate(ModelPatchBody, { ref: "echo", displayName: null });
  expect(r.ok).toBe(true);
  if (r.ok) {
    expect(r.value.displayName).toBeNull();
    expect(r.value.visible).toBeUndefined();
  }
});

// --- withBody: the Bun per-method route wrapper -------------------------------
function fakeReq(body: unknown, badJson = false) {
  return { json: async () => { if (badJson) throw new Error("bad json"); return body; } };
}

test("withBody passes validated, typed data to the handler (200)", async () => {
  const handler = withBody(PromptBody, (data) => Response.json({ model: data.model }));
  const res = await handler(fakeReq({ content: "hi", model: "echo" }));
  expect(res.status).toBe(200);
  expect(await res.json()).toEqual({ model: "echo" });
});

test("withBody returns 400 on unparseable JSON", async () => {
  const handler = withBody(PromptBody, () => new Response("unreached"));
  const res = await handler(fakeReq(null, true));
  expect(res.status).toBe(400);
});

test("withBody returns 422 and does NOT call the handler on a schema failure", async () => {
  let called = false;
  const handler = withBody(PromptBody, () => { called = true; return new Response("x"); });
  const res = await handler(fakeReq({ content: "hi" })); // no model
  expect(res.status).toBe(422);
  expect(called).toBe(false);
  const body = (await res.json()) as { error: string; issues: unknown[] };
  expect(body.error).toBe("validation failed");
  expect(body.issues.length).toBeGreaterThan(0);
});
