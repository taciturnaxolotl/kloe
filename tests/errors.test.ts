import { expect, test } from "bun:test";
import { providerErrorDetail, requestShape } from "../src/errors";

// What an AI SDK APICallError actually carries when a provider answers 400 with
// a message that says nothing.
const err = Object.assign(
  new Error("Invalid input. Please review your request before trying again."),
  {
    url: "https://api.anthropic.com/v1/messages",
    statusCode: 400,
    responseBody:
      '{"type":"error","error":{"message":"messages.1: text content blocks must be non-empty"}}',
    requestBodyValues: {
      messages: [
        { role: "user", content: "hi" },
        { role: "assistant", content: [{ type: "thinking" }, { type: "text", text: "" }] },
      ],
    },
  },
);

test("the response body survives, which String(err) throws away", () => {
  expect(String(err)).not.toContain("non-empty");
  expect(providerErrorDetail(err)).toContain("400 https://api.anthropic.com/v1/messages");
  expect(providerErrorDetail(err)).toContain("must be non-empty");
});

test("a long body is capped", () => {
  const big = Object.assign(new Error("x"), {
    statusCode: 500,
    url: "u",
    responseBody: "y".repeat(50),
  });
  expect(providerErrorDetail(big, 10)).toBe("500 u → yyyyyyyyyy…");
});

test("the request's shape is logged, its content is not", () => {
  expect(requestShape(err)).toBe("user:text(2) assistant:[thinking,text(0)]");
});

test("an error that isn't a provider call is left alone", () => {
  expect(providerErrorDetail(new Error("boom"))).toBeNull();
  expect(requestShape(new Error("boom"))).toBeNull();
});
