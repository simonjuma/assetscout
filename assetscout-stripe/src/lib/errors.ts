/**
 * AssetScout — canonical error, logging and redaction core.
 *
 * This module is deliberately **isomorphic and dependency-free** (no
 * `next/server`, no `server-only`) so that:
 *   - the HTTP layer (`src/lib/http.ts`) can build responses from it,
 *   - `src/lib/billing/errors.ts` can re-export it without pulling Next into
 *     non-route code,
 *   - `node --test tests/` can exercise redaction and sanitisation directly.
 *
 * Guarantees enforced here (the security boundary for every API response):
 *   1. Provider/third-party error text is never returned to a client.
 *   2. Credentials are stripped from anything that reaches a log or the database
 *      (`redactSecrets`).
 *   3. Every server-side failure is logged with a correlation id that IS safe to
 *      return, so a user's report can be matched to a log line.
 */

export type ApiError = { error: string; details?: unknown };
export type ApiOk<T> = { data: T };

/** The exact error codes the API contract promises clients. Keep this list closed. */
export const ErrorCode = {
  unauthenticated: 'unauthenticated',
  forbidden: 'forbidden',
  invalidRequest: 'invalid_request',
  notFound: 'not_found',
  methodNotAllowed: 'method_not_allowed',
  rateLimited: 'rate_limited',
  planUpgradeRequired: 'plan_upgrade_required',
  planNotPurchasable: 'plan_not_purchasable',
  subscriptionExists: 'subscription_exists',
  noBillingAccount: 'no_billing_account',
  stripeUnavailable: 'stripe_unavailable',
  invalidSignature: 'invalid_signature',
  providerUnavailable: 'provider_unavailable',
  serverError: 'server_error',
} as const;

export type ErrorCodeName = keyof typeof ErrorCode;

/**
 * The wire values of `ErrorCode` (e.g. `'unauthenticated'`).
 *
 * The object above is keyed in camelCase for ergonomic use in code
 * (`ErrorCode.stripeUnavailable`) while the values are the snake_case strings
 * promised to clients. Anything that carries an error code on the wire — logs,
 * database rows, response bodies — is typed with THIS alias, not `ErrorCodeName`
 * (the key), so a literal like `'stripe_unavailable'` is assignable and the
 * compiler still rejects an unknown code.
 */
export type ErrorCodeValue = (typeof ErrorCode)[ErrorCodeName];

/** Every wire error code, for exhaustiveness checks and tests. */
export const errorCodeValues: readonly ErrorCodeValue[] = Object.values(ErrorCode);

export class BodyTooLargeError extends Error {
  constructor() {
    super('Request body exceeded the maximum allowed size');
    this.name = 'BodyTooLargeError';
  }
}

export class InvalidJsonError extends Error {
  constructor() {
    super('Request body was not valid JSON');
    this.name = 'InvalidJsonError';
  }
}

/** Raised by an ingestion provider when an upstream source cannot be used. */
export class ProviderError extends Error {
  readonly provider: string;
  readonly stage: string;
  readonly httpStatus: number | null;
  /** Safe-to-log code, e.g. `http_429` or `timeout`. Never provider prose. */
  readonly code: string;

  constructor(init: {
    provider: string;
    stage: string;
    code: string;
    message: string;
    httpStatus?: number | null;
  }) {
    super(init.message);
    this.name = 'ProviderError';
    this.provider = init.provider;
    this.stage = init.stage;
    this.code = init.code;
    this.httpStatus = init.httpStatus ?? null;
  }
}

/** A new correlation id. Uses WebCrypto so it works in Node and on the edge. */
export function newCorrelationId(): string {
  return globalThis.crypto.randomUUID();
}

/**
 * Environment variable names whose VALUES must never be logged or stored.
 *
 * Matched by name rather than by value pattern because patterns are incomplete:
 * a new credential format must not silently become loggable. The value lookup is
 * lazy (inside the function) so a test can set an env var and assert redaction
 * without ordering constraints.
 */
const SECRET_ENV_NAMES = [
  'STRIPE_SECRET_KEY',
  'STRIPE_WEBHOOK_SECRET',
  'SUPABASE_SERVICE_ROLE_KEY',
  'NEXT_PUBLIC_SUPABASE_ANON_KEY',
  'NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY',
  'COMPANIES_HOUSE_API_KEY',
  'CRON_SECRET',
] as const;

/**
 * Value patterns that identify credentials by shape. Each replacement keeps a
 * short prefix so a log reader can still tell *which kind* of secret leaked.
 */
const SECRET_PATTERNS: ReadonlyArray<readonly [RegExp, string]> = [
  [/(sk|rk)_(test|live)_[A-Za-z0-9]{4,}/g, '$1_$2_[redacted]'],
  [/whsec_[A-Za-z0-9]{4,}/g, 'whsec_[redacted]'],
  [/\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}\b/g, '[redacted-jwt]'],
  [/\b(?:postgres|postgresql):\/\/[^\s:@/]+:[^\s@/]+@/gi, 'postgres://[redacted]@'],
  [/\bBearer\s+[A-Za-z0-9._~+/=-]{8,}/gi, 'Bearer [redacted]'],
  [
    /(["']?(?:api[_-]?key|apikey|access[_-]?token|token|password|secret)["']?\s*[:=]\s*)["']?[A-Za-z0-9._~+/=-]{6,}["']?/gi,
    '$1[redacted]',
  ],
];

/** Collapses whitespace and caps length so one log line stays readable. */
function condense(input: string, maxLength = 600): string {
  const flat = input.replace(/\s+/g, ' ').trim();
  return flat.length > maxLength ? `${flat.slice(0, maxLength)}…[truncated]` : flat;
}

/**
 * Removes credentials from free text. Use for ANY untrusted string that could be
 * logged or persisted (provider messages, URLs with query tokens, headers).
 */
export function redactSecrets(input: string, maxLength = 600): string {
  let output = input;
  for (const [pattern, replacement] of SECRET_PATTERNS) {
    output = output.replace(pattern, replacement);
  }
  for (const name of SECRET_ENV_NAMES) {
    const value = process.env[name];
    // Length guard avoids replacing every occurrence of a one-character value.
    if (typeof value === 'string' && value.length >= 8) {
      output = output.split(value).join(`[redacted:${name}]`);
    }
  }
  return condense(output, maxLength);
}

/**
 * Message from any thrown value, sanitised and safe to persist or log.
 * Stack traces are NOT included here; they are attached to the console log only.
 */
export function safeErrorMessage(error: unknown): string {
  if (error instanceof ProviderError) {
    return redactSecrets(`[${error.provider}:${error.code}] ${error.message}`);
  }
  if (error instanceof Error) {
    return redactSecrets(error.message);
  }
  if (typeof error === 'string') {
    return redactSecrets(error);
  }
  try {
    return redactSecrets(JSON.stringify(error));
  } catch {
    return '[unserialisable error]';
  }
}

export type SanitizedProviderError = {
  /** Stable machine code for the client and for tests. */
  code: ErrorCodeValue;
  /** Which third party failed, when known. Never a message or credential. */
  provider: string | null;
  httpStatus: number | null;
  correlationId: string;
};

/**
 * Classifies a thrown value into a client-safe shape.
 *
 * Stripe and other SDKs attach their own message, type and code to thrown errors.
 * None of that is forwarded: it can contain the request id, the API key
 * fingerprint or internal account details.
 */
export function sanitizeProviderError(error: unknown, providerHint?: string): SanitizedProviderError {
  const correlationId = newCorrelationId();
  let provider = providerHint ?? null;
  let httpStatus: number | null = null;
  let isStripeLike = false;

  if (error && typeof error === 'object') {
    const candidate = error as {
      type?: unknown;
      requestId?: unknown;
      statusCode?: unknown;
    };
    if (typeof candidate.requestId === 'string') {
      isStripeLike = true;
      provider = provider ?? 'stripe';
    }
    if (typeof candidate.type === 'string' && candidate.type.startsWith('Stripe')) {
      isStripeLike = true;
      provider = provider ?? 'stripe';
    }
    if (typeof candidate.statusCode === 'number') {
      httpStatus = candidate.statusCode;
    }
  }

  if (isStripeLike) {
    return { code: ErrorCode.stripeUnavailable, provider: 'stripe', httpStatus, correlationId };
  }
  if (error instanceof ProviderError) {
    return {
      code: ErrorCode.providerUnavailable,
      provider: error.provider,
      httpStatus: error.httpStatus,
      correlationId,
    };
  }
  return { code: ErrorCode.serverError, provider, httpStatus, correlationId };
}

/**
 * Logs a server-side failure and returns the correlation id.
 *
 * `console.error` is deliberate: it lands in the platform log stream (Vercel,
 * CloudWatch, Docker) with no extra dependency. Only the sanitised message and
 * the stack are logged — never a request body and never a response body.
 */
export function logServerError(scope: string, error: unknown): string {
  const correlationId = newCorrelationId();
  const message = safeErrorMessage(error);
  const stack = error instanceof Error && typeof error.stack === 'string'
    ? redactSecrets(error.stack, 2000)
    : '';
  console.error(`[assetscout:${scope}] correlationId=${correlationId} ${message}`, stack);
  return correlationId;
}

/**
 * Reads a JSON request body with a hard size cap, and never logs the body.
 * API payloads in this app are tiny; anything large is hostile or a bug.
 *
 * The size check happens on the raw text length BEFORE parsing, so a hostile body
 * cannot force a large allocation inside JSON.parse.
 */
export async function readJsonBody(req: Request, maxBytes = 4096): Promise<unknown> {
  const text = await req.text();
  if (text.length > maxBytes) {
    throw new BodyTooLargeError();
  }
  if (text.trim().length === 0) return {};
  try {
    return JSON.parse(text) as unknown;
  } catch {
    throw new InvalidJsonError();
  }
}

/** True when a value is a plain object (not null, not an array). */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}