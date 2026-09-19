/**
 * IANA RDAP bootstrap registry (https://data.iana.org/rdap/dns.json).
 *
 * This is the public, authoritative mapping from a TLD to the RDAP base URL of
 * the registry that operates it. It is what makes RDAP usable without
 * hard-coding a registry endpoint per extension (which would silently go stale
 * and would be a fabricated source of truth).
 *
 * Cached in process for `TTL_MS` because it changes rarely, and because a run
 * that checks 50 domains must not re-download it 50 times.
 *
 * `parseBootstrap` is pure and unit-tested; `loadBootstrap` is the only part
 * that touches the network, through the injected polite client.
 */
import type { IngestLogger, SourcePolicy } from '../types.ts';
import type { PoliteFetch } from '../http-client.ts';

export const IANA_BOOTSTRAP_SOURCE_URL = 'https://data.iana.org/rdap/dns.json';

export type RdapBootstrap = {
  /** Lowercase TLD (no leading dot) -> validated https base URLs. */
  byTld: ReadonlyMap<string, readonly string[]>;
  /** ISO timestamp of the download this data came from. */
  fetchedAt: string;
  sourceUrl: string;
  tldCount: number;
};

/** The bootstrap file is static; a day of cache is both safe and polite. */
const TTL_MS = 24 * 60 * 60 * 1000;

type ServiceEntry = { tlds: string[]; urls: string[] };

/** Validates one `[[tlds], [urls]]` service entry. */
function parseServiceEntry(entry: unknown): ServiceEntry | null {
  if (!Array.isArray(entry) || entry.length < 2) return null;
  const rawTlds = entry[0];
  const rawUrls = entry[1];
  if (!Array.isArray(rawTlds) || !Array.isArray(rawUrls)) return null;

  const tlds: string[] = [];
  for (const value of rawTlds) {
    if (typeof value !== 'string') continue;
    const tld = value.trim().toLowerCase().replace(/^\./, '');
    // Only DNS labels: the file also contains a few IDN entries in A-label form.
    if (/^[a-z0-9-]{2,63}$/.test(tld)) tlds.push(tld);
  }

  const urls: string[] = [];
  for (const value of rawUrls) {
    if (typeof value !== 'string') continue;
    try {
      const url = new URL(value);
      // Only https endpoints are ever called: a registry that has not moved to
      // TLS is not something this pipeline will authenticate against.
      if (url.protocol !== 'https:') continue;
      urls.push(url.toString().replace(/\/?$/, '/'));
    } catch {
      continue;
    }
  }

  if (tlds.length === 0 || urls.length === 0) return null;
  return { tlds, urls };
}

/**
 * Parses the bootstrap document.
 * Returns null when the shape is not the IANA file, so a captive-portal HTML
 * page can never be mistaken for the registry.
 */
export function parseBootstrap(payload: unknown): RdapBootstrap | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const services = (payload as { services?: unknown }).services;
  if (!Array.isArray(services)) return null;

  const byTld = new Map<string, string[]>();
  for (const entry of services) {
    const parsed = parseServiceEntry(entry);
    if (!parsed) continue;
    for (const tld of parsed.tlds) {
      const existing = byTld.get(tld);
      if (existing) {
        for (const url of parsed.urls) if (!existing.includes(url)) existing.push(url);
      } else {
        byTld.set(tld, [...parsed.urls]);
      }
    }
  }

  if (byTld.size === 0) return null;

  const publication =
    typeof (payload as { publication?: unknown }).publication === 'string'
      ? ((payload as { publication: string }).publication)
      : null;

  return {
    byTld,
    fetchedAt: publication ?? new Date().toISOString(),
    sourceUrl: IANA_BOOTSTRAP_SOURCE_URL,
    tldCount: byTld.size,
  };
}

let cached: { at: number; value: RdapBootstrap } | null = null;

/** Clears the process cache. Used by tests and by `force` refreshes. */
export function resetBootstrapCache(): void {
  cached = null;
}

export type BootstrapDeps = {
  fetch: PoliteFetch;
  logger: IngestLogger;
  policy: SourcePolicy;
  now: () => Date;
  /** Bypass the cache (admin-triggered refresh). */
  force?: boolean;
};

/**
 * Returns the bootstrap registry, downloading it at most once per TTL.
 *
 * Throws `ProviderError` (via the polite client) when the file cannot be
 * fetched, so the caller records a source failure instead of proceeding with an
 * empty registry — which would silently turn every domain into "not covered".
 */
export async function loadBootstrap(deps: BootstrapDeps): Promise<RdapBootstrap> {
  const nowMs = deps.now().getTime();
  if (!deps.force && cached && nowMs - cached.at < TTL_MS) {
    return cached.value;
  }

  deps.logger.info('iana_bootstrap.fetch', { url: IANA_BOOTSTRAP_SOURCE_URL });

  const response = await deps.fetch({
    provider: deps.policy.key,
    stage: 'configure',
    url: IANA_BOOTSTRAP_SOURCE_URL,
    headers: { accept: 'application/json' },
    timeoutMs: 15_000,
    maxAttempts: 2,
    acceptStatuses: [200],
  });

  let payload: unknown;
  try {
    payload = JSON.parse(response.body);
  } catch {
    deps.logger.error('iana_bootstrap.parse_failed', { url: IANA_BOOTSTRAP_SOURCE_URL });
    throw new Error('IANA RDAP bootstrap response was not JSON');
  }

  const parsed = parseBootstrap(payload);
  if (!parsed) {
    deps.logger.error('iana_bootstrap.shape_failed', { url: IANA_BOOTSTRAP_SOURCE_URL });
    throw new Error('IANA RDAP bootstrap response did not have the expected shape');
  }

  const value: RdapBootstrap = { ...parsed, fetchedAt: deps.now().toISOString() };
  cached = { at: nowMs, value };
  deps.logger.info('iana_bootstrap.loaded', { tldCount: value.tldCount });
  return value;
}

/** RDAP base URLs for a TLD, in the registry's own priority order. */
export function rdapBaseUrlsFor(bootstrap: RdapBootstrap, tld: string): readonly string[] {
  return bootstrap.byTld.get(tld.trim().toLowerCase().replace(/^\./, '')) ?? [];
}
