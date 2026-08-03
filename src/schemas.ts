import * as v from "valibot";

/**
 * Request-body schemas (valibot).
 *
 * `v.object` ignores unknown keys (lenient like the current API);
 * `v.minLength(1)` on `model`/`ref` reproduces the "required, non-empty" rule
 * that returns 422 today.
 */

/** POST /api/conversations/:id/prompt */
export const PromptBody = v.object({
	content: v.string(),
	model: v.pipe(v.string(), v.minLength(1, "model is required")),
	runId: v.optional(v.string()),
});
export type PromptBody = v.InferOutput<typeof PromptBody>;

/** POST /api/conversations/:id/steer */
export const SteerBody = v.object({
	content: v.string(),
	model: v.pipe(v.string(), v.minLength(1, "model is required")),
});
export type SteerBody = v.InferOutput<typeof SteerBody>;

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
