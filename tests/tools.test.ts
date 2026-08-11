import { expect, test } from "bun:test";
import type { LanguageModel, ToolSet } from "ai";
import type { BlobStore } from "../src/blobs";
import { Store } from "../src/store";
import { harden, sandboxDescription, toolSet } from "../src/tools";

// harden() only reads/replaces each tool's `execute`, so a minimal tool-shaped
// object exercises it without the `tool()` builder's generic gymnastics.
function toolset(execute: () => Promise<unknown>): ToolSet {
  return { t: { description: "t", inputSchema: {}, execute } } as unknown as ToolSet;
}
function run(tools: ToolSet): Promise<unknown> {
  const exec = tools.t!.execute as (i: unknown, o: unknown) => Promise<unknown>;
  return exec({}, { toolCallId: "t", messages: [] });
}

test("harden turns a thrown execute into a recoverable message, not a throw", async () => {
  const tools = harden(
    toolset(async () => {
      throw new Error("upstream 400");
    }),
  );
  const out = (await run(tools)) as string;
  expect(typeof out).toBe("string");
  expect(out).toContain('"t"');
  expect(out).toContain("upstream 400");
  expect(out).toContain("not fatal");
});

test("harden leaves a succeeding execute's result untouched", async () => {
  const tools = harden(toolset(async () => ({ ok: true, n: 42 })));
  const out = await run(tools);
  expect(out).toEqual({ ok: true, n: 42 });
});

// The sandbox description is the model's whole picture of the environment, and
// the half that config decides is the half that used to be wrong.
const INFO = {
  image: "alpine:3.20",
  network: false,
  defaultTimeoutMs: 30_000,
  maxTimeoutMs: 300_000,
  memory: "512m",
  cpus: "1",
};

test("sandboxDescription tells the truth about the network, both ways", () => {
  const off = sandboxDescription(INFO, false);
  expect(off).toContain("NO network access");
  expect(off).not.toContain("package installs work");

  const on = sandboxDescription({ ...INFO, network: true }, false);
  expect(on).toContain("package installs work");
  expect(on).not.toContain("NO network access");
});

test("sandboxDescription claims isolation only where the sandbox actually has it", () => {
  // With networking on it reaches whatever the daemon's host can route to, so
  // any promise about the user's network or services is a lie the model would
  // act on. The filesystem claim is the one that survives.
  const d = sandboxDescription({ ...INFO, network: true }, false);
  expect(d).toContain("cannot see their files");
  expect(d).not.toMatch(/cannot reach their.*network/);
});

test("sandboxDescription asserts nothing about what the image ships", () => {
  // It is pointed at whatever image config names — bare alpine or a Debian
  // image with python and git already in it — so naming a shell or a package
  // manager as fact is drift waiting to happen.
  const d = sandboxDescription(INFO, false);
  expect(d).not.toContain("busybox) and core utilities");
  expect(d).toContain("command -v python3");
});

test("sandboxDescription states the image and both timeouts in seconds", () => {
  const d = sandboxDescription(INFO, false);
  expect(d).toContain("alpine:3.20");
  expect(d).toContain("killed at 30s");
  expect(d).toContain("up to 300s");
});

test("sandboxDescription mentions get_attachment only when that tool is offered", () => {
  expect(sandboxDescription(INFO, true)).toContain("get_attachment");
  expect(sandboxDescription(INFO, false)).not.toContain("get_attachment");
});

test("the shell description points at the file tools only when they're offered", () => {
  const withFiles = sandboxDescription(INFO, false, true);
  expect(withFiles).toContain("view_file");
  expect(withFiles).toContain("edit_file");
  // The reason, not just the instruction: a model that knows WHY reaches for
  // the right tool in cases this text didn't enumerate.
  expect(withFiles).toContain("quoting");

  // A one-off sandbox (no conversation) has no persistent filesystem to edit,
  // so the tools aren't offered and must not be advertised.
  expect(sandboxDescription(INFO, false, false)).not.toContain("view_file");
});

// ---- read_image ------------------------------------------------------------
// The tool exists for one situation: an image in the conversation and a model
// that can't look at it. Offering it in any other case would be a slower path
// to what the run's own model already does.

/** A store with one conversation whose user turn carried an attachment. */
function storeWithFile(name: string, mime: string): Store {
  const store = new Store(":memory:");
  store.db
    .prepare("INSERT INTO conversations (id, created_at, last_seq) VALUES ('c1', ?, 0)")
    .run(Date.now());
  store.db
    .prepare(
      "INSERT INTO events (id, conversation_id, seq, event, data, created_at) VALUES ('c1:1','c1',1,'user-message',?,?)",
    )
    .run(
      JSON.stringify({ content: "look", attachments: [{ sha256: "a".repeat(64), name, mime }] }),
      Date.now(),
    );
  return store;
}

const FAKE_MODEL = { modelId: "vision" } as unknown as LanguageModel;
const BLOBS = {} as unknown as BlobStore;

test("read_image is offered to a blind model with an image to look at", () => {
  const store = storeWithFile("shot.png", "image/png");
  const tools = toolSet({
    store,
    blobs: BLOBS,
    conversationId: "c1",
    visionModel: FAKE_MODEL,
    modelReadsImages: false,
  });
  expect(Object.keys(tools)).toContain("read_image");
});

test("read_image is withheld when it would add nothing", () => {
  const store = storeWithFile("shot.png", "image/png");
  const base = { store, blobs: BLOBS, conversationId: "c1" };

  // The run's model can see for itself: the image is already in its context.
  expect(
    Object.keys(toolSet({ ...base, visionModel: FAKE_MODEL, modelReadsImages: true })),
  ).not.toContain("read_image");

  // No reader configured or discoverable.
  expect(Object.keys(toolSet({ ...base, modelReadsImages: false }))).not.toContain("read_image");

  // Nothing to look at: a conversation whose only file is a spreadsheet.
  const noImages = storeWithFile("budget.csv", "text/csv");
  expect(
    Object.keys(
      toolSet({
        store: noImages,
        blobs: BLOBS,
        conversationId: "c1",
        visionModel: FAKE_MODEL,
        modelReadsImages: false,
      }),
    ),
  ).not.toContain("read_image");
});
