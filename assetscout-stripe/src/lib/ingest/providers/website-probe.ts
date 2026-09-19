/**
 * `website-probe` provider — one polite request per host.
 *
 * A LIVENESS PROBE, NOT A CRAWLER. For each host it:
 *   1. fetches `/robots.txt` and parses it for our agent token (RFC 9309),
 *   2. refuses to continue when the path is disallowed,
 *   3. honours `Crawl-delay` (and skips the probe when the delay exceeds a
 *      ceiling rather than holding a serverless invocation open),
 *   4. requests exactly one document — the homepage — and records the status,
 *      whether it redirected to another registrable domain, and whether TLS
 *      answered.
 *
 * There is no link following and no content extraction, so nothing here can
 * become a scrape of a site whose terms forbid one.
 *
 * SSRF CONTROL: only hosts with a public registrable domain are probed. IP
 * literals, single-label hosts and internal TLDs are rejected before any
 * request, so operator input cannot be used to reach cloud metadata endpoints.
 */
import { ProviderError } from '../../errors.ts';
import { webDedupeKey } from '../dedupe.ts';
import { mapWithConcurrency } from '../http-client.ts';
import { isIpv4, isIpv6, normalizeHost, registrableDomain, tldOf } from '../normalize.ts';
import { ALLOW_ALL, isPathAllowed, parseRobots, type RobotsPolicy } from '../robots.ts';
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

/** The agent token our User-Agent presents to robots.txt. */
const OUR_AGENT_TOKEN = 'assetscoutbot';

/** Refuse to wait longer than this for a Crawl-delay; skip the probe instead. */
const MAX_CRAWL_DELAY_MS = 5_000;

/** Internal / non-public suffixes that must never be probed. */
const BLOCKED_SUFFIXES = ['.local', '.internal', '.localhost', '.test', '.invalid', '.example', '.home', '.lan'];

/** True when a host is safe to probe: public DNS name, not an IP literal. */
export function isProbeableHost(host: string): boolean {
  if (isIpv4(host) || isIpv6(host)) return false;
  if (!host.includes('.')) return false;
  if (BLOCKED_SUFFIXES.some((suffix) => host.endsWith(suffix))) return false;
  if (!registrableDomain(host)) return false;
  return true;
}

/** Extracts the crawl-delay our agent is asked to respect, in milliseconds. */
function crawlDelayMs(policy: RobotsPolicy): number {
  if (policy.crawlDelaySeconds === null) return 0;
  return Math.max(0, Math.ceil(policy.crawlDelaySeconds * 1000));
}

export const websiteProbeProvider: IngestProvider = {
  meta: {
    key: 'website-probe',
    label: 'Direct website reachability probe',
    kind: 'website',
    capability: 'verification',
  },

  readiness() {
    return { ready: true };
  },

  async run(deps: ProviderDeps, query: IngestQuery): Promise<ProviderRunResult> {
    const result = emptyProviderResult();

    // Only operator-named domains are probed. Generating hosts to probe from
    // keywords would turn a polite probe into a scan, which this source's terms
    // and robots posture do not permit.
    const targets = Array.from(
      new Set(
        query.domains
          .map((domain) => normalizeHost(domain))
          .filter((host): host is string => host !== null)
          .filter(isProbeableHost),
      ),
    ).slice(0, 40);

    if (targets.length === 0) {
      result.notes.push(
        'No probeable domains were supplied. The website probe only runs against domains the operator named, so it can never become a scan.',
      );
      return result;
    }

    const outcomes = await mapWithConcurrency(targets, 2, async (host) => {
      const local = emptyProviderResult();
      try {
        await probeHost({ deps, host, result: local });
      } catch (error) {
        const code = error instanceof ProviderError ? error.code : 'probe_failed';
        deps.logger.warn('probe.host_failed', { host, code });
        return { host, errorCode: code, local };
      }
      return { host, errorCode: null, local };
    });

    for (const outcome of outcomes) {
      result.fetched += outcome.local.fetched;
      result.invalid += outcome.local.invalid;
      result.invalidReasons.push(...outcome.local.invalidReasons);
      result.assets.push(...outcome.local.assets);
      result.notes.push(...outcome.local.notes);
      if (outcome.errorCode) result.notes.push(`probe_failed:${outcome.host}:${outcome.errorCode}`);
    }

    return result;
  },
};

/** Reads robots.txt and returns the policy that applies to our agent. */
async function loadRobots(deps: ProviderDeps, host: string): Promise<{ policy: RobotsPolicy; sourceUrl: string } | null> {
  const sourceUrl = `https://${host}/robots.txt`;
  const response = await deps.fetch({
    provider: deps.policy.key,
    stage: 'configure',
    url: sourceUrl,
    headers: { accept: 'text/plain' },
    timeoutMs: 8_000,
    maxAttempts: 1,
    // 200 = rules present. 404/410 = no restrictions (RFC 9309 §2.3.1.3).
    // 403 = the site is refusing us; treated as "unknown" by returning null.
    acceptStatuses: [200, 403, 404, 410],
  });

  if (response.status !== 200) {
    if (response.status === 403) return null;
    return { policy: ALLOW_ALL, sourceUrl };
  }
  return { policy: parseRobots(response.body, OUR_AGENT_TOKEN), sourceUrl };
}

/** Probes one host, appending to `result`. */
async function probeHost(params: {
  deps: ProviderDeps;
  host: string;
  result: ProviderRunResult;
}): Promise<void> {
  const { deps, host, result } = params;
  const registrable = registrableDomain(host);
  if (!registrable) return;
  const tld = tldOf(registrable);
  const dedupeKey = webDedupeKey(registrable);
  if (!dedupeKey) return;

  const observedAt = deps.now().toISOString();

  const robots = await loadRobots(deps, host);
  result.fetched += 1;

  if (robots === null) {
    result.notes.push(`robots_unavailable:${host}:403 — probe skipped out of caution.`);
    return;
  }

  const { policy: robotsPolicy, sourceUrl: robotsUrl } = robots;
  if (!isPathAllowed(robotsPolicy, '/')) {
    result.notes.push(`robots_disallowed:${host} — the host disallows automated access to "/".`);
    return;
  }

  const delay = crawlDelayMs(robotsPolicy);
  if (delay > MAX_CRAWL_DELAY_MS) {
    result.notes.push(
      `crawl_delay_too_long:${host}:${delay}ms — probe skipped rather than holding a request that long.`,
    );
    return;
  }

  const pageUrl = `https://${host}/`;
  const response = await deps.fetch({
    provider: deps.policy.key,
    stage: 'fetch',
    url: pageUrl,
    headers: { accept: 'text/html,application/xhtml+xml' },
    timeoutMs: 12_000,
    maxAttempts: 2,
    // Every status is a finding here: 5xx means the property is down, which is
    // exactly what the probe exists to record.
    acceptAnyStatus: true,
    // A liveness probe needs the status and the first bytes, not the document.
    maxBodyBytes: 64_000,
  });
  result.fetched += 1;

  const siteServes = response.status >= 200 && response.status < 400;
  const redirectedElsewhere = response.redirectedCrossHost;
  const evidenceUrl = response.finalUrl.length > 0 ? response.finalUrl : pageUrl;

  const signals: EvidenceSignals = {
    ...EMPTY_SIGNALS,
    siteServes,
    redirectsElsewhere: redirectedElsewhere,
  };

  result.assets.push(
    buildProbeAsset({
      siteServes,
      redirectedElsewhere,
      evidenceUrl,
      pageUrl,
      robotsUrl,
      robotsPolicy,
      dedupeKey,
      registrable,
      tld,
      observedAt,
      httpStatus: response.status,
      signals,
    }),
  );

  if (delay > 0) {
    // Honouring Crawl-delay for further automated requests to this host is
    // handled by the shared limiter's per-host minimum interval; the declared
    // value is recorded so an operator can see it was respected.
    result.notes.push(`crawl_delay_declared:${host}:${delay}ms`);
  }
}

/** Builds the normalized asset for one probe observation. */
function buildProbeAsset(params: {
  siteServes: boolean;
  redirectedElsewhere: boolean;
  evidenceUrl: string;
  pageUrl: string;
  robotsUrl: string;
  robotsPolicy: RobotsPolicy;
  dedupeKey: string;
  registrable: string;
  tld: string | null;
  observedAt: string;
  httpStatus: number;
  signals: EvidenceSignals;
}): NormalizedAsset {
  const {
    siteServes, redirectedElsewhere, evidenceUrl, pageUrl, robotsUrl, robotsPolicy,
    dedupeKey, registrable, tld, observedAt, httpStatus, signals,
  } = params;

  return {
    // A host that does not answer is recorded as the DOMAIN it is, not as a
    // "website": there is no live website to classify. The classification stays
    // tied to what was actually observed.
    kind: siteServes ? 'website' : 'domain',
    dedupeKey,
    name: registrable,
    identifier: registrable,
    url: `https://${registrable}/`,
    tld,
    country: null,
    industry: null,
    niche: null,
    status: siteServes ? 'active' : 'potentially_inactive',
    acquisitionRoute: siteServes
      ? null
      : 'domain transfer if the owner is reachable, or rebuild on a new name',
    estimatedCostMin: null,
    estimatedCostMax: null,
    costCurrency: null,
    riskLevel: 'unknown',
    // Liveness was verified by direct observation; ownership, revenue and
    // transferability were NOT, so this is deliberately not `verified`.
    verificationStatus: 'partially_verified',
    monetization: [],
    attributes: {
      probe_method: 'single homepage GET over HTTPS, no link following',
      http_status: httpStatus,
      final_url: evidenceUrl,
      probed_at: observedAt,
    },
    signals,
    provenance: [
      {
        sourceKey: 'website-probe',
        sourceUrl: pageUrl,
        sourceRecordId: null,
        discoveryMethod: 'candidate_check',
        confidence: 'authoritative',
        observedAt,
        lastVerifiedAt: observedAt,
        verificationStatus: 'partially_verified',
        excerpt: {
          http_status: httpStatus,
          final_url: evidenceUrl,
          redirected_cross_host: redirectedElsewhere,
        },
      },
    ],
    verifications: [
      {
        checkKey: 'website.homepage_reachable',
        category: 'website',
        status: siteServes ? 'verified' : 'failed',
        method: 'api',
        evidenceUrl,
        evidence: { http_status: httpStatus, site_serves: siteServes },
        checkVersion: 'probe-v1',
        checkedAt: observedAt,
      },
      {
        checkKey: 'website.redirect_behaviour',
        category: 'website',
        status: 'verified',
        method: 'api',
        evidenceUrl,
        evidence: { redirected_cross_host: redirectedElsewhere, final_url: evidenceUrl },
        checkVersion: 'probe-v1',
        checkedAt: observedAt,
      },
      {
        checkKey: 'website.robots_policy',
        category: 'website',
        status: 'verified',
        method: 'api',
        evidenceUrl: robotsUrl,
        evidence: {
          matched_agent: robotsPolicy.matchedAgent,
          crawl_delay_seconds: robotsPolicy.crawlDelaySeconds,
          fetch_allowed: true,
        },
        checkVersion: 'probe-v1',
        checkedAt: observedAt,
      },
      {
        checkKey: 'website.ownership',
        category: 'ownership',
        status: 'not_checked',
        method: 'not_available',
        evidenceUrl: null,
        evidence: {
          note: 'A reachable homepage is not evidence of ownership. Who controls this property has not been established.',
        },
        checkVersion: 'probe-v1',
        checkedAt: observedAt,
      },
    ],
  };
}