import { MAX_SSE_FIELD_BYTES } from "./config";

/**
 * Truncates a string to at most n bytes of UTF-8 without splitting multi-byte
 * runes. Keeps one SSE `data:` field bounded.
 */
export function truncateUtf8(s: string, n: number = MAX_SSE_FIELD_BYTES): string {
  const buf = new TextEncoder().encode(s);
  if (buf.byteLength <= n) return s;
  let end = n;
  while (end > 0 && (buf[end]! & 0xc0) === 0x80) end--;
  return new TextDecoder().decode(buf.subarray(0, end));
}

/** A single SSE block: `event` + `id` + JSON `data`, blank-line terminated. */
export function sseBlock(e: { id: string; event: string; data: unknown }): string {
  return `event: ${e.event}\nid: ${e.id}\ndata: ${JSON.stringify(e.data)}\n\n`;
}

/**
 * Wraps a feed of typed events as SSE-formatted strings. The feed must
 * implement the async-iterator protocol with strict sequential `next()` calls
 * (e.g. a ReadableStream's reader guarantees this).
 */
export async function* sseBlocks(
  events: AsyncIterable<{ id: string; event: string; data: unknown }>,
): AsyncGenerator<string> {
  for await (const e of events) {
    yield sseBlock(e);
  }
}
