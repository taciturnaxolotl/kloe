# AGENTS.md

kloe is a server-authoritative LLM chat backend: generation is decoupled from client connections, each conversation is a single-writer actor over an append-only event log, and clients ride SSE down / HTTP POST up. Bun + native `routes` (no web framework) + `bun:sqlite` + the Vercel AI SDK. `spec.md` is the design document and is authoritative for intent; when a change feels ambiguous, read it before deciding.

## Commands

```sh
bun test                     # all tests (bun:test, no separate runner)
bunx tsc --noEmit            # typecheck (noEmit is set in tsconfig; there is no npm script for this)
bun server.ts                # run the server (also runs an inline job drive loop)
bun worker.ts                # standalone worker process; optional, the server can drive jobs itself
bun run dev                  # server with --watch
KLOE_DB=/tmp/k.db SMOKE_PORT=3456 bun run scripts/smoke.ts   # end-to-end smoke against the echo model (spawns a real server)
```

No lint or format tooling is configured. Do not add any.

## Runtime invariants

- **Single writer per conversation.** At most one run executes for a conversation at a time. Enforced twice: in SQL (`Store.claimExpiredExclusive` refuses to claim while another job for the conversation holds a live lease) and in-process (the `activeRuns` set in `src/drive.ts`). Any new execution path must respect this.
- **Durable write before fan-out.** Every persisted event is inserted synchronously into SQLite before being emitted to SSE subscribers. Actors keep no durable state of their own; seq is recovered from `Store.lastSeq` on construction, so evicting an actor never loses events. Idle eviction only touches actors with **no subscribers**: an SSE stream is pinned to its actor instance, and evicting it would orphan the stream from every future run.
- **Jobs, not requests.** `POST /api/conversations/:id/prompt` enqueues a job and returns 202 immediately. Execution happens later via `JobDriver` (`src/drive.ts`), polled by the server's inline loop and/or `worker.ts`. Anything you add to run execution belongs in `src/drive.ts`, not the HTTP handler.

## Request/event flow

All API routes live under `/api/` (the `/` and `/settings` HTML routes are separate).

1. `POST /api/conversations/:id/prompt` validates the model against the registry, appends a `user-message` event through the actor, enqueues a job, returns 202 with `{jobId, runId, messageId}`. The user message and the run share one `runId` on purpose so clients can correlate them.
2. `JobDriver.driveOnce` claims the job and runs it. Two job kinds: a plain run calls `actor.runText(runId, messageId, steps, onProgress)`, which persists `run-started` → `message-start` → batched `text-delta`s → `message-end` (and `cancelled`/`run-error` when applicable); a **flush** job (`kind: "flush"`, from `/steer`) promotes the conversation's pending steer queue and runs the whole thing as ONE batched `runText`. `onProgress` fires after each durable delta flush and advances the job's `checkpoint_seq` and lease heartbeat; the driver also heartbeats the lease on its own timer so a slow first token never expires it.
3. `POST /api/conversations/:id/steer` queues a message WITHOUT interrupting: it appends a durable `queued-message` event (so every device sees it) and enqueues a single flush job if none is pending. The steer queue is derived from the log (pending = `queued-message` with no matching `user-message` yet), not a separate table. When the current run ends, the flush promotes every pending steer to `user-message` (keeping its steer `runId`) and runs them together. `GET .../steer` returns the pending queue.
4. `GET /api/conversations/:id/stream` is a long-lived SSE connection that survives individual runs. Resume works via `Last-Event-ID`; the header carries the full `<conversationId>:<seq>` id and the server extracts the seq (`readLastEventId`), replaying strictly after it. A cursor for a *different* conversation is treated as no cursor (replay all), never applied. SSE comments (`: keepalive`) go out every 15s.
5. `POST .../cancel` sets a cancel flag on the actor (scoped to a runId when known, or deferred to the next run to cover the cancel-before-claim race).

Event names (`src/events.ts`) follow AG-UI conventions (`message-start`, `text-delta`, `run-started`, ...) and payloads always carry `threadId`/`runId`. Keep new event types in that vocabulary.

## The model pipeline (three layers, keep them separate)

1. **Catalog** (`src/catalog.ts`): read-only metadata about what models exist, fetched live from catwalk with two fallbacks: disk cache (`.cache/catwalk.json`) then vendored seed (`vendor/catwalk.seed.json`). Raw payloads are snake_case and parsed into camelCase here; never let raw catwalk shapes leak past `Catalog.fromRaw`.
2. **Ops config** (the `providers` array of `kloe.json`, loaded + validated in `src/settings.ts`, consumed by `src/providers.ts`): which providers this deployment enables, plus secrets and rate limits. An entry means "enabled". `apiKey`/`apiEndpoint` may be `"$ENV_VAR"` interpolation strings (resolved lazily via `resolveRef`); `apiKey` is optional (omit it for a keyless local provider — a *declared* key that resolves empty still errors). A provider missing from the catalog must carry `apiEndpoint`; if it also has no inline `models` list, models are **discovered live** from `{apiEndpoint}/models` at startup (`initInference` awaits `registry.discover()`), then enriched by the type's enricher in `src/discover.ts`. Crush convention: empty model list ⇒ discover, explicit list ⇒ skip (unless `discoverModels: true`). Explicit inline entries always win over discovered duplicates. `type` selects both the AI SDK adapter and the enricher (`"hyper"`, ...; default `"openai-compat"`).
3. **Curation** (`model_settings` table, `PATCH /api/models`): which models the chat UI shows. **Opt-in: a model with no row is hidden.** `/api/models` is the admin view (all models + curation state), `/api/models/chat` is the curated view.

The built-in **`echo` model** (`createEchoModel` in `src/providers.ts`) is a deterministic streaming mock that bypasses all three layers. It exists so the whole pipeline runs with zero network access; tests and the smoke script rely on it. Refs are `provider/model`; `echo` is the one bare ref allowed.

## Code layout

- `server.ts` — web entrypoint (side effects gated behind `import.meta.main`): serves the HTML page routes + `apiRoutes`, runs the inline drive loop and the reaper/idle-eviction timer.
- `src/http.ts` — the framework-free API layer: `apiRoutes(deps)` returns a Bun `routes` object, plus the actor map with idle eviction, the SSE stream plumbing, and request-body validation via `withBody` (valibot schemas in `src/schemas.ts`, Standard-Schema glue in `src/validate.ts`). Tests import `apiRoutes` directly, so importing `src/http` never triggers frontend bundling.
- `src/drive.ts` — `JobDriver`: the one claim → run → heartbeat/checkpoint → done implementation, shared by the server and `worker.ts`. Change run-execution logic here and both drivers change with it.
- `worker.ts` — standalone driver entrypoint running `JobDriver` on the same job table; kept for crash isolation.
- `src/client/` — the web frontend (vanilla JS + CSS, no build step; Bun transpiles/bundles it when serving `index.html`/`settings.html`).
- `src/actor.ts` — `ConversationActor`: seq management, subscriber fan-out, cancel flags, delta batching.
- `src/store.ts` — SQLite schema and all prepared statements. Column names are snake_case; TS interfaces camelCase; `rowToSetting`-style converters bridge them. Follow that pattern for new tables.
- `src/inference.ts` — module-level registry (`initInference`/`getRegistry`/`setRegistry`) and `run()`, which wraps `streamText`.
- `src/ratelimit.ts` — per-provider concurrency cap + min-interval shaping with 429-adaptive backoff. The semaphore deliberately hands permits from `release()` directly to a waiter without decrementing `active`; don't "simplify" it, the comment explains the race it prevents.
- `src/settings.ts` — the single validated deployment config (`kloe.json` + env + `$VAR` interpolation); `getConfig()` is the one loader every module reads. `src/blobs.ts` — content-addressed blob store (`BlobStore` interface, `FsBlobStore`/`S3BlobStore` backends, `createBlobStore()` picks by `config.blobs.backend`).
- `src/catalog.ts`, `src/providers.ts`, `src/discover.ts`, `src/events.ts`, `src/sse.ts`, `src/config.ts`, `src/errors.ts`. Discovery is ported from crush's `internal/discover`: generic `{base}/models` listing + per-type enrichers that backfill metadata without ever overwriting operator-set fields, failing soft at every step.
- **Internal tuning constants** live in `src/config.ts` (batch sizes, lease/heartbeat timings) — distinct from **deployment config** (`kloe.json` via `settings.ts`). `LEASE_GRACE_MS` (30s) must stay above `HEARTBEAT_INTERVAL_MS` (10s) or healthy runs get reaped between beats.

## Testing conventions

- `bun:test` with real temp-dir SQLite (`mkdtempSync` + `new Store(path)`); close and `rmSync` in `afterAll`. Never point tests at `data/`.
- Exercise HTTP by starting a real server on an ephemeral port: `Bun.serve({ port: 0, routes: apiRoutes({ store }) })`, then `fetch` against `server.url.origin`. `apiRoutes` carries no HTML routes, so tests never trigger frontend bundling. Stop servers and `rmSync` temp dirs in `afterAll`.
- The inference registry is module-global, so tests call `setRegistry(...)` in `beforeEach` (not just `beforeAll`) to survive interleaving with other test files' mutations. Build fixtures with `Catalog.fromRaw([...])` and `new ProviderRegistry(catalog, { config: { providers: [...] } })`; the registry reads no file itself — providers are always injected (production wires in `getConfig().providers` from `src/settings.ts`).
- Fake generation by passing inline async generators to `actor.runText`, or use the `echo` model. Never hit real providers in tests. Network code (`loadCatalog`, discovery) takes an injectable `fetchImpl`; tests mock it with `okFetch`-style helpers rather than intercepting globals.
- SSE assertions parse frames manually (`event:`/`id:`/`data:` blocks split on blank lines, skipping `:` comment keepalives). Copy the existing `readSse` helper rather than adding a dependency.
- `JobDriver` (`src/drive.ts`) in a test plays the role of the drive loop end-to-end; for finer control, `store.claimExpiredExclusive` + `actor.runText` + `store.markDone` is the manual equivalent.

## Gotchas

- `scripts/smoke.ts` sleeps (e.g. 1200ms for claim) assume the 1s drive-loop polling interval and the `ECHO_DELAY_MS` it sets; if you change either, re-check the cancel timing.
- Deployment config is one validated file, `kloe.json` (schema in `src/settings.ts` → generated `kloe.schema.json` via `bun run schema`; example in `kloe.example.json`). `getConfig()` is the single loader: schema defaults < file < a documented env-override map (`applyEnvOverrides`). `.env.example` documents that env surface (`PORT`, `KLOE_DB`, `KLOE_BLOB_BACKEND`, `KLOE_BLOBS`, `KLOE_S3_PREFIX`, `S3_*`, `CATWALK_*`, `ECHO_DELAY_MS`) plus the `$ENV_VAR` interpolations `kloe.json` names. Don't add scattered `process.env` reads — thread new config through `settings.ts`.
- `Store` creates the db's parent directory on construction, and treats `:memory:` specially. Keep both behaviors if you touch the constructor.
- Unknown-model validation at the HTTP edge (422) exists so jobs never fail silently at claim time. Any new endpoint that takes a model ref starts with `requireKnownModel()` in `src/http.ts`.
- Job params are parsed in exactly one place (`parseJobParams` in `src/store.ts`); a corrupt row is marked `failed` immediately rather than re-claimed forever. Don't re-parse `row.params` ad hoc.
- Delta batching means resume granularity is the batch boundary (`BATCH_MAX_DELTAS` / `BATCH_FLUSH_MS`), not the token. The live tail between flushes is only in memory; that is intentional per the spec's write-amplification recipe.
- `GET /api/conversations/:id/events` replays from seq 0 through the actor and will spin up an actor for any id, same as every other route; there is no auth yet (the `TODO(auth)` in `src/http.ts` is the only reference).
- **`[hidden]` loses to any author `display`.** The attribute's `display: none` comes from the UA stylesheet, so a rule like `.split { display: inline-flex }` silently overrides it and `el.hidden = true` does nothing visible. Every element the client toggles via `.hidden` needs a paired explicit rule (`.split[hidden] { display: none }`); `.chatshell[hidden]` documents the same trap. It has bitten this codebase several times and always looks like a JS bug.
- The frontend (`src/client/`) is intentionally framework-free vanilla JS with no build step; Bun's HTML route handling does the bundling. Keep it dependency-light (the one vendored lib is `streaming-markdown`) and don't introduce a bundler.

## Style

- TypeScript strict, `verbatimModuleSyntax` (use `import type` for types), `.ts` extensions on relative imports, `erasableSyntaxOnly` (no enums, no namespaces).
- JSDoc block comments on exported types/functions explaining intent and invariants are the house style; match them.
- camelCase everywhere except SQL columns (snake_case). Double quotes, semicolons, two-space indent.
- Prefer prepared statements cached in the `Store` constructor over inline SQL, except one-off reads like `lastSeq`.
