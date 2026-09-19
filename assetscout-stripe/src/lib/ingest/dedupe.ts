/**
 * Asset identity (the deduplication contract).
 *
 * A `dedupe_key` is the canonical identity of an asset, independent of which
 * provider observed it. `public.assets` has `UNIQUE (kind, dedupe_key)`, and the
 * pipeline additionally merges across kinds (see `pipeline.ts`), so the same
 * website discovered by the RDAP provider and later by the signal provider ends
 * up as ONE row with two provenance rows — never two opportunities.
 *
 * Key shapes (all lowercase, colon-separated, no whitespace):
 *   domain:<registrable-domain>        web-facing assets (domain/website/saas/…)
 *   company:<jurisdiction>:<number>    official business-registry records
 *   brand:<slug>                       name-only identities (no web/registry id)
 *
 * Pure and node-loadable.
 */
import type { AssetKind, VerificationStatus } from '../supabase/database.types.ts';
import { normalizeHost, normalizeName, registrableDomain, slugify, truncate } from './normalize.ts';

/** A web-facing identity, keyed on the registrable domain. */
export function webDedupeKey(hostOrUrl: string): string | null {
  const registrable = registrableDomain(hostOrUrl) ?? registrableDomain(normalizeHost(hostOrUrl) ?? '');
  if (!registrable) return null;
  return `domain:${registrable}`;
}

/**
 * An official business-registry identity. `jurisdiction` is the registry's own
 * country code (e.g. `gb`) and `companyNumber` the registry's identifier, so two
 * companies that share a name can never collapse into one asset.
 */
export function companyDedupeKey(jurisdiction: string, companyNumber: string): string | null {
  const cleanJurisdiction = slugify(jurisdiction, 8);
  const cleanNumber = normalizeName(companyNumber, 40).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (cleanJurisdiction.length === 0 || cleanNumber.length === 0) return null;
  return `company:${cleanJurisdiction}:${cleanNumber}`;
}

/** A name-only identity, used when no web or registry identifier exists. */
export function brandDedupeKey(name: string): string | null {
  const slug = slugify(name, 63);
  return slug.length >= 2 ? `brand:${slug}` : null;
}

/**
 * Validates a dedupe key before it is written.
 *
 * Rejects empty segments, whitespace, uppercase and over-long keys, so a buggy
 * provider cannot create an unmergeable identity that silently duplicates an
 * asset on the next run.
 */
export function isValidDedupeKey(key: string): boolean {
  if (key.length === 0 || key.length > 200) return false;
  if (/\s/.test(key)) return false;
  if (key !== key.toLowerCase()) return false;
  const segments = key.split(':');
  if (segments.length < 2) return false;
  return segments.every((segment) => segment.length > 0 && /^[a-z0-9._-]+$/.test(segment));
}

/**
 * Extracts the registrable domain encoded in a `domain:` key.
 * Returns null for any other key shape.
 */
export function registrableFromDedupeKey(key: string): string | null {
  if (!key.startsWith('domain:')) return null;
  const value = key.slice('domain:'.length);
  return isValidDedupeKey(key) && value.length > 0 ? value : null;
}

/**
 * How "specific" an asset classification is.
 *
 * The pipeline only replaces a stored `kind` with an incoming one when the
 * incoming classification is strictly more specific AND is backed by real
 * evidence (see `resolveKind`). This is what stops a weak signal from
 * relabelling a registry-verified domain as something it is not.
 */
const KIND_RANK: Record<AssetKind, number> = {
  domain: 1,
  website: 2,
  brand: 2,
  digital_product: 3,
  saas: 4,
  digital_business: 4,
};

export function kindRank(kind: AssetKind): number {
  return KIND_RANK[kind];
}

/**
 * Chooses the classification to keep when an incoming observation merges with a
 * stored asset.
 *
 * Rule: keep the stored kind unless the incoming kind is strictly more specific
 * and the incoming observation is evidence-backed (`verified` or
 * `partially_verified`). A `unverified` observation never relabels anything.
 */
export function resolveKind(
  storedKind: AssetKind,
  incomingKind: AssetKind,
  incomingVerificationStatus: VerificationStatus,
): AssetKind {
  if (storedKind === incomingKind) return storedKind;
  const evidenceBacked =
    incomingVerificationStatus === 'verified' || incomingVerificationStatus === 'partially_verified';
  if (evidenceBacked && KIND_RANK[incomingKind] > KIND_RANK[storedKind]) return incomingKind;
  return storedKind;
}

/** Caps a provenance excerpt so a provider payload can never bloat a row. */
export function excerptValue(value: unknown, maxLength = 500): string | null {
  if (value === null || value === undefined) return null;
  if (typeof value === 'string') return truncate(value, maxLength);
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  return null;
}
