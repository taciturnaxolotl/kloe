import { afterEach, expect, test } from "bun:test";
import type { FetchProvider, FetchResult } from "../src/fetch";
import {
  bindCitations,
  linkCitations,
  normalizeMarkers,
  reportFilename,
  researchBudget,
  runResearch,
  type Source,
  thinCitations,
} from "../src/research";
import type { SearchProvider, SearchResult } from "../src/search";
import { loadConfig, setConfig } from "../src/settings";

afterEach(() => setConfig(null));

function ledger(...urls: string[]): Source[] {
  return urls.map((url, i) => ({ n: i + 1, url, title: `Page ${i + 1}` }));
}

test("a citation that points at nothing is dropped, not shown", () => {
  // The citation pass is a model doing its best: it can invent [7] for a
  // two-source run. An invalid marker must never reach the reader.
  const out = bindCitations("Water is wet [1]. The moon is cheese [7].", ledger("a", "b"));
  expect(out.report).toBe("Water is wet [1]. The moon is cheese.");
  expect(out.sources.map((s) => s.url)).toEqual(["a"]);
});

test("cited sources are renumbered from 1 in order of appearance", () => {
  // The report leaned on the third and first pages only, so the reader sees
  // [1] and [2] rather than [3] and [1].
  const out = bindCitations("Claim A [3]. Claim B [1]. Claim C [3].", ledger("a", "b", "c"));
  expect(out.report).toBe("Claim A [1]. Claim B [2]. Claim C [1].");
  expect(out.sources).toEqual([
    { n: 1, url: "c", title: "Page 3" },
    { n: 2, url: "a", title: "Page 1" },
  ]);
});

test("several sources on one sentence survive together", () => {
  const out = bindCitations("Both agree [1][2].", ledger("a", "b"));
  expect(out.report).toBe("Both agree [1][2].");
  expect(out.sources).toHaveLength(2);
});

test("dropping a marker doesn't leave a gap before the punctuation", () => {
  const out = bindCitations("A fact [9] holds.", ledger("a"));
  expect(out.report).toBe("A fact holds.");
});

test("an uncited report keeps its text and lists no sources", () => {
  const out = bindCitations("Nothing here is attributed.", ledger("a", "b"));
  expect(out.report).toBe("Nothing here is attributed.");
  expect(out.sources).toEqual([]);
});

test("validated markers become links, and the document carries its sources", () => {
  const out = linkCitations("Water is wet [1]. So is rain [2].", [
    { n: 1, url: "https://a.test/x", title: "A page" },
    { n: 2, url: "https://b.test/y", title: "B page" },
  ]);
  // A plain `[n](url)` link: streaming-markdown mis-parses the nested `[[n]]`
  // form and leaks the raw URL into the paragraph. The renderer puts the bracket
  // shape back when it upgrades these to source pills.
  expect(out).toContain("[1](https://a.test/x)");
  expect(out).toContain("[2](https://b.test/y)");
  // And the file stands on its own once downloaded.
  expect(out).toContain("## Sources");
  expect(out).toContain("1. [A page](https://a.test/x)");
});

test("an uncited document gains no sources section", () => {
  expect(linkCitations("Nothing attributed.", [])).toBe("Nothing attributed.");
});

test("the budget comes from config, and a caller may tighten one field", () => {
  const base = loadConfig({ path: "/nonexistent", env: {} });
  setConfig({ ...base, research: { ...base.research, maxSources: 4 } });
  expect(researchBudget().maxSources).toBe(4);
  expect(researchBudget({ maxSources: 2 }).maxSources).toBe(2);
  expect(researchBudget({ maxSources: 2 }).maxSteps).toBe(base.research.maxSteps);
});

// ---- the loop, against stub providers ----------------------------------

function stubSearch(results: SearchResult[]): SearchProvider {
  return { search: async () => results };
}
function stubFetch(pages: Record<string, Partial<FetchResult>>): FetchProvider {
  return {
    fetch: async (url) => ({
      url,
      title: "T",
      content: "body",
      format: "markdown",
      truncated: false,
      ...pages[url],
    }),
  };
}

/**
 * A model that answers by ROLE rather than by position.
 *
 * The run is a planner, then workers in parallel, then a synthesizer — so a
 * positional script would be nondeterministic the moment two workers interleave.
 * Each call is identified by the tools it was given, which is exactly what
 * distinguishes the roles in the real code too.
 */
type Turn = { text?: string; calls?: Array<[string, unknown]> };
function roleModel(roles: { plan?: Turn[]; worker?: Turn[]; synth?: Turn[] }) {
  const seen = { plan: 0, worker: 0, synth: 0 };
  return {
    specificationVersion: "v4",
    provider: "test",
    modelId: "scripted",
    supportedUrls: {},
    doStream: async (opts: { tools?: Array<{ name: string }> }) => {
      const names = (opts.tools ?? []).map((t) => t.name);
      const role = names.includes("plan")
        ? "plan"
        : names.includes("read_page")
          ? "worker"
          : "synth";
      const script = roles[role] ?? [];
      const turn = script[Math.min(seen[role]++, script.length - 1)] ?? {};
      const parts: Array<Record<string, unknown>> = [];
      for (const [name, input] of turn.calls ?? []) {
        parts.push({
          type: "tool-call",
          toolCallId: `c${role}${seen[role]}${name}`,
          toolName: name,
          input: JSON.stringify(input),
        });
      }
      if (turn.text) {
        parts.push({ type: "text-start", id: "t" });
        parts.push({ type: "text-delta", id: "t", delta: turn.text });
        parts.push({ type: "text-end", id: "t" });
      }
      parts.push({
        type: "finish",
        finishReason: turn.calls?.length ? "tool-calls" : "stop",
        usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
      });
      return {
        stream: new ReadableStream({
          start(c) {
            for (const p of parts) c.enqueue(p);
            c.close();
          },
        }),
      };
    },
  } as unknown as Parameters<typeof runResearch>[0]["model"];
}

const PLAN = (...angles: string[]): Turn => ({ calls: [["plan", { angles }]] });
const NOTES = (notes: string): Turn => ({ calls: [["submit_findings", { notes }]] });
const FILE = (
  content: string,
  title = "T",
  filename = "f",
  summary = "The short answer.",
): Turn => ({
  calls: [["write_report", { title, filename, summary, content }]],
});
/** The common shape: one angle, one worker that reads nothing, one report. */
function simpleRun(over: Partial<Parameters<typeof runResearch>[0]> = {}) {
  return runResearch({
    question: "what",
    model: roleModel({
      plan: [PLAN("only angle")],
      worker: [NOTES("notes")],
      synth: [FILE("Findings.")],
    }),
    search: stubSearch([]),
    fetcher: stubFetch({}),
    ...over,
  });
}

test("the model names its own document, but not where the name points", () => {
  expect(reportFilename("Hack Club Funding")).toBe("hack-club-funding.md");
  expect(reportFilename("hack-club-funding.md")).toBe("hack-club-funding.md");
  // Separators, traversal and leading dots are stripped, not escaped: the model
  // picks a name, never a path.
  expect(reportFilename("../../etc/passwd")).toBe("etc-passwd.md");
  expect(reportFilename("/tmp/x")).toBe("tmp-x.md");
  expect(reportFilename(".hidden")).toBe("hidden.md");
  expect(reportFilename("   ")).toBe("research-findings.md");
  expect(reportFilename("a".repeat(200)).length).toBeLessThanOrEqual(63);
});

test("the filed report is the deliverable, and workers never write it", async () => {
  const out = await runResearch({
    question: "what",
    model: roleModel({
      plan: [PLAN("angle a")],
      worker: [{ text: "thinking out loud", calls: [["submit_findings", { notes: "raw notes" }]] }],
      synth: [FILE("# Real report\n\nBody.", "How X works", "how-x")],
    }),
    search: stubSearch([]),
    fetcher: stubFetch({}),
  });
  expect(out.report).toBe("# Real report\n\nBody."); // no sources read, so nothing appended
  expect(out.title).toBe("How X works");
  expect(out.filename).toBe("how-x.md");
  // The worker's narration and its raw notes are both upstream of the document.
  expect(out.report).not.toContain("thinking out loud");
  expect(out.report).not.toContain("raw notes");
});

test("the document travels on the progress channel, not in the result", async () => {
  // A tool result is permanent conversation context, re-sent on every later
  // turn. The report can run to thousands of tokens, so it goes to the UI over
  // progress — durable and rendered, never shown to a model — and the run hands
  // back a summary instead.
  const seen: Array<{ phase: string; data?: unknown }> = [];
  const out = await runResearch({
    question: "what",
    model: roleModel({
      plan: [PLAN("a")],
      worker: [NOTES("notes")],
      synth: [FILE("# Long report\n\nMany paragraphs.", "T", "f", "Two sentences of answer.")],
    }),
    search: stubSearch([]),
    fetcher: stubFetch({}),
    onProgress: (phase, data) => seen.push({ phase, data }),
  });
  expect(out.summary).toBe("Two sentences of answer.");
  const done = seen.find((p) => p.phase === "done")?.data as { report?: string } | undefined;
  expect(done?.report).toContain("Many paragraphs.");
});

test("a synthesizer that files no summary still says something useful", async () => {
  const out = await runResearch({
    question: "how does X work",
    model: roleModel({ plan: [PLAN("a")], worker: [NOTES("notes")], synth: [{ text: "nope" }] }),
    search: stubSearch([]),
    fetcher: stubFetch({}),
  });
  expect(out.summary).toContain("how does X work");
});

test("the synthesizer's citations survive into the document, validated", async () => {
  // End to end, because this is the property that broke in the field: every
  // document came out with zero citations and no bibliography. The synthesizer
  // cites [n] against the read ledger; the harness drops what doesn't resolve
  // and renumbers what does.
  const out = await runResearch({
    question: "what",
    model: roleModel({
      plan: [PLAN("a")],
      worker: [{ calls: [["read_page", { url: "https://a.test/x" }]] }, NOTES("notes")],
      // [1] is real; [4] points at a page nobody opened.
      synth: [FILE("Revenue was $22M [1]. The moon is cheese [4].")],
    }),
    search: stubSearch([]),
    fetcher: stubFetch({ "https://a.test/x": { title: "A page" } }),
  });
  expect(out.report).toContain("[1](https://a.test/x)"); // a real, clickable marker
  expect(out.report).not.toContain("[4]"); // invented, so dropped
  expect(out.report).toContain("## Sources");
  expect(out.report).toContain("1. [A page](https://a.test/x)");
  expect(out.sources).toEqual([{ n: 1, url: "https://a.test/x", title: "A page" }]);
});

test("the question is split across parallel workers", async () => {
  const seen: Array<{ phase: string; data?: unknown }> = [];
  await runResearch({
    question: "what",
    model: roleModel({
      plan: [PLAN("angle a", "angle b", "angle c")],
      worker: [NOTES("notes")],
      synth: [FILE("Done.")],
    }),
    search: stubSearch([]),
    fetcher: stubFetch({}),
    onProgress: (phase, data) => seen.push({ phase, data }),
  });
  const agents = seen.filter((p) => p.phase === "agent");
  expect(agents).toHaveLength(3);
  const planned = seen.find((p) => p.phase === "plan")?.data as { angles: string[] } | undefined;
  expect(planned?.angles).toEqual(["angle a", "angle b", "angle c"]);
  // Every worker is started before any of them finishes: they run together.
  const phases = seen.map((p) => p.phase);
  expect(phases.lastIndexOf("agent")).toBeLessThan(phases.indexOf("agent-done"));
  expect(phases.indexOf("synthesis")).toBeGreaterThan(phases.lastIndexOf("agent-done"));
});

test("a planner that fails still researches, as one angle", async () => {
  const seen: string[] = [];
  const out = await runResearch({
    question: "the whole question",
    model: roleModel({
      plan: [{ text: "I refuse to use the tool" }],
      worker: [NOTES("notes")],
      synth: [FILE("Done.")],
    }),
    search: stubSearch([]),
    fetcher: stubFetch({}),
    onProgress: (phase) => seen.push(phase),
  });
  expect(out.report).toBe("Done.");
  expect(seen.filter((p) => p === "agent")).toHaveLength(1);
});

test("workers share one page budget, one numbering and one dedupe", async () => {
  // Two workers, each asking for the same two pages: four requests, one URL
  // apiece after redirects — so two sources, numbered once, not four.
  const out = await runResearch({
    question: "what",
    model: roleModel({
      plan: [PLAN("a", "b")],
      worker: [
        {
          calls: [
            ["read_page", { url: "https://a.test/1" }],
            ["read_page", { url: "https://a.test/2" }],
          ],
        },
        NOTES("notes"),
      ],
      synth: [FILE("Both pages said things [1][2].")],
    }),
    search: stubSearch([]),
    fetcher: stubFetch({}),
    budget: { maxSources: 10 },
  });
  expect(out.stats.read).toBe(2);
  expect(out.sources.map((s) => s.n)).toEqual([1, 2]);
});

test("the page-read cap is enforced by the harness, not the prompt", async () => {
  // Four reads asked for, two allowed. The rest come back as a budget message
  // rather than a fetch, and never enter the ledger.
  const out = await runResearch({
    question: "what",
    model: roleModel({
      plan: [PLAN("a")],
      worker: [
        {
          calls: [
            ["read_page", { url: "https://a.test/1" }],
            ["read_page", { url: "https://a.test/2" }],
            ["read_page", { url: "https://a.test/3" }],
            ["read_page", { url: "https://a.test/4" }],
          ],
        },
        NOTES("notes"),
      ],
      synth: [FILE("Done.")],
    }),
    search: stubSearch([]),
    fetcher: stubFetch({}),
    budget: { maxSources: 2 },
  });
  expect(out.stats.read).toBe(2);
});

test("the run reports its phases as it goes, not only at the end", async () => {
  const seen: Array<{ phase: string; data?: unknown }> = [];
  await runResearch({
    question: "what",
    model: roleModel({
      plan: [PLAN("a")],
      worker: [
        { calls: [["web_search", { query: "spherical mirrors" }]] },
        { calls: [["read_page", { url: "https://a.test/x" }]] },
        NOTES("notes"),
      ],
      synth: [FILE("Findings.")],
    }),
    search: stubSearch([{ title: "T", url: "https://a.test/x", snippet: "s" }]),
    fetcher: stubFetch({ "https://a.test/x": { title: "A page" } }),
    onProgress: (phase, data) => seen.push({ phase, data }),
  });
  const phases = seen.map((p) => p.phase);
  expect(phases.indexOf("planning")).toBe(0);
  expect(phases.indexOf("plan")).toBeLessThan(phases.indexOf("agent"));
  expect(phases.indexOf("search")).toBeLessThan(phases.indexOf("read"));
  expect(phases.indexOf("read")).toBeLessThan(phases.indexOf("synthesis"));
  expect(phases[phases.length - 1]).toBe("done");
  expect(seen.find((p) => p.phase === "read")?.data).toMatchObject({
    agent: 0,
    url: "https://a.test/x",
    title: "A page",
  });
});

test("a worker that fails doesn't sink the run", async () => {
  // The reads happened; only the filing blew up. Thinner, not lost.
  const out = await runResearch({
    question: "what",
    model: roleModel({
      plan: [PLAN("a", "b")],
      worker: [{ calls: [["read_page", { url: "https://a.test/1" }]] }, NOTES("notes")],
      synth: [FILE("Salvaged.")],
    }),
    search: stubSearch([]),
    fetcher: stubFetch({}),
  });
  expect(out.report).toBe("Salvaged.");
  expect(out.stats.read).toBe(1);
});

test("a run with nothing listening still works", async () => {
  const out = await simpleRun();
  expect(out.report).toBe("Findings.");
});

// ---- citation density ------------------------------------------------------
// The synthesizer reaches for markers as a display of rigour. The prompt asks
// for restraint; this enforces it, because an instruction about density is one
// a model holds for two paragraphs and forgets across three thousand words.

test("a source cited in the previous sentence is not re-cited in the next", () => {
  const text = "Bun ships a bundler [3]. It also runs tests [3]. Deno differs [4].";
  // One passage, one source: the second marker tells the reader nothing they
  // didn't learn from the first.
  expect(thinCitations(text)).toBe(
    "Bun ships a bundler [3]. It also runs tests. Deno differs [4].",
  );
});

test("stacks of markers are capped at two", () => {
  const text =
    "The figure is contested [1][2][3][4]. Later work agrees [1]. Others dissent [2]. A third view [3]. And a fourth [4].";
  const out = thinCitations(text);
  // The first two survive — the ones the synthesizer reached for first.
  expect(out).toContain("contested [1][2].");
  // …and every dropped source still appears where it does real work.
  expect(out).toContain("A third view [3]");
  expect(out).toContain("a fourth [4]");
});

test("a source's only marker is never dropped, however dense its neighbourhood", () => {
  // [9] appears once, inside a stack, right after [9]'s neighbours were cited.
  const text = "A claim [1][2][9]. Another [1].";
  const out = thinCitations(text);
  expect(out).toContain("[9]"); // dropping it would delete the page from the bibliography
});

test("thinning survives the round trip into a bound, linked report", () => {
  const ledger = [
    { n: 1, url: "https://a.test", title: "A" },
    { n: 2, url: "https://b.test", title: "B" },
  ];
  const draft = "First claim [1]. Same source again [1]. A different one [2].";
  const bound = bindCitations(thinCitations(draft), ledger);
  expect(bound.report).toBe("First claim [1]. Same source again. A different one [2].");
  // Both sources were used, so both keep their place in the bibliography.
  expect(bound.sources.map((s) => s.url)).toEqual(["https://a.test", "https://b.test"]);
});

test("prose with no citations is returned untouched", () => {
  const plain = "A paragraph with nothing to cite. And a second sentence.";
  expect(thinCitations(plain)).toBe(plain);
});

test("grouped markers are split so validation can't be bypassed", () => {
  // Found by the eval suite: a model writes [4,5] as naturally as [4][5], and
  // the grouped form matched no validator — so it reached the reader pointing
  // at sources that were never read.
  expect(normalizeMarkers("A claim [4,5]. Another [7, 9]. A third [1;2].")).toBe(
    "A claim [4][5]. Another [7][9]. A third [1][2].",
  );
  expect(normalizeMarkers("Ordinary [3] is untouched.")).toBe("Ordinary [3] is untouched.");

  // The point of the fix: grouped markers pointing at nothing are now dropped
  // like any other invalid one, instead of surviving as literal text.
  const ledger = [{ n: 1, url: "https://a", title: "A" }];
  const bound = bindCitations("A claim [4,5]. Another [1].", ledger);
  expect(bound.report).toBe("A claim. Another [1].");
  expect(bound.sources).toHaveLength(1);
});
