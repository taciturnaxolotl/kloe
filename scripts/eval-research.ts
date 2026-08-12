import { mkdirSync, writeFileSync } from "node:fs";
import { RESEARCH_CASES } from "../evals/research-cases";
import { aggregate, type EvalScore, judgeRun } from "../src/evals";
import { createFetchProvider } from "../src/fetch";
import { initInference, resolveModel } from "../src/inference";
import { runResearch } from "../src/research";
import { createSearchProvider } from "../src/search";
import { getConfig } from "../src/settings";

/**
 * Run the research suite and grade it.
 *
 *   bun run eval:research -- --model hyper/some-model
 *   bun run eval:research -- --case compare-two --case unanswerable
 *   bun run eval:research -- --judge hyper/other-model --out evals/out
 *
 * This spends real money — a full pass is a dozen multi-agent research runs —
 * so it is a script you invoke, never part of `bun test`. Cases run one at a
 * time on purpose: the point is to measure the runs, and eight of them sharing
 * one rate limit measures the rate limit instead.
 *
 * Judging with the same model that did the research is allowed but noted in the
 * output: a model grading its own work grades it generously, and the number is
 * only meaningful against other numbers produced the same way.
 */

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(`--${name}`);
  return i > 0 ? process.argv[i + 1] : undefined;
}
function args(name: string): string[] {
  const out: string[] = [];
  for (let i = 0; i < process.argv.length; i++) {
    if (process.argv[i] === `--${name}` && process.argv[i + 1]) out.push(process.argv[i + 1]!);
  }
  return out;
}

const bar = (n: number) => "█".repeat(Math.round(n * 10)).padEnd(10, "·");

if (import.meta.main) {
  await initInference();
  const cfg = getConfig();

  const modelRef = arg("model") || cfg.agent.smallModel;
  if (!modelRef) {
    console.error("no model: pass --model <ref> (or set agent.smallModel)");
    process.exit(1);
  }
  const judgeRef = arg("judge") || modelRef;
  const search = createSearchProvider();
  const fetcher = createFetchProvider();
  if (!search || !fetcher) {
    console.error("research needs both a search provider and fetch enabled — check kloe.json");
    process.exit(1);
  }

  const only = new Set(args("case"));
  const cases = only.size ? RESEARCH_CASES.filter((c) => only.has(c.id)) : RESEARCH_CASES;
  if (!cases.length) {
    console.error(`no cases matched. known: ${RESEARCH_CASES.map((c) => c.id).join(", ")}`);
    process.exit(1);
  }

  const model = resolveModel(modelRef);
  const judge = resolveModel(judgeRef);
  console.log(
    `model  ${modelRef}\njudge  ${judgeRef}${judgeRef === modelRef ? "  (self-graded — read the number as relative, not absolute)" : ""}`,
  );
  console.log(`cases  ${cases.length}\n`);

  const scores: EvalScore[] = [];
  for (const c of cases) {
    const started = Date.now();
    process.stdout.write(`▸ ${c.id.padEnd(16)} `);
    try {
      const result = await runResearch({ question: c.question, model, search, fetcher });
      const score = await judgeRun(judge, c, result);
      scores.push(score);
      console.log(
        `${bar(score.overall)} ${score.overall.toFixed(2)}  ` +
          `${score.cost.sources} src · ${(score.cost.tokens / 1000).toFixed(0)}k tok · ` +
          `${Math.round(score.cost.ms / 1000)}s`,
      );
      if (score.overall < 0.7) console.log(`  ${score.notes}`);
    } catch (e) {
      // A run that crashes is a result: record it as a zero rather than losing
      // the rest of the suite to it.
      console.log(`FAILED after ${Math.round((Date.now() - started) / 1000)}s`);
      console.log(`  ${(e as Error).message}`);
      scores.push({
        id: c.id,
        factual: 0,
        citation: 0,
        completeness: 0,
        sources: 0,
        efficiency: 0,
        overall: 0,
        notes: `RUN FAILED: ${(e as Error).message}`,
        cost: { tokens: 0, sources: 0, steps: 0, ms: Date.now() - started, citeDensity: 0 },
      });
    }
  }

  const agg = aggregate(scores);
  console.log("\n───");
  for (const [k, v] of Object.entries(agg)) {
    if (k === "tokens") continue;
    console.log(`${k.padEnd(13)} ${bar(v as number)} ${(v as number).toFixed(2)}`);
  }
  console.log(`tokens/run    ${(agg.tokens / 1000).toFixed(0)}k`);

  const dir = arg("out") || "evals/runs";
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const path = `${dir}/${stamp}.json`;
  writeFileSync(
    path,
    JSON.stringify({ model: modelRef, judge: judgeRef, at: Date.now(), agg, scores }, null, 2),
  );
  console.log(`\nwrote ${path}`);
}
