/**
 * Server environment access — the ONLY module `process.env` is read through.
 *
 * This file is the `server-only` facade over `src/lib/env-core.ts`. The logic
 * lives there (pure + unit-testable); this file adds the build-time guard that
 * makes an accidental Client Component import a hard error instead of a silent
 * credential leak.
 *
 * Billing secrets never cross this boundary:
 *   - no NEXT_PUBLIC_STRIPE_SECRET_KEY exists, by design
 *   - Checkout is redirect-based, so the browser never needs Stripe config
 *   - provider credentials (e.g. COMPANIES_HOUSE_API_KEY) are read server-side
 *     only, via `optionalEnv`
 */
import 'server-only';

export {
  MissingServerEnvError,
  billingCurrency,
  cronSecret,
  envReadiness,
  ingestContactConfigured,
  ingestUserAgent,
  isBillingConfigured,
  isSupabaseConfigured,
  optionalEnv,
  parseStripeEnv,
  parseSupabaseEnv,
  serverEnv,
  stripeEnv,
  stripePriceBindings,
  supabaseServerEnv,
  type EnvSource,
  type ServerEnv,
  type StripeEnv,
  type SupabaseServerEnv,
} from '@/lib/env-core';

import { optionalEnv } from '@/lib/env-core';

/**
 * Browser-safe values.
 *
 * Only NEXT_PUBLIC_* values are read here. Next.js inlines these at build time,
 * so this object contains nothing that is not already public. A Stripe
 * publishable key is public by design and is only needed if Stripe Elements is
 * ever adopted; Checkout here is redirect-based, so it is optional.
 */
export const publicEnv = {
  supabaseUrl: process.env.NEXT_PUBLIC_SUPABASE_URL ?? '',
  supabaseAnonKey: process.env.NEXT_PUBLIC_SUPABASE_ANON_KEY ?? '',
  appUrl: process.env.APP_URL ?? process.env.NEXT_PUBLIC_APP_URL ?? '',
  stripePublishableKey: process.env.NEXT_PUBLIC_STRIPE_PUBLISHABLE_KEY ?? '',
} as const;

/**
 * Guards a Server Component that requires Supabase in the browser bundle.
 * Server Components pass values down as props; there is no separate client env
 * module to keep in sync.
 */
export function assertBrowserEnv(): { supabaseUrl: string; supabaseAnonKey: string } {
  const missing = (
    [
      ['NEXT_PUBLIC_SUPABASE_URL', publicEnv.supabaseUrl],
      ['NEXT_PUBLIC_SUPABASE_ANON_KEY', publicEnv.supabaseAnonKey],
    ] as const
  )
    .filter(([, value]) => value.length === 0)
    .map(([name]) => name);

  if (missing.length > 0) {
    throw new Error(`Missing public env: ${missing.join(', ')}`);
  }
  return { supabaseUrl: publicEnv.supabaseUrl, supabaseAnonKey: publicEnv.supabaseAnonKey };
}

/** Supabase service-role credentials for the RLS-bypassing admin client. */
export function supabaseAdminEnv(): { url: string; serviceRoleKey: string } {
  const url = publicEnv.supabaseUrl;
  const serviceRoleKey = optionalEnv('SUPABASE_SERVICE_ROLE_KEY');
  if (!url || !serviceRoleKey) {
    throw new Error('Supabase admin access requires NEXT_PUBLIC_SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY');
  }
  return { url, serviceRoleKey };
}