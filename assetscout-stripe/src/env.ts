/**
 * Server environment access — the ONLY place process.env is read for billing.
 *
 * Rules enforced here (see ASSETSCOUT_STRIPE_INTEGRATION_PLAN.md §4.1):
 *  - Stripe secrets are server-only. There is no NEXT_PUBLIC_STRIPE_SECRET_KEY and there never will be.
 *  - Validation is lazy (called inside handlers, never at module scope) so that
 *    `next build` does not fail on a machine without production secrets.
 *  - Errors never echo secret VALUES, only the missing variable NAMES.
 */
import 'server-only';
import { z } from 'zod';

const httpUrl = (name: string) =>
  z
    .string()
    .min(1, `${name} is required`)
    .refine((v) => /^https?:\/\/[^\s]+$/.test(v), `${name} must be an absolute http(s) URL`);

const serverSchema = z.object({
  /** sk_test_… / sk_live_… — never logged, never returned in a response body. */
  STRIPE_SECRET_KEY: z
    .string()
    .min(1, 'STRIPE_SECRET_KEY is required')
    .refine((v) => v.startsWith('sk_'), 'STRIPE_SECRET_KEY must start with sk_'),
  /** whsec_… — per endpoint, per mode (test vs live vs `stripe listen`). */
  STRIPE_WEBHOOK_SECRET: z
    .string()
    .min(1, 'STRIPE_WEBHOOK_SECRET is required')
    .refine((v) => v.startsWith('whsec_'), 'STRIPE_WEBHOOK_SECRET must start with whsec_'),
  /**
   * Absolute origin used for success_url / cancel_url / portal return_url.
   * Never derived from the Host header (host-header-injection risk in redirects).
   */
  APP_URL: httpUrl('APP_URL'),
  NEXT_PUBLIC_SUPABASE_URL: httpUrl('NEXT_PUBLIC_SUPABASE_URL'),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1, 'NEXT_PUBLIC_SUPABASE_ANON_KEY is required'),
  /** Service-role key: webhook writes bypass RLS by design. Server-only. */
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY is required'),
});

export type ServerEnv = z.infer<typeof serverSchema>;

let cached: ServerEnv | undefined;

/**
 * Returns validated server env, or throws a `MissingServerEnvError` naming the
 * variables that are absent/invalid. Call this inside a try/catch in every route
 * so a misconfigured deployment produces a 500 with a clear server log instead
 * of a confusing runtime TypeError deep inside the Stripe SDK.
 */
export function serverEnv(): ServerEnv {
  if (cached) return cached;

  const parsed = serverSchema.safeParse({
    STRIPE_SECRET_KEY: process.env.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: process.env.STRIPE_WEBHOOK_SECRET,
    // APP_URL is canonical; NEXT_PUBLIC_APP_URL is accepted as an alias because
    // many Next repos already define it. One of the two must be set.
    APP_URL: process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL,
    NEXT_PUBLIC_SUPABASE_URL: process.env.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: process.env.SUPABASE_SERVICE_ROLE_KEY,
  });

  if (!parsed.success) {
    const issues = parsed.error.issues
      .map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`)
      .join('; ');
    throw new MissingServerEnvError(issues);
  }

  if (process.env.NODE_ENV === 'production' && !parsed.data.APP_URL.startsWith('https://')) {
    throw new MissingServerEnvError('APP_URL must be an https:// origin in production');
  }

  cached = parsed.data;
  return cached;
}

export class MissingServerEnvError extends Error {
  constructor(detail: string) {
    super(`Server environment is not configured: ${detail}`);
    this.name = 'MissingServerEnvError';
  }
}

/** True when billing is configured — used by pages to render a clear notice instead of crashing. */
export function isBillingConfigured(): boolean {
  try {
    serverEnv();
    return true;
  } catch {
    return false;
  }
}

/**
 * Supabase service-role credentials for the RLS-bypassing admin client
 * (`src/lib/supabase/admin.ts`).
 *
 * Derived from the same validated `serverEnv()` payload rather than reading
 * process.env a second time, so this module stays the single source of truth
 * for environment access and a misconfigured deployment fails with the same
 * `MissingServerEnvError` everywhere.
 */
export function supabaseAdminEnv(): { url: string; serviceRoleKey: string } {
  const env = serverEnv();
  return {
    url: env.NEXT_PUBLIC_SUPABASE_URL,
    serviceRoleKey: env.SUPABASE_SERVICE_ROLE_KEY,
  };
}

/**
 * Browser-safe values. Deliberately a separate function so it is obvious that
 * only NEXT_PUBLIC_* values may cross to the client.
 */
export const publicEnv = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
  /**
   * OPTIONAL. This integration uses **redirect-based** Stripe Checkout plus the
   * Stripe-hosted Billing Portal (see ASSETSCOUT_STRIPE_INTEGRATION_PLAN.md §4.1:
   * "With redirect-based Stripe Checkout + Billing Portal, no publishable key is
   * needed"). The key is therefore read but never required, and never asserted.
   *
   * Add it only if you later adopt Stripe Elements / Stripe.js on the client.
   * A publishable key is public by design and can never be used to charge, read,
   * or modify anything on its own. Never put a secret key here.
   */
  stripePublishableKey: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '',
} as const;

/**
 * Client-safe values needed by a browser bundle.
 *
 * NOTE: `NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY` is deliberately **not** required —
 * Checkout is redirect-based, so the browser never talks to Stripe directly.
 * Server Components pass these values down as props; there is no separate
 * client env module to keep in sync.
 */
export function assertBrowserEnv(): { supabaseUrl: string; supabaseAnonKey: string } {
  const missing = ([
    ['supabaseUrl', publicEnv.supabaseUrl],
    ['supabaseAnonKey', publicEnv.supabaseAnonKey],
  ] as const)
    .filter(([, v]) => v.length === 0)
    .map(([k]) => k);
  if (missing.length > 0) {
    throw new Error(`Missing public env: ${missing.join(', ')}`);
  }
  return { supabaseUrl: publicEnv.supabaseUrl, supabaseAnonKey: publicEnv.supabaseAnonKey };
}