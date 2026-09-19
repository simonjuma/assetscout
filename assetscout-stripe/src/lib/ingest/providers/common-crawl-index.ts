/**
 * `common-crawl-index` provider — historical web presence.
 *
 * Common Crawl publishes an open, public CDX index of its crawls. Consulting it
 * answers one narrow question honestly: "has this host appeared in a public web
 * crawl, and when?" That is evidence of historical presence — it is NOT traffic,
 * revenue, ranking or ownership, and the provider never says otherwise.
 *
 * The crawl list is read from `collinfo.json` on every run rather than
 * hard-coding a crawl id, because a hard-coded id silently goes stale and would
 * turn a real observation into a fabricated one.
 *
 * Posture: `api_only`. This is a documented dataset endpoint; the site is never
 * crawled.
 */
import { ProviderError } from '../../errors.ts';
import { webDedupeKey } from '../dedupe.ts';
import { mapWithConcurrency } from '../http-client.ts';
import { normalizeHost, normalizeTimestamp, registrableDomain, tldOf } from '../normalize.ts';
import {
  EMPTY_SIGNALS,
  emptyProviderResult,
  type EvidenceSignals,
  type IngestProvider,
  type IngestQuery,
  type NormalizedAsset,
  type ProviderDeps,
  type ProviderRunResult,
} from '../types.ts';

const COLLINFO_URL = 'https://index.commoncrawl.org/collinfo.json';
const CDX_BASE = 'https://index.commoncrawl.org/';
/** One page of matches is enough to establish presence. */
const CDX_LIMIT = 10;

export type CrawlIndex = { id: string; cdxApi: string };

/**
 * Picks the most recent crawl from `collinfo.json`.
 *
 * Returns null when the document is not the expected array of crawl objects, so
 * a captive portal or error page can never be treated as a crawl id.
 */
export function parseCrawlIndex(payload: unknown): CrawlIndex | null {
  if (!Array.isArray(payload)) return null;
  for (const entry of payload) {
    if (typeof entry !== 'object' || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const id = typeof record.id === 'string' ? record.id : null;
    if (!id) continue;
    const cdxApi =
      typeof record['cdx-api'] === 'string' ? (record['cdx-api'] as string) : `${CDX_BASE}${id}-index`;
    try {
      const url = new URL(cdxApi);
      if (url.protocol !== 'https:') continue;
      return { id, cdxApi: url.toString() };
    } catch {
      continue;
    }
  }
  return null;
}

/**
 * Parses the newline-delimited CDX response.
 * Returns the observations that carry a usable timestamp.
 */
export function parseCdxResponse(
  body: string,
): Array<{ timestamp: string; url: string; status: string | null }> {
  const rows: Array<{ timestamp: string; url: string; status: string | null }> = [];
  for (const line of body.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0 || !trimmed.startsWith('{')) continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      continue;
    }
    if (typeof parsed !== 'object' || parsed === null) continue;
    const record = parsed as Record<string, unknown>;
    const timestamp = normalizeTimestamp(record.timestamp);
    const url = typeof record.url === 'string' ? record.url : null;
    if (!timestamp || !url) continue;
    rows.push({
      timestamp,
      url,
      status: typeof record.status === 'string' ? record.status : null,
    });
  }
  return rows;
}

/** Queries the CDX index for one host. */
async function lookupHost(params: {
  deps: ProviderDeps;
  host: string;
  crawlIndex: CrawlIndex;
  result: ProviderRunResult;
}): Promise<void> {
  const { deps, host, crawlIndex, result } = params;
  const registrable = registrableDomain(host);
  if (!registrable) return;
  const dedupeKey = webDedupeKey(registrable);
  if (!dedupeKey) return;

  const sourceUrl = `${crawlIndex.cdxApi}?url=${encodeURIComponent(registrable)}&output=json&limit=${CDX_LIMIT}`;
  const response = await deps.fetch({
    provider: deps.policy.key,
    stage: 'fetch',
    url: sourceUrl,
    headers: { accept: 'application/json, text/plain' },
    timeoutMs: 20_000,
    maxAttempts: 2,
    // 200 = matches (NDJSON). 404 = the index has no record of this host, which
    // is itself a legitimate negative observation.
    acceptStatuses: [200, 404],
  });
  result.fetched += 1;

  const rows = response.status === 200 ? parseCdxResponse(response.body) : [];
  if (rows.length === 0) {
    result.notes.push(`no_crawl_presence:${registrable}`);
    return;
  }

  const observedAt = deps.now().toISOString();
  const latest = rows.reduce<string | null>(
    (newest, row) => (newest === null || row.timestamp > newest ? row.timestamp : newest),
    null,
  );

  const signals: EvidenceSignals = { ...EMPTY_SIGNALS, crawlArchives: rows.length };

  const asset: NormalizedAsset = {
    kind: 'website',
    dedupeKey,
    name: registrable,
    identifier: registrable,
    url: `https://${registrable}/`,
    tld: tldOf(registrable),
    country: null,
    industry: null,
    niche: null,
    status: 'unknown',
    acquisitionRoute: null,
    estimatedCostMin: null,
    estimatedCostMax: null,
    costCurrency: null,
    riskLevel: 'unknown',
    // Historical presence is not current-state verification.
    verificationStatus: 'partially_verified',
    monetization: [],
    attributes: {
      crawl_index: crawlIndex.id,
      crawl_records: rows.length,
      latest_crawl_timestamp: latest,
      sample_urls: rows.slice(0, 3).map((row) => row.url.slice(0, 200)),
    },
    signals,
    provenance: [
      {
        sourceKey: 'common-crawl-index',
        sourceUrl,
        sourceRecordId: crawlIndex.id,
        discoveryMethod: 'candidate_check',
        confidence: 'signal',
        observedAt,
        lastVerifiedAt: null,
        verificationStatus: 'partially_verified',
        excerpt: {
          crawl_index: crawlIndex.id,
          crawl_records: rows.length,
          latest_crawl_timestamp: latest,
        },
      },
    ],
    verifications: [
      {
        checkKey: 'website.historical_presence',
        category: 'website',
        status: 'verified',
        method: 'api',
        evidenceUrl: sourceUrl,
        evidence: {
          crawl_index: crawlIndex.id,
          crawl_records: rows.length,
          latest_crawl_timestamp: latest,
          note: 'Presence in a public web crawl is historical evidence only. It is not traffic, ranking, revenue or ownership.',
        },
        checkVersion: 'ccindex-v1',
        checkedAt: observedAt,
      },
    ],
  };

  result.assets.push(asset);
}

export const commonCrawlIndexProvider: IngestProvider = {
  meta: {
    key: 'common-crawl-index',
    label: 'Common Crawl index (historical web presence)',
    kind: 'historical_index',
    capability: 'verification',
  },

  readiness() {
    return { ready: true };
  },

  async run(deps: ProviderDeps, query: IngestQuery): Promise<ProviderRunResult> {
    const result = emptyProviderResult();

    const targets = Array.from(
      new Set(
        query.domains.map((domain) => normalizeHost(domain)).filter((host): host is string => host !== null),
      ),
    ).slice(0, 25);

    if (targets.length === 0) {
      result.notes.push(
        'No named domains were supplied. The historical index is consulted for specific domains only, so it cannot become a bulk crawl of the archive.',
      );
      return result;
    }

    const collinfo = await deps.fetch({
      provider: deps.policy.key,
      stage: 'configure',
      url: COLLINFO_URL,
      headers: { accept: 'application/json' },
      timeoutMs: 15_000,
      maxAttempts: 2,
      acceptStatuses: [200],
    });
    result.fetched += 1;

    let crawlIndex: CrawlIndex | null = null;
    try {
      crawlIndex = parseCrawlIndex(JSON.parse(collinfo.body));
    } catch {
      crawlIndex = null;
    }
    if (!crawlIndex) {
      throw new ProviderError({
        provider: deps.policy.key,
        stage: 'configure',
        code: 'crawl_index_unavailable',
        message: 'Common Crawl collinfo.json did not contain a usable crawl index',
        httpStatus: 200,
      });
    }
    result.notes.push(`Using Common Crawl index ${crawlIndex.id}.`);

    const outcomes = await mapWithConcurrency(targets, 2, async (host) => {
      const local = emptyProviderResult();
      try {
        await lookupHost({ deps, host, crawlIndex, result: local });
      } catch (error) {
        const code = error instanceof ProviderError ? error.code : 'index_query_failed';
        return { host, errorCode: code, local };
      }
      return { host, errorCode: null, local };
    });

    for (const outcome of outcomes) {
      result.fetched += outcome.local.fetched;
      result.assets.push(...outcome.local.assets);
      result.notes.push(...outcome.local.notes);
      if (outcome.errorCode) result.notes.push(`index_failed:${outcome.host}:${outcome.errorCode}`);
    }

    return result;
  },
};