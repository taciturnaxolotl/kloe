import { generateText } from "ai";
import { resolveModel } from "./inference";
import type { Store } from "./store";

/**
 * A short conversation title from the first user message, via a small/cheap
 * model (config `agent.smallModel`). Best-effort — any failure returns null and
 * the caller leaves the title as the truncated first message.
 */

const SYSTEM =
  "You write a short, specific title for a conversation from the user's first message. " +
  "Reply with ONLY the title: 3 to 6 words, no surrounding quotes, no trailing punctuation, " +
  "no preamble or explanation.";

function sanitize(raw: string): string {
  let t = raw.trim().split("\n")[0]!.trim();
  t = t.replace(/^["'`*_]+|["'`*_]+$/g, "").trim(); // strip wrapping quotes/markdown
  t = t.replace(/[.]+$/, "").trim(); // drop a trailing period
  if (t.length > 70) t = t.slice(0, 70).trimEnd() + "…";
  return t;
}

export async function generateTitle(store: Store, conversationId: string, modelRef: string): Promise<string | null> {
  const first = store.firstUserMessage(conversationId);
  if (!first || !first.trim()) return null;
  try {
    const { text } = await generateText({
      model: resolveModel(modelRef),
      system: SYSTEM,
      prompt: first.slice(0, 2000), // enough to title from without feeding a whole essay
      maxOutputTokens: 24,
      temperature: 0.3,
    });
    return sanitize(text) || null;
  } catch (e) {
    console.warn("[title] generation failed:", (e as Error).message);
    return null;
  }
}
