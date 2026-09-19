/**
 * Shared HTTP envelope for every billing route (API contracts doc §6.1).
 *
 *   ApiOk<T>  = { data: T }
 *   ApiError  = { error: string; details?: unknown }
 *
 * ARCHITECTURE NOTE (why this file is now a thin facade)
 * ------------------------------------------------------
 * This module previously contained the envelope, the redaction rules and the
 * logging in one place, and imported `MissingServerEnvError` from `@/env` just to
 * branch on it. Two problems followed:
 *
 *   1. `@/env` is `server-only`, so nothing here could be unit-tested without a
 *      React Server Component runtime.
 *   2. `unexpectedFailure` returned the SAME response for a misconfiguration and
 *      for a bug, and the raw thrown message was logged without scrubbing — a
 *      Stripe SDK error string can contain an API-key fingerprint.
 *
 * The implementation now lives in two importable, tested modules:
 *   - `src/lib/errors.ts`  → codes, redaction, sanitisation, correlation ids
 *   - `src/lib/http.ts`    → NextResponse builders + the `handleRoute` wrapper
 *
 * Everything that used to be exported from here still is, so no import site had
 * to change.
 */
export {
  BodyTooLargeError,
  ErrorCode,
  InvalidJsonError,
  ProviderError,
  errorCodeValues,
  isRecord,
  logServerError,
  newCorrelationId,
  readJsonBody,
  redactSecrets,
  safeErrorMessage,
  sanitizeProviderError,
  type ApiError,
  type ApiOk,
  type ErrorCodeName,
  type ErrorCodeValue,
  type SanitizedProviderError,
} from '../errors.ts';

export {
  fail,
  forbidden,
  handleRoute,
  invalidRequest,
  methodNotAllowed,
  notFound,
  ok,
  parseJsonBody,
  parseSearchParams,
  rateLimited,
  unauthenticated,
  unexpectedFailure,
  upgradeRequired,
  upstreamFailure,
  type ParseResult,
} from '../http.ts';