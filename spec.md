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
  event: "user-message" | "queued-message" | "queued-cancelled" | "run-started" |
         "message-start" | "text-delta" | "message-end" | "run-error" |
         "cancelled" | "tool-call" | "tool-result",
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
  the run share one `runId` so clients can correlate the optimistic echo. May
  carry `attachments[]` (blob refs from `POST /api/blobs`); each is validated to
  reference a real blob (422 otherwise) and registered in `blob_refs`.
- `POST /api/conversations/:id/cancel` — sets the cancel flag; the run checks it
  between token batches and aborts upstream. **A dropped connection is NOT a cancel**
  (resume is in play), so cancellation must be explicit and out-of-band.
- `POST /api/conversations/:id/steer` — queues a message for the next run,
  WITHOUT interrupting the current one. It appends a durable `queued-message`
  event (visible on every device) and enqueues one flush job. When the current
  run ends, the whole pending queue is promoted to `user-message` events and
  run as ONE batched generation — all queued messages go out together, never
  one at a time. Carries `attachments[]` like `prompt` (registered at queue time
  so they're GC-protected while pending, and promoted with the message).
- `DELETE /api/conversations/:id/steer/:runId` — removes ONE still-pending steer
  by `runId` (append-only, via a `queued-cancelled` tombstone the queue
  derivation honors). 404 if that runId isn't currently queued, so a stale id
  can't spam the log. There is no bulk clear — the client deletes per item.
- `GET /api/conversations/:id/steer` — the pending steer queue (derived from the
  log: `queued-message` events not yet superseded by a `user-message` promotion
  or a `queued-cancelled` removal).
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
- **Implemented** against an indiko-style OAuth 2.0 / OIDC server (`src/auth.ts`),
  as a **public client**: Authorization Code + PKCE, no secret. `client_id` is
  kloe's own `/client-metadata.json` (a Client ID Metadata Document) and the
  redirect is `/auth/callback`, both derived from `auth.baseUrl`; the IdP's
  endpoints come from OIDC discovery on `auth.issuer`. On callback we verify
  `state` + `iss`, exchange the code, check `allowedSubs` (empty = any
  authenticated user), and **mint our own opaque cookie session** (SQLite
  `sessions`, swept on expiry) rather than keeping the provider's tokens.
- **Gate:** `/api/*` (including the SSE stream) requires a session — 401
  otherwise; `/health` stays open. Pages stay public; the SPA calls `/api/me` on
  boot and, on a 401, redirects to `/auth/login` (client-side, like indiko's own
  dashboard), preserving `returnTo`. Disabled by default, so local dev and
  single-user setups run open. Cookie is `HttpOnly`, `SameSite=Lax`, and `Secure`
  when `baseUrl` is https. The signed-in avatar shows in the rail footer next to
  Settings.
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
 
## Tools, attachments, thinking & sandboxing

> Status: **designed, not built.** The base build streams text only. This section
> is the one large capability extension the base build was shaped to accept —
> the event enum already reserves `tool-call`/`tool-result` and
> `message-start.type` already admits `"tool-call"`. Build it in the sequence at
> the end; don't land it all at once.

The whole extension rides **one spine**: consume the provider's *full* stream
(not just text), persist each non-reproducible part durably as its own event,
and keep bytes out of the log behind a **content-addressed blob store**.
Attachments, thinking, tool calls, and sandboxed execution are four faces of
that single change, not four subsystems.

### The full stream

`run()` today consumes only `result.textStream`. Switch to `result.fullStream`
and demux by part type into `RunStep`s the actor already understands, plus new
ones:

```
text-delta        → TextStep        (batched, reproducible — as today)
reasoning-delta   → ReasoningStep   (batched, reproducible)
reasoning-end     → carries the signature/providerMetadata (DURABLE)
tool-call         → ToolCallStep    (DURABLE)
tool-result       → ToolResultStep  (DURABLE)
finish            → UsageStep        (as today)
```

The durability split is the load-bearing rule, and it is the same two-SLA
classification the write-amplification section already draws: **reproducible
parts batch** (a crash regenerates them on re-run), **non-reproducible parts
fsync before the model sees them again** (a crash must not lose or re-run them).
Text and reasoning *text* batch; tool calls, tool results, and reasoning
*signatures* are durable events through `persist()`.

### Content parts & the blob store

A message `content` stops being only a string. User messages gain
`attachments: Attachment[]`; tool results gain `artifacts: Artifact[]`. Both are
**references, never inlined bytes**:

```
Attachment/Artifact = { sha256, kind: "image" | "file", mime, name, size }
```

Bytes live in a **content-addressed blob store**; only the reference rides the
log. This keeps the durable log small and text-searchable (the whole write-amp
story assumes small events) and preserves the existing title/search paths, which
read `content` as text. `content` stays the text; attachments sit beside it.

The store is deliberately **S3-shaped** — `put(bytes) → sha256`,
`get(sha256)`, `exists`, `delete` — because content-addressing *is* the
object-store abstraction: immutable keys, no overwrites, dedup is a no-op PUT,
consistency is free (a sha256's bytes never change).

- **Default backend: local filesystem** (`data/blobs/<sha256>`). Single node
  wants no network hop, no credentials, no dependency; the OS page cache handles
  hot blobs. Per the spec's own rule, no infra until a feature demands it.
- **`BlobStore` is an interface with swappable backends** (mirrors the provider
  adapters). An `S3BlobStore` — over Bun's native `S3Client`, no `aws-sdk`
  dependency — ships alongside the fs backend and is selected by
  `KLOE_BLOB_BACKEND` (`fs` | `s3`), so object storage is a config switch, not a
  rewrite. Reach for it when the spec's own inflections bite: **multi-node**
  (local disk isn't shared across worker boxes) or **serving offload**
  (returning an `S3File` from a `Response` redirects the client to a presigned
  URL — bytes never proxy through Bun; gate for auth since it bypasses the app's).
- **When S3, self-host it** (Garage / MinIO / SeaweedFS), never AWS. Sending
  private conversation data and agent artifacts off-box is the same mistake that
  rules out Tangled pipelines below. Self-hosted keeps the S3 API and gains
  replication/backup while staying private by construction.
- **Bytes never go in the event sqlite** — they bloat the DB holding the hot
  log and wreck WAL/backup. Refs and metadata in sqlite; bytes on fs/object
  store.
- **GC is refcount, driven by kloe**: a blob no live event references is
  collectable (mark-sweep on a timer + deref on `deleteConversation`). Dedup
  means deleting one conversation can't yank a blob another still references.
  S3 lifecycle rules are age-based and can't do this, so kloe drives deletion
  either way; bucket versioning is a safety net against a buggy sweep.
- **Big data is touched through tools, not context.** A large dataset is a blob
  the agent reads/writes via sandbox tools; only summaries or the needed slice
  enter the prompt. Raw stdout is truncated into the log; only explicit
  artifacts are blobbed.

`POST /api/blobs` streams to the store while hashing (never buffers in RAM) and
returns `{sha256, size, mime}`. `GET /api/blobs/:sha256` serves behind the same
cookie/session auth as everything else, with immutable long-cache headers and a
`Content-Disposition` from the reference's `name`. Access control is
single-user today (is this *the* user); per-blob tenant scoping is deferred until
kloe is actually multi-user.

### Attachment handling — by type, plus the universal sandbox path

Attachments are **files of any type**, not just images. `kind` is a coarse UI
hint; **`mime` drives how the attachment reaches the model**, cheapest path
first:

1. **Image** (`image/*`, and the model reports `supportsImages`) → an AI SDK
   **image part** — native vision, no sandbox needed.
2. **Text-like** (`text/*`, JSON/CSV/source, and small enough to fit the context
   budget) → **inlined as a text part**, fenced and labeled with its `name`.
   This is the easiest case: the bytes just become context.
3. **Everything else** — binary, or text too large to inline — is **not put in
   context at all**. It's surfaced to the model as an addressable handle it can
   pull into the **sandbox** and operate on with tools (parse a PDF, probe an
   archive, run a binary). This is the same "big data is touched through tools,
   not context" rule, applied to uploads.

**The universal invariant, independent of the routing above: every attachment —
any type, any size — is addressable by a stable handle (its `sha256`/ref) and can
be materialized read-only into the sandbox workspace on demand by the model.**
Inlining and sandbox-access are orthogonal: inlining is a convenience for what
fits in context; the sandbox is the always-available way to *act on* the bytes.
So even an image or a small text file the model already saw in context can still
be pulled into the sandbox as a file (to resize it, grep it, feed it to a tool).

The mechanism is the one the sandbox section already defines: attachments are
blobs, and blobs are mounted into `/workspace/inputs/` read-only (virtiofs/9p,
zero-copy, content-addressed, uncorruptable) — plus a tool
(`get_attachment(sha256)` / `read_file`) so the model can request any attachment
by reference regardless of how (or whether) it appeared in context. The model
never needs the bytes inlined to work with a file; it needs the handle.

**Original filenames are preserved and used.** The blob is content-addressed
(keyed by `sha256`, shared across references), so the human name lives on the
*reference* (`Attachment.name`), not the blob. That name is carried durably in
the event log and put to work in two places:

- **In the sandbox**, an attachment materializes as `/workspace/inputs/<name>`,
  not `/workspace/inputs/<sha256>` — models reason far better about `report.pdf`
  than a hash, and a tool that writes `output.csv` reads naturally. Collisions
  (same name, different bytes, or the same name twice in one turn) are
  disambiguated by a short prefix directory (`inputs/<n>/<name>`), never by
  mangling the name itself.
- **On download**, `GET /api/blobs/:sha256?name=<name>` sets a sanitized
  `Content-Disposition` filename (one safe path segment — no separators or
  header-break bytes), so a user saving a file gets its real name back.

### Thinking (reasoning)

Reasoning is another stream of durable parts on the assistant turn, not a
separate feature. The catalog already exposes `reasoning_levels`/`can_reason`
and the picker already renders a "reasoning" tag.

- **Requesting it is adapter-specific**, so the level map lives where adapter
  selection already branches on catwalk `type`: normalize kloe's own level
  (`off | low | medium | high`) once, then map to `providerOptions` —
  `anthropic.thinking = { type:"enabled", budgetTokens }`,
  `openai.reasoningEffort`, others as they support it. `reasoningLevel` joins
  `PromptBody` (and `SteerBody` inherits it); the client stores it beside the
  model and shows the toggle only when the selected model has non-empty
  `reasoningLevels`.
- **The signature is the catch.** Anthropic extended-thinking blocks carry a
  signature that must be sent back verbatim on the *next* turn when tools are in
  play, or the API rejects it (OpenAI returns only a summary + an opaque item
  id). So batch reasoning *text* for the live view, but persist the completed
  block's `providerMetadata` durably on `reasoning-end`, and have `history()`
  fold reasoning back into the assistant message **with** its signature. Rule:
  reasoning text is reproducible (batch it); reasoning signature is
  non-reproducible (fsync it). Preserve and resend `redacted_thinking` blocks;
  never render them.
- **Render as a collapsible thought block** above the answer — its own muted smd
  region, streamed live, auto-collapsed to "Thought for Ns" on the first real
  text delta. Handle all three real cases gracefully: raw thinking, summary
  only, none.

### System prompt

Every run is grounded by a system prompt (`streamText`'s `system`), built per
turn in `prompt.ts` from a publisher-owned template (`prompt.tpl`, Go
text/template syntax so it reads like Crush's). Rendered with: the **current
date** (so the model isn't stuck at its training cutoff), the deployment's
persona/preferences/boundaries from the `prompt` config section, and the set of
tools **actually exposed to this run** — the `<tools>` block (and its "reach for
tools rather than speculate" nudge) appears only when tools exist, which is the
other half of getting a model to call them (the first half is exposing them at
all — a search provider must be configured, or `toolSet()` is empty and no
`tools` are sent). The renderer implements only the subset the file uses
(`{{.Field}}`, `{{if}}/{{else}}/{{end}}`, `{{range}}`, comments); it is not a
general engine. A deployment can override the template path or drop context
files into the `<memory>` block via config.

### Tools — the explicit, durable loop

**Shipped so far — in-process pure tools** (read-only, side-effect-free, safe to
re-run on reclaim): `web_search` (swappable `SearchProvider`, Ceramic backend)
and `fetch_url` (fetch a page → its main content as markdown via Readability +
Turndown, behind a swappable `FetchProvider`, on by default). `fetch_url` can't
gate each call on a human approval the way a dev CLI does, so its safety is an
SSRF guard: http(s) only, the *resolved* IP checked against private/reserved
ranges, every redirect hop re-checked, plus an `allowPrivate` escape hatch for
reading homelab-internal services. The durable loop + sandbox below is for the
*dangerous* tools still to come.

The AI SDK will run the whole tool loop itself (`stopWhen` + `tool.execute`).
**Don't use that**: it executes tools *inside* one `streamText`, so a worker
crash mid-tool re-runs the tool on reclaim — fine for a read-only search,
catastrophic for a side-effecting one. Drive the loop explicitly and persist
across the boundary:

```
run(messages):
  loop:
    step = streamText(model, messages, tools)   # one provider round-trip
    stream text-delta / reasoning-delta         # batched
    if step ends with tool-calls:
      for each call:
        persist tool-call            (DURABLE)
        result = executor.run(call)  # ← the sandbox lives here
        persist tool-result          (DURABLE)
        append call + result to messages
      continue                                   # feed results back
    else: break                                  # normal stop
```

Because the tool-result is in the log **before** the model sees it, `history()`
on reclaim replays it and the model continues from the stored result **rather
than re-executing the tool**. That is the whole game for side-effecting tools.
One job still equals one turn; it just spans several provider round-trips, which
the existing heartbeat/lease/checkpoint already tolerate (checkpoint advances
across tool boundaries).

- **Tool registry** (`{name, description, inputSchema, riskLevel, executor}`),
  enabled via the same opt-in curation UI as models.
- **Tool calls render as cards, not markdown** — a collapsible region keyed by
  `toolCallId` inside the current turn (name, args, spinner, result/preview).
  smd stays for prose.
- **Approval gate = the safety lever, and it reuses machinery you have.**
  A tool declares risk. Read-only/pure → auto-run in-proc. Dangerous → emit the
  `tool-call` with `status:"pending-approval"` and **park the run exactly like a
  steer** (a durable event, no interrupt); the client shows Approve/Deny inline;
  `POST /…/tools/:id/approve` enqueues the continuation. Multi-device approval
  and resumability fall out for free — approve on a phone, the laptop's SSE
  replay rebuilds the same state.

### Sandboxing — reuse the spindle *engine*, not its pipelines

Dangerous tools run in a microVM. The homelab already runs a **Tangled spindle**,
whose execution engine is exactly a sandboxed command runner wearing a CI
costume: a QEMU microVM per job, an in-guest agent (Shuttle) that dials back over
**vsock/agentproto** and runs commands as an unprivileged user streaming
stdout/stderr/exit, aggressive network-namespace isolation (RFC 6890 special
addresses blackholed, private-IP DNS answers stripped), a work-conserving fair
scheduler with cgroup limits, a nix binary cache, and uniform teardown. Reusing
that is far better than hand-rolling nsjail/docker.

**Integrate at the engine boundary, not the pipeline boundary.** Tangled
pipelines are the wrong seam: they're triggered by public `sh.tangled.*` records
and stream results to a public event stream — and Tangled has **no private
repos**, so conversation data would be world-readable — and the record →
Jetstream → clone → boot path is slow. None of that is inherent to *running a
command*: vsock exec is host-local and touches no PDS.

```
kloe (SpindleExecutor) ──authed local API──► sandbox broker ──agentproto/vsock──► microVM
   dangerous tool call                     (co-located w/ spindle)   Shuttle runs cmd
   ◄──────────── streamed stdout/stderr/exit ─────────────────────────────┘
```

The **broker** is a thin daemon on the spindle host that reuses spindle's
microVM engine (vendored packages, or a private "manual exec" mode added to
spindle) but skips Jetstream/PDS/repo-clone and never publishes to the public
event stream. Logs land in kloe's own log, private by construction. vsock is
host-local, so the broker must live on the spindle box; kloe reaches it over an
authed LAN API (a unix socket if co-located).

**Executor tiers**, selected by a tool's risk level (same adapter-by-type
spirit as providers): pure/read-only → **in-proc** (no VM); anything needing a
sandbox → **microVM via the broker**.

### The Nix sandbox as event-sourced, self-extending state

The environment is defined **declaratively in Nix**, and that definition is part
of the conversation's durable state — not hidden mutable state in a VM.

- A `sandbox-spec` event records a declarative delta ("this env now also has
  `nixpkgs#ffmpeg`, `git+…#tool`"). The **current environment is a fold** over
  those events — the same shape as the steer queue and model curation.
- On boot/reclaim/warm-pool assignment the broker **reconstructs the Nix spec
  from the log** and activates it. The VM holds no state the log doesn't; a
  disposable VM loses nothing.
- **Replay reconstructs the toolset, not just the transcript.** Pin the nixpkgs
  rev / flake lock and a conversation is byte-reproducible — the agent gets the
  identical tools on re-run. This falls straight out of the event-log model.
- **The agent extends itself** via an `add_tools({packages, flakes})` meta-tool:
  it appends a `sandbox-spec` event, re-activates the warm VM (near-instant on a
  cache hit), and subsequent `run_shell` calls see the new binaries. Declarative
  beats imperative `curl | sh`: atomic, reproducible, rolls back to a generation
  if it doesn't build. Services (postgres, headless chromium) come the same way
  via NixOS `services`; a custom tool is a flake ref.
- **The homelab cache compounds.** Every realized path is pushed back to
  spindle's cache; the first use of a package builds, every use after is a
  store-path realization. The cache becomes a shared, growing tool library
  across all agent runs, so `add_tools` gets cheaper over time.
- **Bounded supply chain = the safety model.** The agent can only pull from
  substituters and flake sources you allow (and egress is namespace-restricted
  anyway), so capability extension and supply-chain control are the *same*
  mechanism.

### Sandbox lifecycle — per-chat logically, pooled physically

A sandbox-per-chat is clean but VMs must not pile up. Split the two lifetimes
the same way a conversation (durable log, forever) and its actor (in-memory,
idle-evicted) are already split:

- **Logical sandbox = the folded manifest in the log.** A few hundred bytes of
  sqlite per chat; a thousand chats = a thousand tiny manifests + *one shared
  nix store*. Never evicted.
- **Physical VM = materialized on demand, torn down aggressively.** Safe to
  discard because the environment rebuilds from the fold. A hot/warm/cold
  hierarchy:

  | Tier | State | When |
  |------|-------|------|
  | Hot  | booted, RAM+vCPU live | chat actively running tools |
  | Warm | QEMU memory snapshot to disk | recently active; fast restore |
  | Cold | manifest only, in the log | rebuild on next call (cache-fast) |

  Eviction is LRU on warm VMs under slot pressure; the sandbox gets its own idle
  TTL, longer than the actor's (boot is expensive → more hysteresis).
- **Capacity is spindle's job.** Its scheduler is work-conserving with per-user
  fairness and acquires a slot before boot. So a tool call that needs a sandbox
  is **a job waiting on a sandbox slot** — if the pool is full it stays queued,
  the same lease/queue model already in the driver. kloe builds no VM scheduler.

### Artifacts — the promotion path

Tools are reproducible from the manifest, so they're disposable; files the agent
*creates* are not, so they need an explicit path to durability:

- **Workspace is ephemeral by default** and dies with the VM. **Rule: if it's
  not promoted to a blob referenced in the log, it's scratch.** This is what
  keeps VMs disposable and stops disk from accumulating.
- **Promotion**: anything under `/workspace/outputs/` is auto-harvested on step
  completion → blobbed → referenced in the `tool-result`; plus an explicit
  `save_artifact({path})` for precision. Agent-produced files use the *same*
  content-addressed blob store as user uploads — one mechanism.
- **Two channels in/out of the VM, kept distinct**: the **nix store** (tools) is
  spindle's read-only store disk + cache proxies; **data blobs** (inputs/outputs)
  are kloe's — inputs mounted read-only (virtiofs/9p, zero-copy, uncorruptable),
  outputs harvested after the step. **User attachments are inputs too**: any
  attachment (image, text, or binary — see "Attachment handling") is a blob, so
  the model materializes it into `/workspace/inputs/` by `sha256` the same way it
  reuses a prior artifact. Every attachment is downloadable into the sandbox
  regardless of type or whether it was also inlined into context.
- **Reuse is by sha256**: an artifact from turn 3, or an attachment from turn 1,
  fed to a tool in turn 7 is just its reference; the broker materializes the same
  blob into the new workspace. No re-upload, no byte-copying.
- **Render** like tool cards: image → inline thumbnail (user uploads and agent
  images render identically); other → a download chip served from
  `GET /api/blobs/:sha256`. **Opt-in persistent per-chat volume** exists for a
  genuine long-lived project workspace, but it's a deliberate choice with its
  own age/size GC — that's where disk pile-up would otherwise sneak back in.

### New events (extend the enum)

All AG-UI-aligned, `threadId`/`runId`-carrying, same as the base set:

| Event | Durability | Payload sketch |
|-------|-----------|----------------|
| `reasoning-delta` | batched | `{ messageId, delta }` |
| `tool-call` | durable | `{ toolCallId, toolName, input, riskLevel, status }` |
| `tool-output-delta` | batched | `{ toolCallId, delta }` (streamed stdout) |
| `tool-result` | durable | `{ toolCallId, output, artifacts[], exitCode? }` |
| `sandbox-spec` | durable | `{ packages[], flakes[], services? }` (a fold delta) |

`tool-call.status` covers `running | pending-approval | ok | denied | error`.
Reasoning signatures ride `message-end` (or `reasoning-end`) rather than a delta.

### Build sequence

Land it in this order — each step is independently useful and proves one layer.
Steps 1–3 are **built**; 4–6 (approval + the spindle sandbox) are the remaining
Part-B work.

1. **Blob store + attachments** ✅ — `BlobStore` (fs + S3), `POST`/`GET
   /api/blobs`, `attachments[]` on user and steered messages, thumbnails,
   orphan GC. Mime-routed delivery in `history()`: image part / inlined text /
   sandbox-note. The sandbox *fetch* lands with the executor (step 5); the
   *addressability* (blob refs) is here from day one.
2. **Full-stream migration + tools** ✅ — `run()` consumes `fullStream`; new
   `ToolCall`/`ToolResult` `RunStep`s; durable `tool-call`/`tool-result` events;
   `history()` folds them into paired assistant/tool messages; tool steps render
   in the timeline. `streamText` runs the agentic loop (`stopWhen`); tools are
   in-process and side-effect-free for now (AI SDK auto-execute — pure tools are
   safe to re-run on reclaim; the persist-before-model-sees explicit loop comes
   with dangerous tools). First tool: **`web_search`** behind a swappable
   `SearchProvider` (Ceramic), offered only when configured.
3. **Thinking** ✅ — reasoning parts, adapter-level effort map (per-provider
   `providerOptions`), the collapsible timeline step, durable `reasoningMs`.
   Signature preservation for reasoning+tools is done: a provider-signed thinking
   block is persisted (`reasoning-signature` event) and echoed back verbatim as a
   `reasoning` part in `history()`, so a follow-up turn that replays tool calls
   isn't rejected; unsigned reasoning stays dropped from history.
4. **Approval gate** — the parked `pending-approval` status over the steer/job
   machinery. *(not built)*
5. **`SpindleExecutor` + broker** — first dangerous tool (`run_shell`) over
   agentproto; the `sandbox-spec` fold + `add_tools`; artifact promotion; the
   explicit durable tool loop; attachment/artifact fetch into the sandbox. *(not built)*
6. **Sandbox lifecycle polish** — warm/cold tiers, slot-as-job, snapshot restore
   — only when boot latency justifies it. *(not built)*

Interleaved rendering is done: a turn's body is an ordered run of segments —
prose blocks and timeline runs (reasoning + tool steps) — so text that resumes
after a tool starts a fresh block below it and a reasoning→tool→text→tool
transcript renders top to bottom, rather than grouping all steps above the
answer. Oversized tool outputs are truncated (`TOOL_OUTPUT_MAX`) before they hit
the durable log. No known follow-ups remain within the in-process tool system;
the sandbox executor + approval gate (items 4–6 above) are the next slice.

## Projects & the memory layer (lard)

kloe on its own is a flat list of conversations. Two related layers give it
durable, cross-session context: **projects** group chats and pin them to shared
context, and an integration with **lard** — a homelab memory server (chuck LLM
sessions in, get consolidated subjects back) — gives that context a brain that
learns across *every* tool the user runs, not just kloe.

### Projects

A **project** is a named collection of conversations plus the context they
share — a first-class entity alongside the conversation:

```
project { id, name, lardProject: "<lard project id>" | null, createdAt, updatedAt }
```

- A conversation optionally **belongs to** one project (`conversation.projectId`,
  nullable — an "unfiled" chat has none). The sidebar can group recents under
  their project; a project page lists its chats.
- **Shared context files.** A project owns a small set of editable markdown
  documents — context files — injected verbatim into the system prompt of
  *every* chat in the project (the way a repo's AGENTS.md grounds a coding
  agent). They are the project's hand-authored, always-on memory: instructions,
  glossaries, standing decisions. Keyed by project, edited from the project page.
- **Why a layer, not a tag.** Grouping is the cheap part; the value is that a
  project is the unit that *shares state* — context files plus a pinned memory
  project — so a new chat in it starts already knowing what the others
  established.

### Pinning to lard

Each project may pin a **lard memory project** (`lardProject`). lard already
models project identity (a canonical id that git remotes / paths / names resolve
to); kloe's project holds that id so every chat, tool call, and ingested session
routes to the same lard area. Set it explicitly, or resolve it once from hints
via lard's `POST /projects/resolve`.

### Auth — device grant, once

lard is an OAuth 2.1 protected resource. kloe authenticates as a **collector**
with the device authorization grant (RFC 8628): discover the AS from lard's
`/.well-known/oauth-protected-resource`, POST the device endpoint, show the user
a code + verification URL, poll the token endpoint, store the token (with
`offline_access` → a refresh token, so kloe outlives the 1-hour access token).
This is an operator action run once (`bun run lard-login`), **not** a per-user
login — kloe holds one machine identity to lard, distinct from kloe's own user
auth. The token lives outside the event log (a token file / one-row table),
refreshed lazily before each call.

### Three ways kloe uses lard

Opt-in via a `lard` config section (absent → none of this exists), splitting
cleanly into read, tool, and write paths:

1. **Auto-injected context (read).** At run start, if the chat's project pins a
   lard project, kloe fetches `GET /context?project=<id>` (profile + subject
   listing + that project's area) and folds it into the system prompt beside the
   project's own context files. The model starts every turn already knowing the
   durable picture — no tool call needed for the common case.
2. **Memory tools (read/write).** Native tools mirror lard's HTTP surface —
   `memory_get_context`, `memory_list`, `memory_read(path)`,
   `memory_write(path, body)`, `memory_append(path, line)` — gated by the `lard`
   config exactly as `web_search` is gated by a search provider. Paths are
   lard's own (`profile`, `areas/<name>`, `topics/<name>`, `people/<name>`);
   writes default to the pinned project's area. A chat can durably record a
   decision mid-conversation, and the user can ask "what do you know about X".
3. **Ingest (write).** Completed conversations are pushed to `POST /ingest` as
   sessions (`{collector, sessions:[{sessionId, source:"kloe", projectHints,
   startedAt, turns:[{index,role,content,ts}]}]}`) so lard extracts facts and
   consolidates them — making kloe a source alongside the user's other LLM
   sessions. Ingest is idempotent (upsert by `sessionId`), so re-sending a grown
   conversation is safe; it runs debounced on `message-end` or a periodic sync,
   off the hot path.

### Data-model & boundaries

- New `projects` table (id, name, lard_project, timestamps) and `project_context`
  (project_id, path, body) for context files; `conversations` gains a nullable
  `project_id`. Project mutations are ordinary API actions, **not** conversation
  events (a project isn't a stream); the conversation↔project link is a column,
  set at creation or moved later. lard tokens live in their own store, never in
  the conversation log.
- lard is **optional and external** — kloe degrades to today's flat behavior when
  it's absent or unreachable (a failed `/context` fetch is logged and skipped,
  never blocks a run).
- kloe holds **one** machine identity to lard; per-kloe-user scoping of lard
  subjects is out of scope for the base build (single-tenant homelab assumption,
  matching lard's own model). Context files are kloe-owned and always-on; lard
  subjects are lard-owned and learned — complementary, not the same thing.

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
| Blob store       | Content-addressed (`sha256`), swappable backend via `KLOE_BLOB_BACKEND`: local-fs default + self-hosted S3 (Garage/MinIO/R2 via Bun `S3Client`) — **built**; endpoints/attachments next |
| Tools            | AI SDK agentic loop (`streamText` + `stopWhen`); durable `tool-call`/`tool-result` events, `history()` folding, timeline rendering; in-process pure tools — **built** |
| Search           | `web_search` behind a swappable `SearchProvider` (Ceramic first); config-selected, offered only when set — **built** |
| Tool sandbox     | microVM via a broker over Tangled spindle's engine (agentproto/vsock); Nix env as an event-sourced fold — *designed, not built* |
 
## When to add more (decision rules)
 
| Symptom / need                                             | Add                                   |
|------------------------------------------------------------|---------------------------------------|
| High-frequency up-channel: voice, token-level barge-in, presence, live cursors | WebSockets (accept losing free resume) |
| Offline authoring that must converge across devices        | Sync engine (TinyBase MergeableStore, ~6–13 KB, over a custom synchronizer riding the existing SSE/actor channel) |
| Concurrent editing/reordering of past messages             | CRDT for those fields only            |
| Horizontal scale across nodes                               | Back the actor's log/pubsub with Redis Streams + Pub/Sub, or Durable Objects, **and** move blobs to a self-hosted S3-compatible store |
| Richer CRDT data (trees, rich text)                        | Yjs (known quantity) or Loro (WASM cost) |
| Model needs images/files, or tools that touch a real environment | The tools/attachments/sandboxing section — full-stream + durable parts + blob store; microVM via the spindle-engine broker for dangerous tools |
 
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
- Steering: steer queues messages (no interrupt) and flushes them together
  when the current run ends. Open: should an explicit "interrupt now" variant
  also exist (cancel + immediate flush), and how should the model be told the
  queued messages are mid-run redirects rather than a fresh turn?
- Multi-tab on one device: dedupe optimistic append when the same user's second
  tab receives the server echo of a message it didn't originate.
- Where the actor lives at scale (sticky in-proc vs. Durable Object) and the
  auth boundary in front of it.
- Sandbox exec idempotency: if the worker dies after the microVM ran but before
  the `tool-result` persisted, re-running risks a double side-effect. The honest
  ceiling is to persist the result before acking the model and treat a crash in
  that gap as a *failed* tool the user/model retries — tightened by a
  broker-side idempotency key (`toolCallId`, don't boot a second VM for the same
  key). Confirm this is enough, or whether a durable "exec-started" marker is
  also needed.
- Broker coupling: vendor spindle's microVM engine packages vs. add a private
  "manual exec" mode to spindle. Which keeps upstream drift lowest while never
  publishing to the public event stream?
- Sandbox TTLs and warm-pool size: the sandbox idle TTL (vs. the actor's), how
  many VMs to keep hot/warm, and whether snapshot-restore is worth the disk over
  a cache-warm cold rebuild.
- Persistent workspace volumes: when a chat should get a durable per-chat ext4
  volume rather than an ephemeral one, and its age/size GC budget.
- Blob GC cadence: refcount mark-sweep on delete is clear; open is the
  background sweep interval and whether to keep a grace window before collecting
  a newly-unreferenced blob.
- lard ingest cadence & granularity: per-conversation session upsert on
  `message-end` (simple, re-sends the whole thread each time) vs. a periodic sync
  of only changed conversations. What debounce, and whether to ingest partial
  (mid-run) threads at all.
- Project ↔ lard resolution: when a project has no pinned `lardProject`, do we
  auto-resolve one from hints (name / a git remote the user supplies) via
  `/projects/resolve`, or leave memory off until explicitly pinned?
- Moving a chat between projects: whether that re-ingests it under the new
  project id (facts already extracted under the old one are lard's to
  supersede), and whether context-file changes should retroactively affect past
  chats' replays (they shouldn't — context is injected per run, not stored).
- Single machine identity vs. per-user: kloe authenticates to lard once as a
  collector, so all kloe users share one lard view. If kloe ever becomes truly
  multi-tenant, the auth boundary to lard (one token vs. per-user device grant)
  reopens.
