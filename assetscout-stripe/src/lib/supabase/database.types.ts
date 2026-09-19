/**
 * Supabase types for the AssetScout schema.
 *
 * Mirrors `supabase/migrations/*.sql` exactly. If a migration renames a column,
 * rename it here too — that is what makes the compiler catch schema drift.
 *
 * Hand-written on purpose: this project has no `supabase gen types` step wired
 * into CI, and a checked-in type contract that TypeScript verifies against the
 * queries is safer than an ungenerated file. Running
 * `supabase gen types typescript --project-id <ref>` and replacing this file is
 * supported — nothing else needs to change.
 */

export type Json = string | number | boolean | null | { [key: string]: Json | undefined } | Json[];

/** Postgres `timestamptz` arrives over PostgREST as an ISO-8601 string. */
export type IsoTimestamp = string;

// ---------------------------------------------------------------------------
// Closed sets (mirror the CHECK constraints)
// ---------------------------------------------------------------------------
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
export type PlatformRole = 'member' | 'admin';

export type AssetKind =
  | 'domain'
  | 'website'
  | 'saas'
  | 'digital_business'
  | 'digital_product'
  | 'brand';

export type AssetStatus =
  | 'active'
  | 'potentially_inactive'
  | 'expired'
  | 'available'
  | 'for_sale'
  | 'auction'
  | 'struck_off'
  | 'under_investigation'
  | 'unknown'
  | 'verification_required'
  | 'acquired'
  | 'relaunching'
  | 'monetizing'
  | 'sold';

export type RiskLevel = 'low' | 'medium' | 'high' | 'critical' | 'unknown';

export type VerificationStatus =
  | 'verified'
  | 'partially_verified'
  | 'unverified'
  | 'verification_required';

export type ProvenanceConfidence =
  | 'authoritative'
  | 'registry'
  | 'provider_claim'
  | 'signal'
  | 'unknown';

export type DiscoveryMethod = 'provider_query' | 'candidate_check' | 'manual';

export type SourceKind =
  | 'domain_registry'
  | 'website'
  | 'historical_index'
  | 'signal_feed'
  | 'business_registry'
  | 'trademark_registry'
  | 'manual_registry';

export type SourceRobotsPolicy = 'respect' | 'api_only';
export type RunMode = 'manual' | 'cron' | 'admin';
export type IngestionStatus = 'running' | 'succeeded' | 'partial' | 'failed';
export type IngestionStage =
  | 'configure'
  | 'fetch'
  | 'validate'
  | 'normalize'
  | 'dedupe'
  | 'persist'
  | 'verify'
  | 'score';

export type CheckCategory = 'domain' | 'business' | 'trademark' | 'website' | 'ownership' | 'risk';
export type CheckStatus =
  | 'verified'
  | 'failed'
  | 'inconclusive'
  | 'not_checked'
  | 'requires_manual_research';
export type CheckMethod = 'api' | 'registry_lookup' | 'manual' | 'not_available';

export type ScoreClassification =
  | 'exceptional'
  | 'high_potential'
  | 'good_potential'
  | 'moderate'
  | 'low_potential';

export type WatchlistStage =
  | 'discovered'
  | 'researching'
  | 'verification'
  | 'contacted_owner'
  | 'negotiating'
  | 'acquired'
  | 'relaunching'
  | 'monetizing'
  | 'sold'
  | 'rejected';

// ---------------------------------------------------------------------------
// Row shapes
// ---------------------------------------------------------------------------
type ProfilesRow = {
  id: string;
  email: string | null;
  display_name: string | null;
  role: PlatformRole;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
};

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
  /** SERVER ONLY. Never selected by a route that returns to a client. */
  stripe_price_id: string;
  billing_interval: BillingInterval;
  currency: CurrencyCode;
  unit_amount: number;
  is_active: boolean;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
};

/** Client-safe projection (`public.public_plan_prices`). */
type PublicPlanPricesRow = Omit<PlanPricesRow, 'stripe_price_id' | 'created_at' | 'updated_at'>;

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

// ---------------------------------------------------------------------------
// Ingestion / discovery row shapes (migration 0002_assets.sql)
// ---------------------------------------------------------------------------
type SourcesRow = {
  id: string;
  key: string;
  name: string;
  kind: SourceKind;
  description: string;
  homepage_url: string;
  api_doc_url: string | null;
  terms_url: string | null;
  license: string | null;
  terms_note: string | null;
  requires_auth: boolean;
  required_env_vars: string[];
  robots_policy: SourceRobotsPolicy;
  is_enabled: boolean;
  min_interval_ms: number;
  max_requests_per_minute: number;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
};

type IngestionRunsRow = {
  id: string;
  source_key: string;
  mode: RunMode;
  status: IngestionStatus;
  query: Json;
  correlation_id: string;
  initiated_by: string | null;
  started_at: IsoTimestamp;
  finished_at: IsoTimestamp | null;
  items_fetched: number;
  items_valid: number;
  items_new: number;
  items_updated: number;
  items_duplicate: number;
  items_rejected: number;
  error_count: number;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
};

type IngestionErrorsRow = {
  id: string;
  run_id: string;
  source_key: string;
  stage: IngestionStage;
  code: string;
  message: string;
  context: Json;
  created_at: IsoTimestamp;
};

type AssetsRow = {
  id: string;
  kind: AssetKind;
  dedupe_key: string;
  name: string;
  identifier: string;
  url: string | null;
  tld: string | null;
  country: string | null;
  industry: string | null;
  niche: string | null;
  status: AssetStatus;
  acquisition_route: string | null;
  estimated_cost_min: number | null;
  estimated_cost_max: number | null;
  cost_currency: CurrencyCode | null;
  risk_level: RiskLevel;
  verification_status: VerificationStatus;
  is_published: boolean;
  monetization: Json;
  attributes: Json;
  score_total: number | null;
  score_classification: ScoreClassification | null;
  score_evidence_coverage: number | null;
  score_version: string | null;
  first_seen_at: IsoTimestamp;
  last_ingested_at: IsoTimestamp;
  last_verified_at: IsoTimestamp | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
};

type AssetSourcesRow = {
  id: string;
  asset_id: string;
  source_key: string;
  source_url: string;
  source_record_id: string | null;
  discovery_method: DiscoveryMethod;
  confidence: ProvenanceConfidence;
  observed_at: IsoTimestamp;
  last_verified_at: IsoTimestamp | null;
  verification_status: VerificationStatus;
  raw_excerpt: Json;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
};

type AssetVerificationsRow = {
  id: string;
  asset_id: string;
  check_key: string;
  category: CheckCategory;
  status: CheckStatus;
  method: CheckMethod;
  evidence_url: string | null;
  evidence: Json;
  source_key: string | null;
  check_version: string | null;
  checked_at: IsoTimestamp;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
};

type AssetScoresRow = {
  id: string;
  asset_id: string;
  version: string;
  total: number;
  classification: ScoreClassification;
  brand_potential: number | null;
  domain_quality: number | null;
  market_demand: number | null;
  monetization_potential: number | null;
  competition: number | null;
  legal_clarity: number | null;
  acquisition_cost: number | null;
  weight_total: number;
  evidence_coverage: number;
  factors: Json;
  computed_at: IsoTimestamp;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
};

type WatchlistItemsRow = {
  id: string;
  user_id: string;
  asset_id: string;
  notes: string | null;
  target_price: number | null;
  target_currency: CurrencyCode;
  stage: WatchlistStage;
  reminder_at: IsoTimestamp | null;
  created_at: IsoTimestamp;
  updated_at: IsoTimestamp;
};

type PipelineEventsRow = {
  id: string;
  user_id: string;
  asset_id: string;
  from_stage: WatchlistStage | null;
  to_stage: WatchlistStage;
  note: string | null;
  created_at: IsoTimestamp;
};

export type Database = {
  public: {
    Tables: {
      profiles: {
        Row: ProfilesRow;
        Insert: {
          id: string;
          email?: string | null;
          display_name?: string | null;
          role?: PlatformRole;
        };
        Update: Partial<ProfilesRow>;
        Relationships: [];
      };
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
      sources: {
        Row: SourcesRow;
        Insert: {
          key: string;
          name: string;
          kind: SourceKind;
          description: string;
          homepage_url: string;
          api_doc_url?: string | null;
          terms_url?: string | null;
          license?: string | null;
          terms_note?: string | null;
          requires_auth?: boolean;
          required_env_vars?: string[];
          robots_policy?: SourceRobotsPolicy;
          is_enabled?: boolean;
          min_interval_ms?: number;
          max_requests_per_minute?: number;
        };
        Update: Partial<SourcesRow>;
        Relationships: [];
      };
      ingestion_runs: {
        Row: IngestionRunsRow;
        Insert: {
          source_key: string;
          mode?: RunMode;
          status?: IngestionStatus;
          query?: Json;
          correlation_id: string;
          initiated_by?: string | null;
          finished_at?: IsoTimestamp | null;
          items_fetched?: number;
          items_valid?: number;
          items_new?: number;
          items_updated?: number;
          items_duplicate?: number;
          items_rejected?: number;
          error_count?: number;
        };
        Update: Partial<IngestionRunsRow>;
        Relationships: [];
      };
      ingestion_errors: {
        Row: IngestionErrorsRow;
        Insert: {
          run_id: string;
          source_key: string;
          stage: IngestionStage;
          code: string;
          message: string;
          context?: Json;
        };
        Update: Partial<IngestionErrorsRow>;
        Relationships: [];
      };
      assets: {
        Row: AssetsRow;
        Insert: {
          kind: AssetKind;
          dedupe_key: string;
          name: string;
          identifier: string;
          url?: string | null;
          tld?: string | null;
          country?: string | null;
          industry?: string | null;
          niche?: string | null;
          status?: AssetStatus;
          acquisition_route?: string | null;
          estimated_cost_min?: number | null;
          estimated_cost_max?: number | null;
          cost_currency?: CurrencyCode | null;
          risk_level?: RiskLevel;
          verification_status?: VerificationStatus;
          is_published?: boolean;
          monetization?: Json;
          attributes?: Json;
          score_total?: number | null;
          score_classification?: ScoreClassification | null;
          score_evidence_coverage?: number | null;
          score_version?: string | null;
          first_seen_at?: IsoTimestamp;
          last_ingested_at?: IsoTimestamp;
          last_verified_at?: IsoTimestamp | null;
        };
        Update: Partial<AssetsRow>;
        Relationships: [];
      };
      asset_sources: {
        Row: AssetSourcesRow;
        Insert: {
          asset_id: string;
          source_key: string;
          source_url: string;
          source_record_id?: string | null;
          discovery_method?: DiscoveryMethod;
          confidence?: ProvenanceConfidence;
          observed_at?: IsoTimestamp;
          last_verified_at?: IsoTimestamp | null;
          verification_status?: VerificationStatus;
          raw_excerpt?: Json;
        };
        Update: Partial<AssetSourcesRow>;
        Relationships: [];
      };
      asset_verifications: {
        Row: AssetVerificationsRow;
        Insert: {
          asset_id: string;
          check_key: string;
          category: CheckCategory;
          status: CheckStatus;
          method: CheckMethod;
          evidence_url?: string | null;
          evidence?: Json;
          source_key?: string | null;
          check_version?: string | null;
          checked_at?: IsoTimestamp;
        };
        Update: Partial<AssetVerificationsRow>;
        Relationships: [];
      };
      asset_scores: {
        Row: AssetScoresRow;
        Insert: {
          asset_id: string;
          version: string;
          total: number;
          classification: ScoreClassification;
          brand_potential?: number | null;
          domain_quality?: number | null;
          market_demand?: number | null;
          monetization_potential?: number | null;
          competition?: number | null;
          legal_clarity?: number | null;
          acquisition_cost?: number | null;
          weight_total: number;
          evidence_coverage: number;
          factors?: Json;
          computed_at?: IsoTimestamp;
        };
        Update: Partial<AssetScoresRow>;
        Relationships: [];
      };
      watchlist_items: {
        Row: WatchlistItemsRow;
        Insert: {
          user_id: string;
          asset_id: string;
          notes?: string | null;
          target_price?: number | null;
          target_currency?: CurrencyCode;
          stage?: WatchlistStage;
          reminder_at?: IsoTimestamp | null;
        };
        Update: Partial<WatchlistItemsRow>;
        Relationships: [];
      };
      pipeline_events: {
        Row: PipelineEventsRow;
        Insert: {
          user_id: string;
          asset_id: string;
          from_stage?: WatchlistStage | null;
          to_stage: WatchlistStage;
          note?: string | null;
        };
        Update: Partial<PipelineEventsRow>;
        Relationships: [];
      };
    };
    Views: {
      /** Column-safe projection of plan_prices; `stripe_price_id` is absent by design. */
      public_plan_prices: {
        Row: PublicPlanPricesRow;
        Relationships: [];
      };
    };
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