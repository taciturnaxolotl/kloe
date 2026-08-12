import type { EvalCase } from "../src/evals";

/**
 * The research suite: a dozen questions chosen to fail in different ways.
 *
 * Not a benchmark and not a sample of real traffic — a set of shapes. Each case
 * is here because some class of research run breaks on it, and a change that
 * fixes one shape while breaking another should show up as a moved number
 * rather than as a feeling.
 *
 * Answers deliberately are NOT pinned to exact values. A suite that asserts
 * "$1.2M" goes stale the week the figure changes and then fails for the one
 * reason that isn't a regression. `expects` describes what a good report has to
 * ESTABLISH; the judge decides whether it did.
 */
export const RESEARCH_CASES: EvalCase[] = [
  {
    id: "fact-single",
    question: "What licence is the Bun JavaScript runtime released under, and has it ever changed?",
    expects: ["the current licence", "whether it has changed since release"],
    why: "The cheapest possible run. Over-investment shows up here: this needs one angle and a couple of pages, and a report with fifteen sources is a failure of judgement, not thoroughness.",
  },
  {
    id: "compare-two",
    question:
      "Compare Bun and Deno as a runtime for a small server-side TypeScript project in 2026: performance, ecosystem compatibility, and stability.",
    expects: [
      "a position on each of the three axes",
      "where each runtime is the better choice",
      "acknowledgement of what is contested or moving",
    ],
    why: "The comparison shape. Tests whether the planner splits by subject (per runtime, per axis) rather than by 'find sources' and 'analyse sources', and whether the synthesizer merges instead of concatenating.",
  },
  {
    id: "moving-target",
    question:
      "What is the current state of WebGPU support across browsers, and what is still missing?",
    expects: [
      "per-browser status",
      "which parts of the spec are unimplemented or behind flags",
      "how recent the information is",
    ],
    why: "A moving target. Rewards primary sources (caniuse, browser status dashboards, the spec) over blog posts, and punishes a report that states a 2023 position as current.",
  },
  {
    id: "numbers",
    question:
      "How much did Hack Club spend on the Athena award program, and where does that funding come from?",
    expects: ["figures with their source", "the funding origin", "what could not be established"],
    why: "Figures with provenance. The failure mode is a confident number with no citation, which `factual` and `citation` should both punish.",
  },
  {
    id: "contested",
    question:
      "Is fluoridation of public drinking water beneficial? What do the strongest arguments on each side rest on?",
    expects: [
      "the strongest case for",
      "the strongest case against",
      "what the disagreement actually turns on",
      "which claims are well supported and which are not",
    ],
    why: "Contested ground. Tests whether conflicting sources are reported as a conflict rather than averaged into mush, and whether the report distinguishes the well-evidenced from the loud.",
  },
  {
    id: "obscure",
    question:
      "What is the Zig build system's approach to dependency management, and how has it changed since 0.11?",
    expects: ["the current mechanism", "what it replaced", "the practical consequences"],
    why: "Sparse material. The failure mode Anthropic names as 'endless searching for sources that do not exist' — a good run establishes what it can and says what it couldn't.",
  },
  {
    id: "js-heavy",
    question: "What are the current pricing tiers for Exa's search API?",
    expects: [
      "the tiers and their prices",
      "what each tier includes",
      "the date the pricing is from",
    ],
    why: "Lives behind a JS-rendered pricing page. Exercises the fetch ladder end to end: a run that answers this from a review site rather than the vendor's own page should lose marks on `sources`.",
  },
  {
    id: "unanswerable",
    question: "What will the FRC 2027 game be?",
    expects: [
      "that this is not knowable yet",
      "what IS known about the timeline or announcement process",
    ],
    why: "There is no answer. The only correct report says so plainly. A run that produces confident speculation, or that burns the whole source budget hunting, has failed in the most expensive way available.",
  },
];
