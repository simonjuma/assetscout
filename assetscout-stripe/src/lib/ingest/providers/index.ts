/**
 * The provider registry.
 *
 * Adding a source is two steps and nothing else changes:
 *   1. write a module exporting an `IngestProvider` (see any sibling file),
 *   2. add one row to `public.sources` (supabase/migrations/0003_seed.sql) and
 *      register the module's key in `PROVIDER_KEYS` below.
 *
 * `validateProviderCatalog()` is the guard that keeps those two steps in sync:
 * it cross-checks the code registry against the database catalog, so a provider
 * can never run without a documented source row (terms posture, rate limit,
 * required credentials) and a catalog row can never exist with no module behind
 * it. `tests/providers.test.ts` and the admin source-health route both call it.
 */
import type { IngestProvider } from '../types.ts';
import { companiesHouseUkProvider } from './companies-house-uk.ts';
import { commonCrawlIndexProvider } from './common-crawl-index.ts';
import { hnSignalsProvider } from './hn-signals.ts';
import { ianaBootstrapProvider } from './iana-bootstrap.ts';
import { manualRegistryProvider } from './manual-registry.ts';
import { rdapDomainProvider } from './rdap-domain.ts';
import { websiteProbeProvider } from './website-probe.ts';

/**
 * The keys of `public.sources` that have a module. Mirrors the seed migration;
 * `validateProviderCatalog()` fails loudly if the two diverge.
 */
export const PROVIDER_KEYS = [
  'rdap-domain',
  'iana-bootstrap',
  'website-probe',
  'common-crawl-index',
  'hn-signals',
  'companies-house-uk',
  'manual-registry',
] as const;

export type ProviderKey = (typeof PROVIDER_KEYS)[number];

export const PROVIDERS: readonly IngestProvider[] = [
  // Ordering matters: the bootstrap load, then authoritative registry data, then
  // observation and signal enrichment, then the manual-research tasks. Each
  // provider merges into the same asset identity, so a later provider enriches
  // rather than duplicating.
  ianaBootstrapProvider,
  rdapDomainProvider,
  websiteProbeProvider,
  commonCrawlIndexProvider,
  hnSignalsProvider,
  companiesHouseUkProvider,
  manualRegistryProvider,
];

const BY_KEY = new Map<string, IngestProvider>(PROVIDERS.map((provider) => [provider.meta.key, provider]));

/** Looks a provider up by its catalog key. Undefined when there is no module. */
export function providerByKey(key: string): IngestProvider | undefined {
  return BY_KEY.get(key);
}

/** Providers whose key is in `keys`, preserving the catalog order above. */
export function providersFor(keys: readonly string[]): IngestProvider[] {
  const wanted = new Set(keys);
  return PROVIDERS.filter((provider) => wanted.has(provider.meta.key));
}

export type CatalogMismatch = {
  /** Catalog keys with no module: a row exists but nothing can run. */
  missingModules: string[];
  /** Module keys with no catalog row: a provider would run undocumented. */
  missingCatalogRows: string[];
  /** Keys in PROVIDER_KEYS with no module (a typo in this file). */
  missingFromRegistry: string[];
};

/**
 * Compares the code registry with the database catalog.
 *
 * `catalogKeys` must come from `public.sources` (the caller loads it), so this
 * function stays pure and testable.
 */
export function validateProviderCatalog(catalogKeys: readonly string[]): CatalogMismatch {
  const catalog = new Set(catalogKeys);
  const registry = new Set<string>(PROVIDER_KEYS);
  const modules = new Set<string>(PROVIDERS.map((provider) => provider.meta.key));

  return {
    missingModules: [...catalog].filter((key) => !modules.has(key)).sort(),
    missingCatalogRows: [...modules].filter((key) => !catalog.has(key)).sort(),
    missingFromRegistry: [...registry].filter((key) => !modules.has(key)).sort(),
  };
}

/** True when the registry and the catalog agree exactly. */
export function catalogIsConsistent(catalogKeys: readonly string[]): boolean {
  const mismatch = validateProviderCatalog(catalogKeys);
  return (
    mismatch.missingModules.length === 0 &&
    mismatch.missingCatalogRows.length === 0 &&
    mismatch.missingFromRegistry.length === 0
  );
}