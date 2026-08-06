import { generateText } from "ai";
import { getRegistry, resolveModel } from "./inference";
import { getConfig } from "./settings";
import type { Store } from "./store";

/** Models the deployment has enabled (visible in the picker). */
function enabledModels(store: Store) {
  const settings = new Map(store.listModelSettings().map((s) => [s.ref, s]));
  return getRegistry()
    .listModels()
    .filter((m) => settings.get(m.ref)?.visible);
}

/**
 * The model for utility work (titles): `agent.smallModel` when it's set AND
 * enabled, otherwise the cheapest enabled model (least in+out cost per 1M) — so
 * a configured ref that no longer exists gracefully falls back. Null only when
 * no model is enabled at all.
 */
export function resolveSmallModel(store: Store): string | null {
  const enabled = enabledModels(store);
  if (!enabled.length) return null;
  const configured = getConfig().agent.smallModel;
  if (configured && enabled.some((m) => m.ref === configured)) return configured;
  return enabled.reduce((a, b) =>
    b.costPer1MIn + b.costPer1MOut < a.costPer1MIn + a.costPer1MOut ? b : a,
  ).ref;
}

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

export async function generateTitle(
  store: Store,
  conversationId: string,
  modelRef: string,
): Promise<string | null> {
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
