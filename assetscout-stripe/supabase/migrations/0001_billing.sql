-- =============================================================================
-- AssetScout — 0001_billing.sql
-- Plans, entitlements, Stripe mirrors, idempotency ledger and `profiles`.
--
-- Mirrors ASSETSCOUT_STRIPE_SCHEMA.sql (the agreed contract). Deviations are
-- called out inline with `DEVIATION:` and are additive only.
--
-- Conventions
--   * money = integer minor units (never floats)
--   * RLS on every table; clients read only their own user-owned rows
--   * writes to billing state come from the Stripe webhook (service role) only
--   * idempotent: safe to re-run
-- =============================================================================

create extension if not exists "pgcrypto";

-- -----------------------------------------------------------------------------
-- Shared helpers
-- -----------------------------------------------------------------------------
create or replace function public.touch_updated_at()
returns trigger
language plpgsql
as $$
begin
  new.updated_at := now();
  return new;
end;
$$;

-- -----------------------------------------------------------------------------
-- 3.1 profiles — role/authorisation record. Auto-created for every auth user.
--     `role` is the ONLY authorisation primitive in the app (spec §22 / §8.1.5).
-- -----------------------------------------------------------------------------
create table if not exists public.profiles (
  id           uuid primary key references auth.users(id) on delete cascade,
  email        text,
  display_name text,
  role         text not null default 'member',
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint profiles_role_valid check (role in ('member','admin'))
);

comment on table public.profiles is
  'One row per auth user. `role` gates /admin surfaces; only the service-role client may change it.';

drop trigger if exists profiles_touch on public.profiles;
create trigger profiles_touch before update on public.profiles
  for each row execute function public.touch_updated_at();

-- The FIRST user to sign up becomes the admin, so a fresh deployment has an
-- operator without manual SQL. Later sign-ups are plain members.
create or replace function public.handle_new_user()
returns trigger
language plpgsql
security definer
set search_path = public
as $$
declare
  v_role text := 'member';
begin
  if not exists (select 1 from public.profiles) then
    v_role := 'admin';
  end if;

  insert into public.profiles (id, email, role)
  values (new.id, new.email, v_role)
  on conflict (id) do update set email = excluded.email;

  return new;
end;
$$;

drop trigger if exists on_auth_user_created on auth.users;
create trigger on_auth_user_created
  after insert on auth.users
  for each row execute function public.handle_new_user();

-- SECURITY DEFINER avoids the "profiles policy reads profiles" recursion that
-- would otherwise break every admin check.
create or replace function public.is_admin(p_user_id uuid)
returns boolean
language sql
stable
security definer
set search_path = public
as $$
  select exists (
    select 1 from public.profiles p
    where p.id = p_user_id and p.role = 'admin'
  );
$$;

-- -----------------------------------------------------------------------------
-- 4.1 plans — catalog of tiers. Prices are NOT columns here (see plan_prices).
-- -----------------------------------------------------------------------------
create table if not exists public.plans (
  id           uuid primary key default gen_random_uuid(),
  key          text        not null,
  name         text        not null,
  tagline      text,
  tier         integer     not null default 0,
  is_public    boolean     not null default true,
  is_active    boolean     not null default true,
  requires_sales_contact boolean not null default false,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint plans_key_unique  unique (key),
  constraint plans_key_format  check (key ~ '^[a-z][a-z0-9_]{1,30}$'),
  constraint plans_tier_nonneg check (tier >= 0)
);

comment on table public.plans is
  'Central plan catalog. Display names/prices/limits are data, never hard-coded in components.';

drop trigger if exists plans_touch on public.plans;
create trigger plans_touch before update on public.plans
  for each row execute function public.touch_updated_at();

-- -----------------------------------------------------------------------------
-- 4.2 plan_prices — one row per (plan, interval, currency) => Stripe Price ID.
--     The ONLY place a Stripe Price ID or a monetary amount is stored.
--     Populate with `npm run billing:sync` (reads Stripe, writes here).
-- -----------------------------------------------------------------------------
create table if not exists public.plan_prices (
  id               uuid primary key default gen_random_uuid(),
  plan_id          uuid        not null references public.plans(id) on delete cascade,
  stripe_price_id  text        not null,
  billing_interval text        not null,
  currency         char(3)     not null,
  unit_amount      integer     not null,
  is_active        boolean     not null default true,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint plan_prices_interval_valid check (billing_interval in ('month','year')),
  constraint plan_prices_currency_iso   check (currency ~ '^[A-Z]{3}$'),
  constraint plan_prices_amount_nonneg  check (unit_amount >= 0),
  constraint plan_prices_stripe_unique  unique (stripe_price_id),
  constraint plan_prices_slot_unique    unique (plan_id, billing_interval, currency)
);

create index if not exists plan_prices_plan_idx on public.plan_prices (plan_id) where is_active;

comment on table public.plan_prices is
  'Stripe Price IDs keyed by plan+interval+currency. Server resolves the price; client never sends one.';

drop trigger if exists plan_prices_touch on public.plan_prices;
create trigger plan_prices_touch before update on public.plan_prices
  for each row execute function public.touch_updated_at();

-- DEVIATION (hardening, additive): a Stripe Price ID must never reach a browser.
-- Postgres RLS is row-level, so the base table is locked down and a column-safe
-- view is exposed instead. The API layer also strips the column.
-- DEVIATION (hardening, additive): a Stripe Price ID must never reach a browser.
-- Postgres RLS is row-level, not column-level, so the base table is locked down
-- (REVOKE + deny-by-default RLS) and a fixed-projection view is exposed instead.
-- The view has no user-supplied SQL and selects a constant column list, so the
-- definer semantics carry no injection surface. The API layer strips the column
-- too, so there are two independent barriers.
create or replace view public.public_plan_prices as
  select id, plan_id, billing_interval, currency, unit_amount, is_active
  from public.plan_prices;

comment on view public.public_plan_prices is
  'Client-safe projection of plan_prices. Deliberately omits stripe_price_id.';

-- -----------------------------------------------------------------------------
-- 4.3 features — centralized catalog of entitlement keys.
-- -----------------------------------------------------------------------------
create table if not exists public.features (
  key         text primary key,
  description text not null,
  value_type  text not null,
  created_at  timestamptz not null default now(),
  constraint features_value_type_valid check (value_type in ('boolean','limit')),
  constraint features_key_format       check (key ~ '^[a-z][a-z0-9_]*(\.[a-z0-9_]+)+$')
);

comment on table public.features is
  'Entitlement catalog. Adding a feature = 1 row here + plan_features rows. No page edits.';

-- -----------------------------------------------------------------------------
-- 4.4 plan_features — which plan grants which feature, and to what limit.
--     limit_value IS NULL => unlimited; enabled = false => not granted.
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
-- -----------------------------------------------------------------------------
create table if not exists public.billing_customers (
  user_id            uuid primary key references auth.users(id) on delete cascade,
  stripe_customer_id text not null,
  currency           char(3) not null default 'USD',
  country            char(2),
  created_at         timestamptz not null default now(),
  updated_at         timestamptz not null default now(),
  constraint billing_customers_stripe_unique unique (stripe_customer_id),
  constraint billing_customers_currency_iso  check (currency ~ '^[A-Z]{3}$')
);

comment on table public.billing_customers is
  'One Stripe customer per user. Created server-side lazily; the ID is never accepted from the client.';

drop trigger if exists billing_customers_touch on public.billing_customers;
create trigger billing_customers_touch before update on public.billing_customers
  for each row execute function public.touch_updated_at();

-- -----------------------------------------------------------------------------
-- 4.6 subscriptions — webhook-authoritative mirror of Stripe subscriptions.
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
  ended_at               timestamptz,
  trial_start            timestamptz,
  trial_end              timestamptz,
  latest_invoice_id      text,
  checkout_session_id    text,
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

create index if not exists subscriptions_user_idx       on public.subscriptions (user_id);
create index if not exists subscriptions_status_idx     on public.subscriptions (status);
create index if not exists subscriptions_customer_idx   on public.subscriptions (stripe_customer_id);
create index if not exists subscriptions_period_end_idx on public.subscriptions (current_period_end);

-- AT MOST ONE live subscription per user: prevents parallel subscriptions from
-- double-granting entitlements.
create unique index if not exists subscriptions_one_live_per_user_idx
  on public.subscriptions (user_id)
  where status in ('active','trialing','past_due','paused');

comment on table public.subscriptions is
  'Webhook-authoritative mirror of Stripe subscriptions. Never written from the browser.';

drop trigger if exists subscriptions_touch on public.subscriptions;
create trigger subscriptions_touch before update on public.subscriptions
  for each row execute function public.touch_updated_at();

-- -----------------------------------------------------------------------------
-- 4.7 invoices — one row per Stripe invoice (the authoritative paid amount).
-- -----------------------------------------------------------------------------
create table if not exists public.invoices (
  id                 uuid primary key default gen_random_uuid(),
  user_id            uuid not null references auth.users(id) on delete cascade,
  subscription_id    uuid references public.subscriptions(id) on delete set null,
  plan_id            uuid references public.plans(id) on delete set null,
  stripe_invoice_id  text not null,
  stripe_customer_id text not null,
  status             text not null,
  currency           char(3) not null,
  amount_due         integer not null default 0,
  amount_paid        integer not null default 0,
  amount_remaining   integer not null default 0,
  billing_reason     text,
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

create index if not exists invoices_user_idx    on public.invoices (user_id);
create index if not exists invoices_paid_at_idx on public.invoices (paid_at desc);
create index if not exists invoices_plan_idx    on public.invoices (plan_id);

comment on table public.invoices is
  'Stripe invoices. MRR/ARR/revenue-by-plan are derived from these paid rows (actual revenue).';

drop trigger if exists invoices_touch on public.invoices;
create trigger invoices_touch before update on public.invoices
  for each row execute function public.touch_updated_at();

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
  checkout_session_id      text,
  amount                   integer not null,
  amount_refunded          integer not null default 0,
  currency                 char(3) not null,
  status                   text not null,
  failure_code             text,
  failure_message           text,
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
create index if not exists payments_checkout_idx      on public.payments (checkout_session_id);

comment on table public.payments is
  'Payment-level records. Mirrors Stripe; no card data is ever stored (PCI scope avoided via Checkout).';

drop trigger if exists payments_touch on public.payments;
create trigger payments_touch before update on public.payments
  for each row execute function public.touch_updated_at();

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
  account_id       text,
  payload          jsonb,   -- MINIMAL: ids/statuses only (data minimisation)
  status           text not null default 'received',
  attempts         integer not null default 0,
  processing_error text,
  processed_at     timestamptz,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  constraint stripe_events_event_unique    unique (stripe_event_id),
  constraint stripe_events_status_valid    check (status in ('received','processed','failed','ignored')),
  constraint stripe_events_attempts_nonneg check (attempts >= 0)
);

create index if not exists stripe_events_type_idx       on public.stripe_events (type);
create index if not exists stripe_events_status_idx     on public.stripe_events (status);
create index if not exists stripe_events_created_at_idx on public.stripe_events (created_at desc);

comment on table public.stripe_events is
  'Idempotency ledger. Insert with ON CONFLICT (stripe_event_id) DO NOTHING; zero rows => duplicate => skip.';

-- -----------------------------------------------------------------------------
-- 4.10 entitlement_overrides — admin-granted comps / enterprise provisioning.
--      Support can grant access WITHOUT faking a Stripe subscription.
-- -----------------------------------------------------------------------------
create table if not exists public.entitlement_overrides (
  id           uuid primary key default gen_random_uuid(),
  user_id      uuid not null references auth.users(id) on delete cascade,
  feature_key  text not null references public.features(key) on delete cascade,
  enabled      boolean not null default true,
  limit_value  integer,
  reason       text not null,
  granted_by   uuid references auth.users(id) on delete set null,
  expires_at   timestamptz,
  revoked_at   timestamptz,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  constraint entitlement_overrides_limit_nonneg check (limit_value is null or limit_value >= 0),
  constraint entitlement_overrides_window       check (expires_at is null or expires_at > created_at)
);

create index if not exists entitlement_overrides_user_idx
  on public.entitlement_overrides (user_id)
  where revoked_at is null;

comment on table public.entitlement_overrides is
  'Manual grants (comps, enterprise deals, support fixes). Honest alternative to faking Stripe state.';

drop trigger if exists entitlement_overrides_touch on public.entitlement_overrides;
create trigger entitlement_overrides_touch before update on public.entitlement_overrides
  for each row execute function public.touch_updated_at();

-- -----------------------------------------------------------------------------
-- 4.11 feature_usage — ADDITIVE (not in the original doc).
--      Per-user, per-period counter that makes `limit` entitlements real
--      (contracts §8.1 rule 3). Written only by consume_feature_usage().
-- -----------------------------------------------------------------------------
create table if not exists public.feature_usage (
  user_id      uuid not null references auth.users(id) on delete cascade,
  feature_key  text not null references public.features(key) on delete cascade,
  period_start timestamptz not null,
  used         integer not null default 0,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now(),
  primary key (user_id, feature_key, period_start),
  constraint feature_usage_used_nonneg check (used >= 0)
);

-- -----------------------------------------------------------------------------
-- 4.12 consume_feature_usage() — race-safe check-and-increment.
--      The limit test lives INSIDE the UPDATE predicate so two concurrent
--      requests can never both pass it. Never increment from TypeScript.
-- -----------------------------------------------------------------------------
create or replace function public.consume_feature_usage(
  p_user_id     uuid,
  p_feature_key text,
  p_limit       integer,
  p_cost        integer default 1
)
returns table (allowed boolean, used integer)
language plpgsql
security definer
set search_path = public
as $$
declare
  v_period_start timestamptz := date_trunc('month', now());
  v_cost         integer     := greatest(coalesce(p_cost, 1), 1);
  v_used         integer;
begin
  insert into public.feature_usage (user_id, feature_key, period_start, used)
  values (p_user_id, p_feature_key, v_period_start, 0)
  on conflict (user_id, feature_key, period_start) do nothing;

  update public.feature_usage fu
     set used = fu.used + v_cost,
         updated_at = now()
   where fu.user_id = p_user_id
     and fu.feature_key = p_feature_key
     and fu.period_start = v_period_start
     and (p_limit is null or fu.used + v_cost <= p_limit)
  returning fu.used into v_used;

  if v_used is null then
    select fu.used into v_used
      from public.feature_usage fu
     where fu.user_id = p_user_id
       and fu.feature_key = p_feature_key
       and fu.period_start = v_period_start;

    return query select false, coalesce(v_used, 0);
    return;
  end if;

  return query select true, v_used;
end;
$$;

comment on function public.consume_feature_usage(uuid, text, integer, integer) is
  'Atomic limit check + increment for one calendar month. p_limit NULL = unlimited.';

-- =============================================================================
-- 5. Row Level Security — deny by default, then allow the minimum.
--    Every billing write path is the Stripe webhook (service role), so no client
--    role gets INSERT/UPDATE/DELETE on any billing table.
-- =============================================================================
alter table public.profiles              enable row level security;
alter table public.plans                 enable row level security;
alter table public.plan_prices           enable row level security;
alter table public.features              enable row level security;
alter table public.plan_features         enable row level security;
alter table public.billing_customers     enable row level security;
alter table public.subscriptions         enable row level security;
alter table public.invoices              enable row level security;
alter table public.payments              enable row level security;
alter table public.stripe_events         enable row level security;
alter table public.entitlement_overrides enable row level security;
alter table public.feature_usage         enable row level security;

-- ---------------------------------------------------------------------------
-- 5.1 profiles — read your own row; admins read all. Never writable by clients.
-- ---------------------------------------------------------------------------
drop policy if exists profiles_select_own on public.profiles;
create policy profiles_select_own on public.profiles
  for select to authenticated
  using (id = (select auth.uid()));

drop policy if exists profiles_select_admin on public.profiles;
create policy profiles_select_admin on public.profiles
  for select to authenticated
  using (public.is_admin((select auth.uid())));

-- ---------------------------------------------------------------------------
-- 5.2 Catalog tables — public read of active+public rows.
-- ---------------------------------------------------------------------------
drop policy if exists plans_select_public on public.plans;
create policy plans_select_public on public.plans
  for select to anon, authenticated
  using (is_public and is_active);

drop policy if exists plans_select_admin on public.plans;
create policy plans_select_admin on public.plans
  for select to authenticated
  using (public.is_admin((select auth.uid())));

drop policy if exists features_select_all on public.features;
create policy features_select_all on public.features
  for select to anon, authenticated
  using (true);

drop policy if exists plan_features_select_all on public.plan_features;
create policy plan_features_select_all on public.plan_features
  for select to anon, authenticated
  using (true);

-- plan_prices deliberately has NO policy: clients cannot read it at all (they
-- read public_plan_prices instead). Service role bypasses RLS.
revoke all on public.plan_prices from anon, authenticated;
grant select on public.public_plan_prices to anon, authenticated;

-- ---------------------------------------------------------------------------
-- 5.3 User-owned billing rows — read your own; admins read all.
-- ---------------------------------------------------------------------------
drop policy if exists billing_customers_select_own on public.billing_customers;
create policy billing_customers_select_own on public.billing_customers
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists subscriptions_select_own on public.subscriptions;
create policy subscriptions_select_own on public.subscriptions
  for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin((select auth.uid())));

drop policy if exists invoices_select_own on public.invoices;
create policy invoices_select_own on public.invoices
  for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin((select auth.uid())));

drop policy if exists payments_select_own on public.payments;
create policy payments_select_own on public.payments
  for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin((select auth.uid())));

drop policy if exists feature_usage_select_own on public.feature_usage;
create policy feature_usage_select_own on public.feature_usage
  for select to authenticated
  using (user_id = (select auth.uid()) or public.is_admin((select auth.uid())));

-- ---------------------------------------------------------------------------
-- 5.4 Tables with NO client access at all.
-- ---------------------------------------------------------------------------
revoke all on public.stripe_events         from anon, authenticated;
revoke all on public.entitlement_overrides from anon, authenticated;

-- Defence in depth: no client role may write billing state even if a future
-- migration adds a permissive policy by mistake.
revoke insert, update, delete on public.profiles,
  public.plans, public.features, public.plan_features, public.billing_customers,
  public.subscriptions, public.invoices, public.payments, public.feature_usage
  from anon, authenticated;

grant select on public.profiles, public.plans, public.features, public.plan_features,
  public.billing_customers, public.subscriptions, public.invoices, public.payments,
  public.feature_usage
  to authenticated;
grant select on public.plans, public.features, public.plan_features to anon;

grant execute on function public.is_admin(uuid) to authenticated;
grant execute on function public.consume_feature_usage(uuid, text, integer, integer) to service_role;
