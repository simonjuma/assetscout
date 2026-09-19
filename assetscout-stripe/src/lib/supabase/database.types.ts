/**
 * Hand-written Supabase types for the billing schema ONLY.
 *
 * Why hand-written: this is a drop-in set. Your repo may already generate types
 * (`supabase gen types typescript`). If it does, DELETE this file and re-point the
 * two imports in `src/lib/supabase/{server,admin}.ts` at your generated
 * `Database` type - nothing else references it.
 *
 * These shapes mirror ASSETSCOUT_STRIPE_SCHEMA.sql exactly. If you rename a
 * column in the migration, rename it here too - that is what makes the compiler
 * catch drift.
 *
 * NOTE: `feature_usage` is ADDITIVE - it is not in the original schema doc.
 * Reason: the contracts doc §8.1 rule 3 requires server-side usage counters for
 * `limit` entitlements, otherwise `*.per_month` limits are decorative.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

/** Postgres `timestamptz` arrives over PostgREST as an ISO-8601 string. */
export type IsoTimestamp = string;

/** The closed set of Stripe subscription statuses mirrored in `public.subscriptions`. */
export type SubscriptionStatus =
  | 'incomplete'
  | 'incomplete_expired'
  | 'trialing'
  | 'active'
  | 'past_due'
  | 'canceled'
  | 'unpaid'
  | 'paused';

export type InvoiceStatus = 'draft' | 'open' | 'paid' | 'void' | 'uncollectible';
export type PaymentStatus = 'pending' | 'succeeded' | 'failed' | 'refunded' | 'partially_refunded';
export type StripeEventStatus = 'received' | 'processed' | 'failed' | 'ignored';
export type FeatureValueType = 'boolean' | 'limit';
export type BillingInterval = 'month' | 'year';
/** Any ISO-4217 code, uppercased. USD is the default; KES is supported when priced. */
export type CurrencyCode = string;

type PlansRow = {
  id: string;
  key: string;
  name: string;
  tagline: string | null;
  tier: number;
  is_public: boolean;
  is_active: boolean;
  requires_sales_contact: boolean;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
};

type PlanPricesRow = {
  id: string;
  plan_id: string;
  stripe_price_id: string;
  billing_interval: BillingInterval;
  currency: CurrencyCode;
  unit_amount: number;
  is_active: boolean;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
};

type FeaturesRow = {
  key: string;
  description: string;
  value_type: FeatureValueType;
  created_at: IsoTimestamp;
};

type PlanFeaturesRow = {
  plan_id: string;
  feature_key: string;
  enabled: boolean;
  limit_value: number | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
};

type BillingCustomersRow = {
  user_id: string;
  stripe_customer_id: string;
  currency: CurrencyCode;
  country: string | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
};

type SubscriptionsRow = {
  id: string;
  user_id: string;
  plan_id: string;
  plan_price_id: string | null;
  stripe_customer_id: string;
  stripe_subscription_id: string;
  stripe_price_id: string;
  status: SubscriptionStatus;
  currency: CurrencyCode;
  quantity: number;
  current_period_start: IsoTimestamp | null;
  current_period_end: IsoTimestamp | null;
  cancel_at_period_end: boolean;
  canceled_at: IsoTimestamp | null;
  ended_at: IsoTimestamp | null;
  trial_start: IsoTimestamp | null;
  trial_end: IsoTimestamp | null;
  latest_invoice_id: string | null;
  checkout_session_id: string | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
};

type InvoicesRow = {
  id: string;
  user_id: string;
  subscription_id: string | null;
  plan_id: string | null;
  stripe_invoice_id: string;
  stripe_customer_id: string;
  status: InvoiceStatus;
  currency: CurrencyCode;
  amount_due: number;
  amount_paid: number;
  amount_remaining: number;
  billing_reason: string | null;
  period_start: IsoTimestamp | null;
  period_end: IsoTimestamp | null;
  paid_at: IsoTimestamp | null;
  hosted_invoice_url: string | null;
  invoice_pdf: string | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
};

type PaymentsRow = {
  id: string;
  user_id: string;
  subscription_id: string | null;
  invoice_id: string | null;
  stripe_payment_intent_id: string | null;
  stripe_charge_id: string | null;
  stripe_invoice_id: string | null;
  checkout_session_id: string | null;
  amount: number;
  amount_refunded: number;
  currency: CurrencyCode;
  status: PaymentStatus;
  failure_code: string | null;
  failure_message: string | null;
  paid_at: IsoTimestamp | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
};

type StripeEventsRow = {
  id: string;
  stripe_event_id: string;
  type: string;
  api_version: string | null;
  livemode: boolean;
  account_id: string | null;
  payload: Json | null;
  status: StripeEventStatus;
  attempts: number;
  processing_error: string | null;
  processed_at: IsoTimestamp | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
};

type EntitlementOverridesRow = {
  id: string;
  user_id: string;
  feature_key: string;
  enabled: boolean;
  limit_value: number | null;
  reason: string;
  granted_by: string | null;
  expires_at: IsoTimestamp | null;
  revoked_at: IsoTimestamp | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
};

/** Usage counter window for `limit` entitlements. Server-written only. */
type FeatureUsageRow = {
  user_id: string;
  feature_key: string;
  period_start: IsoTimestamp;
  used: number;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
};

type ConsumeFeatureUsageResult = {
  allowed: boolean;
  used: number;
};

export type Database = {
  public: {
    Tables: {
      plans: {
        Row: PlansRow;
        Insert: {
          id?: string;
          key: string;
          name: string;
          tagline?: string | null;
          tier?: number;
          is_public?: boolean;
          is_active?: boolean;
          requires_sales_contact?: boolean;
          created_at?: IsoTimestamp;
          updated_at?: IsoTimestamp;
        };
        Update: Partial<PlansRow>;
        Relationships: [];
      };
      plan_prices: {
        Row: PlanPricesRow;
        Insert: {
          id?: string;
          plan_id: string;
          stripe_price_id: string;
          billing_interval: BillingInterval;
          currency: CurrencyCode;
          unit_amount: number;
          is_active?: boolean;
        };
        Update: Partial<PlanPricesRow>;
        Relationships: [];
      };
      features: {
        Row: FeaturesRow;
        Insert: { key: string; description: string; value_type: FeatureValueType };
        Update: Partial<FeaturesRow>;
        Relationships: [];
      };
      plan_features: {
        Row: PlanFeaturesRow;
        Insert: {
          plan_id: string;
          feature_key: string;
          enabled?: boolean;
          limit_value?: number | null;
        };
        Update: Partial<PlanFeaturesRow>;
        Relationships: [];
      };
      billing_customers: {
        Row: BillingCustomersRow;
        Insert: {
          user_id: string;
          stripe_customer_id: string;
          currency?: CurrencyCode;
          country?: string | null;
        };
        Update: Partial<BillingCustomersRow>;
        Relationships: [];
      };
      subscriptions: {
        Row: SubscriptionsRow;
        Insert: {
          id?: string;
          user_id: string;
          plan_id: string;
          plan_price_id?: string | null;
          stripe_customer_id: string;
          stripe_subscription_id: string;
          stripe_price_id: string;
          status: SubscriptionStatus;
          currency?: CurrencyCode;
          quantity?: number;
          current_period_start?: IsoTimestamp | null;
          current_period_end?: IsoTimestamp | null;
          cancel_at_period_end?: boolean;
          canceled_at?: IsoTimestamp | null;
          ended_at?: IsoTimestamp | null;
          trial_start?: IsoTimestamp | null;
          trial_end?: IsoTimestamp | null;
          latest_invoice_id?: string | null;
          checkout_session_id?: string | null;
        };
        Update: Partial<SubscriptionsRow>;
        Relationships: [];
      };
      invoices: {
        Row: InvoicesRow;
        Insert: {
          id?: string;
          user_id: string;
          subscription_id?: string | null;
          plan_id?: string | null;
          stripe_invoice_id: string;
          stripe_customer_id: string;
          status: InvoiceStatus;
          currency: CurrencyCode;
          amount_due?: number;
          amount_paid?: number;
          amount_remaining?: number;
          billing_reason?: string | null;
          period_start?: IsoTimestamp | null;
          period_end?: IsoTimestamp | null;
          paid_at?: IsoTimestamp | null;
          hosted_invoice_url?: string | null;
          invoice_pdf?: string | null;
        };
        Update: Partial<InvoicesRow>;
        Relationships: [];
      };
      payments: {
        Row: PaymentsRow;
        Insert: {
          id?: string;
          user_id: string;
          subscription_id?: string | null;
          invoice_id?: string | null;
          stripe_payment_intent_id?: string | null;
          stripe_charge_id?: string | null;
          stripe_invoice_id?: string | null;
          checkout_session_id?: string | null;
          amount?: number;
          amount_refunded?: number;
          currency: CurrencyCode;
          status: PaymentStatus;
          failure_code?: string | null;
          failure_message?: string | null;
          paid_at?: IsoTimestamp | null;
        };
        Update: Partial<PaymentsRow>;
        Relationships: [];
      };
      stripe_events: {
        Row: StripeEventsRow;
        Insert: {
          id?: string;
          stripe_event_id: string;
          type: string;
          api_version?: string | null;
          livemode?: boolean;
          account_id?: string | null;
          payload?: Json | null;
          status?: StripeEventStatus;
          attempts?: number;
          processing_error?: string | null;
          processed_at?: IsoTimestamp | null;
        };
        Update: Partial<StripeEventsRow>;
        Relationships: [];
      };
      entitlement_overrides: {
        Row: EntitlementOverridesRow;
        Insert: {
          id?: string;
          user_id: string;
          feature_key: string;
          enabled?: boolean;
          limit_value?: number | null;
          reason: string;
          granted_by?: string | null;
          expires_at?: IsoTimestamp | null;
          revoked_at?: IsoTimestamp | null;
        };
        Update: Partial<EntitlementOverridesRow>;
        Relationships: [];
      };
      feature_usage: {
        Row: FeatureUsageRow;
        Insert: {
          user_id: string;
          feature_key: string;
          period_start: IsoTimestamp;
          used?: number;
        };
        Update: Partial<FeatureUsageRow>;
        Relationships: [];
      };
    };
    Views: Record<string, never>;
    Functions: {
      /**
       * Atomic limit check + increment for one billing period (schema migration
       * 0001_billing.sql). Running the check inside the UPDATE ... WHERE is what
       * makes `limit` entitlements race-safe; never increment from TypeScript.
       */
      consume_feature_usage: {
        Args: {
          p_user_id: string;
          p_feature_key: string;
          p_limit: number | null;
          p_cost?: number;
        };
        Returns: ConsumeFeatureUsageResult[];
      };
    };
    Enums: Record<string, never>;
    CompositeTypes: Record<string, never>;
  };
};