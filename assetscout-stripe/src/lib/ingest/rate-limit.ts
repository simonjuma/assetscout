/**
 * Per-host rate limiting for the ingestion layer.
 *
 * Two independent limits are enforced together, because either alone is rude:
 *   - a token bucket bounding requests per minute
 *   - a minimum interval between consecutive requests (so we never burst)
 *
 * Requests to the same host are serialised through a promise chain, which is what
 * makes the minimum-interval guarantee hold under concurrency. Different hosts
 * are independent.
 *
 * CAVEAT (documented, not hidden): the bucket lives in process memory. On a
 * serverless platform each instance has its own bucket, so the effective limit is
 * `instances × limit`. Ingestion runs are low-volume, operator-triggered and
 * mostly sequential, so this is acceptable — but a high-volume future deployment
 * should move the bucket to a shared store. The CLI (`npm run ingest`) has one
 * process and therefore an exact limit.
 *
 * No I/O and an injectable clock/sleep: fully unit-testable.
 */
export type RateLimitPolicy = {
  maxRequestsPerMinute: number;
  minIntervalMs: number;
};

export type RateLimiterDeps = {
  now: () => number;
  sleep: (ms: number) => Promise<void>;
};

const defaultDeps: RateLimiterDeps = {
  now: () => Date.now(),
  sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
};

type Bucket = {
  tokens: number;
  updatedAt: number;
  lastRequestAt: number;
};

export class RateLimiter {
  private readonly queues = new Map<string, Promise<void>>();
  private readonly buckets = new Map<string, Bucket>();
  private readonly deps: RateLimiterDeps;

  /**
   * `deps` is stored on a normal field rather than a constructor parameter
   * property: parameter properties are non-erasable TypeScript syntax, and this
   * module must stay loadable by `node --test` with type stripping only (no
   * build step), which is how the ingestion suite runs on every platform.
   */
  constructor(deps: RateLimiterDeps = defaultDeps) {
    this.deps = deps;
  }

  /**
   * Waits until a request to `key` (a host) is allowed, then consumes a token.
   * Returns how long it waited, for logging and for tests.
   */
  async acquire(key: string, policy: RateLimitPolicy): Promise<number> {
    const prior = this.queues.get(key) ?? Promise.resolve();
    let releaseCurrent: () => void = () => undefined;
    const current = new Promise<void>((resolve) => {
      releaseCurrent = resolve;
    });
    // Chain BEFORE awaiting, so a second caller queues behind this one.
    const chained = prior.then(() => current);
    this.queues.set(key, chained);

    await prior;
    try {
      return await this.waitForSlot(key, policy);
    } finally {
      releaseCurrent();
      // Drop settled chains so the map cannot grow without bound. A later caller
      // has already replaced the entry, so this only removes our own chain.
      if (this.queues.get(key) === chained) {
        this.queues.delete(key);
      }
    }
  }

  /** Current token count, for the admin diagnostics view and tests. */
  snapshot(key: string): { tokens: number; lastRequestAt: number } | null {
    const bucket = this.buckets.get(key);
    return bucket ? { tokens: bucket.tokens, lastRequestAt: bucket.lastRequestAt } : null;
  }

  private async waitForSlot(key: string, policy: RateLimitPolicy): Promise<number> {
    const now = this.deps.now();
    const rpm = Math.max(1, Math.trunc(policy.maxRequestsPerMinute) || 1);
    const refillPerMs = rpm / 60_000;

    const bucket: Bucket = this.buckets.get(key) ?? {
      tokens: rpm,
      updatedAt: now,
      lastRequestAt: 0,
    };

    // Refill first (capped at burst size = rpm), then decide how long to wait.
    const elapsed = Math.max(0, now - bucket.updatedAt);
    bucket.tokens = Math.min(rpm, bucket.tokens + elapsed * refillPerMs);
    bucket.updatedAt = now;

    const spacingWaitMs = Math.max(0, Math.trunc(policy.minIntervalMs) - (now - bucket.lastRequestAt));
    const tokenWaitMs = bucket.tokens >= 1 ? 0 : Math.ceil((1 - bucket.tokens) / refillPerMs);
    const waitMs = Math.max(spacingWaitMs, tokenWaitMs);

    if (waitMs > 0) {
      await this.deps.sleep(waitMs);
    }

    bucket.tokens = Math.max(0, bucket.tokens - 1);
    // `now()` already includes the sleep when the real clock advanced; the
    // projection keeps the spacing guarantee when a test uses a frozen clock.
    bucket.lastRequestAt = Math.max(this.deps.now(), now + waitMs);
    bucket.updatedAt = bucket.lastRequestAt;
    this.buckets.set(key, bucket);

    return waitMs;
  }
}

/** One shared limiter per process: providers must not each hold their own. */
let shared: RateLimiter | undefined;

export function sharedRateLimiter(): RateLimiter {
  shared ??= new RateLimiter();
  return shared;
}