/**
 * The pipeline: DEDUPLICATE -> VALIDATE -> SCORE.
 *
 * Providers each return their own observations. This module is what turns that
 * pile into a set of unique, schema-valid, scored assets — the same asset
 * discovered by three sources must become ONE row with three provenance rows.
 *
 * Everything here is pure: no I/O, no database, no clock. The caller (runner.ts)
 * owns persistence, which is what makes this logic directly unit-testable.
 */
import { resolveKind } from './dedupe.ts';
import { computeScore, type AssetScore } from './score.ts';
import { validateNormalizedAsset } from './validate.ts';
import type { EvidenceSignals, NormalizedAsset } from './types.ts';

/** Ordering for asset status. Higher wins when two providers disagree. */
const STATUS_RANK: Record<string, number> = {
  unknown: 0,
  verification_required: 1,
  potentially_inactive: 2,
  active: 3,
  available: 3,
  expired: 3,
  for_sale: 4,
  auction: 4,
  struck_off: 4,
  under_investigation: 4,
  acquired: 5,
  relaunching: 5,
  monetizing: 5,
  sold: 5,
};

/** Ordering for verification status. Higher wins. */
const VERIFICATION_RANK: Record<string, number> = {
  verification_required: 0,
  unverified: 1,
  partially_verified: 2,
  verified: 3,
};

/** Ordering for risk severity. `unknown` is its own thing, not "no risk". */
const RISK_RANK: Record<string, number> = {
  unknown: 0,
  low: 1,
  medium: 2,
  high: 3,
  critical: 4,
};

/** Ordering for an individual check result. Higher wins on a duplicate key. */
const CHECK_RANK: Record<string, number> = {
  requires_manual_research: 0,
  not_checked: 1,
  inconclusive: 2,
  failed: 3,
  verified: 4,
};

function pickHigher<T extends string>(current: T, candidate: T, ranks: Record<string, number>): T {
  const currentRank = ranks[current] ?? 0;
  const candidateRank = ranks[candidate] ?? 0;
  return candidateRank > currentRank ? candidate : current;
}

/** Merges signal counters, preferring an observed value over `null`. */
function mergeSignals(base: EvidenceSignals, incoming: EvidenceSignals): EvidenceSignals {
  const statuses = new Set([...base.registryStatuses, ...incoming.registryStatuses]);
  return {
    mentions: incoming.mentions ?? base.mentions,
    crawlArchives: incoming.crawlArchives ?? base.crawlArchives,
    siteServes: incoming.siteServes ?? base.siteServes,
    redirectsElsewhere: incoming.redirectsElsewhere ?? base.redirectsElsewhere,
    registryStatuses: [...statuses].slice(0, 40),
    nameserverCount: incoming.nameserverCount ?? base.nameserverCount,
    registrar: incoming.registrar ?? base.registrar,
    daysUntilExpiry: incoming.daysUntilExpiry ?? base.daysUntilExpiry,
    companyFound: incoming.companyFound ?? base.companyFound,
    companyStatus: incoming.companyStatus ?? base.companyStatus,
    trademarkManualResearch: incoming.trademarkManualResearch ?? base.trademarkManualResearch,
  };
}

/** Folds one observation into an accumulated asset for the same identity. */
function foldAsset(base: NormalizedAsset, incoming: NormalizedAsset): NormalizedAsset {
  const provenance = [...base.provenance];
  for (const entry of incoming.provenance) {
    const duplicate = provenance.some(
      (existing) => existing.sourceKey === entry.sourceKey && existing.sourceUrl === entry.sourceUrl,
    );
    if (!duplicate) provenance.push(entry);
  }

  const verifications = [...base.verifications];
  for (const entry of incoming.verifications) {
    const index = verifications.findIndex((existing) => existing.checkKey === entry.checkKey);
    if (index === -1) {
      verifications.push(entry);
      continue;
    }
    const existing = verifications[index];
    if (!existing) continue;
    // Same check reported twice: keep the stronger result rather than the later
    // one, so an inconclusive follow-up cannot downgrade a verified fact.
    if ((CHECK_RANK[entry.status] ?? 0) > (CHECK_RANK[existing.status] ?? 0)) {
      verifications[index] = entry;
    }
  }

  const minCandidates = [base.estimatedCostMin, incoming.estimatedCostMin].filter(
    (value): value is number => value !== null,
  );
  const maxCandidates = [base.estimatedCostMax, incoming.estimatedCostMax].filter(
    (value): value is number => value !== null,
  );

  const monetization = [...new Set([...base.monetization, ...incoming.monetization])].slice(0, 12);

  return {
    kind: resolveKind(base.kind, incoming.kind, incoming.verificationStatus),
    dedupeKey: base.dedupeKey,
    name: base.name.length >= incoming.name.length ? base.name : incoming.name,
    identifier: base.identifier.length > 0 ? base.identifier : incoming.identifier,
    url: base.url ?? incoming.url,
    tld: base.tld ?? incoming.tld,
    country: base.country ?? incoming.country,
    industry: base.industry ?? incoming.industry,
    niche: base.niche ?? incoming.niche,
    status: pickHigher(base.status, incoming.status, STATUS_RANK),
    acquisitionRoute: base.acquisitionRoute ?? incoming.acquisitionRoute,
    estimatedCostMin: minCandidates.length > 0 ? Math.min(...minCandidates) : null,
    estimatedCostMax: maxCandidates.length > 0 ? Math.max(...maxCandidates) : null,
    costCurrency: base.costCurrency ?? incoming.costCurrency,
    riskLevel: pickHigher(base.riskLevel, incoming.riskLevel, RISK_RANK),
    verificationStatus: pickHigher(
      base.verificationStatus,
      incoming.verificationStatus,
      VERIFICATION_RANK,
    ),
    monetization,
    attributes: { ...base.attributes, ...incoming.attributes },
    signals: mergeSignals(base.signals, incoming.signals),
    provenance: provenance.slice(0, 20),
    verifications: verifications.slice(0, 20),
  };
}

export type MergeResult = {
  merged: NormalizedAsset[];
  /** Observations folded into an asset that was already present. */
  duplicates: number;
};

/**
 * Groups observations by `dedupeKey` and folds each group into one asset.
 *
 * The first observation for an identity sets the shape; every later one enriches
 * it. Because identity is the dedupe key and NOT the provider, the same domain
 * found by RDAP and later linked from a discussion thread is one opportunity.
 */
export function mergeNormalizedAssets(assets: readonly NormalizedAsset[]): MergeResult {
  const byKey = new Map<string, NormalizedAsset>();
  let duplicates = 0;

  for (const asset of assets) {
    const existing = byKey.get(asset.dedupeKey);
    if (existing) {
      byKey.set(asset.dedupeKey, foldAsset(existing, asset));
      duplicates += 1;
    } else {
      byKey.set(asset.dedupeKey, asset);
    }
  }

  return { merged: [...byKey.values()], duplicates };
}

export type RejectedAsset = {
  dedupeKey: string;
  reasons: string[];
};

export type ValidateStageResult = {
  accepted: NormalizedAsset[];
  rejected: RejectedAsset[];
};

/**
 * Runs every merged asset through schema validation.
 *
 * A rejected asset is reported with its reasons and never persisted, so a
 * malformed provider payload cannot put a partially-valid row into the database.
 */
export function validateStage(assets: readonly NormalizedAsset[]): ValidateStageResult {
  const accepted: NormalizedAsset[] = [];
  const rejected: RejectedAsset[] = [];

  for (const asset of assets) {
    const result = validateNormalizedAsset(asset);
    if (result.ok) accepted.push(result.asset);
    else rejected.push({ dedupeKey: asset.dedupeKey, reasons: result.reasons });
  }

  return { accepted, rejected };
}

export type ScoredAsset = {
  asset: NormalizedAsset;
  score: AssetScore;
};

/**
 * Scores every validated asset.
 *
 * The score is computed from the asset's own evidence. When coverage is below
 * the publishable threshold the caller stores `score_total = NULL` — the UI then
 * renders "insufficient evidence" instead of a number that means nothing.
 */
export function scoreStage(assets: readonly NormalizedAsset[]): ScoredAsset[] {
  return assets.map((asset) => ({
    asset,
    score: computeScore({
      kind: asset.kind,
      name: asset.name,
      identifier: asset.identifier,
      tld: asset.tld,
      status: asset.status,
      industry: asset.industry,
      niche: asset.niche,
      signals: asset.signals,
      checks: asset.verifications.map((entry) => ({
        checkKey: entry.checkKey,
        status: entry.status,
      })),
      monetization: asset.monetization,
      estimatedCostMin: asset.estimatedCostMin,
      estimatedCostMax: asset.estimatedCostMax,
      costCurrency: asset.costCurrency,
    }),
  }));
}

export type PreparedAsset = ScoredAsset;

export type PrepareResult = {
  prepared: PreparedAsset[];
  rejected: RejectedAsset[];
  duplicates: number;
};

/**
 * The complete pure stage: merge (dedupe) -> validate -> score.
 *
 * `runner.ts` calls only this, then persists. Keeping the three steps together
 * means the counters a run reports (duplicates, rejected) are computed from the
 * same data that was persisted, so the telemetry cannot drift from reality.
 */
export function prepareAssets(observations: readonly NormalizedAsset[]): PrepareResult {
  const { merged, duplicates } = mergeNormalizedAssets(observations);
  const { accepted, rejected } = validateStage(merged);
  const prepared = scoreStage(accepted);
  return { prepared, rejected, duplicates };
}