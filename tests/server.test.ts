import { test, expect, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store } from "../src/store";
import { buildApp, getActor } from "../server";
import { setRegistry } from "../src/inference";
import { ProviderRegistry } from "../src/providers";
import { Catalog } from "../src/catalog";

const tmp = mkdtempSync(join(tmpdir(), "kloe-srv-"));
const store = new Store(join(tmp, "test.db"));
const app = buildApp({ store });
const base = "http://localhost";

// A minimal registry so model validation resolves (echo is always known).
// Set per-test to survive interleaving with other files' registry mutations.
beforeEach(() => {
  setRegistry(new ProviderRegistry(Catalog.fromRaw([]), { config: { providers: [] } }));
});

interface Frame {
  event: string;
  id: string;
  data: unknown;
}

/**
 * Reads an SSE response until `until` returns true (or EOF), returning the
 * frames seen. Leaves the reader open past the stop point, then cancels.
 */
async function readSse(
  res: Response,
  until: (frames: Frame[]) => boolean,
): Promise<Frame[]> {
  const reader = res.body!.getReader();
  let buffer = "";
  const frames: Frame[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    // The body is a TransformStream<string, string>; chunks are strings.
    buffer += typeof value === "string" ? value : new TextDecoder().decode(value);
    // Parse complete SSE blocks (each ends with a blank line).
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (!block.trim()) continue;
      // Skip SSE comments (keepalive).
      if (block.startsWith(":")) continue;
      let event = "message";
      let id = "";
      const dataLines: string[] = [];
      for (const line of block.split("\n")) {
        if (line.startsWith("event:")) event = line.slice(6).trim();
        else if (line.startsWith("id:")) id = line.slice(3).trim();
        else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
      }
      frames.push({ event, id, data: JSON.parse(dataLines.join("\n")) });
      if (until(frames)) {
        await reader.cancel();
        return frames;
      }
    }
  }
  return frames;
}

test("prompt rejects an unknown model with 422 (no silent async failure)", async () => {
  const res = await app.handle(
    new Request(`${base}/conversations/badmodel/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hi", model: "openai/gpt-4" }),
    }),
  );
  expect(res.status).toBe(422);
  // Nothing should have been enqueued for that conversation.
  expect(getActor("badmodel", store).replay(0).length).toBe(0);
});

test("prompt rejects an empty model string with 422", async () => {
  const res = await app.handle(
    new Request(`${base}/conversations/emptymodel/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hi", model: "" }),
    }),
  );
  expect(res.status).toBe(422);
});

test("steer rejects an unknown model with 422", async () => {
  const res = await app.handle(
    new Request(`${base}/conversations/steerbad/steer`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "go", model: "nope/nope" }),
    }),
  );
  expect(res.status).toBe(422);
});

test("prompt → SSE stream emits user-message, message-start, deltas, message-end", async () => {
  const conv = "s1";
  const res = await app.handle(
    new Request(`${base}/conversations/${conv}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hello kloe", model: "echo" }),
    }),
  );
  expect(res.status).toBe(202);

  // Claim the queued job (as the drive loop would) and run it inline.
  const row = store.claimExpiredExclusive(Date.now());
  expect(row).not.toBeNull();
  const params = JSON.parse(row!.params) as {
    runId: string;
    messageId: string;
    prompt: string;
  };
  const actor = getActor(conv, store);
  await actor.runText(params.runId, params.messageId, async function* (_signal) {
    yield { kind: "text", chunk: `echo: ${params.prompt}` };
  });
  store.markDone(row!.id);

  // Open the stream after the run: it replays the durable log.
  const streamRes = await app.handle(new Request(`${base}/conversations/${conv}/stream`));
  expect(streamRes.headers.get("content-type")).toBe("text/event-stream");
  const frames = await readSse(streamRes, (f) =>
    f.some((x) => x.event === "message-end"),
  );
  const events = frames.map((f) => f.event);
  expect(events).toContain("user-message");
  expect(events).toContain("message-start");
  expect(events).toContain("text-delta");
  expect(events).toContain("message-end");
  const delta = frames.find((f) => f.event === "text-delta");
  expect((delta!.data as { delta: string }).delta).toBe("echo: hello kloe");
  // Ids monotonic.
  const seqs = frames.map((f) => Number(f.id.split(":")[1]!));
  for (let i = 1; i < seqs.length; i++) expect(seqs[i]!).toBeGreaterThan(seqs[i - 1]!);
});

test("resume via HTTP Last-Event-ID replays only the gap", async () => {
  const conv = "s2";
  const actor = getActor(conv, store);
  await actor.runText("r2", "m2", async function* (_signal) {
    yield { kind: "text", chunk: "ab" };
  });

  // Cursor 0: full replay over HTTP.
  const full = await readSse(
    await app.handle(new Request(`${base}/conversations/${conv}/stream`)),
    (f) => f.some((x) => x.event === "message-end"),
  );
  const lastSeq = Math.max(...full.map((f) => Number(f.id.split(":")[1]!)));

  // Resume over HTTP with Last-Event-ID = lastSeq. The server must parse the
  // `<convId>:<seq>` header and replay strictly after it. With nothing new,
  // the stream stays open (no message-end arrives), so we read with a short
  // timeout and assert we got zero real frames.
  const resumeRes = await app.handle(
    new Request(`${base}/conversations/${conv}/stream`, {
      headers: { "last-event-id": `${conv}:${lastSeq}` },
    }),
  );
  const reader = resumeRes.body!.getReader();
  let buffer = "";
  const resumed: Frame[] = [];
  const deadline = Bun.sleep(300);
  const readLoop = (async () => {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += typeof value === "string" ? value : new TextDecoder().decode(value);
      let idx;
      while ((idx = buffer.indexOf("\n\n")) !== -1) {
        const block = buffer.slice(0, idx);
        buffer = buffer.slice(idx + 2);
        if (!block.trim() || block.startsWith(":")) continue;
        let event = "message";
        let id = "";
        const dataLines: string[] = [];
        for (const line of block.split("\n")) {
          if (line.startsWith("event:")) event = line.slice(6).trim();
          else if (line.startsWith("id:")) id = line.slice(3).trim();
          else if (line.startsWith("data:")) dataLines.push(line.slice(5).trim());
        }
        resumed.push({ event, id, data: JSON.parse(dataLines.join("\n")) });
      }
    }
  })();
  await Promise.race([readLoop, deadline]);
  await reader.cancel();
  // Nothing new to replay: no real frames (only keepalive comments, skipped).
  expect(resumed.length).toBe(0);

  // An intermediate cursor must replay the missing middle strictly.
  const firstSeq = Math.min(...full.map((f) => Number(f.id.split(":")[1]!)));
  const midRes = await app.handle(
    new Request(`${base}/conversations/${conv}/stream`, {
      headers: { "last-event-id": `${conv}:${firstSeq}` },
    }),
  );
  const mid = await readSse(midRes, (f) => f.some((x) => x.event === "message-end"));
  expect(mid.length).toBeGreaterThan(0);
  for (const e of mid) {
    expect(Number(e.id.split(":")[1]!)).toBeGreaterThan(firstSeq);
  }
});
