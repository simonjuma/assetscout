/**
 * Polite HTTP client for provider adapters.
 *
 * One function owns every outbound request the ingestion layer makes, so the
 * politeness and safety rules cannot be forgotten by an individual provider:
 *
 *   - rate limiting  : shared token bucket + minimum interval per host
 *   - timeouts       : a hard AbortSignal deadline per attempt
 *   - retries        : bounded exponential backoff with jitter, honouring
 *                      `Retry-After` on 429/503
 *   - identification : descriptive User-Agent and `x-assetscout-client` header
 *   - size caps      : a response body can never be read unbounded
 *   - error shape    : failures become `ProviderError` with a machine code and
 *                      an HTTP status — never the upstream body, never a header
 *
 * A provider cannot opt out of the rate limiter: `acquire` is called before
 * every attempt, including retries.
 *
 * No `server-only` import and no global state beyond the shared limiter, so this
 * module is loadable by the CLI and by `node --test`.
 */
import { ProviderError } from '../errors.ts';
import { RateLimiter, sharedRateLimiter } from './rate-limit.ts';
import type { IngestLogger, SourcePolicy } from './types.ts';

export type HttpRequest = {
  /** Provider key, used in the error code and the log scope. */
  provider: string;
  /** Pipeline stage, used in the error code. */
  stage: string;
  url: string;
  method?: 'GET' | 'HEAD';
  headers?: Record<string, string>;
  /** Hard deadline for a single attempt. */
  timeoutMs?: number;
  /** Total attempts, including the first. */
  maxAttempts?: number;
  /** Status codes that are a legitimate answer rather than a failure. */
  acceptStatuses?: readonly number[];
  /**
   * Treat ANY HTTP status as an answer instead of an error.
   *
   * Used by the website probe, where `503` is itself the finding ("the property
   * is down"). Without this the probe would retry a genuinely-broken site and
   * then throw, recording no observation at all.
   */
  acceptAnyStatus?: boolean;
  /** Maximum body size to read, in bytes. */
  maxBodyBytes?: number;
};

export type HttpResponse = {
  status: number;
  ok: boolean;
  /** The requested URL (canonicalized by the caller, echoed for provenance). */
  url: string;
  /** The URL that actually answered, after redirects. */
  finalUrl: string;
  contentType: string | null;
  body: string;
  attempts: number;
  /** Total time spent waiting on the rate limiter, for telemetry. */
  waitedMs: number;
  /** True when the response came from a different host than the request. */
  redirectedCrossHost: boolean;
};

export type HttpDeps = {
  fetchImpl?: typeof fetch;
  limiter?: RateLimiter;
  now?: () => Date;
  /** Injectable sleep so tests never wait in real time. */
  sleep?: (ms: number) => Promise<void>;
};

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_ATTEMPTS = 3;
const DEFAULT_MAX_BODY_BYTES = 1_000_000;
/** Statuses that are worth retrying: transient upstream conditions. */
const RETRYABLE_STATUSES = new Set([408, 425, 429, 500, 502, 503, 504, 522, 524]);

function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return 'invalid';
  }
}

function parseRetryAfter(header: string | null): number | null {
  if (!header) return null;
  const seconds = Number(header.trim());
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, 30_000);
  const date = new Date(header);
  if (!Number.isNaN(date.getTime())) {
    return Math.max(0, Math.min(date.getTime() - Date.now(), 30_000));
  }
  return null;
}

/** Bounded exponential backoff with jitter: 400ms, 800ms, 1600ms (+/- 25%). */
function backoffMs(attempt: number): number {
  const base = 400 * 2 ** (attempt - 1);
  const jitter = base * 0.25 * (Math.random() * 2 - 1);
  return Math.min(Math.round(base + jitter), 8_000);
}

function providerError(
  request: HttpRequest,
  code: string,
  message: string,
  httpStatus: number | null = null,
): ProviderError {
  return new ProviderError({
    provider: request.provider,
    stage: request.stage,
    code,
    message,
    httpStatus,
  });
}

/**
 * Reads a response body with a byte cap.
 * Uses the raw stream so an oversized body is abandoned instead of buffered.
 */
async function readCapped(response: Response, maxBytes: number): Promise<string> {
  const body = response.body;
  if (!body) return '';

  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8', { fatal: false });
  let received = 0;
  let text = '';

  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      if (!value) continue;
      received += value.byteLength;
      if (received > maxBytes) {
        await reader.cancel();
        text += decoder.decode(value, { stream: true });
        break;
      }
      text += decoder.decode(value, { stream: true });
    }
  } finally {
    text += decoder.decode();
  }
  return text;
}
export type PoliteFetch = (request: HttpRequest) => Promise<HttpResponse>;

/**
 * Builds the polite fetcher.
 *
 * Every provider receives one of these through `ProviderDeps.fetchImpl`, so a
 * test can inject a deterministic fake while production always goes through the
 * rate limiter.
 */
export function createPoliteFetch(policy: SourcePolicy, logger: IngestLogger, deps: HttpDeps = {}): PoliteFetch {
  const doFetch = deps.fetchImpl ?? globalThis.fetch;
  const limiter = deps.limiter ?? sharedRateLimiter();
  const sleep = deps.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));

  return async function politeFetch(request: HttpRequest): Promise<HttpResponse> {
    const maxAttempts = Math.max(1, request.maxAttempts ?? DEFAULT_MAX_ATTEMPTS);
    const timeoutMs = Math.max(500, request.timeoutMs ?? DEFAULT_TIMEOUT_MS);
    const maxBodyBytes = Math.max(1024, request.maxBodyBytes ?? DEFAULT_MAX_BODY_BYTES);
    const acceptStatuses = request.acceptStatuses ?? [];
    const method = request.method ?? 'GET';
    const host = hostOf(request.url);

    let waitedMs = 0;
    let lastCode = 'request_failed';
    let lastStatus: number | null = null;
    let lastMessage = 'request failed';

    for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
      waitedMs += await limiter.acquire(host, {
        maxRequestsPerMinute: policy.maxRequestsPerMinute,
        minIntervalMs: policy.minIntervalMs,
      });

      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);

      try {
        const response = await doFetch(request.url, {
          method,
          redirect: 'follow',
          signal: controller.signal,
          headers: {
            // Descriptive identification is part of using a public source
            // politely: it tells the operator who is calling and how to reach us.
            'user-agent': policy.userAgent,
            accept: 'application/json, text/plain;q=0.9, */*;q=0.1',
            'accept-language': 'en',
            'x-assetscout-client': policy.key,
            ...request.headers,
          },
        });

        const contentType = response.headers.get('content-type');
        const status = response.status;
        const answered = response.ok || acceptStatuses.includes(status) || request.acceptAnyStatus === true;

        if (answered) {
          const body = await readCapped(response, maxBodyBytes);
          let finalUrl = request.url;
          let redirectedCrossHost = false;
          try {
            // `Response.url` is empty for a synthesized response (tests); fall
            // back to the requested URL rather than reporting a redirect.
            if (response.url.length > 0) {
              finalUrl = response.url;
              redirectedCrossHost = hostOf(finalUrl) !== host;
            }
          } catch {
            redirectedCrossHost = false;
          }

          return {
            status,
            ok: response.ok,
            url: request.url,
            finalUrl,
            contentType,
            body,
            attempts: attempt,
            waitedMs,
            redirectedCrossHost,
          };
        }

        lastStatus = status;
        lastCode = `http_${status}`;
        // The upstream body is deliberately NOT included: it can echo the
        // request (headers, keys) and is never safe to log or persist raw.
        lastMessage = `upstream responded ${status}`;

        if (!RETRYABLE_STATUSES.has(status) || attempt === maxAttempts) {
          throw providerError(request, lastCode, lastMessage, status);
        }

        const retryAfter = parseRetryAfter(response.headers.get('retry-after'));
        logger.warn('http.retry', {
          url: request.url,
          status,
          attempt,
          reason: 'retryable_status',
        });
        await sleep(retryAfter ?? backoffMs(attempt));
      } catch (error) {
        if (error instanceof ProviderError) throw error;

        const aborted =
          error instanceof Error && (error.name === 'AbortError' || error.name === 'TimeoutError');
        lastCode = aborted ? 'timeout' : 'network_error';
        lastMessage = aborted ? `request timed out after ${timeoutMs}ms` : 'request failed';

        if (attempt === maxAttempts) {
          throw providerError(request, lastCode, lastMessage, null);
        }

        logger.warn('http.retry', {
          url: request.url,
          attempt,
          reason: lastCode,
        });
        await sleep(backoffMs(attempt));
        continue;
      } finally {
        clearTimeout(timer);
      }
    }

    // Unreachable: the loop either returns or throws. Kept so the function is
    // total under `noImplicitReturns`-style review.
    throw providerError(request, lastCode, lastMessage, lastStatus);
  };
}

/**
 * Runs a bounded worker pool over `items`.
 *
 * Providers use this to overlap slow registry lookups without ever exceeding the
 * per-host request budget: the shared limiter still serialises each host.
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  worker: (item: T, index: number) => Promise<R>,
): Promise<R[]> {
  const limit = Math.max(1, Math.trunc(concurrency));
  const results: R[] = new Array<R>(items.length);
  let next = 0;

  const runners = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const index = next;
      next += 1;
      if (index >= items.length) return;
      const item = items[index];
      if (item === undefined) return;
      results[index] = await worker(item, index);
    }
  });

  await Promise.all(runners);
  return results;
}
