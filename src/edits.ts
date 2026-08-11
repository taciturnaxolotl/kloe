/**
 * The text half of the file tools: numbering, slicing, and exact replacement.
 *
 * Kept apart from the sandbox on purpose. Reading and writing bytes is the
 * executor's problem; deciding what a view shows and whether an edit is
 * unambiguous is string work, and string work should be testable without a
 * container running.
 *
 * The design follows Anthropic's text-editor tool (view with a line range,
 * str_replace requiring a unique match) and Crush's `edit`, with one deliberate
 * divergence: when `old_string` doesn't match, Crush will fall back to
 * whitespace-normalized matching and silently re-indent the replacement. That
 * rescues a call at the cost of the model never learning what the file actually
 * contains. Here the same analysis runs, but its output is a DIAGNOSTIC — the
 * real lines, with whitespace made visible — and the edit is refused. The model
 * gets the byte-accurate text it was missing and can retry exactly.
 */

/** A line's worth of margin, wide enough for a six-figure file. */
function gutter(n: number): string {
  const s = String(n);
  return s.length >= 6 ? s : " ".repeat(6 - s.length) + s;
}

/** Cap on one line's length, so a minified bundle can't fill the window. */
export const MAX_LINE = 2000;

export interface ViewSlice {
  /** The requested lines, numbered, ready to hand back. */
  body: string;
  /** 1-based line number of the first line shown. */
  from: number;
  /** How many lines this slice holds. */
  shown: number;
  /** How many lines the file has in total. */
  total: number;
}

/**
 * A window onto a file's lines, numbered from its real position.
 *
 * Numbers are not decoration: they are what makes a follow-up `offset` mean
 * something, and what lets a person reading the transcript check the model's
 * claim about line 40 against line 40.
 */
export function viewSlice(text: string, offset = 0, limit = 200): ViewSlice {
  const lines = text.split("\n");
  // A trailing newline yields a final empty element that is not a line.
  if (lines.length > 1 && lines[lines.length - 1] === "") lines.pop();
  const from = Math.max(0, offset);
  const window = lines.slice(from, from + Math.max(1, limit));
  const body = window
    .map((line, i) => {
      const shown = line.length > MAX_LINE ? `${line.slice(0, MAX_LINE)}…[line truncated]` : line;
      return `${gutter(from + i + 1)}|${shown}`;
    })
    .join("\n");
  return { body, from: from + 1, shown: window.length, total: lines.length };
}

export type ReplaceOutcome =
  | { ok: true; text: string; replaced: number }
  | { ok: false; reason: string };

/**
 * Exact find-and-replace, refusing anything ambiguous.
 *
 * A unique match is the whole safety property: "replace this text" is only a
 * well-defined instruction when the text appears once. When it appears several
 * times the model has to say which — with more context, or by asking for all of
 * them — because guessing produces an edit nobody can review.
 */
export function replaceOnce(
  content: string,
  oldString: string,
  newString: string,
  replaceAll = false,
): ReplaceOutcome {
  if (oldString === "") return { ok: false, reason: "old_string must not be empty." };
  if (oldString === newString)
    return { ok: false, reason: "old_string and new_string are identical; nothing to do." };
  const first = content.indexOf(oldString);
  if (first === -1) {
    const hint = mismatchHint(content, oldString);
    return {
      ok: false,
      reason:
        "old_string was not found in the file. It must match exactly, including whitespace and " +
        "line breaks." +
        (hint ? `\n\n${hint}` : ""),
    };
  }
  const count = content.split(oldString).length - 1;
  if (count > 1 && !replaceAll) {
    return {
      ok: false,
      reason:
        `old_string appears ${count} times, so which one to change is ambiguous. Include more ` +
        "surrounding lines to make it unique, or pass replace_all to change every occurrence.",
    };
  }
  const text = replaceAll
    ? content.split(oldString).join(newString)
    : content.slice(0, first) + newString + content.slice(first + oldString.length);
  return { ok: true, text, replaced: replaceAll ? count : 1 };
}

/** Whitespace runs collapsed, so two lines can be compared for their words. */
function normalize(line: string): string {
  return line.trim().split(/\s+/).join(" ");
}

/** Tabs and spaces made visible, for a hint about text that looks identical. */
function visualize(line: string): string {
  return line.replace(/\t/g, "→").replace(/ /g, "·");
}

/**
 * Why an exact match failed, when the answer is knowable.
 *
 * Two cases are worth the model's time. The text is there but its whitespace
 * differs — invisible in a transcript, and the single most common way an edit
 * misses. Or one line is very close, in which case showing the neighbourhood is
 * more useful than repeating that nothing matched.
 */
export function mismatchHint(content: string, oldString: string): string | null {
  const lines = content.split("\n");
  const want = oldString.split("\n");
  const wantNorm = want.map(normalize).join("\n");
  if (wantNorm.trim() === "") return null;

  // Whitespace-only difference: report the real lines, whitespace visible.
  const norm = lines.map(normalize);
  for (let i = 0; i + want.length <= lines.length; i++) {
    if (norm.slice(i, i + want.length).join("\n") !== wantNorm) continue;
    const actual = lines
      .slice(i, i + want.length)
      .map((l, k) => `${gutter(i + k + 1)}|${visualize(l)}`)
      .join("\n");
    return (
      "The text is in the file, but its whitespace differs (tabs vs spaces, or a different " +
      `indent). Lines ${i + 1}-${i + want.length} actually read:\n${actual}\n` +
      "→ is a tab and · is a space. Copy exactly that."
    );
  }

  // Otherwise, the closest single line — enough to locate the drift.
  const target = normalize(want[0] ?? "");
  if (target === "") return null;
  let bestAt = -1;
  let bestScore = 0;
  for (let i = 0; i < lines.length; i++) {
    const score = similarity(norm[i] ?? "", target);
    if (score > bestScore) {
      bestScore = score;
      bestAt = i;
    }
  }
  // Half the trigrams in common. Two versions of one line with an identifier
  // renamed land around 0.55-0.7, while genuinely unrelated lines sit well
  // below — and a hint is advisory, so the cost of a loose threshold is a few
  // wasted lines rather than a wrong edit.
  if (bestAt < 0 || bestScore < 0.5) return null;
  const from = Math.max(0, bestAt - 2);
  const near = lines
    .slice(from, bestAt + 3)
    .map((l, k) => `${gutter(from + k + 1)}|${l}`)
    .join("\n");
  return `The closest text in the file is around line ${bestAt + 1}:\n${near}`;
}

/**
 * Trigram overlap — enough to rank candidate lines, not a diff algorithm.
 *
 * Character trigrams rather than words, because the lines this has to tell
 * apart are code: `def greet(name):` and `def greet(person):` share only one
 * whitespace-delimited token out of two, which reads as unrelated, while their
 * character runs are obviously the same line with one word changed.
 */
function similarity(a: string, b: string): number {
  if (!a || !b) return 0;
  if (a === b) return 1;
  const grams = (s: string): Map<string, number> => {
    const m = new Map<string, number>();
    const padded = ` ${s} `;
    for (let i = 0; i + 3 <= padded.length; i++) {
      const g = padded.slice(i, i + 3);
      m.set(g, (m.get(g) ?? 0) + 1);
    }
    return m;
  };
  const ga = grams(a);
  const gb = grams(b);
  let shared = 0;
  let total = 0;
  for (const [, n] of ga) total += n;
  for (const [g, n] of gb) {
    total += n;
    shared += Math.min(n, ga.get(g) ?? 0);
  }
  return total === 0 ? 0 : (2 * shared) / total;
}
