/**
 * Persistence round-trip for collected evidence signals.
 *
 * WHY THIS EXISTS
 * ---------------
 * `public.assets` has no `signals` column: the schema stores provenance
 * (`asset_sources.raw_excerpt`), checks (`asset_verifications`) and the score
 * breakdown (`asset_scores.factors`). Those cover what a check proved, but not
 * the raw observation counters a later run needs to *merge with* — e.g. the
 * `mentions` count that `hn-signals` collected for a host, or whether
 * `website-probe` saw the homepage serving.
 *
 * Without keeping them, a later, sparser provider run would recompute a score
 * from fewer signals and could downgrade a well-evidenced asset — silently
 * losing evidence that was really observed. So the signals are stored inside the
 * free-form `assets.attributes` jsonb under the reserved key
 * `STORED_SIGNALS_KEY`, and read back with a strict, defensive parser: the column
 * is operator-writable and may hold anything.
 *
 * Reserved-key note: `attributes` is documented as provider-supplied attributes.
 * `observed_signals` is the only key this pipeline owns; every other key is
 * passed through untouched.
 *
 * Pure, no I/O, node-loadable.
 */
import { EMPTY_SIGNALS, type EvidenceSignals } from './types.ts';

/** The reserved `assets.attributes` key holding the last observed signals. */
export const STORED_SIGNALS_KEY = 'observed_signals';

function numberOrNull(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null;
}

function booleanOrNull(value: unknown): boolean | null {
  return typeof value === 'boolean' ? value : null;
}

function stringOrNull(value: unknown): string | null {
  return typeof value === 'string' && value.trim().length > 0 ? value.trim().slice(0, 160) : null;
}

function stringArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((entry): entry is string => typeof entry === 'string' && entry.trim().length > 0)
    .map((entry) => entry.trim().slice(0, 120))
    .slice(0, 40);
}

/**
 * Reads the signals stored in an `attributes` jsonb value.
 *
 * Never throws and never returns a partially-parsed value: anything that is not
 * the expected shape degrades to `EMPTY_SIGNALS` for that field, so a corrupted
 * row cannot poison a score.
 */
export function readStoredSignals(attributes: unknown): EvidenceSignals {
  if (typeof attributes !== 'object' || attributes === null || Array.isArray(attributes)) {
    return { ...EMPTY_SIGNALS };
  }
  const raw = (attributes as Record<string, unknown>)[STORED_SIGNALS_KEY];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return { ...EMPTY_SIGNALS };
  }
  const record = raw as Record<string, unknown>;
  return {
    mentions: numberOrNull(record.mentions),
    crawlArchives: numberOrNull(record.crawlArchives),
    siteServes: booleanOrNull(record.siteServes),
    redirectsElsewhere: booleanOrNull(record.redirectsElsewhere),
    registryStatuses: stringArray(record.registryStatuses),
    nameserverCount: numberOrNull(record.nameserverCount),
    registrar: stringOrNull(record.registrar),
    daysUntilExpiry: numberOrNull(record.daysUntilExpiry),
    companyFound: booleanOrNull(record.companyFound),
    companyStatus: stringOrNull(record.companyStatus),
    trademarkManualResearch: booleanOrNull(record.trademarkManualResearch),
  };
}

/**
 * Returns `attributes` with the reserved signals key set to `signals`.
 *
 * Existing keys are preserved, so provider attributes (registry status,
 * nameservers, probe results) survive the round-trip untouched.
 */
export function withStoredSignals(
  attributes: Record<string, unknown>,
  signals: EvidenceSignals,
): Record<string, unknown> {
  return { ...attributes, [STORED_SIGNALS_KEY]: signals };
}
