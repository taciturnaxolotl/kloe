import { expect, test } from "bun:test";
import type { LanguageModelV3StreamPart } from "@ai-sdk/provider";
import { MockLanguageModelV3, simulateReadableStream } from "ai/test";
import { RESEARCH_CASES } from "../evals/research-cases";
import { aggregate, type EvalScore, judgeRun, overall, ZERO } from "../src/evals";
import type { ResearchResult } from "../src/research";

/**
 * The grader, not the research.
 *
 * A suite that only runs against real models can't be tested — it costs money
 * and returns different numbers every time. What IS testable is everything
 * around the judgement: that a filed score is carried through, that a judge
 * which never answers produces a score labelled as a non-measurement rather
 * than a zero that looks like a bad report, and that scores out of range are
 * clamped rather than trusted.
 */

const RESULT: ResearchResult = {
  summary: "s",
  title: "T",
  filename: "t.md",
  report: "# T\n\nA claim [1].",
  sources: [{ n: 1, url: "https://a.test", title: "A" }],
  stats: {
    steps: 7,
    read: 3,
    searches: 4,
    ms: 1234,
    tokens: { input: 90, output: 10, total: 100 },
    citeDensity: 12.5,
  },
};

/** A model that answers with one `grade` tool call carrying `args`. */
function judgeModel(args: unknown): MockLanguageModelV3 {
  return new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          {
            type: "tool-call",
            toolCallId: "c1",
            toolName: "grade",
            input: JSON.stringify(args),
          },
          {
            type: "finish",
            finishReason: "tool-calls",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ] as LanguageModelV3StreamPart[],
      }),
    }),
  });
}

test("a filed grade is carried through, with the mean as one number", async () => {
  const score = await judgeRun(
    judgeModel({
      factual: 0.8,
      citation: 0.6,
      completeness: 1,
      sources: 0.4,
      efficiency: 0.7,
      notes: "Thin on the second half of the question.",
    }),
    RESEARCH_CASES[0]!,
    RESULT,
  );
  expect(score.overall).toBe(0.7); // (0.8+0.6+1+0.4+0.7)/5
  expect(score.notes).toContain("second half");
  // The price rides with the score: a 0.9 that cost 400k tokens is a different
  // result from a 0.9 that cost 40k.
  expect(score.cost).toEqual({ tokens: 100, sources: 3, steps: 7, ms: 1234, citeDensity: 12.5 });
});

test("scores outside the range are clamped, not trusted", async () => {
  const score = await judgeRun(
    judgeModel({
      factual: 4,
      citation: -2,
      completeness: 0.5,
      sources: Number.NaN,
      efficiency: 0.5,
      notes: "n",
    }),
    RESEARCH_CASES[0]!,
    RESULT,
  );
  expect(score.factual).toBe(1);
  expect(score.citation).toBe(0);
  expect(score.sources).toBe(0);
});

test("a judge that never files is marked as a broken measurement", async () => {
  const silent = new MockLanguageModelV3({
    doStream: async () => ({
      stream: simulateReadableStream({
        chunks: [
          { type: "stream-start", warnings: [] },
          { type: "text-start", id: "t" },
          { type: "text-delta", id: "t", delta: "I would rather chat about it." },
          { type: "text-end", id: "t" },
          {
            type: "finish",
            finishReason: "stop",
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          },
        ] as LanguageModelV3StreamPart[],
      }),
    }),
  });
  const score = await judgeRun(silent, RESEARCH_CASES[0]!, RESULT);
  expect(score.overall).toBe(0);
  // The distinction that matters: a provider outage must not read as a quality
  // regression the next time someone looks at the chart.
  expect(score.notes).toContain("JUDGE DID NOT REPORT");
});

test("overall and aggregate average what they say they average", () => {
  expect(overall({ ...ZERO, factual: 1, citation: 1 })).toBe(0.4);
  const s = (id: string, v: number, tokens: number): EvalScore => ({
    id,
    factual: v,
    citation: v,
    completeness: v,
    sources: v,
    efficiency: v,
    overall: v,
    notes: "",
    cost: { tokens, sources: 1, steps: 1, ms: 1, citeDensity: 0 },
  });
  const agg = aggregate([s("a", 0.4, 10_000), s("b", 0.8, 30_000)]);
  expect(agg.overall).toBe(0.6);
  expect(agg.tokens).toBe(20_000);
  expect(aggregate([]).overall).toBe(0); // an empty suite is not a perfect one
});

test("every case carries a reason for being in the suite", () => {
  // A case nobody can justify is a case nobody will fix when it fails.
  const ids = new Set<string>();
  for (const c of RESEARCH_CASES) {
    expect(c.why.length).toBeGreaterThan(40);
    expect(c.expects.length).toBeGreaterThan(0);
    expect(ids.has(c.id)).toBe(false);
    ids.add(c.id);
  }
});
