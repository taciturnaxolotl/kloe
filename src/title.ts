import { type JSONValue, streamText } from "ai";
import { providerErrorDetail } from "./errors";
import { getRegistry, resolveModelFor, resolveSmallModel } from "./inference";
import type { Store } from "./store";

// Model selection moved to inference.ts, where the registry lives; re-exported
// here because titling is what it was first for and every caller says so.
export { resolveSmallModel };

/**
 * A short conversation title from the opening exchange, via a small/cheap model
 * (config `agent.smallModel`). Best-effort — any failure returns null and the
 * caller leaves the title as the truncated first message.
 */

const SYSTEM =
  "You write a short, specific title for a conversation from how it opens. " +
  "Reply with ONLY the title: 3 to 6 words, no surrounding quotes, no trailing punctuation, " +
  "no preamble or explanation.";

/**
 * Six words is about ten tokens; the rest of this budget is headroom to think.
 *
 * Reasoning models spend the output budget before the first answer token, and
 * some endpoints reason on everything (Hyper does — see discover.ts). The old
 * 24-token cap was exhausted mid-thought, so the call came back `length` with
 * empty text: no title, no error, nothing in the log.
 */
const MAX_OUTPUT_TOKENS = 1_024;

/** A title is never worth stalling on, and nothing else is waiting on it. */
const TIMEOUT_MS = 20_000;

/** Strip what a small model wraps around the title it was asked for. */
export function sanitize(raw: string): string {
  let t = raw.trim().split("\n")[0]!.trim();
  const unwrap = (s: string) => s.replace(/^["'`*_]+|["'`*_]+$/g, "").trim();
  // Small models like to label their answer, inside or outside the quotes.
  t = unwrap(t).replace(/^title\s*[:–-]\s*/i, "");
  t = unwrap(t).replace(/[.]+$/, "").trim();
  if (t.length > 70) t = t.slice(0, 70).trimEnd() + "…";
  return t;
}

export async function generateTitle(
  store: Store,
  conversationId: string,
  modelRef: string,
  /** Whose credential pays for it — the conversation's owner. */
  sub?: string,
): Promise<string | null> {
  const seed = store.titleSeed(conversationId);
  if (!seed) return null;
  // Whatever the operator tuned for this endpoint (a thinking toggle, an effort
  // level) applies here too — the utility call shouldn't be the one request that
  // ignores the config and runs at the model's own default effort.
  const slash = modelRef.indexOf("/");
  const providerId = slash > 0 ? modelRef.slice(0, slash) : modelRef;
  const providerOptions = getRegistry().getConfig(providerId)?.providerOptions;
  try {
    // streamText, not generateText: a stream-only model (the echo mock, and any
    // endpoint that implements only the streaming half) has no `doGenerate` and
    // threw on every title. Everything that serves chat can stream.
    const result = streamText({
      model: await resolveModelFor(modelRef, { store, sub }),
      system: SYSTEM,
      prompt: seed,
      maxOutputTokens: MAX_OUTPUT_TOKENS,
      abortSignal: AbortSignal.timeout(TIMEOUT_MS),
      // No temperature: some endpoints reject it outright when reasoning is on,
      // and a title doesn't need the knob.
      ...(providerOptions
        ? { providerOptions: { [providerId]: providerOptions as Record<string, JSONValue> } }
        : {}),
    });
    const title = sanitize(await result.text);
    if (title) return title;
    // Empty text is a real outcome (a budget spent on reasoning, a filter), and
    // it used to vanish silently — the caller just saw "no title".
    console.warn(`[title] ${modelRef} produced no title (finish: ${await result.finishReason})`);
    return null;
  } catch (e) {
    // The provider's own words, not just the SDK's summary — a 400 here is
    // otherwise a one-liner that names nothing.
    console.warn("[title] generation failed:", providerErrorDetail(e) ?? (e as Error).message);
    return null;
  }
}
