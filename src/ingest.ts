/*
 * Feed completed conversations to lard so it can extract facts and consolidate
 * them into memory. A conversation is folded into a lard "session" (user +
 * assistant turns) and pushed to POST /ingest under its OWNER's lard token.
 *
 * Ingest is idempotent (lard upserts by sessionId = the conversation id), so
 * re-sending a grown thread is safe. We only push once a conversation has gone
 * quiet (see the debounce in drive.ts) — a live thread isn't worth extracting
 * from yet, and re-ingesting on every turn would be wasteful.
 */
import { Event } from "./events";
import type { UserMessageData, TextDeltaData } from "./events";
import { ingest, lardConnected, lardEnabled, LOCAL_SUB, type IngestSession, type IngestTurn } from "./lard";
import { getConfig } from "./settings";
import type { Store } from "./store";

const iso = (ms: number): string => new Date(ms).toISOString();

/** Fold a conversation's event log into a lard session, or null if there's
 * nothing worth ingesting (no completed turns). */
export function buildSession(store: Store, conversationId: string): IngestSession | null {
  const events = store.allEventsTimed(conversationId);
  if (!events.length) return null;

  const turns: IngestTurn[] = [];
  let asst = "";
  let asstTs = 0;
  let inAssistant = false;
  for (const e of events) {
    if (e.event === Event.User) {
      const content = (e.data as UserMessageData).content ?? "";
      if (content.trim()) turns.push({ index: turns.length, role: "user", content, ts: iso(e.createdAt) });
    } else if (e.event === Event.MsgStart) {
      inAssistant = true;
      asst = "";
      asstTs = e.createdAt;
    } else if (e.event === Event.TextDelta && inAssistant) {
      asst += (e.data as TextDeltaData).delta ?? "";
    } else if (e.event === Event.MsgEnd) {
      if (inAssistant && asst.trim()) turns.push({ index: turns.length, role: "assistant", content: asst, ts: iso(asstTs) });
      inAssistant = false;
    }
  }
  if (!turns.length) return null;

  return {
    sessionId: conversationId,
    source: "kloe",
    startedAt: iso(events[0]!.createdAt),
    endedAt: iso(events[events.length - 1]!.createdAt),
    turns,
  };
}

/** Push one conversation to lard under its owner's token. Best-effort — a
 * disabled/unconnected/failed ingest is skipped or logged, never thrown. */
export async function ingestConversation(store: Store, conversationId: string): Promise<void> {
  if (!lardEnabled() || getConfig().lard.ingestIdleMs === 0) return;
  const owner = store.getConversationOwner(conversationId) ?? LOCAL_SUB;
  if (!lardConnected(store, owner)) return;
  const session = buildSession(store, conversationId);
  if (!session) return;
  try {
    await ingest(store, owner, [session]);
  } catch (e) {
    console.error("lard ingest:", (e as Error).message);
  }
}
