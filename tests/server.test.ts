import { afterAll, beforeAll, beforeEach, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { FsBlobStore } from "../src/blobs";
import { Catalog } from "../src/catalog";
import { SSE_RETRY_MS } from "../src/config";
import { JobDriver } from "../src/drive";
import { apiRoutes, evictIdleActors, getActor } from "../src/http";
import { setRegistry } from "../src/inference";
import { ProviderRegistry } from "../src/providers";
import { getConfig, setConfig } from "../src/settings";
import { shareRoutes } from "../src/share";
import { parseJobParams, Store } from "../src/store";

const tmp = mkdtempSync(join(tmpdir(), "kloe-srv-"));
const store = new Store(join(tmp, "test.db"));
const blobs = new FsBlobStore(join(tmp, "blobs"));

// A real Bun server on an ephemeral port — the same routing/validation path
// production uses. `apiRoutes` carries no HTML routes, so starting it never
// triggers frontend bundling.
let server: ReturnType<typeof Bun.serve>;
let base: string;
beforeAll(() => {
  // Public share routes are mounted the way production mounts them: beside the
  // gated API, never inside it.
  server = Bun.serve({
    port: 0,
    routes: { ...apiRoutes({ store, blobs }), ...shareRoutes({ store, blobs }) },
  });
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
async function readSse(res: Response, until: (frames: Frame[]) => boolean): Promise<Frame[]> {
  const reader = res.body!.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  const frames: Frame[] = [];
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += typeof value === "string" ? value : decoder.decode(value);
    let idx: number;
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
      if (!dataLines.length) continue; // control frame (`retry:`), not an event
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

test("the stream sets its own reconnect interval", async () => {
  // Without `retry:` the browser guesses (~3s in Chrome), which makes a server
  // restart feel like an outage. It has to be the first thing on the wire.
  const res = await fetch(`${base}/api/conversations/retryfield/stream`);
  const reader = res.body!.getReader();
  const head = new TextDecoder().decode((await reader.read()).value);
  await reader.cancel();
  expect(head.startsWith(`retry: ${SSE_RETRY_MS}\n\n`)).toBe(true);
});

test("resume via HTTP Last-Event-ID replays only the gap", async () => {
  const conv = "s2";
  const actor = getActor(conv, store);
  await actor.runText("r2", "m2", async function* (_signal) {
    yield { kind: "text", chunk: "ab" };
  });

  // Cursor 0: full replay over HTTP.
  const full = await readSse(await fetch(`${base}/api/conversations/${conv}/stream`), (f) =>
    f.some((x) => x.event === "message-end"),
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

test("batch /events + /stream?after= loads history then only the tail", async () => {
  const conv = "s2b";
  const actor = getActor(conv, store);
  await actor.runText("rb", "mb", async function* (_signal) {
    yield { kind: "text", chunk: "hi" };
  });

  // The whole history in one request (what the client batch-renders on open).
  const ndjson = await (await fetch(`${base}/api/conversations/${conv}/events`)).text();
  const events = ndjson
    .split("\n")
    .filter(Boolean)
    .map((l) => JSON.parse(l)) as Array<{ id: string; event: string }>;
  expect(events.length).toBeGreaterThan(0);
  expect(events.some((e) => e.event === "message-end")).toBe(true);
  const lastId = events[events.length - 1]!.id;
  const lastSeq = Number(lastId.split(":")[1]);

  // A new event, then open the stream from that cursor via ?after= (native
  // EventSource can't set a header on the first connect): only the tail arrives.
  actor.appendUser("more", "rb2");
  const tail = await readSse(
    await fetch(`${base}/api/conversations/${conv}/stream?after=${encodeURIComponent(lastId)}`),
    (f) => f.length >= 1,
  );
  expect(tail.length).toBeGreaterThan(0);
  expect(tail.every((f) => Number(f.id.split(":")[1]!) > lastSeq)).toBe(true);
});

test("/events ?tailTurns and ?before partition the history (bottom-first backfill)", async () => {
  const conv = "s2c";
  const actor = getActor(conv, store);
  for (let i = 0; i < 3; i++) {
    actor.appendUser("q" + i, "r" + i);
    await actor.runText("r" + i, "m" + i, async function* (_s) {
      yield { kind: "text", chunk: "a" + i };
    });
  }
  const parse = async (q: string) =>
    (await (await fetch(`${base}/api/conversations/${conv}/events${q}`)).text())
      .split("\n")
      .filter(Boolean)
      .map((l) => JSON.parse(l)) as Array<{ id: string; event: string }>;
  const seq = (e: { id: string }) => Number(e.id.split(":")[1]);

  const all = await parse("");
  const tail = await parse("?tailTurns=1"); // just the last turn
  expect(tail.length).toBeGreaterThan(0);
  expect(tail[0]!.event).toBe("user-message"); // cut lands on a turn boundary
  const cut = seq(tail[0]!);
  const older = await parse("?before=" + cut);
  expect(older.every((e) => seq(e) < cut)).toBe(true); // strictly older
  expect(tail.every((e) => seq(e) >= cut)).toBe(true);
  expect(older.length + tail.length).toBe(all.length); // exact partition: no gap, no overlap
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

  const row = store.db.prepare("SELECT status FROM jobs WHERE id = ?").get(jobId) as {
    status: string;
  };
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
  const hit = (await (
    await fetch(`${base}/api/conversations?q=${encodeURIComponent("100%")}`)
  ).json()) as {
    conversations: Array<{ id: string }>;
  };
  expect(hit.conversations.map((c) => c.id)).toContain("search-literal");
  const miss = (await (
    await fetch(`${base}/api/conversations?q=${encodeURIComponent("50%")}`)
  ).json()) as {
    conversations: Array<{ id: string }>;
  };
  expect(miss.conversations.map((c) => c.id)).not.toContain("search-literal");
});

test("PATCH /api/conversations/:id sets a custom title (overriding the derived one)", async () => {
  const conv = "rename-me";
  getActor(conv, store).appendUser("original first message", "r-rn");
  // Derived title is the first message.
  const before = (await (await fetch(`${base}/api/conversations`)).json()) as {
    conversations: Array<{ id: string; title: string | null }>;
  };
  expect(before.conversations.find((c) => c.id === conv)!.title).toBe("original first message");

  const res = await fetch(`${base}/api/conversations/${conv}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "My renamed chat" }),
  });
  expect(res.status).toBe(200);

  const after = (await (await fetch(`${base}/api/conversations`)).json()) as {
    conversations: Array<{ id: string; title: string | null }>;
  };
  expect(after.conversations.find((c) => c.id === conv)!.title).toBe("My renamed chat");
  // Searchable by the new title.
  const hit = (await (await fetch(`${base}/api/conversations?q=renamed`)).json()) as {
    conversations: Array<{ id: string }>;
  };
  expect(hit.conversations.map((c) => c.id)).toContain(conv);

  // Empty title clears the override back to the derived one.
  await fetch(`${base}/api/conversations/${conv}`, {
    method: "PATCH",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ title: "  " }),
  });
  const cleared = (await (await fetch(`${base}/api/conversations`)).json()) as {
    conversations: Array<{ id: string; title: string | null }>;
  };
  expect(cleared.conversations.find((c) => c.id === conv)!.title).toBe("original first message");
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
  expect(
    events
      .filter((e) => e.event === "queued-message")
      .map((e) => (e.data as { runId: string }).runId),
  ).toEqual(["sq-1", "sq-2"]);

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
  const body = (await (await fetch(`${base}/api/conversations/${conv}/steer`)).json()) as {
    queued: unknown[];
  };
  expect(body.queued).toEqual([]);
});

test("a stale flush job with an empty queue completes as a no-op", async () => {
  const conv = "steer-stale";
  store.enqueue(`${conv}:stale`, conv, { kind: "flush", conversationId: conv });
  await new JobDriver(store, (id) => getActor(id, store)).driveOnce();
  // Empty queue → the flush promotes nothing, writes no events, and just
  // completes (covers a crash between promote and completion).
  expect(getActor(conv, store).replay(0)).toEqual([]);
  const status = (
    store.db.prepare("SELECT status FROM jobs WHERE id = ?").get(`${conv}:stale`) as {
      status: string;
    }
  ).status;
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
  expect(
    getActor(conv, store)
      .replay(0)
      .filter((e) => e.event === "user-message"),
  ).toHaveLength(0);

  release();
  await running;

  await new JobDriver(store, (id) => getActor(id, store)).driveOnce();
  const events = getActor(conv, store).replay(0);
  expect(
    events
      .filter((e) => e.event === "user-message")
      .map((e) => (e.data as { runId: string }).runId),
  ).toEqual(["sm-1", "sm-2"]);
  expect(events.filter((e) => e.event === "message-end")).toHaveLength(2); // the mid run + the flush batch
});

test("a reconnecting stream replays queued-message events (and their promotion)", async () => {
  const conv = "steer-reconnect";
  await steerPost(base, conv, { content: "waiting steer", model: "echo", runId: "sr-1" });

  // Connect fresh (simulates a client that was offline when the steer landed):
  // it must see the queued-message, then the promotion on flush.
  await new JobDriver(store, (id) => getActor(id, store)).driveOnce();
  const frames = await readSse(await fetch(`${base}/api/conversations/${conv}/stream`), (f) =>
    f.some((x) => x.event === "message-end"),
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

// ---- blob upload / download -------------------------------------------
test("POST /api/blobs stores content-addressed bytes; GET returns them", async () => {
  const bytes = new TextEncoder().encode("hello blob");
  const post = await fetch(`${base}/api/blobs`, {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: bytes,
  });
  expect(post.status).toBe(201);
  const { sha256, size, mime } = (await post.json()) as {
    sha256: string;
    size: number;
    mime: string;
  };
  expect(sha256).toMatch(/^[0-9a-f]{64}$/);
  expect(size).toBe(bytes.byteLength);
  expect(mime).toBe("text/plain");

  const get = await fetch(`${base}/api/blobs/${sha256}`);
  expect(get.status).toBe(200);
  expect(get.headers.get("content-type")).toBe("text/plain");
  expect(get.headers.get("cache-control")).toContain("immutable");
  expect(await get.text()).toBe("hello blob");
});

test("re-uploading identical bytes returns the same sha256 (dedup)", async () => {
  const body = () => new TextEncoder().encode("same bytes");
  const a = await (await fetch(`${base}/api/blobs`, { method: "POST", body: body() })).json();
  const b = await (await fetch(`${base}/api/blobs`, { method: "POST", body: body() })).json();
  expect((b as { sha256: string }).sha256).toBe((a as { sha256: string }).sha256);
});

test("GET /api/blobs/:sha256 is 404 for an unknown or malformed id", async () => {
  const unknown = "0".repeat(64);
  expect((await fetch(`${base}/api/blobs/${unknown}`)).status).toBe(404);
  expect((await fetch(`${base}/api/blobs/not-a-hash`)).status).toBe(404);
});

test("POST /api/blobs rejects a body over the size cap with 413", async () => {
  const base0 = getConfig();
  setConfig({ ...base0, blobs: { ...base0.blobs, maxBytes: 8 } });
  try {
    const res = await fetch(`${base}/api/blobs`, {
      method: "POST",
      body: new TextEncoder().encode("this is definitely more than eight bytes"),
    });
    expect(res.status).toBe(413);
  } finally {
    setConfig(base0); // restore the cap for any later tests
  }
});

// ---- attachments on messages ------------------------------------------
/** Uploads bytes and returns the attachment reference the client would send. */
async function upload(
  text: string,
  name: string,
  kind: "image" | "file",
): Promise<{ sha256: string; name: string; mime: string; kind: "image" | "file" }> {
  const res = await fetch(`${base}/api/blobs`, {
    method: "POST",
    body: new TextEncoder().encode(text),
  });
  const { sha256, mime } = (await res.json()) as { sha256: string; mime: string };
  return { sha256, name, mime, kind };
}

test("prompt with attachments records them on the user-message and links blob_refs", async () => {
  const conv = "att-1";
  const att = await upload("pretend png", "cat.png", "image");
  const res = await fetch(`${base}/api/conversations/${conv}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "look", model: "echo", runId: "a1", attachments: [att] }),
  });
  expect(res.status).toBe(202);

  const events = getActor(conv, store).replay(0);
  const user = events.find((e) => e.event === "user-message");
  const data = user!.data as { attachments?: Array<{ sha256: string; name: string }> };
  expect(data.attachments).toHaveLength(1);
  expect(data.attachments![0]!.sha256).toBe(att.sha256);
  expect(data.attachments![0]!.name).toBe("cat.png");

  // blob_refs now protects the blob from GC.
  const refd = store.findOrphanBlobs(Date.now() + 1_000_000);
  expect(refd).not.toContain(att.sha256);
});

test("prompt rejects an attachment whose blob was never uploaded (422)", async () => {
  const res = await fetch(`${base}/api/conversations/att-bad/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: "x",
      model: "echo",
      attachments: [{ sha256: "a".repeat(64), name: "ghost", mime: "image/png", kind: "image" }],
    }),
  });
  expect(res.status).toBe(422);
});

test("deleting a conversation frees blobs it was the last to reference", async () => {
  const conv = "att-del";
  const att = await upload("delete me", "doc.txt", "file");
  await fetch(`${base}/api/conversations/${conv}/prompt`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ content: "keep then delete", model: "echo", attachments: [att] }),
  });
  expect(store.getBlob(att.sha256)).toBeDefined();

  const del = await fetch(`${base}/api/conversations/${conv}`, { method: "DELETE" });
  expect(del.status).toBe(200);
  expect(store.getBlob(att.sha256)).toBeUndefined(); // row gone
  expect((await fetch(`${base}/api/blobs/${att.sha256}`)).status).toBe(404); // bytes gone
});

test("a blob shared by two conversations survives deleting one", async () => {
  const att = await upload("shared bytes", "s.bin", "file");
  for (const conv of ["share-a", "share-b"]) {
    await fetch(`${base}/api/conversations/${conv}/prompt`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ content: "hi", model: "echo", attachments: [att] }),
    });
  }
  await fetch(`${base}/api/conversations/share-a`, { method: "DELETE" });
  expect(store.getBlob(att.sha256)).toBeDefined(); // share-b still references it
  expect((await fetch(`${base}/api/blobs/${att.sha256}`)).status).toBe(200);
});

test("steer with attachments queues them, and flush promotes them to the user turn", async () => {
  const conv = "steer-att";
  const att = await upload("steered image", "pic.png", "image");
  const res = await fetch(`${base}/api/conversations/${conv}/steer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: "with a pic",
      model: "echo",
      runId: "sa-1",
      attachments: [att],
    }),
  });
  expect(res.status).toBe(202);

  // The queued-message (visible before promotion) carries the attachments.
  const queued = getActor(conv, store)
    .replay(0)
    .find((e) => e.event === "queued-message");
  expect((queued!.data as { attachments?: unknown[] }).attachments).toHaveLength(1);
  // GET /steer reflects them too (reconnect rebuild path).
  const pending = (await (await fetch(`${base}/api/conversations/${conv}/steer`)).json()) as {
    queued: Array<{ runId: string; attachments?: unknown[] }>;
  };
  expect(pending.queued[0]!.attachments).toHaveLength(1);

  // Flush the queue: the steer is promoted to a user-message carrying the attachments.
  await new JobDriver(store, (id) => getActor(id, store)).driveOnce();
  const promoted = getActor(conv, store)
    .replay(0)
    .find((e) => e.event === "user-message" && (e.data as { runId: string }).runId === "sa-1");
  expect(
    (promoted!.data as { attachments?: Array<{ sha256: string }> }).attachments![0]!.sha256,
  ).toBe(att.sha256);
});

test("steer rejects an attachment whose blob was never uploaded (422)", async () => {
  const res = await fetch(`${base}/api/conversations/steer-att-bad/steer`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({
      content: "x",
      model: "echo",
      attachments: [{ sha256: "b".repeat(64), name: "ghost", mime: "image/png", kind: "image" }],
    }),
  });
  expect(res.status).toBe(422);
});

test("a queued steer can be removed before it's promoted", async () => {
  const conv = "steer-cancel";
  await steerPost(base, conv, { content: "cancel me", model: "echo", runId: "sc-1" });
  await steerPost(base, conv, { content: "keep me", model: "echo", runId: "sc-2" });
  let pending = (await (await fetch(`${base}/api/conversations/${conv}/steer`)).json()) as {
    queued: Array<{ runId: string }>;
  };
  expect(pending.queued.map((m) => m.runId)).toEqual(["sc-1", "sc-2"]);

  const del = await fetch(`${base}/api/conversations/${conv}/steer/sc-1`, { method: "DELETE" });
  expect(del.status).toBe(200);
  pending = (await (await fetch(`${base}/api/conversations/${conv}/steer`)).json()) as {
    queued: Array<{ runId: string }>;
  };
  expect(pending.queued.map((m) => m.runId)).toEqual(["sc-2"]); // sc-1 gone, sc-2 stays
});

test("cancelling a non-pending steer is a 404 (no log spam)", async () => {
  const res = await fetch(`${base}/api/conversations/steer-cancel-404/steer/nope`, {
    method: "DELETE",
  });
  expect(res.status).toBe(404);
});

test("a cancelled steer is not promoted on flush", async () => {
  const conv = "steer-cancel-flush";
  await steerPost(base, conv, { content: "doomed", model: "echo", runId: "cf-1" });
  await fetch(`${base}/api/conversations/${conv}/steer/cf-1`, { method: "DELETE" });
  await new JobDriver(store, (id) => getActor(id, store)).driveOnce();
  const promoted = getActor(conv, store)
    .replay(0)
    .some((e) => e.event === "user-message" && (e.data as { runId: string }).runId === "cf-1");
  expect(promoted).toBe(false);
});

test("GET /api/blobs/:sha256?name= sets the download filename", async () => {
  const bytes = new TextEncoder().encode("named download");
  const { sha256 } = (await (
    await fetch(`${base}/api/blobs`, { method: "POST", body: bytes })
  ).json()) as {
    sha256: string;
  };
  const res = await fetch(`${base}/api/blobs/${sha256}?name=report%20final.pdf`);
  expect(res.headers.get("content-disposition")).toContain('filename="report final.pdf"');
  // Path-traversal / injection in the name is neutralized to one safe segment:
  // no separators (can't traverse) and no header-break bytes.
  const evil = await fetch(`${base}/api/blobs/${sha256}?name=../../etc/passwd`);
  const cd = evil.headers.get("content-disposition")!;
  expect(cd).not.toContain("/");
  expect(cd).not.toMatch(/[\r\n]/);
});

// Blobs are model- and upload-authored bytes on the app's own origin, so an
// HTML artifact must never come back as a live document.
test("an html blob is served defanged, an image is left alone", async () => {
  const evil = await blobs.put(new TextEncoder().encode("<script>alert(1)</script>"));
  store.recordBlob(evil.sha256, "text/html", evil.size);
  const png = await blobs.put(new Uint8Array([137, 80, 78, 71]));
  store.recordBlob(png.sha256, "image/png", png.size);

  const html = await fetch(`${base}/api/blobs/${evil.sha256}`);
  expect(html.headers.get("content-security-policy")).toBe("sandbox");
  expect(html.headers.get("x-content-type-options")).toBe("nosniff");

  // An image creates no document, so the sandbox header would only be noise —
  // and inline rendering of attachments has to keep working.
  const img = await fetch(`${base}/api/blobs/${png.sha256}`);
  expect(img.headers.get("content-security-policy")).toBeNull();
  expect(img.headers.get("content-disposition")).toContain("inline");
});

test("GET /api/conversations/:id/artifacts?name= answers with that document's history", async () => {
  const conv = "doc-history";
  const rec = (sha: string, title: string) =>
    store.recordArtifact({
      conversationId: conv,
      name: "report.md",
      sha256: sha,
      title,
      mime: "text/markdown",
      size: 10,
    });
  rec("a".repeat(64), "Draft");
  rec("b".repeat(64), "Final");
  store.recordArtifact({
    conversationId: conv,
    name: "other.md",
    sha256: "c".repeat(64),
    mime: "text/markdown",
    size: 10,
  });

  // Without ?name it's still the one-row-per-document list.
  const all = (await (await fetch(`${base}/api/conversations/${conv}/artifacts`)).json()) as {
    artifacts: Array<{ name: string; version: number; versions: number }>;
  };
  expect(all.artifacts.map((a) => a.name).sort()).toEqual(["other.md", "report.md"]);

  const res = await fetch(`${base}/api/conversations/${conv}/artifacts?name=report.md`);
  const { versions } = (await res.json()) as {
    versions: Array<{ version: number; sha256: string; title: string | null }>;
  };
  // Newest first, and only this document's.
  expect(versions.map((v) => v.version)).toEqual([2, 1]);
  expect(versions[0]!.title).toBe("Final");

  // A name with no history is an empty list, not the whole conversation's.
  const none = (await (
    await fetch(`${base}/api/conversations/${conv}/artifacts?name=nope.md`)
  ).json()) as { versions: unknown[] };
  expect(none.versions).toEqual([]);
});

test("publishing a document hands back a link, and unpublishing revokes it", async () => {
  const conv = "share-me";
  const bytes = new TextEncoder().encode("# Shared\n\nHello from a published doc.\n");
  const { sha256 } = await blobs.put(bytes);
  store.recordBlob(sha256, "text/markdown", bytes.length);
  store.recordArtifact({
    conversationId: conv,
    name: "report.md",
    sha256,
    title: "The report",
    mime: "text/markdown",
    size: bytes.length,
  });

  const res = await fetch(`${base}/api/conversations/${conv}/publications`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "report.md", version: 1 }),
  });
  expect(res.status).toBe(200);
  const { token, url } = (await res.json()) as { token: string; url: string };
  expect(url).toBe(`/s/${token}`);

  // The public routes answer without a session — that's the whole point.
  const meta = (await (await fetch(`${base}/api/public/${token}`)).json()) as {
    title: string;
    mime: string;
    name: string;
  };
  expect(meta).toMatchObject({ title: "The report", name: "report.md", mime: "text/markdown" });
  // …and tell a reader nothing about where the document came from.
  expect(Object.keys(meta)).not.toContain("conversationId");

  const raw = await fetch(`${base}/api/public/${token}/raw`);
  expect(await raw.text()).toContain("Hello from a published doc.");
  expect(raw.headers.get("X-Content-Type-Options")).toBe("nosniff");

  // The owner's version list now shows which revision is public.
  const { versions } = (await (
    await fetch(`${base}/api/conversations/${conv}/artifacts?name=report.md`)
  ).json()) as { versions: Array<{ token: string | null }> };
  expect(versions[0]!.token).toBe(token);

  const gone = await fetch(`${base}/api/conversations/${conv}/publications/${token}`, {
    method: "DELETE",
  });
  expect(gone.status).toBe(200);
  expect((await fetch(`${base}/api/public/${token}`)).status).toBe(404);
  expect((await fetch(`${base}/api/public/${token}/raw`)).status).toBe(404);
});

test("a published page is served defanged, and a bogus token is just not found", async () => {
  const conv = "share-html";
  const bytes = new TextEncoder().encode("<!doctype html><p>hi<script>alert(1)</script>");
  const { sha256 } = await blobs.put(bytes);
  store.recordBlob(sha256, "text/html", bytes.length);
  store.recordArtifact({
    conversationId: conv,
    name: "page.html",
    sha256,
    mime: "text/html",
    size: bytes.length,
  });
  const { token } = (await (
    await fetch(`${base}/api/conversations/${conv}/publications`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "page.html", version: 1 }),
    })
  ).json()) as { token: string };

  // Visiting the bytes directly must not run them: the share page renders HTML
  // deliberately, in a sandboxed frame of its own.
  const raw = await fetch(`${base}/api/public/${token}/raw`);
  expect(raw.headers.get("Content-Security-Policy")).toBe("sandbox");

  // Nothing that isn't a token reaches SQL, and a well-formed miss is a 404.
  expect((await fetch(`${base}/api/public/not-a-token`)).status).toBe(404);
  expect((await fetch(`${base}/api/public/${"0".repeat(32)}`)).status).toBe(404);
});

test("publishing a version that doesn't exist is a 404, not an empty link", async () => {
  const res = await fetch(`${base}/api/conversations/no-such-conv/publications`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ name: "ghost.md", version: 1 }),
  });
  expect(res.status).toBe(404);
});
