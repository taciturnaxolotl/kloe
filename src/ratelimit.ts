import type { LanguageModel } from "ai";
import type { ProviderConfig } from "./providers";

/** The result shape returned by a LanguageModel's `doStream`. */
type StreamResult = { stream: ReadableStream<unknown> } & Record<string, unknown>;

/** The subset of the model surface this limiter intercepts. */
interface StreamingModel {
  doStream(...args: unknown[]): Promise<StreamResult>;
  doGenerate(...args: unknown[]): Promise<unknown>;
}

/**
 * Per-provider rate limiter. Enforces two things the AI SDK doesn't:
 *   - a concurrency cap (semaphore) so a burst of jobs can't stampede a
 *     provider, and
 *   - a minimum interval between request starts (a crude token bucket).
 *
 * It also adapts to 429s: when the wrapped stream errors with a rate-limit
 * response, the min interval is pushed out exponentially (capped), then
 * decays back down over time. The AI SDK still does its own request-level
 * retries; this layer shapes the *load* we present.
 */
export class RateLimiter {
  private active = 0;
  private readonly waiters: Array<() => void> = [];
  private lastStart = 0;
  private minIntervalMs: number;
  private readonly baseIntervalMs: number;
  private readonly maxConcurrency: number;
  private static readonly MAX_INTERVAL_MS = 30_000;
  private static readonly DECAY_MS = 60_000;
  private lastBackoff = 0;

  constructor(config: ProviderConfig) {
    this.maxConcurrency = config.maxConcurrency;
    this.baseIntervalMs = config.minIntervalMs;
    this.minIntervalMs = config.minIntervalMs;
  }

  /** Waits until a slot is free and the min interval has elapsed. */
  async acquire(): Promise<void> {
    // Concurrency gate. Claim a free slot immediately; otherwise wait for
    // release() to hand a permit directly to us. The woken waiter must NOT
    // re-increment `active` — release() keeps the slot counted on its behalf,
    // so there is no microtask gap in which a fresh synchronous acquire()
    // could see a decremented `active` and over-admit past maxConcurrency.
    if (this.active < this.maxConcurrency) {
      this.active++;
    } else {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }

    // Interval gate.
    const now = Date.now();
    const wait = this.lastStart + this.minIntervalMs - now;
    if (wait > 0) await Bun.sleep(wait);
    this.lastStart = Date.now();
  }

  release(): void {
    const next = this.waiters.shift();
    if (next) {
      // Hand our permit straight to the next waiter without touching `active`.
      next();
    } else {
      this.active--;
    }
  }

  /** Called when the provider signals a rate limit (HTTP 429). */
  onRateLimit(): void {
    const now = Date.now();
    // Exponential backoff on repeated 429s within the decay window.
    if (now - this.lastBackoff < RateLimiter.DECAY_MS) {
      this.minIntervalMs = Math.min(
        this.minIntervalMs * 2 || this.baseIntervalMs || 1000,
        RateLimiter.MAX_INTERVAL_MS,
      );
    } else {
      this.minIntervalMs = Math.max(this.baseIntervalMs, 1000);
    }
    this.lastBackoff = now;
  }

  /** Slowly relax the interval back toward the configured baseline. */
  private maybeDecay(): void {
    if (this.minIntervalMs > this.baseIntervalMs) {
      if (Date.now() - this.lastBackoff > RateLimiter.DECAY_MS) {
        this.minIntervalMs = Math.max(this.baseIntervalMs, Math.floor(this.minIntervalMs / 2));
      }
    }
  }

  /**
   * Wraps a LanguageModel so every doStream/doGenerate call is gated by this
   * limiter. The permit is released when the returned stream settles.
   */
  wrap(model: LanguageModel): LanguageModel {
    const limiter = this;
    const wrapStream = (result: StreamResult): StreamResult => {
      const upstream = result.stream;
      const reader = upstream.getReader();
      let released = false;
      const releaseOnce = () => {
        if (released) return;
        released = true;
        limiter.release();
        limiter.maybeDecay();
      };
      // Defensive secondary trigger: if the underlying stream settles (closes
      // or errors) by any path — not just our pull loop — reclaim the permit.
      // The permit is still held for the stream's lifetime; the caller's
      // contract is to drain or cancel the returned stream (streamText does).
      void reader.closed.then(releaseOnce, releaseOnce);
      const stream = new ReadableStream<unknown>({
        async pull(controller) {
          try {
            const { done, value } = await reader.read();
            if (done) {
              controller.close();
              releaseOnce();
            } else {
              controller.enqueue(value);
            }
          } catch (err) {
            if (isRateLimitError(err)) limiter.onRateLimit();
            controller.error(err);
            releaseOnce();
          }
        },
        cancel(reason) {
          releaseOnce();
          return reader.cancel(reason);
        },
      });
      return { ...result, stream };
    };

    return new Proxy(model as object, {
      get(target, prop, receiver) {
        const t = target as unknown as StreamingModel;
        if (prop === "doStream") {
          return async (...args: unknown[]) => {
            await limiter.acquire();
            try {
              const result = await t.doStream(...args);
              return wrapStream(result);
            } catch (err) {
              limiter.release();
              if (isRateLimitError(err)) limiter.onRateLimit();
              throw err;
            }
          };
        }
        if (prop === "doGenerate") {
          return async (...args: unknown[]) => {
            await limiter.acquire();
            try {
              return await t.doGenerate(...args);
            } catch (err) {
              if (isRateLimitError(err)) limiter.onRateLimit();
              throw err;
            } finally {
              limiter.release();
              limiter.maybeDecay();
            }
          };
        }
        return Reflect.get(target, prop, receiver);
      },
    }) as LanguageModel;
  }
}

function isRateLimitError(err: unknown): boolean {
  const e = err as { statusCode?: number; status?: number; data?: { error?: { code?: string } } };
  return (
    e?.statusCode === 429 || e?.status === 429 || e?.data?.error?.code === "rate_limit_exceeded"
  );
}
