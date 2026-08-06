import type { StandardSchemaV1 } from "@standard-schema/spec";

/**
 * Framework-agnostic request-body validation, built on the Standard Schema
 * interface (implemented by valibot, zod v4, arktype, typebox...). Nothing here
 * imports valibot directly — swapping validators never touches this file.
 *
 * Designed for Bun's per-method route handlers (`{ POST: withBody(Schema, fn) }`),
 * which already give method dispatch, `req.params`, and automatic 405s — so all
 * that's left is shaping + typing the JSON body, which is what this does.
 */

export type Validated<T> =
  | { ok: true; value: T }
  | { ok: false; status: number; error: string; issues: readonly StandardSchemaV1.Issue[] };

/** Validate an already-parsed value against a schema. 422 with issues on failure. */
export async function validate<S extends StandardSchemaV1>(
  schema: S,
  input: unknown,
): Promise<Validated<StandardSchemaV1.InferOutput<S>>> {
  let result = schema["~standard"].validate(input);
  if (result instanceof Promise) result = await result;
  if (result.issues) {
    return { ok: false, status: 422, error: "validation failed", issues: result.issues };
  }
  return { ok: true, value: result.value };
}

/** The minimal request surface we need: a JSON body reader. */
interface JsonRequest {
  json(): Promise<unknown>;
}

/**
 * Wraps a route handler so the JSON body is read and validated first: 400 on
 * unparseable JSON, 422 (with Standard Schema issues) on a shape mismatch, and
 * only then the handler runs with fully-typed, validated data. `req` is passed
 * through untouched so the handler still sees `req.params`, headers, etc.
 */
export function withBody<S extends StandardSchemaV1, R extends JsonRequest>(
  schema: S,
  handler: (data: StandardSchemaV1.InferOutput<S>, req: R) => Response | Promise<Response>,
): (req: R) => Promise<Response> {
  return async (req) => {
    let raw: unknown;
    try {
      raw = await req.json();
    } catch {
      return Response.json({ error: "invalid JSON body" }, { status: 400 });
    }
    const result = await validate(schema, raw);
    if (!result.ok) {
      return Response.json(
        { error: result.error, issues: result.issues },
        { status: result.status },
      );
    }
    return handler(result.value, req);
  };
}
