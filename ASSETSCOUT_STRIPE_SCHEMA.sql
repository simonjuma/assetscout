-- =============================================================================
-- AssetScout — Stripe Billing Schema
-- -----------------------------------------------------------------------------
-- STATUS: PROPOSED DDL (documentation artifact). NOT YET APPLIED.
-- Assumes PostgreSQL / Supabase.
--
-- APPLY ONLY AFTER: (1) the real repo is located, (2) the existing schema is
-- inspected, (3) you confirm the spec's suggested tables (`plans`,
-- `subscriptions`, spec §29 lines 845-871) do NOT already exist in a usable form.
-- If they DO exist, EXTEND them instead of creating these — do not fork the model.
--
-- Conventions assumed from the spec:
--   * Supabase Auth, user FK -> auth.users(id)
--   * RLS on user-owned tables; client reads own rows, writes via service role only
--   * money stored as integer minor units (cents), never floats
-- =============================================================================

create extension if not exists "pgcrypto";   -- gen_random_uuid()
create extension if not exists "citext";     -- optional: case-insensitive keys

-- -----------------------------------------------------------------------------
-- 4.1 plans — catalog of tiers. Prices are NOT columns here (see plan_prices).
-- -----------------------------------------------------------------------------
create table if not exists public.plans (
  id           uuid primary key default gen_random_uuid(),
  key          text        not null,
  name         text        not null,
  tagline      text,
  tier         integer     not null default 0,     -- display ordering, low -> high
  is_public    boolean     not null default true,  -- shown on the pricing page
  is_active    boolean     not null default true,  -- purchasable / assignable
  requires_sales_contact boolean not null default false, -- enterprise
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint plans_key_unique      unique (key),
  constraint plans_key_format      check (key ~ '^[a-z][a-z0-9_]{1,30}$'),
  constraint plans_tier_nonneg     check (tier >= 0)
);

comment on table public.plans is
  'Central plan catalog. Display names/prices/limits are data, never hard-coded in components.';

-- -----------------------------------------------------------------------------
-- 4.2 plan_prices — one row per (plan, interval, currency) => Stripe Price ID.
--     This is the ONLY place a Stripe Price ID or a monetary amount is stored.
-- -----------------------------------------------------------------------------
create table if not exists public.plan_prices (
  id              uuid primary key default gen_random_uuid(),
  plan_id         uuid        not null references public.plans(id) on delete cascade,
  stripe_price_id text        not null,
  billing_interval text       not null,
  currency        char(3)     not null,
  unit_amount     integer     not null,   -- minor units (cents); 0 allowed for free
  is_active       boolean     not null default true,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint plan_prices_interval_valid check (billing_interval in ('month','year')),
  constraint plan_prices_currency_iso   check (currency ~ '^[A-Z]{3}$'),
  constraint plan_prices_amount_nonneg  check (unit_amount >= 0),
  constraint plan_prices_stripe_unique  unique (stripe_price_id),
  constraint plan_prices_slot_unique    unique (plan_id, billing_interval, currency)
);

create index if not exists plan_prices_plan_idx on public.plan_prices (plan_id) where is_active;

comment on table public.plan_prices is
  'Stripe Price IDs keyed by plan+interval+currency. Server resolves the price; client never sends one.';

-- -----------------------------------------------------------------------------
-- 4.3 features — the centralized catalog of entitlement keys.
-- -----------------------------------------------------------------------------
create table if not exists public.features (
  key         text primary key,
  description text not null,
  value_type  text not null,
  created_at  timestamptz not null default now(),
  constraint features_value_type_valid check (value_type in ('boolean','limit')),
  constraint features_key_format       check (key ~ '^[a-z][a-z0-9_]*(\\.[a-z0-9_]+)+$')
);

comment on table public.features is
  'Entitlement catalog. Adding a feature = 1 row here + plan_features rows. No page edits.';

-- -----------------------------------------------------------------------------
-- 4.4 plan_features — which plan grants which feature, and to what limit.
--     limit_value IS NULL  => unlimited.
--     0 / enabled=false    => not granted.
-- -----------------------------------------------------------------------------
create table if not exists public.plan_features (
  plan_id     uuid    not null references public.plans(id) on delete cascade,
  feature_key text    not null references public.features(key) on delete cascade,
  enabled     boolean not null default true,
  limit_value integer,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now(),
  primary key (plan_id, feature_key),
  constraint plan_features_limit_nonneg check (limit_value is null or limit_value >= 0)
);

create index if not exists plan_features_feature_idx on public.plan_features (feature_key);

-- -----------------------------------------------------------------------------
-- 4.5 billing_customers — maps an AssetScout user to exactly one Stripe customer.
--     [VERIFY] if the existing `profiles` table already has a stripe_customer_id
--     column, REUSE that instead of adding this table.
-- -----------------------------------------------------------------------------
create table if not exists public.billing_customers (
  user_id             uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id  text not null,
  currency            char(3) not null default 'USD',
  country             char(2),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint billing_customers_stripe_unique unique (stripe_customer_id),
  constraint billing_customers_currency_iso  check (currency ~ '^[A-Z]{3}$')
);

comment on table public.billing_customers is
  'One Stripe customer per user. Created server-side lazily; ID is never accepted from the client.';

-- -----------------------------------------------------------------------------
-- 4.6 subscriptions — webhook-authoritative subscription mirror.
-- -----------------------------------------------------------------------------
create table if not exists public.subscriptions (
  id                     uuid primary key default gen_random_uuid(),
  user_id                uuid not null references auth.users(id) on delete cascade,
  plan_id                uuid not null references public.plans(id),
  plan_price_id          uuid references public.plan_prices(id),
  stripe_customer_id     text not null,
  stripe_subscription_id text not null,
  stripe_price_id        text not null,
  status                 text not null,
  currency               char(3) not null default 'USD',
  quantity               integer not null default 1,
  current_period_start   timestamptz,
  current_period_end     timestamptz,
  cancel_at_period_end   boolean not null default false,
  canceled_at            timestamptz,
  ended_at               timestamptz,          -- Stripe `ended_at` (terminal states)
  trial_start            timestamptz,
  trial_end              timestamptz,
  latest_invoice_id      text,
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint subscriptions_stripe_unique   unique (stripe_subscription_id),
  constraint subscriptions_status_valid    check (status in (
      'incomplete','incomplete_expired','trialing','active',
      'past_due','canceled','unpaid','paused'
  )),
  constraint subscriptions_quantity_pos    check (quantity > 0),
  constraint subscriptions_currency_iso    check (currency ~ '^[A-Z]{3}$'),
  constraint subscriptions_period_order    check (
      current_period_end is null or current_period_start is null
      or current_period_end >= current_period_start
  )
);

create index if not exists subscriptions_user_idx      on public.subscriptions (user_id);
create index if not exists subscriptions_status_idx    on public.subscriptions (status);
create index if not exists subscriptions_customer_idx  on public.subscriptions (stripe_customer_id);
create index if not exists subscriptions_period_end_idx on public.subscriptions (current_period_end);

-- Enforce AT MOST ONE live subscription per user. Prevents duplicate/parallel
-- subscriptions from double-granting entitlements.
create unique index if not exists subscriptions_one_live_per_user_idx
  on public.subscriptions (user_id)
  where status in ('active','trialing','past_due','paused');

comment on table public.subscriptions is
  'Webhook-authoritative mirror of Stripe subscriptions. Never written from the browser.';

-- -----------------------------------------------------------------------------
-- 4.7 invoices — one row per Stripe invoice (the authoritative paid amount).
--     Admin revenue reporting reads from here, NOT from estimates.
-- -----------------------------------------------------------------------------
create table if not exists public.invoices (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  subscription_id    uuid references public.subscriptions(id) on delete set null,
  plan_id            uuid references public.plans(id) on delete set null,
  stripe_invoice_id  text not null,
  stripe_customer_id text not null,
  status             text not null,          -- draft/open/paid/void/uncollectible
  currency           char(3) not null,
  amount_due         integer not null default 0,
  amount_paid        integer not null default 0,
  amount_remaining   integer not null default 0,
  billing_reason     text,                   -- subscription_create / subscription_cycle / …
  period_start       timestamptz,
  period_end         timestamptz,
  paid_at            timestamptz,
  hosted_invoice_url text,
  invoice_pdf        text,
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint invoices_stripe_unique  unique (stripe_invoice_id),
  constraint invoices_status_valid   check (status in ('draft','open','paid','void','uncollectible')),
  constraint invoices_amounts_nonneg check (
      amount_due >= 0 and amount_paid >= 0 and amount_remaining >= 0
  ),
  constraint invoices_currency_iso   check (currency ~ '^[A-Z]{3}$')
);

create index if not exists invoices_user_idx     on public.invoices (user_id);
create index if not exists invoices_paid_at_idx  on public.invoices (paid_at desc);
create index if not exists invoices_plan_idx     on public.invoices (plan_id);
create index if not exists invoices_period_idx   on public.invoices (period_start, period_end);

comment on table public.invoices is
  'Stripe invoices. MRR/ARR/revenue-by-plan are derived from these paid rows (actual revenue).';

-- -----------------------------------------------------------------------------
-- 4.8 payments — payment intents / charges (refunds, failures, reconciliation).
-- -----------------------------------------------------------------------------
create table if not exists public.payments (
  id                       uuid primary key default gen_random_uuid(),
  user_id                  uuid not null references auth.users(id) on delete cascade,
  subscription_id          uuid references public.subscriptions(id) on delete set null,
  invoice_id               uuid references public.invoices(id) on delete set null,
  stripe_payment_intent_id text,
  stripe_charge_id         text,
  stripe_invoice_id        text,
  amount                   integer not null,
  amount_refunded          integer not null default 0,
  currency                 char(3) not null,
  status                   text not null,   -- succeeded/pending/failed/refunded/partially_refunded
  failure_code             text,
  failure_message          text,
  paid_at                  timestamptz,
  created_at               timestamptz not null default now(),
  updated_at               timestamptz not null default now(),
  constraint payments_intent_unique unique (stripe_payment_intent_id),
  constraint payments_charge_unique unique (stripe_charge_id),
  constraint payments_status_valid  check (status in (
      'pending','succeeded','failed','refunded','partially_refunded'
  )),
  constraint payments_amounts_ok    check (amount >= 0 and amount_refunded >= 0),
  constraint payments_currency_iso  check (currency ~ '^[A-Z]{3}$')
);

create index if not exists payments_user_idx          on public.payments (user_id);
create index if not exists payments_status_idx        on public.payments (status);
create index if not exists payments_invoice_id_idx    on public.payments (stripe_invoice_id);
create index if not exists payments_paid_at_idx       on public.payments (paid_at desc);

comment on table public.payments is
  'Payment-level records. Mirrors Stripe; no card data is ever stored (PCI scope avoided via Checkout).';

-- -----------------------------------------------------------------------------
-- 4.9 stripe_events — the idempotency ledger. THE critical table.
--     UNIQUE(stripe_event_id) is what makes webhook processing idempotent.
-- -----------------------------------------------------------------------------
create table if not exists public.stripe_events (
  id               uuid primary key default gen_random_uuid(),
  stripe_event_id  text not null,
  type             text not null,
  api_version      text,
  livemode         boolean not null default false,
  account_id       text,                    -- reserved for future Connect use
  payload          jsonb,                   -- MINIMAL: ids/statuses only (data minimisation)
  status           text not null default 'received',
  attempts         integer not null default 0,
  processing_error text,
  processed_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint stripe_events_event_unique unique (stripe_event_id),
  constraint stripe_events_status_valid check (status in (
      'received','processed','failed','ignored'
  )),
  constraint stripe_events_attempts_nonneg check (attempts >= 0)
);

create index if not exists stripe_events_type_idx       on public.stripe_events (type);
create index if not exists stripe_events_status_idx     on public.stripe_events (status);
create index if not exists stripe_events_created_at_idx on public.stripe_events (created_at desc);

comment on table public.stripe_events is
  'Idempotency ledger. Insert with ON CONFLICT (stripe_event_id) DO NOTHING; zero rows => duplicate => skip.';

-- -----------------------------------------------------------------------------
-- 4.10 entitlement_overrides — admin-granted comps / enterprise provisioning.
--      Gives support a way to grant access WITHOUT faking a Stripe subscription.
-- -----------------------------------------------------------------------------
create table if not exists public.entitlement_overrides (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  feature_key  text not null references public.features(key) on delete cascade,
  enabled      boolean not null default true,
  limit_value  integer,
  reason       text not null,                      -- required: audit trail
  granted_by   uuid references auth.users(id) on delete set null,
  expires_at   timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint entitlement_overrides_limit_nonneg check (limit_value is null or limit_value >= 0),
  constraint entitlement_overrides_window check (
      expires_at is null or expires_at > created_at
  )
);

create index if not exists entitlement_overrides_user_idx
  on public.entitlement_overrides (user_id)
  where revoked_at is null;

comment on table public.entitlement_overrides is
  'Manual grants (comps, enterprise deals, support fixes). Honest alternative to faking Stripe state.';

