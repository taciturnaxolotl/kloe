import { tool, jsonSchema, type ToolSet } from "ai";

/**
 * The tool registry. Each entry is an AI SDK `tool` with an input schema and an
 * `execute`; `streamText` runs the agentic loop (call → execute → feed back),
 * and the actor persists each tool-call/tool-result as a durable event that the
 * UI renders as a timeline step.
 *
 * First slice: read-only, side-effect-free tools only, executed in-process. The
 * durable-loop guarantee (persist a result before the model sees it, so a job
 * reclaim doesn't re-run a side-effecting tool) and the sandbox executor come
 * with dangerous tools later — pure tools are safe to re-run on reclaim.
 */

const getTime = tool({
  description:
    "Get the current date and time. Optionally in a specific IANA timezone " +
    "(e.g. 'America/New_York', 'Europe/London'); defaults to the server's zone.",
  inputSchema: jsonSchema<{ timezone?: string }>({
    type: "object",
    properties: {
      timezone: { type: "string", description: "IANA timezone name, e.g. Asia/Tokyo" },
    },
    additionalProperties: false,
  }),
  execute: async ({ timezone }) => {
    const now = new Date();
    try {
      const fmt = new Intl.DateTimeFormat("en-US", {
        dateStyle: "full",
        timeStyle: "long",
        timeZone: timezone || undefined,
      });
      return {
        iso: now.toISOString(),
        formatted: fmt.format(now),
        timezone: timezone || Intl.DateTimeFormat().resolvedOptions().timeZone,
      };
    } catch {
      return { iso: now.toISOString(), error: `invalid timezone: ${timezone}` };
    }
  },
});

/** The tools available to a run. Empty → no tools passed to the provider. */
export function toolSet(): ToolSet {
  return { get_time: getTime };
}
