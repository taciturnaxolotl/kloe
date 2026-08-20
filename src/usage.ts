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
function priceOf(modelRef: string): { in: number; out: number } {
  const [providerId, ...rest] = modelRef.split("/");
  const modelId = rest.join("/");
  try {
    const enabled = getRegistry()
      .listModels()
      .find((m) => m.ref === modelRef);
    if (enabled) return { in: num(enabled.costPer1MIn), out: num(enabled.costPer1MOut) };
  } catch {
    // no registry yet (early boot, tests): the catalog below may still know it
  }
  const model = getCatalog()
    ?.getProvider(providerId ?? "")
    ?.models.find((m) => m.id === modelId);
  return { in: num(model?.costPer1MIn), out: num(model?.costPer1MOut) };
}

/**
 * What a call cost, in dollars.
 *
 * Cached-input pricing is deliberately not applied: nothing on the response
 * tells us reliably how much of the prompt was a cache hit, and a guess that
 * lowers the number is the wrong way to be wrong about a spending limit.
 */
export function costOf(modelRef: string, inputTokens: number, outputTokens: number): number {
  const price = priceOf(modelRef);
  return (inputTokens / 1e6) * price.in + (outputTokens / 1e6) * price.out;
}

/** Who a call is billed to, and where to file it. */
export interface Meter {
  store: Store;
  sub: string;
  payer: UsageEntry["payer"];
  conversationId?: string;
}

function record(meter: Meter, modelRef: string, input: number, output: number): void {
  if (input === 0 && output === 0) return; // the provider told us nothing; nothing to file
  meter.store.recordUsage({
    ts: Date.now(),
    sub: meter.sub,
    payer: meter.payer,
    service: "inference",
    providerId: modelRef.split("/")[0] ?? "",
    modelRef,
    conversationId: meter.conversationId,
    inputTokens: input,
    outputTokens: output,
    costUsd: costOf(modelRef, input, output),
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
        record(meter, modelRef, num(result.usage?.inputTokens), num(result.usage?.outputTokens));
        return result;
      },
      wrapStream: async ({ doStream }) => {
        const { stream, ...rest } = await doStream();
        let input = 0;
        let output = 0;
        return {
          ...rest,
          stream: stream.pipeThrough(
            new TransformStream({
              transform(chunk, controller) {
                const part = chunk as { type?: string; usage?: Record<string, unknown> };
                if (part.type === "finish" && part.usage) {
                  input = num(part.usage.inputTokens);
                  output = num(part.usage.outputTokens);
                }
                controller.enqueue(chunk);
              },
              flush() {
                record(meter, modelRef, input, output);
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
