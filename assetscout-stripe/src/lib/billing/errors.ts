/**
 * Shared HTTP envelope for every billing route (API contracts doc §6.1).
 *
 *   ApiOk<T>  = { data: T }
 *   ApiError  = { error: string; details?: unknown }
 *
 * Guarantees provided here:
 *  - Stripe/provider errors are NEVER echoed to the caller.
 *  - Every server-side failure is logged with a correlation id that IS returned
 *    to the client, so a user's bug report can be matched to a server log line
 *    without leaking internals.
 */
import { NextResponse } from 'next/server';
import { MissingServerEnvError } from '@/env';

export type ApiError = { error: string; details?: unknown };
export type ApiOk<T> = { data: T };

export function ok<T>(data: T, init?: { status?: number }): NextResponse<ApiOk<T>> {
  return NextResponse.json<ApiOk<T>>({ data }, { status: init?.status ?? 200 });
}

export function fail(status: number, error: string, details?: unknown): NextResponse<ApiError> {
  const body: ApiError = details === undefined ? { error } : { error, details };
  return NextResponse.json<ApiError>(body, { status });
}

/** The exact error codes the contracts doc promises clients. Keep this list closed. */
export const ErrorCode = {
  unauthenticated: 'unauthenticated',
  invalidRequest: 'invalid_request',
  planUpgradeRequired: 'plan_upgrade_required',
  planNotPurchasable: 'plan_not_purchasable',
  subscriptionExists: 'subscription_exists',
  noBillingAccount: 'no_billing_account',
  stripeUnavailable: 'stripe_unavailable',
  invalidSignature: 'invalid_signature',
  notFound: 'not_found',
  serverError: 'server_error',
} as const;

export type ErrorCodeName = keyof typeof ErrorCode;

/**
 * Logs the real error against a correlation id and returns the generic 502 body.
 * The correlation id is safe to expose; the provider message is not.
 */
export function upstreamFailure(scope: string, error: unknown): NextResponse<ApiError> {
  const correlationId = logServerError(scope, error);
  return fail(502, ErrorCode.stripeUnavailable, { correlationId });
}

/** Unexpected/unknown failure: 500 + correlation id, details stay in the log. */
export function unexpectedFailure(scope: string, error: unknown): NextResponse<ApiError> {
  const correlationId = logServerError(scope, error);
  if (error instanceof MissingServerEnvError) {
    // Misconfiguration is a deployment bug, not a user error. Do not leak the
    // variable list to the client; it is in the server log under the same id.
    return fail(500, ErrorCode.serverError, { correlationId });
  }
  return fail(500, ErrorCode.serverError, { correlationId });
}

export function logServerError(scope: string, error: unknown): string {
  const correlationId = globalThis.crypto.randomUUID();
  const message = error instanceof Error ? error.message : String(error);
  const stack = error instanceof Error ? error.stack : undefined;
  // console.error is deliberate: it lands in the platform log stream and in
  // `vercel logs`/CloudWatch without any extra dependency.
  console.error(`[billing:${scope}] correlationId=${correlationId} ${message}`, stack ?? '');
  return correlationId;
}

/**
 * Reads the raw request body as JSON with a hard size guard, and never logs the body.
 * Billing requests are tiny; anything large is hostile or a bug.
 */
export async function readJsonBody(req: Request, maxBytes = 4096): Promise<unknown> {
  const text = await req.text();
  if (text.length > maxBytes) {
    throw new BodyTooLargeError();
  }
  if (text.trim().length === 0) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw new InvalidJsonError();
  }
}

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