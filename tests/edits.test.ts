import { expect, test } from "bun:test";
import { MAX_LINE, mismatchHint, replaceOnce, viewSlice } from "../src/edits";

// The text half of the file tools (src/edits.ts): what a view shows, and when
// an edit is allowed to happen. No container involved — that's the point of
// keeping this apart from the executor.

test("a view numbers lines from their real position and reports the whole", () => {
  const text = "alpha\nbravo\ncharlie\ndelta\n";
  const all = viewSlice(text);
  expect(all.total).toBe(4); // the trailing newline is not a fifth line
  expect(all.from).toBe(1);
  expect(all.body.split("\n")[0]).toBe("     1|alpha");

  const mid = viewSlice(text, 2, 2);
  expect(mid.from).toBe(3);
  expect(mid.shown).toBe(2);
  expect(mid.body).toBe("     3|charlie\n     4|delta");
});

test("a view past the end shows nothing rather than pretending", () => {
  expect(viewSlice("one\ntwo", 9, 10).shown).toBe(0);
});

test("a very long line is truncated, so one line can't fill the window", () => {
  const long = "x".repeat(MAX_LINE + 500);
  const body = viewSlice(long).body;
  expect(body.length).toBeLessThan(MAX_LINE + 100);
  expect(body).toContain("[line truncated]");
});

test("an edit needs a unique match, and says how many it found", () => {
  const content = "a = 1\nb = 2\na = 1\n";
  const ambiguous = replaceOnce(content, "a = 1", "a = 3");
  expect(ambiguous.ok).toBe(false);
  if (!ambiguous.ok) {
    expect(ambiguous.reason).toContain("appears 2 times");
    expect(ambiguous.reason).toContain("replace_all");
  }

  // More context makes it unique.
  const unique = replaceOnce(content, "b = 2\na = 1", "b = 2\na = 3");
  expect(unique.ok).toBe(true);
  if (unique.ok) expect(unique.text).toBe("a = 1\nb = 2\na = 3\n");

  const all = replaceOnce(content, "a = 1", "a = 3", true);
  expect(all.ok).toBe(true);
  if (all.ok) {
    expect(all.replaced).toBe(2);
    expect(all.text).toBe("a = 3\nb = 2\na = 3\n");
  }
});

test("an empty new_string deletes, and a no-op edit is refused", () => {
  const gone = replaceOnce("keep\ndrop\nkeep2\n", "drop\n", "");
  expect(gone.ok).toBe(true);
  if (gone.ok) expect(gone.text).toBe("keep\nkeep2\n");

  expect(replaceOnce("x", "", "y").ok).toBe(false);
  expect(replaceOnce("x", "same", "same").ok).toBe(false);
});

test("a whitespace mismatch is diagnosed with the file's real bytes", () => {
  // The file indents with a tab; the model wrote spaces. Invisible in a
  // transcript, and the most common reason an exact edit misses.
  const content = "def f():\n\treturn 1\n";
  const out = replaceOnce(content, "def f():\n    return 1", "def f():\n    return 2");
  expect(out.ok).toBe(false);
  if (!out.ok) {
    expect(out.reason).toContain("whitespace differs");
    expect(out.reason).toContain("→"); // the tab, made visible
    expect(out.reason).toContain("Lines 1-2");
  }
});

test("a near miss points at the closest lines instead of just saying no", () => {
  const content = ["import os", "", "def greet(name):", '    print("hi", name)', ""].join("\n");
  const hint = mismatchHint(content, 'def greet(person):\n    print("hi", person)');
  expect(hint).toContain("line 3");
  expect(hint).toContain("def greet(name):");
});

test("a hint is withheld when nothing in the file is close", () => {
  expect(mismatchHint("nothing alike here\n", "completely different text")).toBeNull();
});
