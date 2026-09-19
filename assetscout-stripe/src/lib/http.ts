/**
 * AssetScout — HTTP response layer for route handlers.
 *
 * Every API route returns one of two shapes, and nothing else:
 *   ApiOk<T>  = { data: T }
 *   ApiError  = { error: string; details?: unknown }
 *
 * `handleRoute()` is the single place that turns a thrown error into a response,
 * so an unexpected failure can never leak a stack trace, a provider message, a
 * database error or a credential. The only diagnostic that crosses the boundary
 * is a correlation id, which is also written to the server log.
 */
import { NextResponse } from 'next/server';
import type { z } from 'zod';
import {
  BodyTooLargeError,
  ErrorCode,
  InvalidJsonError,
  logServerError,
  readJsonBody,
  sanitizeProviderError,
  type ApiError,
  type ApiOk,
} from './errors.ts';

export { ErrorCode } from './errors.ts';
export type { ApiError, ApiOk } from './errors.ts';

export function ok<T>(data: T, init?: { status?: number; headers?: HeadersInit }): NextResponse<ApiOk<T>> {
  return NextResponse.json<ApiOk<T>>(
    { data },
    { status: init?.status ?? 200, headers: init?.headers },
  );
}

export function fail(
  status: number,
  error: string,
  details?: unknown,
  headers?: HeadersInit,
): NextResponse<ApiError> {
  const body: ApiError = details === undefined ? { error } : { error, details };
  return NextResponse.json<ApiError>(body, { status, headers });
}

export function unauthenticated(): NextResponse<ApiError> {
  return fail(401, ErrorCode.unauthenticated);
}

export function forbidden(): NextResponse<ApiError> {
  return fail(403, ErrorCode.forbidden);
}

export function notFound(what = 'resource'): NextResponse<ApiError> {
  return fail(404, ErrorCode.notFound, { resource: what });
}

export function methodNotAllowed(allowed: string[]): NextResponse<ApiError> {
  return fail(405, ErrorCode.methodNotAllowed, { allowed }, { Allow: allowed.join(', ') });
}

export function invalidRequest(details: unknown): NextResponse<ApiError> {
  return fail(400, ErrorCode.invalidRequest, details);
}

/**
 * 402 with the exact missing feature key, so the UI can render a targeted
 * upgrade prompt instead of a generic error (contracts §8.1 rule 4).
 */
export function upgradeRequired(requiredFeature: string, extra?: Record<string, unknown>) {
  return fail(402, ErrorCode.planUpgradeRequired, { requiredFeature, ...extra });
}

export function rateLimited(retryAfterSeconds: number): NextResponse<ApiError> {
  return fail(
    429,
    ErrorCode.rateLimited,
    { retryAfterSeconds },
    { 'Retry-After': String(Math.max(1, Math.ceil(retryAfterSeconds))) },
  );
}

/**
 * 502 for a third-party failure. The provider message stays in the log; the
 * client gets a code plus the correlation id.
 */
export function upstreamFailure(scope: string, error: unknown): NextResponse<ApiError> {
  const sanitized = sanitizeProviderError(error);
  console.error(
    `[assetscout:${scope}] correlationId=${sanitized.correlationId} provider=${sanitized.provider ?? 'unknown'} code=${sanitized.code}`,
    error instanceof Error ? error.message : String(error),
  );
  return fail(502, sanitized.code, { correlationId: sanitized.correlationId });
}

/** 500 for an unexpected failure. Nothing but a correlation id is returned. */
export function unexpectedFailure(scope: string, error: unknown): NextResponse<ApiError> {
  const correlationId = logServerError(scope, error);
  return fail(500, ErrorCode.serverError, { correlationId });
}

/**
 * Wraps a route handler so every thrown error becomes a correct, sanitised
 * response. Body/JSON problems map to 400; everything else to 500 (or 502 when
 * the error came from a third-party SDK).
 */
export function handleRoute<T>(
  scope: string,
  handler: () => Promise<NextResponse<T>>,
): Promise<NextResponse<T> | NextResponse<ApiError>> {
  return handler().catch((error: unknown) => {
    if (error instanceof BodyTooLargeError || error instanceof InvalidJsonError) {
      return invalidRequest({ reason: error.name });
    }
    const sanitized = sanitizeProviderError(error);
    if (sanitized.code === ErrorCode.stripeUnavailable) {
      return upstreamFailure(scope, error);
    }
    return unexpectedFailure(scope, error);
  });
}

export type ParseResult<T> = { ok: true; data: T } | { ok: false; response: NextResponse<ApiError> };

/** Reads + strict-validates a JSON body. Unknown keys are rejected by `.strict()`. */
export async function parseJsonBody<T>(
  req: Request,
  schema: z.ZodType<T>,
  maxBytes = 4096,
): Promise<ParseResult<T>> {
  const raw = await readJsonBody(req, maxBytes);
  const parsed = schema.safeParse(raw);
  if (!parsed.success) {
    // Zod issues contain no secrets: they describe the caller's own payload.
    return { ok: false, response: invalidRequest({ issues: parsed.error.issues }) };
  }
  return { ok: true, data: parsed.data };
}

/** Validates `searchParams` against a schema. Used by every GET route. */
export function parseSearchParams<T>(req: Request, schema: z.ZodType<T>): ParseResult<T> {
  const params = Object.fromEntries(new URL(req.url).searchParams.entries());
  const parsed = schema.safeParse(params);
  if (!parsed.success) {
    return { ok: false, response: invalidRequest({ issues: parsed.error.issues }) };
  }
  return { ok: true, data: parsed.data };
}