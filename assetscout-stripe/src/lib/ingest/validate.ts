/**
 * Provider-output validation.
 *
 * Nothing a provider returns reaches the database without passing through here.
 * The checks are deliberately strict and total (no `any`, no casting): a
 * malformed provider payload must be counted and rejected, never partially
 * written. Each rejection carries a stable reason code that lands in
 * `public.ingestion_errors`, so the admin health view can show *what* a source
 * is getting wrong without ever storing the offending payload.
 *
 * Pure, node-loadable, no I/O.
 */
import type {
  AssetKind,
  AssetStatus,
  CheckCategory,
  CheckMethod,
  CheckStatus,
  DiscoveryMethod,
  ProvenanceConfidence,
  RiskLevel,
  SourceKind,
  VerificationStatus,
} from '../supabase/database.types.ts';
import { isValidDedupeKey } from './dedupe.ts';
import type { EvidenceSignals, NormalizedAsset } from './types.ts';

// ---------------------------------------------------------------------------
// Closed sets — the runtime mirror of the schema CHECK constraints.
// `satisfies` keeps these arrays and the generated row types in step: adding a
// value to one without the other fails `npm run typecheck`.
// ---------------------------------------------------------------------------
export const ASSET_KINDS = [
  'domain', 'website', 'saas', 'digital_business', 'digital_product', 'brand',
] as const satisfies readonly AssetKind[];

export const ASSET_STATUSES = [
  'active', 'potentially_inactive', 'expired', 'available', 'for_sale', 'auction',
  'struck_off', 'under_investigation', 'unknown', 'verification_required',
  'acquired', 'relaunching', 'monetizing', 'sold',
] as const satisfies readonly AssetStatus[];

export const RISK_LEVELS = ['low', 'medium', 'high', 'critical', 'unknown'] as const satisfies readonly RiskLevel[];

export const VERIFICATION_STATUSES = [
  'verified', 'partially_verified', 'unverified', 'verification_required',
] as const satisfies readonly VerificationStatus[];

export const PROVENANCE_CONFIDENCES = [
  'authoritative', 'registry', 'provider_claim', 'signal', 'unknown',
] as const satisfies readonly ProvenanceConfidence[];

export const DISCOVERY_METHODS = [
  'provider_query', 'candidate_check', 'manual',
] as const satisfies readonly DiscoveryMethod[];

export const SOURCE_KINDS = [
  'domain_registry', 'website', 'historical_index', 'signal_feed',
  'business_registry', 'trademark_registry', 'manual_registry',
] as const satisfies readonly SourceKind[];

export const CHECK_CATEGORIES = [
  'domain', 'business', 'trademark', 'website', 'ownership', 'risk',
] as const satisfies readonly CheckCategory[];

export const CHECK_STATUSES = [
  'verified', 'failed', 'inconclusive', 'not_checked', 'requires_manual_research',
] as const satisfies readonly CheckStatus[];

export const CHECK_METHODS = [
  'api', 'registry_lookup', 'manual', 'not_available',
] as const satisfies readonly CheckMethod[];

const MAX_INT32 = 2_147_483_647;
const MAX_SIGNAL_COUNTER = 1_000_000_000;

function isIn<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

function isIsoTimestamp(value: unknown): value is string {
  if (typeof value !== 'string' || value.length < 20) return false;
  const parsed = new Date(value);
  return !Number.isNaN(parsed.getTime()) && value.endsWith('Z');
}

function isHttpUrl(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  try {
    const url = new URL(value);
    return url.protocol === 'http:' || url.protocol === 'https:';
  } catch {
    return false;
  }
}

/** A safe integer that fits the schema's `integer` columns. */
function isSafeIntegerOrNull(value: unknown): value is number | null {
  return (
    value === null ||
    (typeof value === 'number' && Number.isSafeInteger(value) && Math.abs(value) <= MAX_INT32)
  );
}

/** A JSON-safe value with bounded depth and breadth. */
function isPlainJson(value: unknown, depth = 0): boolean {
  if (value === null) return true;
  const type = typeof value;
  if (type === 'string' || type === 'number' || type === 'boolean') return true;
  if (depth >= 4) return false;
  if (Array.isArray(value)) {
    return value.length <= 100 && value.every((item) => isPlainJson(item, depth + 1));
  }
  if (type === 'object') {
    const entries = Object.entries(value as Record<string, unknown>);
    return entries.length <= 50 && entries.every(([, item]) => isPlainJson(item, depth + 1));
  }
  return false;
}

function validateSignals(signals: EvidenceSignals, reasons: string[]): void {
  for (const key of ['mentions', 'crawlArchives', 'nameserverCount', 'daysUntilExpiry'] as const) {
    const value = signals[key];
    if (!isSafeIntegerOrNull(value)) {
      reasons.push(`signals.${key}:not-an-integer`);
    } else if (value !== null && Math.abs(value) > MAX_SIGNAL_COUNTER) {
      reasons.push(`signals.${key}:out-of-range`);
    }
  }

  for (const key of [
    'siteServes', 'redirectsElsewhere', 'companyFound', 'trademarkManualResearch',
  ] as const) {
    const value = signals[key];
    if (value !== null && typeof value !== 'boolean') reasons.push(`signals.${key}:not-boolean`);
  }

  if (!Array.isArray(signals.registryStatuses) || signals.registryStatuses.length > 40) {
    reasons.push('signals.registryStatuses:invalid');
  } else if (!signals.registryStatuses.every((s) => typeof s === 'string' && s.length <= 64)) {
    reasons.push('signals.registryStatuses:entry-invalid');
  }

  for (const key of ['registrar', 'companyStatus'] as const) {
    const value = signals[key];
    if (value !== null && (typeof value !== 'string' || value.length > 160)) {
      reasons.push(`signals.${key}:invalid`);
    }
  }
}

function validateProvenance(entry: NormalizedAsset['provenance'][number], index: number, reasons: string[]): void {
  const scope = `provenance[${index}]`;
  if (typeof entry.sourceKey !== 'string' || !/^[a-z][a-z0-9_-]{1,40}$/.test(entry.sourceKey)) {
    reasons.push(`${scope}.sourceKey:invalid`);
  }
  if (!isHttpUrl(entry.sourceUrl)) reasons.push(`${scope}.sourceUrl:not-http-url`);
  if (
    entry.sourceRecordId !== null &&
    (typeof entry.sourceRecordId !== 'string' || entry.sourceRecordId.length > 200)
  ) {
    reasons.push(`${scope}.sourceRecordId:invalid`);
  }
  if (!isIn(DISCOVERY_METHODS, entry.discoveryMethod)) reasons.push(`${scope}.discoveryMethod:invalid`);
  if (!isIn(PROVENANCE_CONFIDENCES, entry.confidence)) reasons.push(`${scope}.confidence:invalid`);
  if (!isIsoTimestamp(entry.observedAt)) reasons.push(`${scope}.observedAt:not-iso-timestamp`);
  if (entry.lastVerifiedAt !== null && !isIsoTimestamp(entry.lastVerifiedAt)) {
    reasons.push(`${scope}.lastVerifiedAt:not-iso-timestamp`);
  }
  if (!isIn(VERIFICATION_STATUSES, entry.verificationStatus)) {
    reasons.push(`${scope}.verificationStatus:invalid`);
  }
  if (!isPlainJson(entry.excerpt)) reasons.push(`${scope}.excerpt:not-json`);
}

function validateVerification(entry: NormalizedAsset['verifications'][number], index: number, reasons: string[]): void {
  const scope = `verifications[${index}]`;
  if (typeof entry.checkKey !== 'string' || !/^[a-z][a-z0-9_.]{2,80}$/.test(entry.checkKey)) {
    reasons.push(`${scope}.checkKey:invalid`);
  }
  if (!isIn(CHECK_CATEGORIES, entry.category)) reasons.push(`${scope}.category:invalid`);
  if (!isIn(CHECK_STATUSES, entry.status)) reasons.push(`${scope}.status:invalid`);
  if (!isIn(CHECK_METHODS, entry.method)) reasons.push(`${scope}.method:invalid`);
  if (entry.evidenceUrl !== null && !isHttpUrl(entry.evidenceUrl)) {
    reasons.push(`${scope}.evidenceUrl:not-http-url`);
  }
  if (!isPlainJson(entry.evidence)) reasons.push(`${scope}.evidence:not-json`);
  if (typeof entry.checkVersion !== 'string' || entry.checkVersion.length > 40) {
    reasons.push(`${scope}.checkVersion:invalid`);
  }
  if (!isIsoTimestamp(entry.checkedAt)) reasons.push(`${scope}.checkedAt:not-iso-timestamp`);
}

export type ValidationResult = { ok: true; asset: NormalizedAsset } | { ok: false; reasons: string[] };

/**
 * Validates one normalized asset.
 *
 * Returns every problem it finds (not just the first) so an operator sees the
 * whole defect list for a provider in one run, and the caller can log the
 * reasons verbatim into `ingestion_errors`.
 */
export function validateNormalizedAsset(asset: NormalizedAsset): ValidationResult {
  const reasons: string[] = [];

  if (!isIn(ASSET_KINDS, asset.kind)) reasons.push('kind:invalid');
  if (typeof asset.dedupeKey !== 'string' || !isValidDedupeKey(asset.dedupeKey)) {
    reasons.push('dedupeKey:invalid');
  }
  if (typeof asset.name !== 'string' || asset.name.trim().length === 0 || asset.name.length > 160) {
    reasons.push('name:invalid');
  }
  if (
    typeof asset.identifier !== 'string' ||
    asset.identifier.trim().length === 0 ||
    asset.identifier.length > 253
  ) {
    reasons.push('identifier:invalid');
  }
  if (asset.url !== null && !isHttpUrl(asset.url)) reasons.push('url:not-http-url');
  if (asset.tld !== null && (typeof asset.tld !== 'string' || !/^[a-z0-9.-]{2,40}$/.test(asset.tld))) {
    reasons.push('tld:invalid');
  }
  if (asset.country !== null && (typeof asset.country !== 'string' || !/^[A-Z]{2}$/.test(asset.country))) {
    reasons.push('country:not-iso-alpha2');
  }
  for (const key of ['industry', 'niche', 'acquisitionRoute'] as const) {
    const value = asset[key];
    if (value !== null && (typeof value !== 'string' || value.length > 120)) {
      reasons.push(`${key}:invalid`);
    }
  }
  if (!isIn(ASSET_STATUSES, asset.status)) reasons.push('status:invalid');
  if (!isIn(RISK_LEVELS, asset.riskLevel)) reasons.push('riskLevel:invalid');
  if (!isIn(VERIFICATION_STATUSES, asset.verificationStatus)) reasons.push('verificationStatus:invalid');

  const { estimatedCostMin, estimatedCostMax } = asset;
  if (!isSafeIntegerOrNull(estimatedCostMin)) reasons.push('estimatedCostMin:not-a-safe-integer');
  if (!isSafeIntegerOrNull(estimatedCostMax)) reasons.push('estimatedCostMax:not-a-safe-integer');
  if (estimatedCostMin !== null && estimatedCostMin < 0) reasons.push('estimatedCostMin:negative');
  if (estimatedCostMax !== null && estimatedCostMax < 0) reasons.push('estimatedCostMax:negative');
  if (estimatedCostMin !== null && estimatedCostMax !== null && estimatedCostMax < estimatedCostMin) {
    reasons.push('cost:max-below-min');
  }
  if (asset.costCurrency !== null && (typeof asset.costCurrency !== 'string' || !/^[A-Z]{3}$/.test(asset.costCurrency))) {
    reasons.push('costCurrency:not-iso4217');
  }
  if (asset.costCurrency !== null && estimatedCostMin === null && estimatedCostMax === null) {
    reasons.push('costCurrency:present-without-amount');
  }

  if (!Array.isArray(asset.monetization) || asset.monetization.length > 12) {
    reasons.push('monetization:invalid');
  } else if (!asset.monetization.every((m) => typeof m === 'string' && m.length <= 60)) {
    reasons.push('monetization:entry-invalid');
  }

  if (!isPlainJson(asset.attributes)) reasons.push('attributes:not-json');

  validateSignals(asset.signals, reasons);

  // Provenance is mandatory: an asset with no source is exactly the fabricated
  // record this product must never store.
  if (!Array.isArray(asset.provenance) || asset.provenance.length === 0) {
    reasons.push('provenance:missing');
  } else if (asset.provenance.length > 20) {
    reasons.push('provenance:too-many');
  } else {
    asset.provenance.forEach((entry, index) => validateProvenance(entry, index, reasons));
  }

  if (!Array.isArray(asset.verifications) || asset.verifications.length > 20) {
    reasons.push('verifications:too-many');
  } else {
    asset.verifications.forEach((entry, index) => validateVerification(entry, index, reasons));
  }

  if (reasons.length > 0) return { ok: false, reasons };
  return { ok: true, asset };
}