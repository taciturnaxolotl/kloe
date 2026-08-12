import { afterEach, expect, test } from "bun:test";
import type { FetchProvider, FetchResult } from "../src/fetch";
import {
  bindCitations,
  linkCitations,
  normalizeMarkers,
  recoverRun,
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
function roleModel(roles: { plan?: Turn[]; worker?: Turn[]; synth?: Turn[]; followup?: Turn[] }) {
  const seen = { plan: 0, worker: 0, synth: 0, followup: 0 };
  return {
    specificationVersion: "v4",
    provider: "test",
    modelId: "scripted",
    supportedUrls: {},
    doStream: async (opts: { tools?: Array<{ name: string }> }) => {
      const names = (opts.tools ?? []).map((t) => t.name);
      const role = names.includes("plan")
        ? "plan"
        : names.includes("direct")
          ? "followup"
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
/** The director's decision: which threads to pull next, or none to finish. */
const DIRECT = (angles: string[], why: string): Turn => ({ calls: [["direct", { angles, why }]] });
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

  // Research runs in ROUNDS, not one fan-out. The opening wave is small (see
  // `firstWave`), and the angles the planner proposed beyond it are a queue the
  // later rounds draw from — so a plan of three becomes 2 then 1.
  const rounds = seen.filter((p) => p.phase === "round").map((p) => p.data as { angles: string[] });
  expect(rounds.map((r) => r.angles.length)).toEqual([2, 1]);

  // Within a round the workers still run together: both of round one start
  // before either finishes.
  const phases = seen.map((p) => p.phase);
  const firstDone = phases.indexOf("agent-done");
  expect(phases.indexOf("agent")).toBeLessThan(firstDone);
  expect(phases.lastIndexOf("agent")).toBeGreaterThan(firstDone); // round two is later
  expect(phases.indexOf("synthesis")).toBeGreaterThan(phases.lastIndexOf("agent-done"));
});

test("what the first wave finds decides who goes out next", async () => {
  // The point of rounds: an angle nobody could have planned up front, because
  // it only exists once a worker has come back with something worth pulling on.
  const seen: Array<{ phase: string; data?: unknown }> = [];
  await runResearch({
    question: "what",
    model: roleModel({
      plan: [PLAN("opening angle")],
      worker: [NOTES("the filing mentions an unopened exhibit B")],
      followup: [
        DIRECT(["what does exhibit B say?"], "the notes point at a document nobody opened"),
      ],
      synth: [FILE("Done.")],
    }),
    search: stubSearch([]),
    fetcher: stubFetch({}),
    onProgress: (phase, data) => seen.push({ phase, data }),
  });
  const followed = seen.find((p) => p.phase === "followup")?.data as {
    angles: string[];
    why: string;
  };
  expect(followed.angles).toEqual(["what does exhibit B say?"]);
  expect(followed.why).toContain("nobody opened");
  // …and a worker actually went out on it.
  const angles = seen
    .filter((p) => p.phase === "agent")
    .map((p) => (p.data as { angle: string }).angle);
  expect(angles).toEqual(["opening angle", "what does exhibit B say?"]);
});

test("a run stops when the director says the question is answered", async () => {
  // Finishing early is a first-class outcome: the failure mode this guards
  // against is spending the whole budget to say the same thing at length.
  const seen: string[] = [];
  await runResearch({
    question: "what",
    model: roleModel({
      plan: [PLAN("only angle")],
      worker: [NOTES("complete answer")],
      followup: [DIRECT([], "the notes answer the question")],
      synth: [FILE("Done.")],
    }),
    search: stubSearch([]),
    fetcher: stubFetch({}),
    onProgress: (phase) => seen.push(phase),
  });
  expect(seen.filter((p) => p === "agent")).toHaveLength(1); // no second wave
  expect(seen).toContain("synthesis");
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

test("each item of a list keeps its own marker, however repetitive", () => {
  // Found by reading a real report: three payments from one ledger page came
  // out as one cited item and two that looked unsupported. A list is not a
  // passage — every item is its own claim.
  const text =
    "1. $33,810 for the award [3]\n2. $10,000 for Sunbeam [3]\n3. $2,500 for Sleepover [3]";
  expect(thinCitations(text)).toBe(text);

  // Prose still collapses, which is the point of the pass.
  expect(thinCitations("A claim [3]. The same source again [3].")).toBe(
    "A claim [3]. The same source again.",
  );
});

test("a URL containing parentheses survives becoming a markdown link", () => {
  // A LibreTexts path with `(Barrett_Dawson_Ortmann)` ended every link at its
  // first `)`, spilling the rest of the URL into the paragraph as plain text.
  const sources = [
    {
      n: 1,
      url: "https://med.libretexts.org/Book%3A_Ethics_(Barrett_Dawson)/02%3A_Topics",
      title: "T",
    },
  ];
  const out = linkCitations("A claim [1].", sources);
  expect(out).toContain(
    "[1](https://med.libretexts.org/Book%3A_Ethics_%28Barrett_Dawson%29/02%3A_Topics)",
  );
  // The bibliography carries the same URL and needs the same treatment.
  expect(out).toContain(
    "1. [T](https://med.libretexts.org/Book%3A_Ethics_%28Barrett_Dawson%29/02%3A_Topics)",
  );
  // Nothing after the link leaks into the prose.
  expect(out).not.toContain("Barrett_Dawson)/02");
});

// ---- resuming after a restart ----------------------------------------------
// A run is minutes of wall clock and millions of tokens. A server restart used
// to throw all of it away: the job came back, the model reissued the tool call,
// and every worker started over on the same pages.

const progressEvent = (phase: string, data: unknown, toolCallId = "call-1") => ({
  event: "tool-progress",
  data: { toolCallId, toolName: "deep_research", phase, data },
});

test("an interrupted run's notes and pages are recovered from the event log", () => {
  const events = [
    progressEvent("planning", { question: "what happened" }),
    progressEvent("read", { url: "https://a.test", title: "A" }),
    progressEvent("read", { url: "https://b.test", title: "B" }),
    progressEvent("agent-done", { agent: 0, angle: "the first angle", notes: "what A said" }),
    // …and then the server died: no `done` phase.
  ];
  const out = recoverRun(events, "what happened");
  expect(out?.notes).toEqual([{ angle: "the first angle", notes: "what A said" }]);
  expect(out?.ledger).toEqual([
    { n: 1, url: "https://a.test", title: "A" },
    { n: 2, url: "https://b.test", title: "B" },
  ]);
});

test("a finished run is not resumed — asking again means researching again", () => {
  const events = [
    progressEvent("planning", { question: "what happened" }),
    progressEvent("agent-done", { agent: 0, angle: "a", notes: "n" }),
    progressEvent("done", { stats: {} }),
  ];
  expect(recoverRun(events, "what happened")).toBeNull();
  // Nor is a different question's work borrowed.
  expect(recoverRun(events.slice(0, 2), "a different question")).toBeNull();
});

test("a resumed run skips finished angles and keeps their pages", async () => {
  const seen: Array<{ phase: string; data?: unknown }> = [];
  const out = await runResearch({
    question: "what",
    model: roleModel({
      plan: [PLAN("angle a", "angle b")],
      worker: [NOTES("fresh notes")],
      followup: [DIRECT([], "done")],
      synth: [FILE("Report body [1].")],
    }),
    search: stubSearch([]),
    fetcher: stubFetch({}),
    resume: {
      notes: [{ angle: "angle a", notes: "notes from before the restart" }],
      ledger: [{ n: 1, url: "https://a.test", title: "A" }],
    },
    onProgress: (phase, data) => seen.push({ phase, data }),
  });

  // Only the unfinished angle went back out.
  const angles = seen
    .filter((p) => p.phase === "agent")
    .map((p) => (p.data as { angle: string }).angle);
  expect(angles).toEqual(["angle b"]);

  // The recovered notes reach the synthesizer, and the recovered page keeps its
  // place in the bibliography — a citation must still resolve after a restart.
  expect(out.report).toContain("[1](https://a.test)");
  expect(out.sources).toEqual([{ n: 1, url: "https://a.test", title: "A" }]);
  expect(seen.some((p) => p.phase === "resumed")).toBe(true);
});

test("a worker's jot survives, and its angle stays open until someone finishes it", () => {
  // The asymmetry with a conversation: what is worth saving from a worker is
  // not its output but its reasoning over pages, and a jot is that reasoning
  // small enough to write down repeatedly.
  const events = [
    progressEvent("planning", { question: "what happened" }),
    progressEvent("read", { url: "https://a.test", title: "A" }),
    progressEvent("agent-note", { agent: 0, angle: "the open angle", notes: "halfway there" }),
    progressEvent("agent-note", { agent: 0, angle: "the open angle", notes: "further along" }),
    progressEvent("agent-done", { agent: 1, angle: "the closed angle", notes: "complete" }),
  ];
  const out = recoverRun(events, "what happened")!;
  // The later jot replaces the earlier one: last write wins.
  expect(out.notes).toEqual([
    { angle: "the open angle", notes: "further along" },
    { angle: "the closed angle", notes: "complete" },
  ]);
  // Only the jotted angle is unfinished; the filed one is done.
  expect(out.unfinished).toEqual(["the open angle"]);
});

test("a resumed run sends a worker back to an angle that only jotted", async () => {
  const seen: Array<{ phase: string; data?: unknown }> = [];
  await runResearch({
    question: "what",
    model: roleModel({
      plan: [PLAN("the open angle")],
      worker: [NOTES("finished this time")],
      followup: [DIRECT([], "done")],
      synth: [FILE("Body.")],
    }),
    search: stubSearch([]),
    fetcher: stubFetch({}),
    resume: {
      notes: [{ angle: "the open angle", notes: "halfway there" }],
      unfinished: ["the open angle"],
      ledger: [],
    },
    onProgress: (phase, data) => seen.push({ phase, data }),
  });
  const angles = seen
    .filter((p) => p.phase === "agent")
    .map((p) => (p.data as { angle: string }).angle);
  expect(angles).toEqual(["the open angle"]); // reopened, not skipped
});
