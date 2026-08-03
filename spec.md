# Kloe — a minimal spec
 
> **Kloe** (pronounced "kloh," silent *s* underneath) — after Charles **Clos**,
> whose 1953 Bell Labs design gave us the non-blocking switching fabric that
> routes any input to any output without collision. The name buries the
> architecture: every conversation routes through a single non-blocking hub (the
> actor) that any client can reach from anywhere. A warm human name on top, a
> switching-network pioneer underneath — the same move as Claude/Shannon.
 
A connection-agnostic, eager, web-standards LLM chat UI. The point of this spec
is how *little* it takes: decouple generation from the connection, keep a
server-authoritative log per conversation, stream down over SSE, act up over
POST, and get the "instant" feel from optimistic append rather than a sync
engine. No React, no WebSockets, no CRDT — until a specific feature earns them.
 
## Principles
 
- **Generation is decoupled from any client connection.** The model keeps
  running whether or not a tab is attached. This single commitment is what makes
  everything else (resume, multi-device, background work) fall out for free.
- **Network off the feedback path.** User-visible response is bounded by CPU, not
  RTT. Optimistic apply now, reconcile with the server later.
- **Server-authoritative, not local-first (by default).** The conversation log
  lives on the server as the source of truth. Clients are projections of it.
- **Web standards first.** `EventSource` + `Last-Event-ID`, `fetch`, WHATWG
  `Request`/`Response`. The resume mechanism is a browser feature, not a library.
- **Add complexity only when a feature demands it.** Every heavier tool (WS,
  CRDT sync engine, signals framework) is opt-in per the decision rules below.
## Non-goals
 
- No full local-first sync engine in the base build. (See "When to add more.")
- No WebSockets in the base build — SSE down + POST up covers chat.
- No client framework runtime (React/Vue), no web components, no build tooling. Plain ES modules served by Bun's HTML routes.
- Not offline-write-capable by default. Base build assumes online with resilient
  reconnect; offline authoring is an explicit later addition.
## Architecture
 
```
          POST /api/:id/prompt, /cancel, /steer   (client → server, low-freq)
Client  ───────────────────────────────────────►  Conversation Actor
(EventSource)                                      ├─ append-only event log (durable, via store)
        ◄───────────────────────────────────────  ├─ subscriber set (SSE connections)
          GET /api/:id/stream  (SSE, id-tagged)    └─ cancel flag

          POST also enqueues a job:              jobs table (enqueue/claim/lease/reap)
                                                         │ drive loop
                                                         ▼
                                                 runText → providers (AI SDK)
```
 
One **conversation actor** per conversation id: a single-writer object that owns
the durable event log, the set of live SSE subscribers, and the cancel flag. It
is the pub/sub hub. Being single-writer is what removes the need for external
coordination (no Redis required for correctness — only for horizontal scale).
 
- **Down channel:** one SSE stream per connected client (`GET /api/conversations/:id/stream`).
- **Up channel:** plain HTTP POST for the low-frequency actions (send, cancel,
  steer). POST is idempotent-friendly, trivially authable, and survives flaky
  mobile better than a duplex socket.
- **Fan-out:** every action the actor accepts is appended to the log and
  published to all subscribers. Device A sends → the prompt event and the
  streamed reply appear on devices B/C/D live, because everything routes through
  the actor's channel.
## Data model
 
The conversation is an **append-only event log**. Each event:
 
```
{
  id:    "<conversationId>:<seq>",  // monotonic; drives Last-Event-ID resume
  event: "user-message" | "run-started" | "message-start" | "text-delta" |
         "message-end" | "run-error" | "cancelled" |
         "tool-call" | "tool-result",
  data:  { ... }                    // event-specific payload
}
```
 
- **Event types align with AG-UI** (typed, `threadId`/`runId`-carrying events)
  so the schema is standard and transport-swappable later — the same events can
  ride WS or webhooks unchanged if needed.
- **`seq` is the resume cursor.** Persist enough of the log to replay from any
  seq. Deltas can be compacted into a full message on `message-end` (store the
  full message, drop the individual deltas) to bound write amplification.
- Persistence is `bun:sqlite` (WAL, `synchronous = FULL`): every event is
  durable **before** it fans out to subscribers. The design still permits
  swapping in Postgres or Durable Object storage for scale.
### Bounding write amplification
 
Naive resume persists every token delta durably so it can be replayed — one
500-token response becomes ~500 writes. At scale this is the real cost. Levers,
in impact-to-effort order:
 
1. **Batch/coalesce deltas** — flush every N tokens or T ms, whichever first
   (e.g. 16 tokens / 50 ms). 500 writes → ~15. Resume granularity coarsens to
   the batch boundary; invisible to users because the in-flight tail is in
   memory anyway. Biggest, cheapest lever.
2. **Tiered hot/cold** — live deltas never touch the canonical DB. Hold them in
   a fast ephemeral layer (in-actor ring buffer, or Redis Stream capped with
   `MAXLEN`/TTL); write only the **compacted full message** to durable storage
   on `message-end`. Canonical DB sees **1 write per message**, not N.
3. **Classify events by durability** — deltas need only survive a *client
   reconnect* (seconds; memory-first, TTL'd, no fsync). `message-start`,
   `tool-call`, `tool-result`, `message-end` are non-reproducible and must
   survive a *node crash* (durable, fsync). Two SLAs; stop fsync-ing tokens
   you'll compact away in 8 seconds.
4. **Write-behind** — persistence is off the token-delivery hot path; stream
   from memory, persist async. With batching, the DB never sits on latency.
5. **Snapshot + tail** — compacted snapshot every K tokens plus the raw tail
   since; resume = snapshot + short replay. Caps write volume and replay work.
6. **Append-friendly engine** — if deltas are persisted, an LSM store (RocksDB,
   which backs many KV/DO layers) turns appends into sequential writes; store
   the delta log as one growing blob per message (text compresses well), not a
   row per token.
**Recipe for this build** (single-writer actor makes it safe): lever 1 only,
and durably. Deltas batch (16 deltas or 50 ms, whichever first); the live tail
between flushes is only in memory; each batch is written synchronously to the
same SQLite log **before** fan-out. One log is the whole store: resume
granularity is the batch boundary, and a crash loses at most the in-flight
batch. No separate hot/cold tier, no write-behind, no compaction yet (see open
questions).
 
## Transport details
 
### Resumable stream (down)
- Native `EventSource` on `GET /api/conversations/:id/stream`.
- The browser auto-reconnects and replays the `Last-Event-ID` header on its own.
- Server reads `Last-Event-ID`, resumes from that seq out of the log, emits the
  gap, then continues live. **No client-side resume library.**
- The header carries the full `<conversationId>:<seq>` id. The server verifies
  the conversation prefix before applying the cursor; a foreign or malformed id
  replays from the start instead of skipping events.
- `id:` on every SSE event. The stream is long-lived and idles between runs:
  Bun's `idleTimeout` is raised to its 255 s max and a `: keepalive` comment
  goes out every 15 s, so neither the runtime nor proxies close it.
### Actions (up)
- `POST /api/conversations/:id/prompt` — appends the user message through the
  actor, enqueues a job, returns 202 with `{jobId, runId, messageId}`. The run
  executes later in the drive loop, not in the handler. The user message and
  the run share one `runId` so clients can correlate the optimistic echo.
- `POST /api/conversations/:id/cancel` — sets the cancel flag; the run checks it
  between token batches and aborts upstream. **A dropped connection is NOT a cancel**
  (resume is in play), so cancellation must be explicit and out-of-band.
- `POST /api/conversations/:id/steer` — hard steer: cancel the current run and
  enqueue the redirect as a new one.
- `GET /api/conversations` — the rail: ids ordered by most recent activity,
  each with a title derived from its first user message.
- `GET /api/conversations/:id/events` — full replay of the durable log.
- `GET|PATCH /api/models`, `GET /api/models/chat` — model curation: opt-in
  visibility, display-name override, sort order. `/api/models` is the admin
  view (every model plus its curation state); `/api/models/chat` is the curated
  subset the picker shows.
### Why not WebSockets (in the base build)
- SSE passes every HTTP proxy, needs no special infra, and gets resume for free
  via the browser. WS gives true duplex but **loses free `Last-Event-ID`
  resume** — you'd re-implement replay yourself.
- Reach for WS only when the *up* channel becomes high-frequency (see below).
## Prior art — what's solved, what's proprietary
 
The transport **pattern** here is settled and public; only the *managed
operation* of it is sold. Worth recording so nobody assumes there's a moat in
the architecture itself.
 
- **The consensus architecture is open.** Every serious writeup converges on the
  same shape this spec uses: separate the prompt request from the response
  stream, thread tokens through a cache/log so a client can resume and a second
  device can follow. Generation lifetime decoupled from connection via pub/sub.
- **Ably (zknill's posts).** The most-cited writeups are by an Ably engineer
  building their AI transport — a managed pub/sub with a `message.append`
  primitive (create a message, append token deltas, connected clients see each
  append live). The **architecture is documented in the open**; the proprietary
  part is the hosted pub/sub that runs it for you. It's a convenience layer, not
  a secret — you don't need it, you need its shape (which is this spec).
- **Open building blocks that actually ship resume/cancel/multi-device:**
  - `vercel/resumable-stream` — wraps string streams for resume + follow-along;
    serverless-friendly, Redis pub/sub, ~1 INCR + SUBSCRIBE per stream in the
    common (no-recovery) case.
  - `zirkelc/ai-resumable-stream` — Redis-backed resume **and** out-of-band
    stop, built around the fact that the "stop" request runs in a different
    process from the stream it cancels.
  - **AI SDK** `useChat({ resume: true })` + `consumeSseStream` — the
    first-party version of the same Redis/`activeStreamId` dance.
  - **LibreChat** — the fullest open app that ships true resumable +
    multi-device streaming against custom OpenAI-compatible endpoints.
- **Still genuinely unsolved / annoying (independent of vendor):**
  - **Write amplification** — everyone hand-rolls delta compaction (see above).
  - **Stateful sessions vs horizontal scale** — a stateful stream behind a load
    balancer with no session affinity can land on a node that doesn't know the
    session. The 2026 MCP roadmap names this an open priority. The
    per-conversation actor is the clean answer — single writer without fighting
    the balancer.
  - **Network-level stall resilience** (packet loss mid-stream) is a separate,
    largely un-productized problem (cf. the *Eloquent* research scheme).
Takeaway: reproduce the pattern with the open libs above; reach for a managed
transport only to avoid operating the compaction + session-affinity edges
yourself, not because the design is unavailable.
 
## Eagerness (no sync engine required)
 
Chat is unusually kind to optimistic UI. The two mutations that matter:
 
- **Send message → optimistic append.** Echo the user's own text into the
  transcript immediately. It's their input, append-only, effectively
  conflict-free; rollback on failure = mark failed + offer retry. Safest possible
  optimistic update.
- **Assistant reply → streaming.** Already eager by nature; render deltas as they
  arrive over SSE.
That's ~95% of the "instant" feel with **zero** sync engine. Local UI state
(input value, toggles, pending flags) is plain module variables + direct DOM
updates in this build — a tiny signal primitive is the escape hatch if it grows,
not a framework.
 
## Multi-device
 
Falls out of the architecture — it is not a separate feature:
 
- Every device opens an `EventSource` on the same conversation stream.
- The actor fans out identical id-tagged events to all subscribers.
- Each device resumes independently from its own last-seen seq.
- Throw a phone in the ocean, reload, switch networks, open 5 tabs: each is just
  a projection catching up from a cursor against the durable log.
## Resilience
 
"Resilient" splits into two axes people conflate. Be ruthless about the
distinction — a datastore only answers one of them.
 
- **Axis A — durable state (the log).** Survive a process crash/restart without
  losing history or delivered tokens. Covered by `bun:sqlite` (WAL, fsync) at
  single-node; by shared Streams (Redis/Dragonfly) at multi-node.
- **Axis B — durable execution (the run).** Survive the node *running the
  generation* dying mid-stream. No storage fixes this alone — it needs the run
  decoupled from the request and made restartable.
### Two meanings of "worker"
 
1. **Decouple the run from the HTTP request** — trivial: don't `await`
   generation in the handler. The handler enqueues a job and returns 202; the
   actor holds the run + its `AbortController`. Survives connection drops. This
   alone gives "disconnect ≠ cancel."
2. **Survive a process crash** — no in-process construct helps here. Worker
   threads / `Bun.spawn` children die with (or are orphaned by) the process.
   Durability lives in **persisted job state + a lease + startup
   reconciliation**, not in a thread. Reaching for `worker_threads` feels like
   the answer and buys nothing.
### Durable job table (single-node, `bun:sqlite`)
 
`bun:sqlite` is synchronous and WAL-durable, and `UPDATE ... RETURNING` gives
race-free atomic claim. This build additionally enforces **single writer per
conversation** in the claim itself: a job is only claimable while no other job
for its conversation holds a live lease.
 
```sql
CREATE TABLE jobs (
  id TEXT PRIMARY KEY,
  conversation_id TEXT NOT NULL,
  status TEXT NOT NULL,          -- queued | running | done | failed
  lease_until INTEGER,           -- ms epoch; heartbeat pushes forward
  checkpoint_seq INTEGER DEFAULT 0,
  params TEXT NOT NULL
);
```
 
- **Enqueue** (in the handler): `INSERT ... status='queued'`, return
  immediately. The client opens `GET /stream` separately — the two are
  decoupled.
- **Claim** (drive loop): atomic `UPDATE ... SET status='running', lease_until=?
  WHERE id=(SELECT id ... WHERE claimable AND NOT EXISTS (another live run for
  the conversation) LIMIT 1) RETURNING *`. Claimed params are parsed through one
  canonical decoder; a corrupt row is marked `failed` rather than re-claimed.
- **Run**: heartbeat pushes `lease_until` forward every ~10 s; write
  `checkpoint_seq` alongside each appended delta flush.
- **Reap** (on startup + on a timer) — the crux of restartability:
  `UPDATE jobs SET status='queued' WHERE status='running' AND lease_until < now`.
  A crashed worker's job has a stale lease, flips back to `queued`, and any
  worker re-claims it from `checkpoint_seq`. Idempotency on `seq` keeps
  reconnected clients consistent through the re-run.
### Where the loop runs
 
The claim/run/checkpoint body lives in one shared driver; both deployment
shapes run the identical code path.
 
- **Same process** as the web server (a `setInterval` pulling the table):
  simplest, one `bun run server.ts`. A web-tier panic still kills in-flight runs.
- **Separate process** (`bun run worker.ts`, supervised by systemd/pm2/docker
  `restart: always`): a crash in either tier doesn't take the other down, and
  the restart policy *is* the recovery trigger — the reaper does the rest.
  Preferred once resilience matters. Both processes may poll the same table;
  the SQL claim is atomic.
### The honest ceiling
 
On reclaim you **re-run** from the checkpoint — you cannot resume the *upstream*
inference mid-completion, because providers don't expose that. Tokens generated
upstream but not yet persisted when the worker died are lost and regenerated.
The guarantee is "delivered tokens durable + re-runs seamless (idempotent on
seq)," not "the identical completion continues."
 
### Multi-node upgrade path
 
Swap the sqlite jobs table for Redis/Dragonfly **Streams consumer groups**:
`XADD` to enqueue, `XREADGROUP` to claim, `XACK` on done, `XAUTOCLAIM` to reap
orphaned pending entries. Same lease/reap contract, distributed — and exactly
the workload Dragonfly's stream+pubsub layer targets. The sqlite version is not
throwaway: identical contract, drop-in when you outgrow one box. (Durable-
execution frameworks — DBOS, Restate, Inngest — productize claim/checkpoint/
replay if you'd rather not hand-roll, at the cost of a dependency.)
 
## Auth
 
- Use cookie/session auth so native `EventSource` works unmodified (it can't set
  custom headers). Bearer-token-in-header would force a `fetch`+`ReadableStream`
  reader and cost you native auto-reconnect. Cookie is the clean path.
## Frontend
 
Built as vanilla ES modules (`src/client/`), no framework and no build tooling —
Bun's HTML route handling transpiles and bundles on serve.
 
- Plain DOM construction; stream markdown deltas into it.
- Native `EventSource` for the down channel; `fetch` for actions.
- Local UI state is plain module variables + direct DOM updates; no signal
  primitive was needed at this size.
- One vendored dependency: `streaming-markdown` (~3 KB brotli). Everything else
  is hand-rolled and small.
## Rendering
 
The naive approach re-parses and re-renders the whole growing message on every
token — O(n²) work, and the real cost is DOM thrash, not parsing. Don't do that.
 
- **Append-only streaming markdown.** Use `streaming-markdown` (smd): ~3 KB
  gzipped, zero-dependency, ES module. It only *adds* nodes to the DOM and never
  mutates existing ones, so already-streamed text stays selectable, there's
  nothing to re-render (memoization is free by construction), and it's optimistic
  about incomplete syntax (styles an open code block immediately). Feed each SSE
  delta straight to `parser_write`.
  - Alternative if you want to render into your own components: a
    framework-agnostic streaming parser (`markdown-parser` / `stream-markdown-parser`)
    that emits finalized blocks as a typed tree, and map blocks → components.
  - The block-memoization pattern (marked lexer, freeze completed blocks,
    re-render only the last) is the framework equivalent — smd's append-only
    model gets you the same win without a framework.
- **Syntax highlighting is deferred and off-thread.** Render code as plain text
  while streaming; once the fence closes, highlight the completed block in a Web
  Worker (Shiki `codeToTokens`), then swap in the styled result. Never highlight
  a growing block per token. Lazy-load only the grammars/themes actually seen —
  Shiki's full set is large and blows the bundle budget.
- **Heavy renderers are per-block and lazy.** KaTeX and Mermaid load only when a
  math/diagram block appears, and render on completion, not mid-token.
- **Throttle to the frame.** Batch DOM updates with `requestAnimationFrame` (~60
  fps) rather than rendering on every token; models emit faster than the eye needs.
- **Sanitize structurally, no HTML purifier.** smd never emits raw HTML tags —
  model text lands in text nodes — so there is no untrusted HTML string to
  purify; a heavyweight sanitizer (DOMPurify) is deliberately absent. The one
  real vector is link/image URLs: a wrapped renderer neutralizes dangerous
  schemes (`javascript:`, `vbscript:`, `file:`, non-image `data:`) as they
  render and surfaces the full URL before navigating external links. If the
  renderer ever strips anything, the UI says so.
- **Polish, cheaply.** A blinking caret at the stream head covers the
  "buttery" feel. No library needed. (Per-token fade-in is the next step, not
  built yet.)
- **Long threads.** Window the message list and set `content-visibility: auto` on
  offscreen messages to skip their layout/paint. (Deferred — threads are short
  enough today that it doesn't matter.)
Resume interplay: because smd is append-only, on reconnect either keep the
rendered DOM and feed only the gap since last seq, or reset the parser and replay
the log — both are cheap DOM appends, no diffing.
 
Rendering bundle: ~3 KB core (smd) only — Shiki/KaTeX/Mermaid are described
above as the deferred path but are not built yet.
 
## Stack
 
| Layer            | Choice                                                        |
|------------------|--------------------------------------------------------------|
| Runtime          | Bun                                                           |
| Server           | Bun native `routes`, framework-free (web-standard `Request`/`Response`) |
| Validation       | Standard Schema (`valibot`) bodies via a framework-free `withBody` |
| Inference        | Vercel AI SDK core (`streamText`) over OpenAI-compatible providers; built-in `echo` mock for tests |
| Down transport   | SSE (hand-rolled blocks), native `EventSource` client          |
| Up transport     | HTTP POST (202 + job queue)                                    |
| Persistence      | `bun:sqlite` (WAL): append-only event log + jobs + curation    |
| Conversation hub | Single-writer per-conversation actor (in-proc today; DO at scale) |
| Frontend         | Vanilla ES modules, no build step (Bun serves the HTML)        |
| Markdown render  | `streaming-markdown` (smd, ~3 KB, append-only); URL hardening instead of DOMPurify |
| Code highlight   | Deferred to completed blocks (Shiki in a worker) — not built yet |
| Event schema     | AG-UI-aligned typed events                                     |
| Sync engine      | **None** in base build (see decision rules)                    |
 
## When to add more (decision rules)
 
| Symptom / need                                             | Add                                   |
|------------------------------------------------------------|---------------------------------------|
| High-frequency up-channel: voice, token-level barge-in, presence, live cursors | WebSockets (accept losing free resume) |
| Offline authoring that must converge across devices        | Sync engine (TinyBase MergeableStore, ~6–13 KB, over a custom synchronizer riding the existing SSE/actor channel) |
| Concurrent editing/reordering of past messages             | CRDT for those fields only            |
| Horizontal scale across nodes                               | Back the actor's log/pubsub with Redis Streams + Pub/Sub, or Durable Objects |
| Richer CRDT data (trees, rich text)                        | Yjs (known quantity) or Loro (WASM cost) |
 
Default to **not** adding these. Optimistic UI gives eagerness; the heavier tools
buy *reconciliation*, which most of a chat UI never needs.
 
## What you deliberately don't build
 
- No per-token DB write amplification beyond what resume needs (deltas batch;
  no separate compaction layer yet — see open questions).
- No client-side resume library (browser does it).
- No sync engine, no CRDT, no WebSocket server, no React — in the base build.
- No polling anywhere.
## Open questions
 
- Compaction: raw deltas are currently kept forever (resume granularity is the
  batch boundary). When/if to compact them into a final message, and what
  keep-alive window to keep raw deltas resumable after `message-end`.
- Steering: today steer = cancel the current run and enqueue the redirect as a
  user message. Does mid-run steer instead append a redirect the model sees
  mid-completion?
- Multi-tab on one device: dedupe optimistic append when the same user's second
  tab receives the server echo of a message it didn't originate.
- Where the actor lives at scale (sticky in-proc vs. Durable Object) and the
  auth boundary in front of it.
