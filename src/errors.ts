export class ParseError extends Error {}

/**
 * What a provider actually said. The AI SDK wraps a non-2xx into an
 * `APICallError` whose `message` is often the endpoint's one-line summary
 * ("Invalid input. Please review your request before trying again.") while the
 * part you need — status, URL, and the endpoint's own JSON — sits on properties
 * that `String(err)` discards. Pull them back out.
 *
 * Duck-typed rather than `instanceof`: a run can cross SDK copies (the provider
 * adapters bundle their own), and a failed diagnostic is worse than a loose one.
 */
export function providerErrorDetail(err: unknown, bodyMax = 2000): string | null {
  const e = err as { url?: unknown; statusCode?: unknown; responseBody?: unknown };
  if (typeof e?.url !== "string" && typeof e?.statusCode !== "number") return null;
  const status = typeof e.statusCode === "number" ? e.statusCode : "?";
  const body = typeof e.responseBody === "string" ? e.responseBody.trim() : "";
  const shown = body.length > bodyMax ? `${body.slice(0, bodyMax)}…` : body;
  return `${status} ${typeof e.url === "string" ? e.url : "?"}${shown ? ` → ${shown}` : ""}`;
}

/**
 * The shape of the request that was rejected: roles, part kinds, and sizes, but
 * none of the content. A 400 is nearly always about shape (an empty text block,
 * a reasoning block from another provider, a tool call without its result), and
 * the shape is small enough to log while the content is not.
 */
export function requestShape(err: unknown): string | null {
  const body = (err as { requestBodyValues?: unknown })?.requestBodyValues;
  if (!body || typeof body !== "object") return null;
  const msgs =
    (body as { messages?: unknown; input?: unknown }).messages ??
    (body as { input?: unknown }).input;
  if (!Array.isArray(msgs)) return null;
  const parts = msgs.map((m) => {
    const role = (m as { role?: unknown }).role ?? (m as { type?: unknown }).type ?? "?";
    const content = (m as { content?: unknown }).content;
    if (typeof content === "string") return `${role}:text(${content.length})`;
    if (Array.isArray(content)) {
      const kinds = content.map((c) => {
        const t = (c as { type?: unknown }).type ?? "?";
        const text = (c as { text?: unknown }).text;
        return typeof text === "string" ? `${t}(${text.length})` : String(t);
      });
      return `${role}:[${kinds.join(",")}]`;
    }
    return String(role);
  });
  return parts.join(" ");
}
