/**
 * `IngestStore` over the real Supabase schema (`supabase/migrations/0002_assets.sql`).
 *
 * WHY THE CLIENT IS INJECTED
 * --------------------------
 * This module takes a `SupabaseClient<Database>` instead of importing
 * `@/lib/supabase/admin`. The route layer passes the service-role client (the
 * asset tables are deliberately write-locked for every client role, so ingestion
 * writes must be server-side), and the `npm run ingest` CLI passes a
 * service-role client built from its own environment. Nothing here reads
 * `process.env`, so no credential can leak by importing this file.
 *
 * Only columns that exist in the generated `Database` type are written — a
 * migration rename breaks this file at compile time rather than at runtime.
 *
 * Write policy (mirrors the pure pipeline so a fact can never be downgraded):
 *   - kind           : `resolveKind` (a more specific, evidence-backed kind wins)
 *   - status/risk    : the higher rank wins
 *   - checks         : the stronger result per `check_key` wins
 *   - score          : the run with the greater evidence coverage wins
 *   - signals        : merged and round-tripped through `assets.attributes`
 *   - provenance     : append-only, keyed on (asset, source, url)
 */
import type { SupabaseClient } from '@supabase/supabase-js';
import { redactSecrets } from '../errors.ts';
import type { CheckStatus, Database, Json } from '../supabase/database.types.ts';
import { kindRank, resolveKind } from './dedupe.ts';
import { mergeAssetFields, strongerCheckStatus } from './pipeline.ts';
import type { AssetScore } from './score.ts';
import { readStoredSignals, withStoredSignals } from './signals.ts';
import { EMPTY_SIGNALS, type NormalizedAsset, type VerificationInput } from './types.ts';
import type {
  FinishRunInput,
  IngestStore,
  PersistAssetInput,
  PersistOutcome,
  RecordErrorInput,
  SourceCatalogRow,
  StartRunInput,
  StoredAsset,
} from './store.ts';

type Db = SupabaseClient<Database>;

/** Postgres unique-violation. Raised when a concurrent run inserted the row. */
const UNIQUE_VIOLATION = '23505';

/** Converts arbitrary provider data into the `Json` shape PostgREST accepts. */
export function toJsonValue(value: unknown, depth = 0): Json {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string' || typeof value === 'boolean') return value;
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (depth >= 6) return null;
  if (Array.isArray(value)) {
    return value.slice(0, 200).map((item) => toJsonValue(item, depth + 1));
  }
  if (typeof value === 'object') {
    const out: { [key: string]: Json } = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>).slice(0, 100)) {
      out[key] = toJsonValue(item, depth + 1);
    }
    return out;
  }
  return null;
}

/** Reads a `Json` column as a plain object, never throwing on odd shapes. */
function asObject(value: Json): Record<string, unknown> {
  if (typeof value === 'object' && value !== null && !Array.isArray(value)) return value;
  return {};
}

/** A failure message that is safe to log and to store in `ingestion_errors`. */
function safeMessage(error: unknown): string {
  if (error && typeof error === 'object') {
    const candidate = error as { message?: unknown; code?: unknown; details?: unknown };
    const parts = [candidate.code, candidate.message, candidate.details].filter(
      (part): part is string => typeof part === 'string' && part.length > 0,
    );
    if (parts.length > 0) return redactSecrets(parts.join(' '), 400);
  }
  return redactSecrets(error instanceof Error ? error.message : String(error), 400);
}

function errorCode(error: unknown): string | null {
  if (error && typeof error === 'object') {
    const candidate = error as { code?: unknown };
    if (typeof candidate.code === 'string') return candidate.code;
  }
  return null;
}

/** Throws a redacted, storage-layer error. Callers record it as a run failure. */
function storageFailure(scope: string, error: unknown): never {
  throw new Error(`ingest_store.${scope}: ${safeMessage(error)}`);
}

async function selectSourceCatalog(client: Db): Promise<SourceCatalogRow[]> {
  const { data, error } = await client
    .from('sources')
    .select(
      'key, name, kind, description, homepage_url, terms_url, terms_note, requires_auth, required_env_vars, robots_policy, is_enabled, min_interval_ms, max_requests_per_minute',
    )
    .order('key', { ascending: true });

  if (error) storageFailure('load_sources', error);

  return (data ?? []).map((row) => ({
    key: row.key,
    name: row.name,
    kind: row.kind,
    description: row.description,
    homepageUrl: row.homepage_url,
    termsUrl: row.terms_url,
    termsNote: row.terms_note,
    requiresAuth: row.requires_auth,
    requiredEnvVars: row.required_env_vars,
    robotsPolicy: row.robots_policy,
    isEnabled: row.is_enabled,
    minIntervalMs: row.min_interval_ms,
    maxRequestsPerMinute: row.max_requests_per_minute,
  }));
}

/** Columns needed to make a merge decision — no more. */
const STORED_ASSET_COLUMNS =
  'id, kind, status, verification_status, risk_level, score_total, score_classification, score_evidence_coverage, attributes, first_seen_at';

/** The generated row type, so a schema rename breaks this file at compile time. */
type AssetRow = Database['public']['Tables']['assets']['Row'];

function toStoredAsset(row: AssetRow): StoredAsset {
  const monetization = Array.isArray(row.monetization)
    ? row.monetization.filter((entry): entry is string => typeof entry === 'string')
    : [];
  return {
    id: row.id,
    kind: row.kind,
    name: row.name,
    identifier: row.identifier,
    url: row.url,
    tld: row.tld,
    country: row.country,
    industry: row.industry,
    niche: row.niche,
    status: row.status,
    acquisitionRoute: row.acquisition_route,
    estimatedCostMin: row.estimated_cost_min,
    estimatedCostMax: row.estimated_cost_max,
    costCurrency: row.cost_currency,
    riskLevel: row.risk_level,
    verificationStatus: row.verification_status,
    monetization,
    scoreTotal: row.score_total,
    scoreClassification: row.score_classification,
    scoreEvidenceCoverage: row.score_evidence_coverage,
    attributes: asObject(row.attributes),
    firstSeenAt: row.first_seen_at,
    lastVerifiedAt: row.last_verified_at,
  };
}

/**
 * Rebuilds a stored row as a `NormalizedAsset` so an incoming observation can be
 * folded into it with the SAME merge policy the in-memory pipeline uses.
 *
 * Provenance and checks are intentionally empty: the database already holds those
 * rows and the persist step upserts per key, so re-listing them here would
 * duplicate work without changing the outcome.
 */
function storedAsNormalized(stored: StoredAsset): NormalizedAsset {
  return {
    kind: stored.kind,
    dedupeKey: '',
    name: stored.name,
    identifier: stored.identifier,
    url: stored.url,
    tld: stored.tld,
    country: stored.country,
    industry: stored.industry,
    niche: stored.niche,
    status: stored.status,
    acquisitionRoute: stored.acquisitionRoute,
    estimatedCostMin: stored.estimatedCostMin,
    estimatedCostMax: stored.estimatedCostMax,
    costCurrency: stored.costCurrency,
    riskLevel: stored.riskLevel,
    verificationStatus: stored.verificationStatus,
    monetization: stored.monetization,
    attributes: stored.attributes,
    signals: readStoredSignals(stored.attributes),
    provenance: [],
    verifications: [],
  };
}
/**
 * Collapses every row that shares a `dedupe_key` into one.
 *
 * The schema's unique constraint is `(kind, dedupe_key)`, so a host observed as a
 * `domain` by one provider and as a `website` by another could have produced two
 * rows before this runner existed (`resolveKind` exists precisely because a kind
 * changes as evidence improves). Those rows are one opportunity, so the most
 * specific kind wins and the loser's provenance, checks, score and user actions
 * are re-pointed before it is deleted.
 *
 * Runs only when a collision is actually found; the normal path is one row.
 */
async function consolidateDuplicateKinds(
  client: Db,
  rows: readonly StoredAsset[],
  dedupeKey: string,
): Promise<StoredAsset> {
  const [first, ...rest] = [...rows].sort(
    (a, b) => kindRank(b.kind) - kindRank(a.kind) || a.firstSeenAt.localeCompare(b.firstSeenAt),
  );
  if (!first) storageFailure('consolidate', new Error(`no rows for ${dedupeKey}`));

  for (const loser of rest) {
    for (const table of ['asset_sources', 'asset_verifications', 'asset_scores'] as const) {
      const { data, error } = await client.from(table).select('id').eq('asset_id', loser.id);
      if (error) storageFailure(`consolidate.${table}.select`, error);
      for (const child of data ?? []) {
        const { error: moveError } = await client
          .from(table)
          .update({ asset_id: first.id })
          .eq('id', child.id);
        // The canonical row already holds the same provenance/check/score, so the
        // loser's copy is superseded rather than moved.
        if (moveError && errorCode(moveError) === UNIQUE_VIOLATION) {
          const { error: deleteError } = await client.from(table).delete().eq('id', child.id);
          if (deleteError) storageFailure(`consolidate.${table}.delete`, deleteError);
        } else if (moveError) {
          storageFailure(`consolidate.${table}.move`, moveError);
        }
      }
    }

    const { error: deleteError } = await client.from('assets').delete().eq('id', loser.id);
    if (deleteError) storageFailure('consolidate.assets.delete', deleteError);
  }

  return first;
}

/**
 * Writes the asset's provenance rows.
 *
 * Append-only per `(asset, source, url)`: an existing row is refreshed with the
 * newest observation instead of being replaced, so "first discovered by X on
 * DATE" survives later enrichment runs.
 */
async function upsertProvenance(client: Db, assetId: string, asset: NormalizedAsset): Promise<void> {
  if (asset.provenance.length === 0) return;
  const rows = asset.provenance.slice(0, 20).map((entry) => ({
    asset_id: assetId,
    source_key: entry.sourceKey,
    source_url: entry.sourceUrl,
    source_record_id: entry.sourceRecordId,
    discovery_method: entry.discoveryMethod,
    confidence: entry.confidence,
    observed_at: entry.observedAt,
    last_verified_at: entry.lastVerifiedAt,
    verification_status: entry.verificationStatus,
    raw_excerpt: toJsonValue(entry.excerpt),
  }));

  const { error } = await client
    .from('asset_sources')
    .upsert(rows, { onConflict: 'asset_id,source_key,source_url' });
  if (error) storageFailure('asset_sources', error);
}

/**
 * Writes the asset's verification rows.
 *
 * The caller has already dropped any check whose stored result is stronger, so
 * this function never has to decide precedence — a stored `verified` fact cannot
 * be overwritten by a later `inconclusive` observation.
 */
async function upsertVerifications(
  client: Db,
  assetId: string,
  sourceKey: string,
  checks: readonly VerificationInput[],
): Promise<void> {
  const rows = checks.slice(0, 20).map((entry) => ({
    asset_id: assetId,
    check_key: entry.checkKey,
    category: entry.category,
    status: entry.status,
    method: entry.method,
    evidence_url: entry.evidenceUrl,
    evidence: toJsonValue(entry.evidence),
    source_key: sourceKey,
    check_version: entry.checkVersion,
    checked_at: entry.checkedAt,
  }));

  if (rows.length === 0) return;

  const { error } = await client
    .from('asset_verifications')
    .upsert(rows, { onConflict: 'asset_id,check_key' });
  if (error) storageFailure('asset_verifications', error);
}

/** Writes (or refreshes) the stored score breakdown for this score version. */
async function upsertScore(
  client: Db,
  assetId: string,
  score: AssetScore,
  observedAt: string,
): Promise<void> {
  const byKey = new Map(score.factors.map((factor) => [factor.key, factor.value]));
  const weightTotal = score.factors.reduce((sum, factor) => sum + factor.weight, 0);

  const { error } = await client.from('asset_scores').upsert(
    {
      asset_id: assetId,
      version: score.version,
      total: score.total,
      classification: score.classification,
      brand_potential: byKey.get('brand_potential') ?? null,
      domain_quality: byKey.get('domain_quality') ?? null,
      market_demand: byKey.get('market_demand') ?? null,
      monetization_potential: byKey.get('monetization_potential') ?? null,
      competition: byKey.get('competition') ?? null,
      legal_clarity: byKey.get('legal_clarity') ?? null,
      acquisition_cost: byKey.get('acquisition_cost') ?? null,
      weight_total: weightTotal,
      evidence_coverage: Math.round(score.evidenceCoverage),
      factors: toJsonValue(score.factors),
      computed_at: observedAt,
    },
    { onConflict: 'asset_id,version' },
  );
  if (error) storageFailure('asset_scores', error);
}
/**
 * Upserts one scored asset: the asset row, its provenance, its checks and its
 * score. Returns whether the asset was new to the database.
 *
 * Merge rules (see the module header) mean a run can only ever *improve* a
 * stored row: a sparser observation never erases a stored fact.
 */
async function persistAsset(client: Db, input: PersistAssetInput): Promise<PersistOutcome> {
  const { asset, score, sourceKey, observedAt } = input;

  const { data, error } = await client
    .from('assets')
    .select('*')
    .eq('dedupe_key', asset.dedupeKey)
    .order('first_seen_at', { ascending: true });
  if (error) storageFailure('load_asset', error);

  const found = (data ?? []).map(toStoredAsset);
  const stored =
    found.length > 1
      ? await consolidateDuplicateKinds(client, found, asset.dedupeKey)
      : (found[0] ?? null);

  // Signals are merged against what was already observed, then carried forward in
  // `attributes` so a later, sparser run cannot silently lose evidence.
  const previousSignals = stored ? readStoredSignals(stored.attributes) : { ...EMPTY_SIGNALS };
  const mergedSignals = mergeEvidenceSignals(previousSignals, asset.signals);
  const incoming: NormalizedAsset = {
    ...asset,
    attributes: withStoredSignals(asset.attributes, mergedSignals),
  };
  const merged = stored ? mergeAssetFields(storedAsNormalized(stored), incoming) : incoming;

  // A score backed by more evidence is the better score: a run that could only
  // observe half as much must not overwrite it.
  const incomingCoverage = score.publishable ? Math.round(score.evidenceCoverage) : 0;
  const keepStoredScore =
    stored !== null && stored.scoreTotal !== null && (stored.scoreEvidenceCoverage ?? 0) > incomingCoverage;

  const verifiedAt = merged.verifications.some((entry) => entry.status === 'verified')
    ? observedAt
    : null;

  const fields = {
    kind: merged.kind,
    name: merged.name,
    identifier: merged.identifier,
    url: merged.url,
    tld: merged.tld,
    country: merged.country,
    industry: merged.industry,
    niche: merged.niche,
    status: merged.status,
    acquisition_route: merged.acquisitionRoute,
    estimated_cost_min: merged.estimatedCostMin,
    estimated_cost_max: merged.estimatedCostMax,
    cost_currency: merged.costCurrency,
    risk_level: merged.riskLevel,
    verification_status: merged.verificationStatus,
    monetization: merged.monetization,
    attributes: toJsonValue(merged.attributes),
    last_ingested_at: observedAt,
    ...(verifiedAt === null ? {} : { last_verified_at: verifiedAt }),
    ...(keepStoredScore
      ? {}
      : {
          score_total: score.publishable ? score.total : null,
          score_classification: score.publishable ? score.classification : null,
          score_evidence_coverage: score.publishable ? incomingCoverage : null,
          score_version: score.publishable ? score.version : null,
        }),
  };

  let assetId: string;
  let outcome: PersistOutcome;

  if (stored) {
    const { error: updateError } = await client.from('assets').update(fields).eq('id', stored.id);
    if (updateError) storageFailure('update_asset', updateError);
    assetId = stored.id;
    outcome = 'updated';
  } else {
    const { data: inserted, error: insertError } = await client
      .from('assets')
      .insert({ ...fields, dedupe_key: asset.dedupeKey, first_seen_at: observedAt })
      .select('id')
      .single();

    if (insertError && errorCode(insertError) === UNIQUE_VIOLATION) {
      // A concurrent run inserted the same identity between the read and the
      // write. Treat it as an update so the run stays idempotent.
      const { data: raced, error: racedError } = await client
        .from('assets')
        .select('*')
        .eq('dedupe_key', asset.dedupeKey)
        .order('first_seen_at', { ascending: true })
        .limit(1);
      if (racedError) storageFailure('load_raced_asset', racedError);
      const racedRow = (raced ?? []).map(toStoredAsset)[0];
      if (!racedRow) storageFailure('load_raced_asset', insertError);
      const { error: raceUpdateError } = await client
        .from('assets')
        .update(fields)
        .eq('id', racedRow.id);
      if (raceUpdateError) storageFailure('update_raced_asset', raceUpdateError);
      assetId = racedRow.id;
      outcome = 'updated';
    } else if (insertError || !inserted) {
      storageFailure('insert_asset', insertError);
    } else {
      assetId = inserted.id;
      outcome = 'created';
    }
  }

  await upsertProvenance(client, assetId, asset);

  // Checks whose stored result is stronger are left untouched, so their evidence
  // URL and timestamp stay the ones that actually proved the fact.
  const storedChecks = new Map<string, CheckStatus>();
  if (stored) {
    const { data: existingChecks, error: checksError } = await client
      .from('asset_verifications')
      .select('check_key, status')
      .eq('asset_id', assetId);
    if (checksError) storageFailure('load_checks', checksError);
    for (const check of existingChecks ?? []) {
      storedChecks.set(check.check_key, check.status);
    }
  }

  const writableChecks = asset.verifications.filter((entry) => {
    const current = storedChecks.get(entry.checkKey);
    if (current === undefined) return true;
    return strongerCheckStatus(current, entry.status) === entry.status;
  });

  await upsertVerifications(client, assetId, sourceKey, writableChecks);

  if (!keepStoredScore && score.publishable) {
    await upsertScore(client, assetId, score, observedAt);
  }

  return outcome;
}

/**
 * Builds the Supabase-backed ingestion store.
 *
 * The caller owns the client: route handlers pass the service-role client (the
 * asset tables reject every client-role write, so ingestion persistence has to be
 * server-side), and the CLI passes a client built from its own environment.
 */
export function createSupabaseIngestStore(client: Db): IngestStore {
  return {
    loadSources: () => selectSourceCatalog(client),

    async startRun(input: StartRunInput): Promise<string> {
      const { data, error } = await client
        .from('ingestion_runs')
        .insert({
          source_key: input.sourceKey,
          mode: input.mode,
          status: 'running',
          query: toJsonValue(input.query),
          correlation_id: input.correlationId,
          initiated_by: input.initiatedBy,
        })
        .select('id')
        .single();

      if (!data) storageFailure('start_run', error ?? new Error('no run row returned'));
      return data.id;
    },

    async recordError(input: RecordErrorInput): Promise<void> {
      const { error } = await client.from('ingestion_errors').insert({
        run_id: input.runId,
        source_key: input.sourceKey,
        stage: input.stage,
        code: input.code,
        // Already redacted by the caller: never an upstream response body.
        message: input.message.slice(0, 400),
        context: toJsonValue(input.context ?? {}),
      });
      if (error) storageFailure('record_error', error);
    },

    async finishRun(input: FinishRunInput): Promise<void> {
      // `items_valid` is the number of observations that survived validation and
      // deduplication, so the counters on the run row always add up.
      const valid = input.created + input.updated + input.duplicates;
      const { error } = await client
        .from('ingestion_runs')
        .update({
          status: input.status,
          finished_at: input.finishedAt,
          items_fetched: input.result.fetched,
          items_valid: valid,
          items_new: input.created,
          items_updated: input.updated,
          items_duplicate: input.duplicates,
          items_rejected: input.rejected,
          error_count: input.errorCount,
          // The schema has no notes column; run notes are operator telemetry, so
          // they ride along with the request that produced them.
          query: toJsonValue({ ...input.query, notes: input.notes.slice(0, 50) }),
        })
        .eq('id', input.runId);
      if (error) storageFailure('finish_run', error);
    },

    persistAsset: (input) => persistAsset(client, input),
  };
}



