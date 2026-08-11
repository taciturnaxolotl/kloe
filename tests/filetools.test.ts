import { expect, test } from "bun:test";
import type { ExecResult, Executor, HarvestedFile, ReadResult } from "../src/executor";
import { editFile, viewFile, writeFile } from "../src/tools";

/**
 * The sandbox file tools, against a fake sandbox.
 *
 * The docker half (reading a real file, classifying a directory or a binary) is
 * covered live in executor.test.ts. What matters here is everything the tools
 * decide: where a relative path lands, what the model is told when a read
 * fails, and that an edit writes back exactly what it computed.
 */
class FakeSandbox implements Executor {
  readonly kind = "fake";
  readonly info = {
    image: "alpine:3.20",
    network: false,
    defaultTimeoutMs: 30_000,
    maxTimeoutMs: 300_000,
    memory: "2g",
    cpus: "2",
  };
  files = new Map<string, string>();
  dirs = new Set<string>(["/workspace"]);
  /** Every path the tools asked about, in order — the resolution record. */
  asked: string[] = [];
  binary = new Set<string>();

  run(): Promise<ExecResult> {
    throw new Error("not used");
  }
  async putFile(_session: string, path: string, bytes: Uint8Array): Promise<void> {
    this.files.set(path, new TextDecoder().decode(bytes));
  }
  async readFile(_session: string, path: string): Promise<ReadResult> {
    this.asked.push(path);
    if (this.dirs.has(path)) return { kind: "directory" };
    if (this.binary.has(path)) return { kind: "binary" };
    const text = this.files.get(path);
    if (text === undefined) return { kind: "missing" };
    return { kind: "file", text, bytes: text.length };
  }
  async harvest(): Promise<HarvestedFile[]> {
    return [];
  }
  disposeSession(): void {}
}

type Exec = (input: never, opts: { toolCallId: string; messages: [] }) => Promise<unknown>;
function call(t: { execute?: unknown }, input: unknown): Promise<unknown> {
  return (t.execute as Exec)(input as never, { toolCallId: "c", messages: [] });
}

test("a relative path lands in the workspace, an absolute one is left alone", async () => {
  const box = new FakeSandbox();
  box.files.set("/workspace/notes.md", "hello\n");
  box.files.set("/etc/hosts", "127.0.0.1\n");
  const view = viewFile(box, "c1");

  expect(await call(view, { path: "notes.md" })).toContain("hello");
  expect(await call(view, { path: "./notes.md" })).toContain("hello");
  expect(await call(view, { path: "/etc/hosts" })).toContain("127.0.0.1");
  expect(box.asked).toEqual(["/workspace/notes.md", "/workspace/notes.md", "/etc/hosts"]);
});

test("a view numbers lines and says how to see the rest", async () => {
  const box = new FakeSandbox();
  box.files.set(
    "/workspace/long.txt",
    Array.from({ length: 500 }, (_, i) => `L${i + 1}`).join("\n"),
  );
  const out = (await call(viewFile(box, "c1"), { path: "long.txt" })) as string;

  expect(out).toContain("     1|L1");
  expect(out).toContain("   200|L200");
  expect(out).not.toContain("|L201");
  expect(out).toContain("showing lines 1-200 of 500");
  expect(out).toContain("offset: 200");
});

test("each way a read fails names a different fix", async () => {
  const box = new FakeSandbox();
  box.binary.add("/workspace/a.png");
  const view = viewFile(box, "c1");

  expect(await call(view, { path: "ghost.md" })).toContain("run_shell");
  expect(await call(view, { path: "ghost.md" })).toContain("No file at /workspace/ghost.md");
  expect(await call(view, { path: "/workspace" })).toContain("is a directory");
  expect(await call(view, { path: "a.png" })).toContain("not text");
  // An empty file is a fact about the file, not a failure to read it.
  box.files.set("/workspace/empty.txt", "");
  expect(await call(view, { path: "empty.txt" })).toContain("is empty");
});

test("writing reports whether it created or replaced, and writes it verbatim", async () => {
  const box = new FakeSandbox();
  const write = writeFile(box, "c1");
  // Content that would need escaping through a shell, passed through untouched.
  const tricky = "line 'one'\n$(echo hi) `date`\n\"two\"\n";

  expect(await call(write, { path: "src/main.py", content: tricky })).toContain("Created");
  expect(box.files.get("/workspace/src/main.py")).toBe(tricky);

  const again = (await call(write, { path: "src/main.py", content: "replaced\n" })) as string;
  expect(again).toContain("Overwrote");
  expect(box.files.get("/workspace/src/main.py")).toBe("replaced\n");

  expect(await call(write, { path: "/workspace", content: "x" })).toContain("is a directory");
});

test("an edit writes back exactly the replacement it computed", async () => {
  const box = new FakeSandbox();
  box.files.set("/workspace/app.py", "def main():\n    return 1\n");
  const edit = editFile(box, "c1");

  const out = (await call(edit, {
    path: "app.py",
    old_string: "    return 1",
    new_string: "    return 2\n    # changed",
  })) as string;
  expect(out).toContain("1 replacement");
  expect(out).toContain("+1 lines");
  expect(box.files.get("/workspace/app.py")).toBe("def main():\n    return 2\n    # changed\n");
});

test("a failed edit changes nothing and explains itself", async () => {
  const box = new FakeSandbox();
  const before = "a = 1\nb = 2\na = 1\n";
  box.files.set("/workspace/c.py", before);
  const edit = editFile(box, "c1");

  const ambiguous = (await call(edit, {
    path: "c.py",
    old_string: "a = 1",
    new_string: "a = 9",
  })) as string;
  expect(ambiguous).toContain("appears 2 times");
  expect(box.files.get("/workspace/c.py")).toBe(before); // untouched

  const missing = (await call(edit, {
    path: "c.py",
    old_string: "nowhere to be found",
    new_string: "x",
  })) as string;
  expect(missing).toContain("not found");
  expect(box.files.get("/workspace/c.py")).toBe(before);

  // replace_all is the way through, and it says how many it changed.
  const all = (await call(edit, {
    path: "c.py",
    old_string: "a = 1",
    new_string: "a = 9",
    replace_all: true,
  })) as string;
  expect(all).toContain("2 replacements");
  expect(box.files.get("/workspace/c.py")).toBe("a = 9\nb = 2\na = 9\n");
});

test("editing a file that isn't there says so instead of creating it", async () => {
  const box = new FakeSandbox();
  const out = (await call(editFile(box, "c1"), {
    path: "ghost.py",
    old_string: "a",
    new_string: "b",
  })) as string;
  expect(out).toContain("No file at /workspace/ghost.py");
  expect(box.files.size).toBe(0);
});
