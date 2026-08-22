import * as v from "valibot";

/**
 * Request-body schemas (valibot).
 *
 * `v.object` ignores unknown keys (lenient like the current API);
 * `v.minLength(1)` on `model`/`ref` reproduces the "required, non-empty" rule
 * that returns 422 today.
 */

/**
 * A reference to an uploaded blob (POST /api/blobs) attached to a message. The
 * bytes live in the BlobStore; only this reference rides the event log. `name`
 * is per-reference (the original filename); `kind` drives how the UI renders it.
 */
export const Attachment = v.object({
  sha256: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/, "sha256 must be 64 hex chars")),
  name: v.string(),
  mime: v.string(),
  kind: v.picklist(["image", "file"]),
});
export type Attachment = v.InferOutput<typeof Attachment>;

/**
 * An answered `ask_user` form, riding the message the user sends back (see
 * AskReply). The client hands the questions back with the answers so the turn
 * renders as a question-and-answer rather than as the prose the model reads;
 * everything here is bounded because it is user input that gets persisted.
 */
const AskChoiceBody = v.object({
  id: v.pipe(v.string(), v.maxLength(200)),
  label: v.pipe(v.string(), v.maxLength(200)),
  description: v.optional(v.pipe(v.string(), v.maxLength(500))),
});
const AskQuestionBody = v.object({
  type: v.picklist(["single_choice", "multi_choice", "rank_priorities", "free_text"]),
  question: v.pipe(v.string(), v.maxLength(500)),
  description: v.optional(v.pipe(v.string(), v.maxLength(2000))),
  choices: v.optional(v.pipe(v.array(AskChoiceBody), v.maxLength(10))),
});
export const AskReplyBody = v.object({
  toolCallId: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  questions: v.pipe(v.array(AskQuestionBody), v.maxLength(10)),
  answers: v.pipe(
    v.array(
      v.object({
        choiceIds: v.optional(
          v.pipe(v.array(v.pipe(v.string(), v.maxLength(200))), v.maxLength(10)),
        ),
        text: v.optional(v.pipe(v.string(), v.maxLength(10_000))),
      }),
    ),
    v.maxLength(10),
  ),
});

/** POST /api/conversations/:id/prompt */
export const PromptBody = v.object({
  content: v.string(),
  model: v.pipe(v.string(), v.minLength(1, "model is required")),
  runId: v.optional(v.string()),
  attachments: v.optional(v.array(Attachment)),
  /**
   * How hard the model should think, from the levels it declares (e.g. "low",
   * "high", "xhigh"). Per message rather than per conversation: the same chat
   * holds "what's this error" and "design the migration", and they do not want
   * the same budget.
   */
  effort: v.optional(v.pipe(v.string(), v.maxLength(20))),
  /** Set when this message answers a question the model asked. */
  ask: v.optional(AskReplyBody),
});
export type PromptBody = v.InferOutput<typeof PromptBody>;

/**
 * POST /api/conversations/:id/steer — queues the message; flushed as one
 * batched run when the current run finishes. A steer carries the same payload
 * as a prompt (content + model + optional runId), so it reuses that schema
 * rather than a byte-identical copy that could drift.
 */
export const SteerBody = PromptBody;
export type SteerBody = PromptBody;

/** PATCH /api/conversations/:id — set a custom title (empty string clears it). */
export const RenameBody = v.object({
  title: v.pipe(v.string(), v.maxLength(200)),
});
export type RenameBody = v.InferOutput<typeof RenameBody>;

export const ProjectCreateBody = v.object({
  name: v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120)),
  description: v.optional(v.pipe(v.string(), v.maxLength(2000))),
});
export type ProjectCreateBody = v.InferOutput<typeof ProjectCreateBody>;

export const ProjectPatchBody = v.object({
  name: v.optional(v.pipe(v.string(), v.trim(), v.minLength(1), v.maxLength(120))),
  description: v.optional(v.pipe(v.string(), v.maxLength(2000))),
  /** Pin (or "" to clear) a lard memory project id. */
  lardProject: v.optional(v.pipe(v.string(), v.maxLength(200))),
});
export type ProjectPatchBody = v.InferOutput<typeof ProjectPatchBody>;

export const ProjectAssignBody = v.object({
  /** null → unfile the conversation. */
  projectId: v.nullable(v.pipe(v.string(), v.maxLength(120))),
});
export type ProjectAssignBody = v.InferOutput<typeof ProjectAssignBody>;

/**
 * PATCH /api/models — partial curation update. `displayName: null` clears the
 * override; omitted fields keep their stored value (merge happens in the handler).
 */
/**
 * POST /api/credentials — a user hands kloe their own key for a provider, so
 * their runs spend their own credits rather than the deployment's.
 */
export const CredentialBody = v.object({
  /** "inference" | "search" — validated against the connector registry. */
  service: v.pipe(v.string(), v.minLength(1)),
  providerId: v.pipe(v.string(), v.minLength(1)),
  /**
   * The credential itself: an API key, or the whole credential file for a
   * provider connected by pasting one. The ceiling is generous because a
   * `~/.codex/auth.json` is a few kilobytes of JWTs, and mean enough that the
   * endpoint is not a place to post a novel.
   */
  apiKey: v.pipe(v.string(), v.minLength(8), v.maxLength(20_000)),
});
export type CredentialBody = v.InferOutput<typeof CredentialBody>;

/** POST /api/roles/signout — end every session one person holds. */
export const SignOutBody = v.object({
  sub: v.pipe(v.string(), v.minLength(1)),
});
export type SignOutBody = v.InferOutput<typeof SignOutBody>;

/**
 * PATCH /api/models/mine — arrange your own picker: put a model in it or take
 * it out, rename it, move it. Partial, so the drag handler can send an order
 * without restating everything else.
 */
export const MyModelBody = v.object({
  ref: v.pipe(v.string(), v.minLength(1)),
  enabled: v.optional(v.boolean()),
  displayName: v.optional(v.nullable(v.string())),
  sortOrder: v.optional(v.number()),
});
export type MyModelBody = v.InferOutput<typeof MyModelBody>;

/**
 * POST /api/conversations/:id/publications — put a document behind a public
 * link, or re-point the one it has.
 *
 * `version` is required even for a following link: it is the version the owner
 * was looking at when they pressed the button, which is what makes "publish"
 * mean something definite either way. `mode` defaults to "pinned" because the
 * frozen link is the one that cannot surprise you later.
 */
export const PublishBody = v.object({
  name: v.pipe(v.string(), v.minLength(1), v.maxLength(200)),
  version: v.pipe(v.number(), v.integer(), v.minValue(1)),
  mode: v.optional(v.picklist(["pinned", "latest"]), "pinned"),
});
export type PublishBody = v.InferOutput<typeof PublishBody>;

/**
 * PATCH /api/prefs — deployment preferences set by clicking rather than by
 * editing kloe.json. `null` clears one back to its configured default.
 */
export const PrefsPatchBody = v.record(v.string(), v.nullable(v.string()));
export type PrefsPatchBody = v.InferOutput<typeof PrefsPatchBody>;
