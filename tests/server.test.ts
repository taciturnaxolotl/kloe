import { test, expect, beforeAll, afterAll, beforeEach } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { Store, parseJobParams } from "../src/store";
import { apiRoutes, getActor, evictIdleActors } from "../src/http";
import { JobDriver } from "../src/drive";
import { setRegistry } from "../src/inference";
import { ProviderRegistry } from "../src/providers";
import { Catalog } from "../src/catalog";

const tmp = mkdtempSync(join(tmpdir(), "kloe-srv-"));
const store = new Store(join(tmp, "test.db"));

// A real Bun server on an ephemeral port — the same routing/validation path
// production uses. `apiRoutes` carries no HTML routes, so starting it never
// triggers frontend bundling.
let server: ReturnType<typeof Bun.serve>;
let base: string;
beforeAll(() => {
  server = Bun.serve({ port: 0, routes: apiRoutes({ store }) });
  base = server.url.origin;
});
afterAll(() => {
  server.stop(true);
  store.db.close();
  rmSync(tmp, { recursive: true, force: true });
});

// A minimal registry so model validation resolves (echo is always known).
// Set per-test to survive interleaving with other files' registry mutations.
// Also clear the jobs table: the store is shared across tests and the claim is
// global (oldest job, whatever conversation), so a job one test leaves queued
// would otherwise be claimed by another test's driveOnce(). Events are left
// intact — they're scoped per conversation and every test uses a fresh one.
beforeEach(() => {
  setRegistry(new ProviderRegistry(Catalog.fromRaw([]), { config: { providers: [] } }));
  store.db.exec("DELETE FROM jobs");
});

interface Frame {
  event: string;
  id: string;
  data: unknown;
}

/**
 * Reads an SSE response until `until` returns true (or EOF), returning the
 * frames seen. Cancels the reader as soon as the condition is met.
 */
async function readSse(
  res: Response,
  until: (frames: Frame[]) => boolean,
): Promise<Frame[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const frames: Frame[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += typeof value === "string" ? value : decoder.decode(value);
    let idx;
    while ((idx = buffer.indexOf("\n\n")) !== -1) {
      const block = buffer.slice(0, idx);
      buffer = buffer.slice(idx + 2);
      if (!block.trim()) continue;
      if (block.startsWith(":")) continue; // keepalive comment
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
  const res = await fetch(`${base}/api/conversations/badmodel/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "hi", model: "openai/gpt-4" }),
  });
  expect(res.status).toBe(422);
  // Nothing should have been enqueued/appended for that conversation.
  expect(getActor("badmodel", store).replay(0).length).toBe(0);
});

test("prompt rejects an empty model string with 422 (schema minLength)", async () => {
  const res = await fetch(`${base}/api/conversations/emptymodel/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "hi", model: "" }),
  });
  expect(res.status).toBe(422);
});

test("prompt rejects a malformed JSON body with 400", async () => {
  const res = await fetch(`${base}/api/conversations/badjson/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{not json",
  });
  expect(res.status).toBe(400);
});

test("steer rejects an unknown model with 422", async () => {
  const res = await fetch(`${base}/api/conversations/steerbad/steer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "go", model: "nope/nope" }),
  });
  expect(res.status).toBe(422);
});

test("GET /api/conversations lists conversations newest-first with a derived title", async () => {
  const actor = getActor("conv-list-1", store);
  actor.appendUser("What is the meaning of it all?", "r-list-1");

  const res = await fetch(`${base}/api/conversations`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    conversations: Array<{ id: string; title: string | null; lastSeq: number }>;
  };
  const row = body.conversations.find((c) => c.id === "conv-list-1");
  expect(row).toBeDefined();
  expect(row!.title).toBe("What is the meaning of it all?");
  expect(row!.lastSeq).toBeGreaterThan(0);
});

test("prompt → SSE stream emits user-message, message-start, deltas, message-end", async () => {
  const conv = "s1";
  const res = await fetch(`${base}/api/conversations/${conv}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "hello kloe", model: "echo" }),
  });
  expect(res.status).toBe(202);

  // Claim the queued job (as the drive loop would) and run it inline.
  const row = store.claimExpiredExclusive(Date.now());
  expect(row).not.toBeNull();
  const params = parseJobParams(row!.params);
  if (params.kind === "flush") throw new Error("expected a run job");
  const actor = getActor(conv, store);
  await actor.runText(params.runId, params.messageId, async function* (_signal) {
    yield { kind: "text", chunk: `echo: ${params.prompt}` };
  });
  store.markDone(row!.id);

  // Open the stream after the run: it replays the durable log.
  const streamRes = await fetch(`${base}/api/conversations/${conv}/stream`);
  expect(streamRes.headers.get("content-type")).toBe("text/event-stream");
  const frames = await readSse(streamRes, (f) => f.some((x) => x.event === "message-end"));
  const events = frames.map((f) => f.event);
  expect(events).toContain("user-message");
  expect(events).toContain("message-start");
  expect(events).toContain("text-delta");
  expect(events).toContain("message-end");
  const delta = frames.find((f) => f.event === "text-delta");
  expect((delta!.data as { delta: string }).delta).toBe("echo: hello kloe");
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
    await fetch(`${base}/api/conversations/${conv}/stream`),
    (f) => f.some((x) => x.event === "message-end"),
  );
  const lastSeq = Math.max(...full.map((f) => Number(f.id.split(":")[1]!)));

  // Append a new event after the full replay, then resume from lastSeq: the
  // stream must deliver ONLY that gap event, never re-sending the earlier ones.
  // (Deterministic — no timing race on an idle connection.)
  actor.appendUser("follow-up", "r3");
  const gap = await readSse(
    await fetch(`${base}/api/conversations/${conv}/stream`, {
      headers: { "last-event-id": `${conv}:${lastSeq}` },
    }),
    (f) => f.length >= 1,
  );
  expect(gap.length).toBeGreaterThan(0);
  expect(gap.every((f) => Number(f.id.split(":")[1]!) > lastSeq)).toBe(true);
  expect(gap.some((f) => f.event === "user-message")).toBe(true);

  // An intermediate cursor must replay the missing middle strictly.
  const firstSeq = Math.min(...full.map((f) => Number(f.id.split(":")[1]!)));
  const midRes = await fetch(`${base}/api/conversations/${conv}/stream`, {
    headers: { "last-event-id": `${conv}:${firstSeq}` },
  });
  const mid = await readSse(midRes, (f) => f.some((x) => x.event === "message-end"));
  expect(mid.length).toBeGreaterThan(0);
  for (const e of mid) {
    expect(Number(e.id.split(":")[1]!)).toBeGreaterThan(firstSeq);
  }
});

test("a Last-Event-ID from a different conversation replays from the start", async () => {
  const conv = "s3";
  const actor = getActor(conv, store);
  actor.appendUser("first turn", "r4");

  // A cursor claiming to belong to another conversation must be treated as
  // "no cursor" — replaying strictly after a foreign seq could skip events.
  const frames = await readSse(
    await fetch(`${base}/api/conversations/${conv}/stream`, {
      headers: { "last-event-id": "some-other-conv:42" },
    }),
    (f) => f.length >= 1,
  );
  expect(frames.length).toBeGreaterThan(0);
  expect(frames[0]!.id).toBe(`${conv}:1`); // full replay from the start
});

test("eviction skips actors with live subscribers", async () => {
  const conv = "evict-me";
  const actor = getActor(conv, store);

  // Idle + no subscribers: evictable.
  actor.lastActivity = 0;
  evictIdleActors();
  expect(getActor(conv, store)).not.toBe(actor);

  // Idle + a live subscriber: pinned. Evicting would orphan the stream, so
  // the map must keep the instance and getActor returns the same object.
  const actor2 = getActor(conv, store);
  actor2.lastActivity = 0;
  const unsub = actor2.follow({ push: () => {}, closed: false });
  evictIdleActors();
  expect(getActor(conv, store)).toBe(actor2);
  unsub();
});

test("JobDriver runs a queued job end-to-end (claim → run → done)", async () => {
  const conv = "drive-1";
  const res = await fetch(`${base}/api/conversations/${conv}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "drive me", model: "echo" }),
  });
  expect(res.status).toBe(202);

  const driver = new JobDriver(store, (id) => getActor(id, store));
  await driver.driveOnce();

  const replay = getActor(conv, store).replay(0);
  expect(replay.some((e) => e.event === "message-end")).toBe(true);
  // Second call finds nothing claimable.
  await driver.driveOnce();
});

test("JobDriver marks a job with corrupt params failed instead of re-claiming it forever", async () => {
  const conv = "drive-corrupt";
  const jobId = `${conv}:bad-params`;
  store.enqueue(jobId, conv, {
    conversationId: conv,
    runId: "r-c",
    messageId: "m-c",
    prompt: "hi",
    model: "echo",
  });
  // Clobber the durable row so it looks like a torn/half-written insert.
  store.db
    .prepare("UPDATE jobs SET params = ? WHERE id = ?")
    .run(JSON.stringify({ conversationId: conv }), jobId);

  const driver = new JobDriver(store, (id) => getActor(id, store));
  await driver.driveOnce();

  const row = store.db.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as { status: string };
  expect(row.status).toBe("failed");
});

test("GET /api/conversations orders by most recent activity, not creation", async () => {
  // Two conversations; the older one gets new activity afterwards and must
  // rise above the newer one.
  const oldActor = getActor("conv-old", store);
  oldActor.appendUser("created first", "r-old");
  const newerActor = getActor("conv-newer", store);
  newerActor.appendUser("created second", "r-newer");

  // Wait a tick so created_at differs, then bump the older conversation.
  await Bun.sleep(5);
  oldActor.appendUser("still going", "r-old-2");

  const body = (await (await fetch(`${base}/api/conversations`)).json()) as {
    conversations: Array<{ id: string }>;
  };
  const ids = body.conversations.map((c) => c.id);
  expect(ids.indexOf("conv-old")).toBeLessThan(ids.indexOf("conv-newer"));
});

test("GET /api/conversations?q= searches titles and message contents", async () => {
  // One conversation whose title matches; another that only matches on the
  // assistant's streamed reply (content search, not just title).
  const a = getActor("search-title", store);
  a.appendUser("How do capybaras behave?", "st-1");

  const b = getActor("search-body", store);
  b.appendUser("Tell me about rodents", "sb-1");
  await b.runText("sb-r", "sb-m", async function* (_signal) {
    yield { kind: "text", chunk: "The capybara is the largest living rodent." };
  });

  const res = await fetch(`${base}/api/conversations?q=${encodeURIComponent("capybara")}`);
  expect(res.status).toBe(200);
  const body = (await res.json()) as {
    conversations: Array<{ id: string; snippet: string | null }>;
  };
  const ids = body.conversations.map((c) => c.id);
  expect(ids).toContain("search-title"); // matched in the title/first message
  expect(ids).toContain("search-body"); // matched only in the assistant reply
  // The body hit carries an excerpt of the matching assistant text.
  const hit = body.conversations.find((c) => c.id === "search-body");
  expect(hit!.snippet).toContain("capybara");

  // A term nobody used returns nothing.
  const none = (await (await fetch(`${base}/api/conversations?q=zzznope`)).json()) as {
    conversations: unknown[];
  };
  expect(none.conversations).toEqual([]);
});

test("search escapes LIKE wildcards so a query matches literally", async () => {
  const a = getActor("search-literal", store);
  a.appendUser("100% sure about this", "sl-1");

  // `%` must be treated as a literal, not a wildcard: "50%" must NOT match.
  const hit = (await (await fetch(`${base}/api/conversations?q=${encodeURIComponent("100%")}`)).json()) as {
    conversations: Array<{ id: string }>;
  };
  expect(hit.conversations.map((c) => c.id)).toContain("search-literal");
  const miss = (await (await fetch(`${base}/api/conversations?q=${encodeURIComponent("50%")}`)).json()) as {
    conversations: Array<{ id: string }>;
  };
  expect(miss.conversations.map((c) => c.id)).not.toContain("search-literal");
});

test("DELETE /api/conversations/:id removes the conversation and its events", async () => {
  const conv = "delete-me";
  getActor(conv, store).appendUser("scratch this", "del-1");
  expect(store.replay(conv, 0).length).toBeGreaterThan(0);

  const res = await fetch(`${base}/api/conversations/${conv}`, { method: "DELETE" });
  expect(res.status).toBe(200);

  // Gone from the event log and the list.
  expect(store.replay(conv, 0)).toEqual([]);
  const list = (await (await fetch(`${base}/api/conversations`)).json()) as {
    conversations: Array<{ id: string }>;
  };
  expect(list.conversations.map((c) => c.id)).not.toContain(conv);
});

const steerPost = (base: string, conv: string, body: object) =>
  fetch(`${base}/api/conversations/${conv}/steer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(body),
  });

test("steer queues the message (durable event) and enqueues exactly one flush job", async () => {
  const conv = "steer-queue";
  const res1 = await steerPost(base, conv, { content: "also this", model: "echo", runId: "sq-1" });
  expect(res1.status).toBe(202);
  const res2 = await steerPost(base, conv, { content: "and this", model: "echo", runId: "sq-2" });
  expect(res2.status).toBe(202);

  // Both steers are durable `queued-message` events (the queue IS the log).
  const events = getActor(conv, store).replay(0);
  expect(events.filter((e) => e.event === "queued-message").map((e) => (e.data as { runId: string }).runId))
    .toEqual(["sq-1", "sq-2"]);

  // One flush job drains the whole queue; a second steer must not add another.
  const flushJobs = store.db
    .prepare(
      `SELECT count(*) AS n FROM jobs WHERE conversation_id = ? AND status = 'queued'
       AND json_extract(params, '$.kind') = 'flush'`,
    )
    .get(conv) as { n: number };
  expect(flushJobs.n).toBe(1);

  // The pending queue is readable over HTTP.
  const listed = (await (await fetch(`${base}/api/conversations/${conv}/steer`)).json()) as {
    queued: Array<{ runId: string; content: string }>;
  };
  expect(listed.queued.map((q) => q.runId)).toEqual(["sq-1", "sq-2"]);
});

test("the flush promotes the WHOLE steer queue as one batched run", async () => {
  const conv = "steer-flush";
  await steerPost(base, conv, { content: "first steer", model: "echo", runId: "sf-1" });
  await steerPost(base, conv, { content: "second steer", model: "echo", runId: "sf-2" });

  const driver = new JobDriver(store, (id) => getActor(id, store));
  await driver.driveOnce();

  const events = getActor(conv, store).replay(0);
  // Both steers promoted to user-messages, keeping their steer runIds.
  const users = events.filter((e) => e.event === "user-message");
  expect(users.map((e) => (e.data as { runId: string }).runId)).toEqual(["sf-1", "sf-2"]);
  // Exactly ONE run covered both messages: one message-end carrying the first
  // steer's runId, and its deltas contain the joined prompt.
  const ends = events.filter((e) => e.event === "message-end");
  expect(ends).toHaveLength(1);
  expect((ends[0]!.data as { runId: string }).runId).toBe("sf-1");
  const text = events
    .filter((e) => e.event === "text-delta")
    .map((e) => (e.data as { delta: string }).delta)
    .join("");
  expect(text).toBe("echo: first steer\n\nsecond steer");
  // Queue is drained.
  const body = (await (await fetch(`${base}/api/conversations/${conv}/steer`)).json()) as { queued: unknown[] };
  expect(body.queued).toEqual([]);
});

test("a stale flush job with an empty queue completes as a no-op", async () => {
  const conv = "steer-stale";
  store.enqueue(`${conv}:stale`, conv, { kind: "flush", conversationId: conv });
  await new JobDriver(store, (id) => getActor(id, store)).driveOnce();
  // Empty queue → the flush promotes nothing, writes no events, and just
  // completes (covers a crash between promote and completion).
  expect(getActor(conv, store).replay(0)).toEqual([]);
  const status = (store.db.prepare("SELECT status FROM jobs WHERE id = ?")
    .get(`${conv}:stale`) as { status: string }).status;
  expect(status).toBe("done");
});

test("steers mid-run wait for it to end, then flush together", async () => {
  const conv = "steer-mid";
  const actor = getActor(conv, store);

  // Start a run inline (as the drive loop would) that blocks on a gate.
  let release: () => void = () => {};
  const gate = new Promise<void>((r) => (release = r));
  const running = actor.runText("r-mid", "m-mid", async function* (_signal) {
    yield { kind: "text", chunk: "working" };
    await gate;
    yield { kind: "text", chunk: "done" };
  });

  // Steer twice while it's running: both queue, nothing executes yet.
  await steerPost(base, conv, { content: "mid one", model: "echo", runId: "sm-1" });
  await steerPost(base, conv, { content: "mid two", model: "echo", runId: "sm-2" });
  expect(getActor(conv, store).replay(0).filter((e) => e.event === "user-message")).toHaveLength(0);

  release();
  await running;

  await new JobDriver(store, (id) => getActor(id, store)).driveOnce();
  const events = getActor(conv, store).replay(0);
  expect(events.filter((e) => e.event === "user-message").map((e) => (e.data as { runId: string }).runId))
    .toEqual(["sm-1", "sm-2"]);
  expect(events.filter((e) => e.event === "message-end")).toHaveLength(2); // the mid run + the flush batch
});

test("a reconnecting stream replays queued-message events (and their promotion)", async () => {
  const conv = "steer-reconnect";
  await steerPost(base, conv, { content: "waiting steer", model: "echo", runId: "sr-1" });

  // Connect fresh (simulates a client that was offline when the steer landed):
  // it must see the queued-message, then the promotion on flush.
  await new JobDriver(store, (id) => getActor(id, store)).driveOnce();
  const frames = await readSse(
    await fetch(`${base}/api/conversations/${conv}/stream`),
    (f) => f.some((x) => x.event === "message-end"),
  );
  const names = frames.map((f) => f.event);
  expect(names).toContain("queued-message");
  expect(names).toContain("user-message"); // promotion, same runId
  expect(names.indexOf("queued-message")).toBeLessThan(names.indexOf("user-message"));
  const q = frames.find((f) => f.event === "queued-message")!.data as { runId: string };
  const u = frames.find((f) => f.event === "user-message")!.data as { runId: string };
  expect(q.runId).toBe("sr-1");
  expect(u.runId).toBe("sr-1");
});
