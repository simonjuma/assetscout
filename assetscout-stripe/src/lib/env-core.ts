/**
 * AssetScout — environment access core.
 *
 * WHY THIS FILE IS SEPARATE FROM `src/env.ts`
 * ------------------------------------------
 * `src/env.ts` imports `server-only`, which throws as soon as it is loaded
 * outside a React Server Component (including under `node --test`). All the
 * actual logic therefore lives here — pure, injectable and unit-testable — and
 * `src/env.ts` is a thin `server-only` re-export for app code.
 *
 * Rules enforced here (plan §4.1):
 *  - Stripe secrets are server-only. There is no NEXT_PUBLIC_STRIPE_SECRET_KEY.
 *  - Validation is LAZY (called inside handlers, never at module scope) so
 *    `next build` succeeds on a machine without production secrets.
 *  - Errors name the MISSING VARIABLES only. Values are never echoed, logged or
 *    returned.
 *  - Supabase and Stripe requirements are validated separately, so the ingestion
 *    and discovery features work in a deployment where billing is not yet
 *    configured (and vice versa).
 */
import { z } from 'zod';

export type EnvSource = Record<string, string | undefined>;

export class MissingServerEnvError extends Error {
  /** Variable NAMES only — safe to log, never returned to a client. */
  readonly variables: string[];

  constructor(detail: string, variables: string[] = []) {
    super(`Server environment is not configured: ${detail}`);
    this.name = 'MissingServerEnvError';
    this.variables = variables;
  }
}

const httpUrl = (name: string) =>
  z
    .string()
    .min(1, `${name} is required`)
    .refine((v) => /^https?:\/\/[^\s]+$/.test(v), `${name} must be an absolute http(s) URL`);

const stripeSecret = z
  .string()
  .min(1, 'STRIPE_SECRET_KEY is required')
  .refine((v) => v.startsWith('sk_') || v.startsWith('rk_'), 'STRIPE_SECRET_KEY must start with sk_');

const webhookSecret = z
  .string()
  .min(1, 'STRIPE_WEBHOOK_SECRET is required')
  .refine((v) => v.startsWith('whsec_'), 'STRIPE_WEBHOOK_SECRET must start with whsec_');

/** Supabase — required by every data feature (auth, discovery, watchlist). */
export const supabaseSchema = z.object({
  NEXT_PUBLIC_SUPABASE_URL: httpUrl('NEXT_PUBLIC_SUPABASE_URL'),
  NEXT_PUBLIC_SUPABASE_ANON_KEY: z.string().min(1, 'NEXT_PUBLIC_SUPABASE_ANON_KEY is required'),
  /** Service-role key: used by the webhook, the ingestion runner and admin ops. */
  SUPABASE_SERVICE_ROLE_KEY: z.string().min(1, 'SUPABASE_SERVICE_ROLE_KEY is required'),
});

/** Stripe — required only by billing routes. */
export const stripeSchema = z.object({
  STRIPE_SECRET_KEY: stripeSecret,
  STRIPE_WEBHOOK_SECRET: webhookSecret,
  /**
   * Absolute origin used for success_url / cancel_url / portal return_url.
   * Never derived from the Host header (host-header-injection risk).
   */
  APP_URL: httpUrl('APP_URL'),
});

export const serverSchema = supabaseSchema.merge(stripeSchema);

export type SupabaseServerEnv = z.infer<typeof supabaseSchema>;
export type StripeEnv = z.infer<typeof stripeSchema>;
export type ServerEnv = z.infer<typeof serverSchema>;

export type EnvParseOk<T> = { ok: true; env: T };
export type EnvParseFail = { ok: false; variables: string[]; message: string };
export type EnvParseResult<T> = EnvParseOk<T> | EnvParseFail;

function requirementIssues(error: z.ZodError): string[] {
  // `path[0]` is the variable name because these schemas have flat, top-level keys.
  return Array.from(new Set(error.issues.map((issue) => String(issue.path[0] ?? '(root)'))));
}

/** Pure: validate an explicit env source. The unit-test entry point. */
export function parseEnv<T>(schema: z.ZodType<T>, source: EnvSource): EnvParseResult<T> {
  const parsed = schema.safeParse(source);
  if (!parsed.success) {
    const variables = requirementIssues(parsed.error);
    const message = parsed.error.issues
      .map((issue) => `${String(issue.path[0] ?? '(root)')}: ${issue.message}`)
      .join('; ');
    return { ok: false, variables, message };
  }
  return { ok: true, env: parsed.data };
}

/** Reads the process environment into a validated Supabase config. */
export function parseSupabaseEnv(source: EnvSource = process.env): EnvParseResult<SupabaseServerEnv> {
  return parseEnv(supabaseSchema, {
    NEXT_PUBLIC_SUPABASE_URL: source.NEXT_PUBLIC_SUPABASE_URL,
    NEXT_PUBLIC_SUPABASE_ANON_KEY: source.NEXT_PUBLIC_SUPABASE_ANON_KEY,
    SUPABASE_SERVICE_ROLE_KEY: source.SUPABASE_SERVICE_ROLE_KEY,
  });
}

/** Reads the process environment into a validated Stripe config. */
export function parseStripeEnv(source: EnvSource = process.env): EnvParseResult<StripeEnv> {
  const isProduction = (source.NODE_ENV ?? 'development') === 'production';
  const appUrl = source.APP_URL ?? source.NEXT_PUBLIC_APP_URL;

  const parsed = parseEnv(stripeSchema, {
    STRIPE_SECRET_KEY: source.STRIPE_SECRET_KEY,
    STRIPE_WEBHOOK_SECRET: source.STRIPE_WEBHOOK_SECRET,
    APP_URL: appUrl,
  });
  if (!parsed.ok) return parsed;

  if (isProduction && !parsed.env.APP_URL.startsWith('https://')) {
    return {
      ok: false,
      variables: ['APP_URL'],
      message: 'APP_URL must be an https:// origin in production',
    };
  }
  return parsed;
}

// ---------------------------------------------------------------------------
// Cached accessors. Each throws MissingServerEnvError naming the variables.
// ---------------------------------------------------------------------------
let supabaseCache: SupabaseServerEnv | undefined;
let stripeCache: StripeEnv | undefined;

function unwrap<T>(result: EnvParseResult<T>): T {
  if (!result.ok) {
    throw new MissingServerEnvError(result.message, result.variables);
  }
  return result.env;
}

/** Supabase server config. Required by auth, discovery, watchlist and ingestion. */
export function supabaseServerEnv(): SupabaseServerEnv {
  if (supabaseCache) return supabaseCache;
  supabaseCache = unwrap(parseSupabaseEnv());
  return supabaseCache;
}

/** Stripe server config. Required only by the billing routes. */
export function stripeEnv(): StripeEnv {
  if (stripeCache) return stripeCache;
  stripeCache = unwrap(parseStripeEnv());
  return stripeCache;
}

/** Both. Kept because existing code imports `serverEnv` from `@/env`. */
export function serverEnv(): ServerEnv {
  return { ...supabaseServerEnv(), ...stripeEnv() };
}

/** Test seam: clears the memoised env so a test can re-parse a different source. */
export function resetEnvCache(): void {
  supabaseCache = undefined;
  stripeCache = undefined;
}

export function isSupabaseConfigured(): boolean {
  return parseSupabaseEnv().ok;
}

/** True when billing can work — used by pages to render a clear notice, not to crash. */
export function isBillingConfigured(): boolean {
  return parseStripeEnv().ok;
}

/**
 * Names of the environment variables still required, grouped by feature.
 * NAMES ONLY — this is what the /admin readiness panel renders, and it is safe
 * to show to an authenticated operator. It is never returned by a public route.
 */
export function envReadiness(source: EnvSource = process.env) {
  const supabase = parseSupabaseEnv(source);
  const stripe = parseStripeEnv(source);
  const optional: Array<{ name: string; configured: boolean; purpose: string }> = [
    {
      name: 'COMPANIES_HOUSE_API_KEY',
      configured: hasValue(source.COMPANIES_HOUSE_API_KEY),
      purpose: 'Enables the UK Companies House official-registry provider.',
    },
    {
      name: 'INGEST_CONTACT',
      configured: hasValue(source.INGEST_CONTACT),
      purpose: 'Required by the robots-respecting website probe: a reachable contact for the crawler.',
    },
    {
      name: 'CRON_SECRET',
      configured: hasValue(source.CRON_SECRET),
      purpose: 'Required to expose GET /api/cron/ingest to a scheduler.',
    },
    {
      name: 'STRIPE_PRICE_PRO_MONTHLY',
      configured: hasValue(source.STRIPE_PRICE_PRO_MONTHLY),
      purpose: 'Used by `npm run billing:sync` to publish the Pro monthly price.',
    },
    {
      name: 'STRIPE_PRICE_PRO_ANNUAL',
      configured: hasValue(source.STRIPE_PRICE_PRO_ANNUAL),
      purpose: 'Used by `npm run billing:sync` to publish the Pro annual price.',
    },
    {
      name: 'STRIPE_PRICE_AGENCY_MONTHLY',
      configured: hasValue(source.STRIPE_PRICE_AGENCY_MONTHLY),
      purpose: 'Used by `npm run billing:sync` to publish the Agency monthly price.',
    },
    {
      name: 'STRIPE_PRICE_AGENCY_ANNUAL',
      configured: hasValue(source.STRIPE_PRICE_AGENCY_ANNUAL),
      purpose: 'Used by `npm run billing:sync` to publish the Agency annual price.',
    },
  ];

  return {
    supabase: { configured: supabase.ok, missing: supabase.ok ? [] : supabase.variables },
    stripe: { configured: stripe.ok, missing: stripe.ok ? [] : stripe.variables },
    optional,
  };
}

function hasValue(value: string | undefined): boolean {
  return typeof value === 'string' && value.trim().length > 0;
}

/** Optional credential lookup. Returns null when unset or blank. */
export function optionalEnv(name: string, source: EnvSource = process.env): string | null {
  const value = source[name];
  return hasValue(value) ? (value as string).trim() : null;
}

/**
 * The descriptive User-Agent sent to public data sources.
 *
 * Sources use it to identify and contact the operator, which is part of using
 * them politely. The default states plainly that it is unconfigured rather than
 * inventing a contact address; providers that require a real contact refuse to
 * run until INGEST_CONTACT is set (see `ingestContactConfigured`).
 */
export function ingestUserAgent(source: EnvSource = process.env): string {
  const contact = optionalEnv('INGEST_CONTACT', source);
  const base = 'AssetScoutBot/1.0 (+https://github.com/assetscout/assetscout; public-data research)';
  return contact ? `AssetScoutBot/1.0 (${contact})` : base;
}

/** True when INGEST_CONTACT contains something that looks like a URL or an email. */
export function ingestContactConfigured(source: EnvSource = process.env): boolean {
  const contact = optionalEnv('INGEST_CONTACT', source);
  if (!contact) return false;
  return /https?:\/\/\S+|[\w.+-]+@[\w-]+\.[\w.-]+/.test(contact);
}

/** Bearer secret for the scheduled-ingestion endpoint. */
export function cronSecret(source: EnvSource = process.env): string | null {
  return optionalEnv('CRON_SECRET', source);
}

export type BillingIntervalKey = 'month' | 'year';

export type StripePriceBinding = {
  planKey: 'pro' | 'agency';
  interval: BillingIntervalKey;
  envVar: string;
  priceId: string;
};

/**
 * Stripe Price IDs supplied through the environment, used by
 * `npm run billing:sync` to publish rows into `public.plan_prices`.
 *
 * These are NOT the source of truth at checkout time: `plan_prices` is. This
 * mapping exists so an operator can declare which Stripe Prices correspond to
 * which (plan, interval) slot, and the sync verifies each Price against Stripe
 * (currency, interval, active flag, amount) before writing.
 */
export function stripePriceBindings(source: EnvSource = process.env): StripePriceBinding[] {
  const slots: Array<{ planKey: 'pro' | 'agency'; interval: BillingIntervalKey; envVar: string }> = [
    { planKey: 'pro', interval: 'month', envVar: 'STRIPE_PRICE_PRO_MONTHLY' },
    { planKey: 'pro', interval: 'year', envVar: 'STRIPE_PRICE_PRO_ANNUAL' },
    { planKey: 'agency', interval: 'month', envVar: 'STRIPE_PRICE_AGENCY_MONTHLY' },
    { planKey: 'agency', interval: 'year', envVar: 'STRIPE_PRICE_AGENCY_ANNUAL' },
  ];

  const bindings: StripePriceBinding[] = [];
  for (const slot of slots) {
    const priceId = optionalEnv(slot.envVar, source);
    if (priceId) {
      bindings.push({ ...slot, priceId });
    }
  }
  return bindings;
}

/** Default currency for the pricing UI and the sync (per-currency prices are separate rows). */
export function billingCurrency(source: EnvSource = process.env): string {
  const raw = optionalEnv('STRIPE_BILLING_CURRENCY', source) ?? 'USD';
  return raw.toUpperCase().slice(0, 3);
}