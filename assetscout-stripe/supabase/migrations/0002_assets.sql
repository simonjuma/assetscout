-- =============================================================================
-- AssetScout — 0002_assets.sql
-- Ingestion provenance, normalized assets, verification, scoring and the
-- user-action tables (watchlist + acquisition pipeline).
--
-- Pipeline this schema serves:
--   Source -> Fetch -> Validate -> Normalize -> Deduplicate -> Supabase
--          -> Verify -> Score/Analyze -> Search/Discovery -> Asset Detail -> User Action
--
-- Honesty rules encoded here:
--   * provenance is first-class (asset_sources), never a text blob on the asset
--   * `verification_status` distinguishes discovered/unverified data from
--     authoritative, re-checked data
--   * a score records its factor breakdown and its evidence coverage, so the UI
--     can never present an unsupported number as fact
-- =============================================================================

-- -----------------------------------------------------------------------------
-- 5.1 sources — the provider catalog. One row per module under
--     src/lib/ingest/providers. `requires_auth` + `required_env_vars` document
--     exactly which credential a source needs (never the value).
-- -----------------------------------------------------------------------------
create table if not exists public.sources (
  id                      uuid primary key default gen_random_uuid(),
  key                     text not null,
  name                    text not null,
  kind                    text not null,
  description             text not null,
  homepage_url            text not null,
  api_doc_url             text,
  terms_url               text,
  license                 text,
  terms_note              text,
  requires_auth           boolean not null default false,
  required_env_vars       text[] not null default '{}',
  robots_policy           text not null default 'respect',
  is_enabled              boolean not null default true,
  min_interval_ms         integer not null default 1000,
  max_requests_per_minute integer not null default 30,
  created_at              timestamptz not null default now(),
  updated_at              timestamptz not null default now(),
  constraint sources_key_unique   unique (key),
  constraint sources_key_format   check (key ~ '^[a-z][a-z0-9_-]{1,40}$'),
  constraint sources_kind_valid   check (kind in (
      'domain_registry','website','historical_index','signal_feed',
      'business_registry','trademark_registry','manual_registry'
  )),
  constraint sources_robots_valid check (robots_policy in ('respect','api_only')),
  constraint sources_interval_pos check (min_interval_ms >= 0),
  constraint sources_rate_pos     check (max_requests_per_minute >= 0)
);

comment on table public.sources is
  'Provider catalog. Adding a source = one provider module + one row here. Credentials stay in env.';

drop trigger if exists sources_touch on public.sources;
create trigger sources_touch before update on public.sources
  for each row execute function public.touch_updated_at();

-- -----------------------------------------------------------------------------
-- 5.2 ingestion_runs — one row per invocation, with per-stage counters.
-- -----------------------------------------------------------------------------
create table if not exists public.ingestion_runs (
  id              uuid primary key default gen_random_uuid(),
  source_key      text not null references public.sources(key) on delete cascade,
  mode            text not null default 'manual',
  status          text not null default 'running',
  query           jsonb not null default '{}'::jsonb,
  correlation_id  text not null,
  initiated_by    uuid references auth.users(id) on delete set null,
  started_at      timestamptz not null default now(),
  finished_at     timestamptz,
  items_fetched   integer not null default 0,
  items_valid     integer not null default 0,
  items_new       integer not null default 0,
  items_updated   integer not null default 0,
  items_duplicate integer not null default 0,
  items_rejected  integer not null default 0,
  error_count     integer not null default 0,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint ingestion_runs_mode_valid   check (mode in ('manual','cron','admin')),
  constraint ingestion_runs_status_valid check (status in ('running','succeeded','partial','failed')),
  constraint ingestion_runs_counters_ok  check (
      items_fetched >= 0 and items_valid >= 0 and items_new >= 0 and items_updated >= 0
      and items_duplicate >= 0 and items_rejected >= 0 and error_count >= 0
  )
);

create index if not exists ingestion_runs_source_idx on public.ingestion_runs (source_key, started_at desc);
create index if not exists ingestion_runs_status_idx on public.ingestion_runs (status);

comment on table public.ingestion_runs is
  'Per-invocation ingestion telemetry. `error_count > 0` with status `partial` means re-check.';

drop trigger if exists ingestion_runs_touch on public.ingestion_runs;
create trigger ingestion_runs_touch before update on public.ingestion_runs
  for each row execute function public.touch_updated_at();

-- -----------------------------------------------------------------------------
-- 5.3 ingestion_errors — sanitized failure log (no secrets, no response bodies).
-- -----------------------------------------------------------------------------
create table if not exists public.ingestion_errors (
  id         uuid primary key default gen_random_uuid(),
  run_id     uuid not null references public.ingestion_runs(id) on delete cascade,
  source_key text not null,
  stage      text not null,
  code       text not null,
  message    text not null,
  context    jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now(),
  constraint ingestion_errors_stage_valid check (stage in (
      'configure','fetch','validate','normalize','dedupe','persist','verify','score'
  ))
);

create index if not exists ingestion_errors_run_idx  on public.ingestion_errors (run_id);
create index if not exists ingestion_errors_code_idx on public.ingestion_errors (code);

comment on table public.ingestion_errors is
  'Sanitized ingestion failures. message/context come from redactSecrets() — never raw response bodies.';

-- -----------------------------------------------------------------------------
-- 5.4 assets — the normalized, deduplicated opportunity.
--     `dedupe_key` is the identity used by the dedupe stage; UNIQUE(kind,
--     dedupe_key) is what makes re-ingestion idempotent.
--     score_* columns are a denormalized cache of the newest asset_scores row so
--     search/sort/filter stay index-only (kept in sync by the scoring stage).
-- -----------------------------------------------------------------------------
create table if not exists public.assets (
  id                  uuid primary key default gen_random_uuid(),
  kind                text not null,
  dedupe_key          text not null,
  name                text not null,
  identifier          text not null,
  url                 text,
  tld                 text,
  country             char(2),
  industry            text,
  niche               text,
  status              text not null default 'unknown',
  acquisition_route   text,
  estimated_cost_min  integer,
  estimated_cost_max  integer,
  cost_currency       char(3) default 'USD',
  risk_level          text not null default 'unknown',
  verification_status text not null default 'unverified',
  is_published        boolean not null default true,
  monetization        jsonb not null default '[]'::jsonb,
  attributes          jsonb not null default '{}'::jsonb,
  score_total              integer,
  score_classification     text,
  score_evidence_coverage  integer,
  score_version            text,
  first_seen_at       timestamptz not null default now(),
  last_ingested_at    timestamptz not null default now(),
  last_verified_at    timestamptz,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  search_vector       tsvector generated always as (
      to_tsvector('english',
        coalesce(name, '') || ' ' || coalesce(identifier, '') || ' ' ||
        coalesce(industry, '') || ' ' || coalesce(niche, '') || ' ' ||
        coalesce(country, '') || ' ' || coalesce(status, ''))
  ) stored,
  constraint assets_kind_valid check (kind in (
      'domain','website','saas','digital_business','digital_product','brand'
  )),
  constraint assets_status_valid check (status in (
      'active','potentially_inactive','expired','available','for_sale','auction',
      'struck_off','under_investigation','unknown','verification_required',
      'acquired','relaunching','monetizing','sold'
  )),
  constraint assets_risk_valid check (risk_level in ('low','medium','high','critical','unknown')),
  constraint assets_verification_valid check (verification_status in (
      'verified','partially_verified','unverified','verification_required'
  )),
  constraint assets_dedupe_unique unique (kind, dedupe_key),
  constraint assets_score_range check (score_total is null or (score_total >= 0 and score_total <= 100)),
  constraint assets_coverage_range check (
      score_evidence_coverage is null or (score_evidence_coverage >= 0 and score_evidence_coverage <= 100)
  ),
  constraint assets_cost_order check (
      estimated_cost_min is null or estimated_cost_max is null or estimated_cost_max >= estimated_cost_min
  ),
  constraint assets_cost_nonneg check (
      (estimated_cost_min is null or estimated_cost_min >= 0)
      and (estimated_cost_max is null or estimated_cost_max >= 0)
  )
);

create index if not exists assets_kind_idx          on public.assets (kind, last_ingested_at desc);
create index if not exists assets_status_idx        on public.assets (status);
create index if not exists assets_verification_idx  on public.assets (verification_status);
create index if not exists assets_country_idx       on public.assets (country);
create index if not exists assets_industry_idx      on public.assets (industry);
create index if not exists assets_tld_idx           on public.assets (tld);
create index if not exists assets_score_idx         on public.assets (score_total desc nulls last);
create index if not exists assets_published_idx     on public.assets (is_published, last_ingested_at desc);
create index if not exists assets_search_idx        on public.assets using gin (search_vector);

comment on table public.assets is
  'Normalized digital-asset opportunities. UNIQUE(kind, dedupe_key) makes re-ingestion idempotent.';

drop trigger if exists assets_touch on public.assets;
create trigger assets_touch before update on public.assets
  for each row execute function public.touch_updated_at();

-- -----------------------------------------------------------------------------
-- 5.5 asset_sources — provenance. Every fact about an asset traces to a row here
--     storing the source, the exact URL fetched, the discovery timestamp and the
--     last verification timestamp (spec §7: source, source URL, discovery date,
--     last verification date, verification status).
-- -----------------------------------------------------------------------------
create table if not exists public.asset_sources (
  id                  uuid primary key default gen_random_uuid(),
  asset_id            uuid not null references public.assets(id) on delete cascade,
  source_key          text not null references public.sources(key) on delete cascade,
  source_url          text not null,
  source_record_id    text,
  discovery_method    text not null default 'provider_query',
  confidence          text not null default 'unknown',
  observed_at         timestamptz not null default now(),
  last_verified_at    timestamptz,
  verification_status text not null default 'unverified',
  raw_excerpt         jsonb not null default '{}'::jsonb,
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint asset_sources_method_valid check (discovery_method in (
      'provider_query','candidate_check','manual'
  )),
  constraint asset_sources_confidence_valid check (confidence in (
      'authoritative','registry','provider_claim','signal','unknown'
  )),
  constraint asset_sources_verification_valid check (verification_status in (
      'verified','partially_verified','unverified','verification_required'
  )),
  constraint asset_sources_unique unique (asset_id, source_key, source_url)
);

create index if not exists asset_sources_asset_idx      on public.asset_sources (asset_id);
create index if not exists asset_sources_source_idx     on public.asset_sources (source_key);
create index if not exists asset_sources_verified_idx   on public.asset_sources (verification_status);
create index if not exists asset_sources_observed_idx   on public.asset_sources (observed_at desc);

comment on table public.asset_sources is
  'Provenance: source key, exact source URL, discovery timestamp, last-verified timestamp, status.';

drop trigger if exists asset_sources_touch on public.asset_sources;
create trigger asset_sources_touch before update on public.asset_sources
  for each row execute function public.touch_updated_at();

-- -----------------------------------------------------------------------------
-- 5.6 asset_verifications — the Verification Center (spec §6). One row per check,
--     upserted on (asset_id, check_key) with the evidence URL that proves it.
-- -----------------------------------------------------------------------------
create table if not exists public.asset_verifications (
  id                  uuid primary key default gen_random_uuid(),
  asset_id            uuid not null references public.assets(id) on delete cascade,
  check_key           text not null,
  category            text not null,
  status              text not null,
  method              text not null,
  evidence_url        text,
  evidence            jsonb not null default '{}'::jsonb,
  source_key          text references public.sources(key) on delete set null,
  check_version       text,
  checked_at          timestamptz not null default now(),
  created_at          timestamptz not null default now(),
  updated_at          timestamptz not null default now(),
  constraint asset_verifications_category_valid check (category in (
      'domain','business','trademark','website','ownership','risk'
  )),
  constraint asset_verifications_status_valid check (status in (
      'verified','failed','inconclusive','not_checked','requires_manual_research'
  )),
  constraint asset_verifications_method_valid check (method in (
      'api','registry_lookup','manual','not_available'
  )),
  constraint asset_verifications_unique unique (asset_id, check_key)
);

create index if not exists asset_verifications_asset_idx  on public.asset_verifications (asset_id);
create index if not exists asset_verifications_status_idx on public.asset_verifications (status);
create index if not exists asset_verifications_cat_idx    on public.asset_verifications (category);

comment on table public.asset_verifications is
  'Verification Center results. A failed check never removes an asset; it changes the badge and the risk note.';

drop trigger if exists asset_verifications_touch on public.asset_verifications;
create trigger asset_verifications_touch before update on public.asset_verifications
  for each row execute function public.touch_updated_at();

-- -----------------------------------------------------------------------------
-- 5.7 asset_scores — transparent 0-100 scoring (spec §4). Stores every factor,
--     the weight that applied, and the share of the total weight that had real
--     evidence (`evidence_coverage`). A score is never presented as a valuation.
-- -----------------------------------------------------------------------------
create table if not exists public.asset_scores (
  id                     uuid primary key default gen_random_uuid(),
  asset_id               uuid not null references public.assets(id) on delete cascade,
  version                text not null,
  total                  integer not null,
  classification         text not null,
  brand_potential        integer,
  domain_quality         integer,
  market_demand          integer,
  monetization_potential integer,
  competition            integer,
  legal_clarity          integer,
  acquisition_cost       integer,
  weight_total           integer not null,
  evidence_coverage      integer not null,
  factors                jsonb not null default '[]'::jsonb,
  computed_at            timestamptz not null default now(),
  created_at             timestamptz not null default now(),
  updated_at             timestamptz not null default now(),
  constraint asset_scores_total_range  check (total >= 0 and total <= 100),
  constraint asset_scores_coverage_range check (evidence_coverage >= 0 and evidence_coverage <= 100),
  constraint asset_scores_weight_ok    check (weight_total >= 0),
  constraint asset_scores_class_valid  check (classification in (
      'exceptional','high_potential','good_potential','moderate','low_potential'
  )),
  constraint asset_scores_unique unique (asset_id, version)
);

create index if not exists asset_scores_asset_idx on public.asset_scores (asset_id, computed_at desc);
create index if not exists asset_scores_total_idx on public.asset_scores (total desc);

comment on table public.asset_scores is
  'Transparent score breakdown. factors[] explains every point; evidence_coverage states how much was actually known.';

drop trigger if exists asset_scores_touch on public.asset_scores;
create trigger asset_scores_touch before update on public.asset_scores
  for each row execute function public.touch_updated_at();

-- -----------------------------------------------------------------------------
-- 5.8 watchlist_items — the primary user action (spec §18). Also carries the
--     acquisition pipeline stage (spec §11) so one row = one tracked opportunity.
-- -----------------------------------------------------------------------------
create table if not exists public.watchlist_items (
  id              uuid primary key default gen_random_uuid(),
  user_id         uuid not null references auth.users(id) on delete cascade,
  asset_id        uuid not null references public.assets(id) on delete cascade,
  notes           text,
  target_price    integer,
  target_currency char(3) not null default 'USD',
  stage           text not null default 'discovered',
  reminder_at     timestamptz,
  created_at      timestamptz not null default now(),
  updated_at      timestamptz not null default now(),
  constraint watchlist_stage_valid check (stage in (
      'discovered','researching','verification','contacted_owner','negotiating',
      'acquired','relaunching','monetizing','sold','rejected'
  )),
  constraint watchlist_target_nonneg check (target_price is null or target_price >= 0),
  constraint watchlist_unique unique (user_id, asset_id)
);

create index if not exists watchlist_user_idx  on public.watchlist_items (user_id, updated_at desc);
create index if not exists watchlist_asset_idx on public.watchlist_items (asset_id);
create index if not exists watchlist_stage_idx on public.watchlist_items (user_id, stage);

comment on table public.watchlist_items is
  'Saved opportunities + acquisition pipeline stage. One row per (user, asset).';

drop trigger if exists watchlist_items_touch on public.watchlist_items;
create trigger watchlist_items_touch before update on public.watchlist_items
  for each row execute function public.touch_updated_at();

-- -----------------------------------------------------------------------------
-- 5.9 pipeline_events — append-only audit of user pipeline transitions.
-- -----------------------------------------------------------------------------
create table if not exists public.pipeline_events (
  id          uuid primary key default gen_random_uuid(),
  user_id     uuid not null references auth.users(id) on delete cascade,
  asset_id    uuid not null references public.assets(id) on delete cascade,
  from_stage  text,
  to_stage    text not null,
  note        text,
  created_at  timestamptz not null default now()
);

create index if not exists pipeline_events_user_idx  on public.pipeline_events (user_id, created_at desc);
create index if not exists pipeline_events_asset_idx on public.pipeline_events (asset_id, created_at desc);

comment on table public.pipeline_events is
  'Append-only pipeline audit trail. Written by the watchlist route only (own rows).';

-- =============================================================================
-- 6. Row Level Security for asset tables.
--    Discovery data is public (it is published registry/marketplace data);
--    user actions are strictly per-user.
-- =============================================================================
alter table public.sources             enable row level security;
alter table public.ingestion_runs      enable row level security;
alter table public.ingestion_errors    enable row level security;
alter table public.assets              enable row level security;
alter table public.asset_sources       enable row level security;
alter table public.asset_verifications enable row level security;
alter table public.asset_scores        enable row level security;
alter table public.watchlist_items     enable row level security;
alter table public.pipeline_events     enable row level security;

-- ---------------------------------------------------------------------------
-- 6.1 Published discovery data — readable by anon + authenticated.
--     Writes are service-role only (the ingestion runner), so no client policy.
-- ---------------------------------------------------------------------------
drop policy if exists sources_select_all on public.sources;
create policy sources_select_all on public.sources
  for select to anon, authenticated
  using (is_enabled);

drop policy if exists assets_select_published on public.assets;
create policy assets_select_published on public.assets
  for select to anon, authenticated
  using (is_published);

drop policy if exists asset_sources_select_published on public.asset_sources;
create policy asset_sources_select_published on public.asset_sources
  for select to anon, authenticated
  using (
    exists (
      select 1 from public.assets a
      where a.id = asset_sources.asset_id and a.is_published
    )
  );

drop policy if exists asset_verifications_select_published on public.asset_verifications;
create policy asset_verifications_select_published on public.asset_verifications
  for select to anon, authenticated
  using (
    exists (
      select 1 from public.assets a
      where a.id = asset_verifications.asset_id and a.is_published
    )
  );

drop policy if exists asset_scores_select_published on public.asset_scores;
create policy asset_scores_select_published on public.asset_scores
  for select to anon, authenticated
  using (
    exists (
      select 1 from public.assets a
      where a.id = asset_scores.asset_id and a.is_published
    )
  );

-- Ingestion telemetry is operator-only: service role, or an admin session.
drop policy if exists ingestion_runs_select_admin on public.ingestion_runs;
create policy ingestion_runs_select_admin on public.ingestion_runs
  for select to authenticated
  using (public.is_admin((select auth.uid())));

drop policy if exists ingestion_errors_select_admin on public.ingestion_errors;
create policy ingestion_errors_select_admin on public.ingestion_errors
  for select to authenticated
  using (public.is_admin((select auth.uid())));

-- ---------------------------------------------------------------------------
-- 6.2 User actions — strictly the owner's rows.
-- ---------------------------------------------------------------------------
drop policy if exists watchlist_select_own on public.watchlist_items;
create policy watchlist_select_own on public.watchlist_items
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists watchlist_insert_own on public.watchlist_items;
create policy watchlist_insert_own on public.watchlist_items
  for insert to authenticated
  with check (user_id = (select auth.uid()));

drop policy if exists watchlist_update_own on public.watchlist_items;
create policy watchlist_update_own on public.watchlist_items
  for update to authenticated
  using (user_id = (select auth.uid()))
  with check (user_id = (select auth.uid()));

drop policy if exists watchlist_delete_own on public.watchlist_items;
create policy watchlist_delete_own on public.watchlist_items
  for delete to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists pipeline_events_select_own on public.pipeline_events;
create policy pipeline_events_select_own on public.pipeline_events
  for select to authenticated
  using (user_id = (select auth.uid()));

drop policy if exists pipeline_events_insert_own on public.pipeline_events;
create policy pipeline_events_insert_own on public.pipeline_events
  for insert to authenticated
  with check (user_id = (select auth.uid()));

-- ---------------------------------------------------------------------------
-- 6.3 Grantee hygiene — no client role may write discovery data.
-- ---------------------------------------------------------------------------
revoke insert, update, delete on public.sources, public.ingestion_runs,
  public.ingestion_errors, public.assets, public.asset_sources,
  public.asset_verifications, public.asset_scores, public.pipeline_events
  from anon, authenticated;

revoke delete on public.watchlist_items from authenticated;

grant select on public.sources, public.assets, public.asset_sources,
  public.asset_verifications, public.asset_scores
  to anon, authenticated;

grant select, insert, update on public.pipeline_events to authenticated;
grant select, insert, update, delete on public.watchlist_items to authenticated;
grant select on public.ingestion_runs, public.ingestion_errors to authenticated;