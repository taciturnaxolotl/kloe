import { type LanguageModel, wrapLanguageModel } from "ai";
import { policyFor, type Role } from "./auth";
import { getCatalog, getRegistry } from "./inference";
import type { Store, UsageEntry } from "./store";

/**
 * What a run costs, and who may keep spending.
 *
 * Two halves of one idea. The ledger records every provider call with a price
 * attached, and a budget reads that ledger back to decide whether a role has
 * spent enough for one day. Both hang off `payer`: a call on someone's own
 * connected account is recorded but never counted against a budget, because a
 * budget bounds what the operator pays for and nothing else.
 *
 * Metering happens at the model, not at the turn. A turn with three tool steps
 * is three calls, a research run is a lead plus its workers, and a title is a
 * fourth model nobody picked — measuring at the model catches all of it, where
 * measuring at the turn would quietly miss most of what a busy run spends.
 */

/** The rolling window a budget is measured over. Not a calendar day: no timezone to argue with. */
export const DAY_MS = 86_400_000;

const num = (n: unknown): number => (typeof n === "number" && Number.isFinite(n) ? n : 0);

/** Per-million prices for a ref, from wherever the ref is known. */
function priceOf(modelRef: string): { in: number; inCached: number; out: number } {
  const [providerId, ...rest] = modelRef.split("/");
  const modelId = rest.join("/");
  try {
    const enabled = getRegistry()
      .listModels()
      .find((m) => m.ref === modelRef);
    if (enabled) {
      // The registry's view carries no cached price; the catalog underneath
      // does, so fall through to it for that one number.
      const cached = getCatalog()?.getModel(providerId ?? "", modelId);
      return {
        in: num(enabled.costPer1MIn),
        inCached: num(cached?.costPer1MInCached),
        out: num(enabled.costPer1MOut),
      };
    }
  } catch {
    // no registry yet (early boot, tests): the catalog below may still know it
  }
  const model = getCatalog()
    ?.getProvider(providerId ?? "")
    ?.models.find((m) => m.id === modelId);
  return {
    in: num(model?.costPer1MIn),
    inCached: num(model?.costPer1MInCached),
    out: num(model?.costPer1MOut),
  };
}

/**
 * What a call cost, in dollars.
 *
 * Cache reads are charged at the cached rate only when the catalog names one.
 * A provider that reports a cache hit against a catalogue with no cached price
 * is charged the full rate instead of nothing: understating a number a budget
 * is measured against is the wrong way to be wrong.
 */
export function costOf(
  modelRef: string,
  inputTokens: number,
  outputTokens: number,
  cachedInputTokens = 0,
): number {
  const price = priceOf(modelRef);
  const cachedRate = price.inCached > 0 ? price.inCached : price.in;
  return (
    (inputTokens / 1e6) * price.in +
    (cachedInputTokens / 1e6) * cachedRate +
    (outputTokens / 1e6) * price.out
  );
}

/**
 * The token counts on a response, whichever shape they arrive in.
 *
 * The SDK's current spec reports each figure as an object — `{total, noCache,
 * cacheRead}` for input, `{total, text, reasoning}` for output — where older
 * ones (and kloe's own echo model) report a plain number. Reading only the
 * number is how this shipped recording nothing at all: every real adapter sends
 * the object, and an object coerces to zero without complaining.
 */
export function countUsage(usage: unknown): {
  input: number;
  cachedInput: number;
  output: number;
} {
  const u = (usage ?? {}) as { inputTokens?: unknown; outputTokens?: unknown };
  const inp = u.inputTokens as { total?: unknown; noCache?: unknown; cacheRead?: unknown };
  const out = u.outputTokens as { total?: unknown };
  if (typeof u.inputTokens === "number" || typeof u.outputTokens === "number") {
    return { input: num(u.inputTokens), cachedInput: 0, output: num(u.outputTokens) };
  }
  const cached = num(inp?.cacheRead);
  // `noCache` when it's there, else back out the cache read from the total —
  // the two must not be added together, they overlap.
  const fresh =
    inp?.noCache !== undefined ? num(inp.noCache) : Math.max(0, num(inp?.total) - cached);
  return { input: fresh, cachedInput: cached, output: num(out?.total) };
}

/** Who a call is billed to, and where to file it. */
export interface Meter {
  store: Store;
  sub: string;
  payer: UsageEntry["payer"];
  conversationId?: string;
}

function record(meter: Meter, modelRef: string, usage: unknown): void {
  const { input, cachedInput, output } = countUsage(usage);
  // The provider told us nothing; there is nothing to file.
  if (input === 0 && cachedInput === 0 && output === 0) return;
  meter.store.recordUsage({
    ts: Date.now(),
    sub: meter.sub,
    payer: meter.payer,
    service: "inference",
    providerId: modelRef.split("/")[0] ?? "",
    modelRef,
    conversationId: meter.conversationId,
    // The whole prompt, cache hits included — that is the number a person
    // recognizes. What each part cost is already settled in cost_usd.
    inputTokens: input + cachedInput,
    outputTokens: output,
    costUsd: costOf(modelRef, input, output, cachedInput),
  });
}

/**
 * Wrap a model so every call it serves lands in the ledger.
 *
 * The stream case files its row when the stream drains rather than when the
 * `finish` part arrives, so a turn the user cancels mid-sentence still records
 * what it had spent by then — the provider charged for it either way.
 */
export function metered(model: LanguageModel, modelRef: string, meter: Meter): LanguageModel {
  return wrapLanguageModel({
    // `LanguageModel` includes the string form (a ref the SDK resolves itself);
    // everything kloe resolves is already an instance, and only an instance can
    // be wrapped.
    model: model as Exclude<LanguageModel, string>,
    middleware: {
      wrapGenerate: async ({ doGenerate }) => {
        const result = await doGenerate();
        record(meter, modelRef, result.usage);
        return result;
      },
      wrapStream: async ({ doStream }) => {
        const { stream, ...rest } = await doStream();
        let usage: unknown;
        return {
          ...rest,
          stream: stream.pipeThrough(
            new TransformStream({
              transform(chunk, controller) {
                const part = chunk as { type?: string; usage?: unknown };
                if (part.type === "finish" && part.usage) usage = part.usage;
                controller.enqueue(chunk);
              },
              flush() {
                record(meter, modelRef, usage);
              },
            }),
          ),
        };
      },
    },
  });
}

/** What a role may spend of the instance's credits in a day. 0 means no bound. */
export interface Budget {
  usdPerDay: number;
  tokensPerDay: number;
}

export function budgetFor(role: Role): Budget {
  const policy = policyFor(role);
  return { usdPerDay: policy.usdPerDay, tokensPerDay: policy.tokensPerDay };
}

export interface BudgetStatus {
  /** True when this person may still start work on the instance's credits. */
  ok: boolean;
  /** Why not, in words a person can act on. */
  reason?: string;
  spentUsd: number;
  spentTokens: number;
  budget: Budget;
  /** When the window rolls far enough for them to continue. */
  resetsAt?: number;
}

/**
 * Where this person stands against their role's budget.
 *
 * Checked when a run starts, not while it runs. A turn already in flight
 * finishes and is billed in full — stopping mid-sentence would waste what was
 * already spent to save the tail of one answer.
 */
export function budgetStatus(store: Store, sub: string, role: Role): BudgetStatus {
  const budget = budgetFor(role);
  const since = Date.now() - DAY_MS;
  const spent = store.spentSince(sub, since);
  const out: BudgetStatus = {
    ok: true,
    spentUsd: spent.costUsd,
    spentTokens: spent.tokens,
    budget,
  };
  if (budget.usdPerDay > 0 && spent.costUsd >= budget.usdPerDay) {
    out.ok = false;
    out.reason = `daily limit of $${budget.usdPerDay.toFixed(2)} reached`;
  } else if (budget.tokensPerDay > 0 && spent.tokens >= budget.tokensPerDay) {
    out.ok = false;
    out.reason = `daily limit of ${budget.tokensPerDay.toLocaleString("en-US")} tokens reached`;
  }
  if (!out.ok) out.resetsAt = since + DAY_MS;
  return out;
}
