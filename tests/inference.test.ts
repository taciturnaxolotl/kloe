import { expect, test } from "bun:test";
import type { ModelMessage } from "ai";
import { Catalog } from "../src/catalog";
import { effortFor, promptChars, setRegistry, usageFor } from "../src/inference";
import { ProviderRegistry } from "../src/providers";

test("context occupancy comes from the final step, not the summed steps", () => {
  // A tool loop re-sends the whole conversation each step, so the run total is a
  // multiple of what the turn actually leaves in the window. Reporting the total
  // as occupancy makes the gauge walk backwards whenever a short turn follows a
  // tool-heavy one.
  const u = usageFor(
    { inputTokens: 220_095, outputTokens: 1714, totalTokens: 221_809 },
    { inputTokens: 43_100, outputTokens: 1273 },
  );
  expect(u?.contextTokens).toBe(44_373);
  // The cost figures stay exactly what the provider reported.
  expect(u?.inputTokens).toBe(220_095);
  expect(u?.outputTokens).toBe(1714);
});

test("a cache read is added back when the input count was net of it", () => {
  // hyper reports prompt_tokens net of the cache hit, so a warm turn on a 250k
  // conversation bills 650. The adapter's derived noCache goes negative, which
  // is the tell; Crush adds the read back unconditionally because its SDK
  // normalizes the other way.
  const u = usageFor(
    { inputTokens: 650, outputTokens: 163, totalTokens: 813 },
    {
      inputTokens: 650,
      outputTokens: 163,
      inputTokenDetails: { noCacheTokens: -249_350, cacheReadTokens: 250_000 },
    },
  );
  expect(u?.contextTokens).toBe(250_813);
  expect(u?.contextEstimated).toBeUndefined(); // a real count, not a guess
  expect(u?.inputTokens).toBe(650); // still what it cost
});

test("an OpenAI-style input count already includes the cache read", () => {
  // prompt_tokens covers the cached prefix, so noCache stays positive and adding
  // the read back would double count.
  const u = usageFor(
    { inputTokens: 40_000, outputTokens: 500 },
    {
      inputTokens: 40_000,
      outputTokens: 500,
      inputTokenDetails: { noCacheTokens: 10_000, cacheReadTokens: 30_000 },
    },
  );
  expect(u?.contextTokens).toBe(40_500);
});

test("a silent provider falls back to the measurement, and says so", () => {
  // No cache detail to correct with: the floor is all we have.
  const u = usageFor(
    { inputTokens: 650, outputTokens: 163, totalTokens: 813 },
    { inputTokens: 650, outputTokens: 163 },
    1_023_027,
  );
  expect(u?.contextTokens).toBe(255_757);
  expect(u?.contextEstimated).toBe(true);
});

test("an honest provider outranks the rough estimate", () => {
  const u = usageFor(
    { inputTokens: 40_000, outputTokens: 500 },
    { inputTokens: 40_000, outputTokens: 500 },
    100_000,
  );
  expect(u?.contextTokens).toBe(40_500); // 100k chars ≈ 25k tokens, so the real count wins
});

test("usage with neither a final step nor a measurement omits occupancy", () => {
  const u = usageFor({ inputTokens: 12, outputTokens: 5, totalTokens: 17 });
  expect(u).toEqual({ inputTokens: 12, outputTokens: 5, totalTokens: 17 });
});

test("a provider reporting nothing yields no usage at all", () => {
  expect(usageFor({}, { inputTokens: 5 }, 400)).toBeUndefined();
});

test("promptChars measures text parts by their text", () => {
  const msgs: ModelMessage[] = [
    { role: "user", content: "hello" },
    { role: "assistant", content: [{ type: "text", text: "hi there" }] },
  ];
  expect(promptChars(msgs)).toBe("hello".length + "hi there".length);
});

test("an attached image costs a flat allowance, not its byte length", () => {
  // Serializing a Uint8Array yields ~6 chars per byte, so a 2MB screenshot would
  // measure as millions of tokens — and occupancy takes the larger source, so it
  // would stick there for the rest of the conversation.
  const msgs: ModelMessage[] = [
    {
      role: "user",
      content: [
        { type: "text", text: "what is this" },
        { type: "file", data: new Uint8Array(2_000_000), mediaType: "image/png" },
      ],
    },
  ];
  expect(promptChars(msgs)).toBeLessThan(20_000);
});

test("a reasoning level the model doesn't offer is dropped, not sent", () => {
  // Providers answer an unknown effort with a 400, and a run should not fail
  // because a client's picker was out of date — or because the level came from
  // a different model that happened to be selected earlier.
  setRegistry(
    new ProviderRegistry(
      Catalog.fromRaw([
        {
          id: "acme",
          name: "Acme",
          type: "openai-compat",
          api_endpoint: "https://acme.test/v1",
          models: [
            {
              id: "thinker",
              name: "Thinker",
              context_window: 8000,
              reasoning_levels: ["low", "high"],
            },
            { id: "plain", name: "Plain", context_window: 8000 },
          ],
        },
      ]),
      { config: { providers: [{ id: "acme", apiKey: "$K" }] } },
    ),
  );
  expect(effortFor("acme/thinker", "high")).toBe("high");
  expect(effortFor("acme/thinker", "xhigh")).toBeNull(); // not a level it offers
  expect(effortFor("acme/plain", "high")).toBeNull(); // offers none at all
  expect(effortFor("acme/thinker", undefined)).toBeNull();
});
