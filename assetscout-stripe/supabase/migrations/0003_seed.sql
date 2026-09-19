-- =============================================================================
-- AssetScout — 0003_seed.sql
-- Idempotent product configuration + the provider catalog.
--
-- WHAT THE SEED DOES **NOT** CONTAIN (deliberate):
--   * no assets / opportunities — those are created only by a real provider run
--     against a real public source (see src/lib/ingest/providers/*)
--   * no Stripe Price IDs and no monetary amounts — `plan_prices` is populated
--     from Stripe itself (`npm run billing:sync`), because inventing an amount
--     here would silently disagree with what Stripe actually charges
-- =============================================================================

-- -----------------------------------------------------------------------------
-- Plan catalog
-- -----------------------------------------------------------------------------
insert into public.plans (key, name, tagline, tier, is_public, is_active, requires_sales_contact)
values
  ('free',       'Free',       'Explore the opportunity index',            0, true, true,  false),
  ('pro',        'Pro',        'Advanced discovery and full verification', 1, true, true,  false),
  ('agency',     'Agency',     'Bulk discovery, team workflows and exports', 2, true, true, false),
  ('enterprise', 'Enterprise', 'Custom data, procurement and support',    3, true, true,  true)
on conflict (key) do update
  set name = excluded.name,
      tagline = excluded.tagline,
      tier = excluded.tier,
      is_public = excluded.is_public,
      is_active = excluded.is_active,
      requires_sales_contact = excluded.requires_sales_contact;

-- -----------------------------------------------------------------------------
-- Feature catalog.
--   ENFORCEMENT CONTRACT: every key below is actually enforced server-side.
--   `npm test` (tests/entitlements.test.ts) fails if the app enforces a key the
--   catalog does not declare, or declares a key nothing enforces.
-- -----------------------------------------------------------------------------
insert into public.features (key, description, value_type)
values
  ('search.queries_per_month',      'Opportunity searches per calendar month',            'limit'),
  ('search.results_limit',          'Maximum results returned per search',                'limit'),
  ('search.advanced_filters',       'Filter by score, risk, cost, monetization, verified', 'boolean'),
  ('opportunity.score_breakdown',   'See the factor-by-factor score breakdown',            'boolean'),
  ('opportunity.provenance_full',   'See full provenance: evidence URLs and check details', 'boolean'),
  ('watchlist.items',               'Saved opportunities (watchlist rows)',                'limit'),
  ('pipeline.deals',                'Opportunities tracked in the acquisition pipeline',  'limit')
on conflict (key) do update
  set description = excluded.description,
      value_type = excluded.value_type;

-- -----------------------------------------------------------------------------
-- plan_features. NULL limit_value = unlimited. enabled=false = not granted.
-- These numbers are product configuration (the spec gives the feature lists but
-- no figures), chosen to be defensible for an intelligence product.
-- -----------------------------------------------------------------------------
with matrix(plan_key, feature_key, enabled, limit_value) as (
  values
    ('free','search.queries_per_month',true,100),
    ('free','search.results_limit',true,10),
    ('free','search.advanced_filters',false,null),
    ('free','opportunity.score_breakdown',false,null),
    ('free','opportunity.provenance_full',false,null),
    ('free','watchlist.items',true,5),
    ('free','pipeline.deals',true,2),

    ('pro','search.queries_per_month',true,10000),
    ('pro','search.results_limit',true,50),
    ('pro','search.advanced_filters',true,null),
    ('pro','opportunity.score_breakdown',true,null),
    ('pro','opportunity.provenance_full',true,null),
    ('pro','watchlist.items',true,100),
    ('pro','pipeline.deals',true,50),

    ('agency','search.queries_per_month',true,100000),
    ('agency','search.results_limit',true,200),
    ('agency','search.advanced_filters',true,null),
    ('agency','opportunity.score_breakdown',true,null),
    ('agency','opportunity.provenance_full',true,null),
    ('agency','watchlist.items',true,1000),
    ('agency','pipeline.deals',true,500),

    ('enterprise','search.queries_per_month',true,null),
    ('enterprise','search.results_limit',true,null),
    ('enterprise','search.advanced_filters',true,null),
    ('enterprise','opportunity.score_breakdown',true,null),
    ('enterprise','opportunity.provenance_full',true,null),
    ('enterprise','watchlist.items',true,null),
    ('enterprise','pipeline.deals',true,null)
)
insert into public.plan_features (plan_id, feature_key, enabled, limit_value)
select p.id, m.feature_key, m.enabled, m.limit_value
from matrix m
join public.plans p on p.key = m.plan_key
on conflict (plan_id, feature_key) do update
  set enabled = excluded.enabled,
      limit_value = excluded.limit_value;

-- -----------------------------------------------------------------------------
-- Provider catalog. Every row here corresponds to exactly one module in
-- src/lib/ingest/providers/. `requires_auth` documents the credential; the value
-- lives in the environment and never in the database or the client bundle.
--
-- Terms/robots posture is recorded per source so the posture is auditable:
--   respect  = HTTP fetches honour robots.txt (RFC 9309) and Crawl-delay
--   api_only = the source is a documented API/dataset endpoint, never crawled
-- -----------------------------------------------------------------------------
insert into public.sources (
  key, name, kind, description, homepage_url, api_doc_url, terms_url,
  license, terms_note, requires_auth, required_env_vars, robots_policy,
  is_enabled, min_interval_ms, max_requests_per_minute
)
values
  (
    'rdap-domain',
    'RDAP (registry-authoritative domain data)',
    'domain_registry',
    'Registration, expiry, registrar and nameserver status straight from the authoritative registry via RDAP (RFC 7480-7484). The only source that can state a domain is unregistered.',
    'https://about.rdap.org/',
    'https://www.icann.org/rdap',
    'https://www.icann.org/resources/pages/gtld-registry-agreement-2015-10-09-en',
    'Public standard (ICANN gTLD RDAP profile)',
    'Queried per-registry with polite serialised requests; the response is authoritative for registration status, never a valuation.',
    false, '{}'::text[], 'api_only', true, 1200, 30
  ),
  (
    'iana-bootstrap',
    'IANA RDAP bootstrap registry',
    'domain_registry',
    'The public IANA DNS bootstrap file (data.iana.org/rdap/dns.json) mapping a TLD to its authoritative RDAP base URL. Cached in process and refreshed at most daily.',
    'https://www.iana.org/',
    'https://data.iana.org/rdap/dns.json',
    'https://www.iana.org/help/licensing-terms',
    'Public data (IANA)',
    'Static public file; downloaded once per process lifetime.',
    false, '{}'::text[], 'api_only', true, 10000, 6
  ),
  (
    'website-probe',
    'Direct website reachability probe',
    'website',
    'One polite request to the asset''s own public homepage, with a descriptive User-Agent, honouring robots.txt and any Crawl-delay, to record serving status, redirect chain and TLS reachability. A liveness probe, not a crawler: one document per host, no link following, no content extraction.',
    'https://www.rfc-editor.org/rfc/rfc9309.html',
    'https://www.rfc-editor.org/rfc/rfc9110.html',
    'https://www.rfc-editor.org/rfc/rfc9309.html',
    'RFC 9309 / RFC 9110',
    'robots.txt is fetched first and obeyed; a Disallow for the probe path makes the source record "not probed" rather than fetching anyway.',
    false, '{}'::text[], 'respect', true, 2000, 20
  ),
  (
    'common-crawl-index',
    'Common Crawl index (historical web presence)',
    'historical_index',
    'The public Common Crawl CDX index, used to record that a host appeared in a real crawl archive and when. Historical presence evidence without scraping the site itself.',
    'https://commoncrawl.org/',
    'https://index.commoncrawl.org/',
    'https://commoncrawl.org/terms-of-use',
    'Common Crawl open data',
    'The collection list is read from collinfo.json so no stale crawl id is hard-coded.',
    false, '{}'::text[], 'api_only', true, 2000, 20
  ),
  (
    'hn-signals',
    'Hacker News technology signal',
    'signal_feed',
    'Public Hacker News (Algolia) search API, used only as a demand/mention signal for a keyword. Recorded with confidence "signal" and never presented as revenue, traffic or ownership evidence.',
    'https://news.ycombinator.com/',
    'https://hn.algolia.com/api',
    'https://www.algolia.com/terms/',
    'Public API, no key required',
    'Low request volume, no auth; results are opinions/mentions only.',
    false, '{}'::text[], 'api_only', true, 1500, 30
  ),
  (
    'companies-house-uk',
    'UK Companies House (official company registry)',
    'business_registry',
    'Official UK company register search: company status, incorporation date, SIC codes and previous names. Activates only when COMPANIES_HOUSE_API_KEY is configured.',
    'https://www.gov.uk/government/organisations/companies-house',
    'https://developer.company-information.service.gov.uk/',
    'https://developer.company-information.service.gov.uk/terms-and-conditions',
    'Open Government Licence v3.0',
    'A registry record is a factual filing, not proof of ownership or transferability of any asset.',
    true, array['COMPANIES_HOUSE_API_KEY'], 'api_only', true, 1000, 60
  ),
  (
    'manual-registry',
    'Manual official-registry research route (BRS / KIPI / USPTO / WIPO)',
    'manual_registry',
    'Emitted for assets where an official register exists but exposes no terms-permitting public API for automated access (Kenya BRS, Kenya KIPI, USPTO trademark search, WIPO Global Brand Database, Kenya Gazette). This provider performs NO fetching and fabricates nothing: it creates a "requires_manual_research" verification task naming the official register and the official URL a human must consult.',
    'https://brs.go.ke/',
    'https://kipi.go.ke/',
    'https://brs.go.ke/terms',
    'N/A (manual research route)',
    'Deliberately not automated: these registers do not permit automated access, so AssetScout links to them instead of scraping them.',
    false, '{}'::text[], 'api_only', true, 0, 0
  )
on conflict (key) do update
  set name = excluded.name,
      kind = excluded.kind,
      description = excluded.description,
      homepage_url = excluded.homepage_url,
      api_doc_url = excluded.api_doc_url,
      terms_url = excluded.terms_url,
      license = excluded.license,
      terms_note = excluded.terms_note,
      requires_auth = excluded.requires_auth,
      required_env_vars = excluded.required_env_vars,
      robots_policy = excluded.robots_policy,
      is_enabled = excluded.is_enabled,
      min_interval_ms = excluded.min_interval_ms,
      max_requests_per_minute = excluded.max_requests_per_minute;