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

/** POST /api/conversations/:id/prompt */
export const PromptBody = v.object({
  content: v.string(),
  model: v.pipe(v.string(), v.minLength(1, "model is required")),
  runId: v.optional(v.string()),
  attachments: v.optional(v.array(Attachment)),
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
export const ModelPatchBody = v.object({
  ref: v.pipe(v.string(), v.minLength(1)),
  visible: v.optional(v.boolean()),
  displayName: v.optional(v.nullable(v.string())),
  sortOrder: v.optional(v.number()),
});
export type ModelPatchBody = v.InferOutput<typeof ModelPatchBody>;

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
