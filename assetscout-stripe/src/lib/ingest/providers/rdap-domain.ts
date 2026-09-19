/**
 * `rdap-domain` provider — registry-authoritative domain data over RDAP.
 *
 * RDAP (RFC 7480-7484) is the ICANN-mandated replacement for WHOIS and is the
 * *only* source in this pipeline that may state whether a domain is registered.
 * Everything it reports is a registry fact, so the resulting provenance
 * confidence is `authoritative` and the verification status is `verified`.
 *
 * Two modes, both driven by the same code path:
 *   - `candidate_check`  : the operator named the domains (query.domains)
 *   - `provider_query`   : keyword -> candidate domains -> registry lookup
 *
 * HONESTY NOTES
 *  - A 404 is a real registry answer meaning "not registered"; it becomes an
 *    `available` asset. It is NOT an inference from a failed DNS lookup.
 *  - No value is estimated here. Expiry comes from the registry's own event
 *    date, and the registrar name from the registrar entity's vCard.
 *  - Nothing is written when the registry gives an ambiguous answer.
 */
import { ProviderError } from '../../errors.ts';
import { mapWithConcurrency } from '../http-client.ts';
import { webDedupeKey } from '../dedupe.ts';
import { candidateDomains, daysBetween, normalizeHost, normalizeTimestamp, registrableDomain, tldOf } from '../normalize.ts';
import { rdapBaseUrlsFor, loadBootstrap, type RdapBootstrap } from './rdap-bootstrap.ts';
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

/** Registry statuses that mean the name is on its way out. */
const EXPIRING_STATUSES = [
  'pending delete', 'redemption period', 'pending restore', 'pendingdelete', 'redemptionperiod',
];

/** Registry statuses that restrict transfer, which matters to a buyer. */
const RESTRICTIVE_STATUSES = [
  'client transfer prohibited', 'server transfer prohibited',
  'client hold', 'server hold',
];

function normalizeStatus(raw: string): string {
  return raw.trim().toLowerCase().replace(/\s+/g, ' ');
}

/** Reads the registrar's display name out of an RDAP entity vCard. */
function registrarName(entity: Record<string, unknown>): string | null {
  const vcard = entity.vcardArray;
  if (!Array.isArray(vcard) || vcard.length < 2) return null;
  const properties = vcard[1];
  if (!Array.isArray(properties)) return null;

  for (const property of properties) {
    if (!Array.isArray(property)) continue;
    if (property[0] !== 'fn') continue;
    const value = property[3];
    if (typeof value === 'string' && value.trim().length > 0) return value.trim().slice(0, 160);
  }
  return null;
}

type RdapDomainRecord = {
  handle: string | null;
  ldhName: string;
  statuses: string[];
  registeredAt: string | null;
  expiresAt: string | null;
  lastChangedAt: string | null;
  nameserverCount: number | null;
  registrar: string | null;
  secureDns: boolean | null;
};

/**
 * Parses an RDAP domain object.
 *
 * Returns null when the payload is not a domain object, so a registry error
 * document (which also comes back as 200 from some servers) can never be stored
 * as though it were a registration record.
 */
export function parseRdapDomain(payload: unknown): RdapDomainRecord | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const record = payload as Record<string, unknown>;
  if (record.objectClassName !== 'domain') return null;

  const ldhName = typeof record.ldhName === 'string' ? record.ldhName : null;
  if (!ldhName) return null;

  const statuses: string[] = [];
  if (Array.isArray(record.status)) {
    for (const value of record.status) {
      if (typeof value === 'string') statuses.push(normalizeStatus(value));
    }
  }

  let registeredAt: string | null = null;
  let expiresAt: string | null = null;
  let lastChangedAt: string | null = null;
  if (Array.isArray(record.events)) {
    for (const event of record.events) {
      if (typeof event !== 'object' || event === null) continue;
      const action = (event as Record<string, unknown>).eventAction;
      const when = normalizeTimestamp((event as Record<string, unknown>).eventDate);
      if (typeof action !== 'string' || !when) continue;
      const key = action.trim().toLowerCase();
      if (key === 'registration') registeredAt = when;
      else if (key === 'expiration') expiresAt = when;
      else if (key === 'last changed' || key === 'last update of rdap database') lastChangedAt = when;
    }
  }

  let nameserverCount: number | null = null;
  if (Array.isArray(record.nameservers)) {
    nameserverCount = record.nameservers.length;
  }

  let registrar: string | null = null;
  if (Array.isArray(record.entities)) {
    for (const entity of record.entities) {
      if (typeof entity !== 'object' || entity === null) continue;
      const candidate = entity as Record<string, unknown>;
      const roles = Array.isArray(candidate.roles) ? candidate.roles : [];
      if (roles.some((role) => typeof role === 'string' && role.toLowerCase() === 'registrar')) {
        registrar = registrarName(candidate);
        if (registrar) break;
      }
    }
  }

  const secureDnsRaw = record.secureDNS;
  const secureDns =
    typeof secureDnsRaw === 'object' && secureDnsRaw !== null
      ? typeof (secureDnsRaw as Record<string, unknown>).delegationSigned === 'boolean'
        ? ((secureDnsRaw as Record<string, unknown>).delegationSigned as boolean)
        : null
      : null;

  return {
    handle: typeof record.handle === 'string' ? record.handle.slice(0, 200) : null,
    ldhName: ldhName.toLowerCase(),
    statuses: Array.from(new Set(statuses)),
    registeredAt,
    expiresAt,
    lastChangedAt,
    nameserverCount,
    registrar,
    secureDns,
  };
}

/** Builds the NormalizedAsset for a registered domain, from registry facts only. */
function assetFromRecord(params: {
  record: RdapDomainRecord;
  registrable: string;
  tld: string;
  sourceUrl: string;
  observedAt: string;
  discoveryMethod: 'candidate_check' | 'provider_query';
}): NormalizedAsset | null {
  const { record, registrable, tld, sourceUrl, observedAt, discoveryMethod } = params;
  const dedupeKey = webDedupeKey(registrable);
  if (!dedupeKey) return null;

  const expiring = record.statuses.some((status) =>
    EXPIRING_STATUSES.some((needle) => status.includes(needle)),
  );
  const restrictive = record.statuses.some((status) =>
    RESTRICTIVE_STATUSES.some((needle) => status.includes(needle)),
  );

  const observedAtDate = new Date(observedAt);
  const daysUntilExpiry = record.expiresAt
    ? daysBetween(observedAtDate, new Date(record.expiresAt))
    : null;

  const signals: EvidenceSignals = {
    ...EMPTY_SIGNALS,
    registryStatuses: record.statuses,
    nameserverCount: record.nameserverCount,
    registrar: record.registrar,
    daysUntilExpiry,
  };

  return {
    kind: 'domain',
    dedupeKey,
    name: registrable,
    identifier: registrable,
    url: `https://${registrable}/`,
    tld,
    country: null,
    industry: null,
    niche: null,
    status: expiring ? 'expired' : 'active',
    acquisitionRoute: null,
    estimatedCostMin: null,
    estimatedCostMax: null,
    costCurrency: null,
    riskLevel: expiring ? 'high' : restrictive ? 'medium' : 'low',
    // The registry answered definitively, so the registry facts are verified.
    verificationStatus: 'verified',
    monetization: [],
    attributes: {
      rdap_handle: record.handle,
      registered_at: record.registeredAt,
      expires_at: record.expiresAt,
      last_changed_at: record.lastChangedAt,
      secure_dns: record.secureDns,
      transfer_restricted: restrictive,
    },
    signals,
    provenance: [
      {
        sourceKey: 'rdap-domain',
        sourceUrl,
        sourceRecordId: record.handle,
        discoveryMethod,
        confidence: 'authoritative',
        observedAt,
        lastVerifiedAt: observedAt,
        verificationStatus: 'verified',
        excerpt: {
          ldh_name: record.ldhName,
          status: record.statuses.slice(0, 8),
          registered_at: record.registeredAt,
          expires_at: record.expiresAt,
          registrar: record.registrar,
        },
      },
    ],
    verifications: [
      {
        checkKey: 'domain.registration_status',
        category: 'domain',
        status: 'verified',
        method: 'registry_lookup',
        evidenceUrl: sourceUrl,
        evidence: { status: record.statuses, handle: record.handle },
        checkVersion: 'rdap-v1',
        checkedAt: observedAt,
      },
      {
        checkKey: 'domain.expiry_window',
        category: 'domain',
        status: record.expiresAt ? 'verified' : 'inconclusive',
        method: 'registry_lookup',
        evidenceUrl: sourceUrl,
        evidence: { expires_at: record.expiresAt, days_until_expiry: daysUntilExpiry },
        checkVersion: 'rdap-v1',
        checkedAt: observedAt,
      },
      {
        checkKey: 'domain.transfer_restriction',
        category: 'risk',
        status: 'verified',
        method: 'registry_lookup',
        evidenceUrl: sourceUrl,
        evidence: { restricted: restrictive, status: record.statuses },
        checkVersion: 'rdap-v1',
        checkedAt: observedAt,
      },
    ],
  };
}

/** Builds the NormalizedAsset for a domain the registry reports as unregistered. */
function assetFromAvailability(params: {
  registrable: string;
  tld: string;
  sourceUrl: string;
  observedAt: string;
  discoveryMethod: 'candidate_check' | 'provider_query';
}): NormalizedAsset | null {
  const { registrable, tld, sourceUrl, observedAt, discoveryMethod } = params;
  const dedupeKey = webDedupeKey(registrable);
  if (!dedupeKey) return null;

  return {
    kind: 'domain',
    dedupeKey,
    name: registrable,
    identifier: registrable,
    url: `https://${registrable}/`,
    tld,
    country: null,
    industry: null,
    niche: null,
    status: 'available',
    acquisitionRoute: 'register at any ICANN-accredited registrar',
    estimatedCostMin: null,
    estimatedCostMax: null,
    costCurrency: null,
    riskLevel: 'low',
    verificationStatus: 'verified',
    monetization: [],
    attributes: {
      // Stated as what it is: a registry answer at a point in time. Availability
      // is never presented as a guarantee, because a name can be registered
      // seconds after this lookup.
      availability_checked_at: observedAt,
      availability_authority: 'RDAP registry response (404 not found)',
    },
    signals: { ...EMPTY_SIGNALS },
    provenance: [
      {
        sourceKey: 'rdap-domain',
        sourceUrl,
        sourceRecordId: null,
        discoveryMethod,
        confidence: 'authoritative',
        observedAt,
        lastVerifiedAt: observedAt,
        verificationStatus: 'verified',
        excerpt: { result: 'not found in the registry at query time' },
      },
    ],
    verifications: [
      {
        checkKey: 'domain.registration_status',
        category: 'domain',
        status: 'verified',
        method: 'registry_lookup',
        evidenceUrl: sourceUrl,
        evidence: { registered: false, http_status: 404 },
        checkVersion: 'rdap-v1',
        checkedAt: observedAt,
      },
      {
        checkKey: 'domain.trademark_clearance',
        category: 'trademark',
        status: 'requires_manual_research',
        method: 'manual',
        evidenceUrl: null,
        evidence: {
          note: 'An unregistered name is not a trademark clearance. Consult the relevant trademark register before adopting it as a brand.',
        },
        checkVersion: 'rdap-v1',
        checkedAt: observedAt,
      },
    ],
  };
}

/** One RDAP lookup: build the URL, call the registry, interpret the answer. */
async function lookupDomain(params: {
  deps: ProviderDeps;
  bootstrap: RdapBootstrap;
  domain: string;
  discoveryMethod: 'candidate_check' | 'provider_query';
  result: ProviderRunResult;
}): Promise<void> {
  const { deps, bootstrap, domain, discoveryMethod, result } = params;

  const registrable = normalizeHost(domain);
  if (!registrable) {
    result.invalid += 1;
    result.invalidReasons.push('target:not-a-host');
    return;
  }
  const registrableName = registrableDomain(registrable);
  if (!registrableName) {
    result.invalid += 1;
    result.invalidReasons.push('target:not-a-registrable-domain');
    return;
  }
  const tld = tldOf(registrableName);
  if (!tld) {
    result.invalid += 1;
    result.invalidReasons.push('target:no-public-suffix');
    return;
  }

  const bases = rdapBaseUrlsFor(bootstrap, tld);
  if (bases.length === 0) {
    // Not a coverage failure of this provider: the registry simply publishes no
    // RDAP endpoint for this extension. Recorded, not guessed at.
    deps.logger.warn('rdap.tld_not_in_bootstrap', { tld });
    result.notes.push(`.${tld} has no RDAP endpoint in the IANA bootstrap registry; skipped.`);
    return;
  }

  const base = bases[0] ?? '';
  if (base.length === 0) return;
  const sourceUrl = `${base}domain/${encodeURIComponent(registrableName)}`;
  const observedAt = deps.now().toISOString();

  const response = await deps.fetch({
    provider: deps.policy.key,
    stage: 'fetch',
    url: sourceUrl,
    headers: { accept: 'application/rdap+json, application/json' },
    timeoutMs: 12_000,
    maxAttempts: 2,
    // 200 = registration record, 404 = not registered. Everything else is an
    // error and is retried or reported by the client, never interpreted.
    acceptStatuses: [200, 404],
  });

  result.fetched += 1;

  if (response.status === 404) {
    const asset = assetFromAvailability({ registrable: registrableName, tld, sourceUrl, observedAt, discoveryMethod });
    if (asset) result.assets.push(asset);
    return;
  }

  let payload: unknown;
  try {
    payload = JSON.parse(response.body);
  } catch {
    result.invalid += 1;
    result.invalidReasons.push('rdap:not-json');
    return;
  }

  const record = parseRdapDomain(payload);
  if (!record) {
    result.invalid += 1;
    result.invalidReasons.push('rdap:not-a-domain-object');
    return;
  }

  const asset = assetFromRecord({ record, registrable: registrableName, tld, sourceUrl, observedAt, discoveryMethod });
  if (asset) result.assets.push(asset);
}

export const rdapDomainProvider: IngestProvider = {
  meta: {
    key: 'rdap-domain',
    label: 'RDAP (registry-authoritative domain data)',
    kind: 'domain_registry',
    capability: 'discovery',
  },

  readiness() {
    return { ready: true };
  },

  async run(deps: ProviderDeps, query: IngestQuery): Promise<ProviderRunResult> {
    const result = emptyProviderResult();

    const bootstrap = await loadBootstrap({
      fetch: deps.fetch,
      logger: deps.logger.child('bootstrap'),
      policy: deps.policy,
      now: deps.now,
    });

    // Operator-named domains first: they are explicit requests, so they get the
    // budget before generated candidates.
    const namedTargets = query.domains
      .map((domain) => normalizeHost(domain))
      .filter((value): value is string => value !== null);

    const candidateTargets: string[] = [];
    for (const keyword of query.keywords) {
      candidateTargets.push(...candidateDomains(keyword, query.tlds, query.limitPerKeyword));
    }

    const targets = Array.from(new Set([...namedTargets, ...candidateTargets]));
    if (targets.length === 0) {
      result.notes.push('No domains or keywords were supplied, so no RDAP lookups were made.');
      return result;
    }

    // Hard ceiling so one run cannot walk an entire TLD.
    const MAX_TARGETS = 250;
    const capped = targets.slice(0, MAX_TARGETS);
    if (targets.length > capped.length) {
      result.notes.push(`Target list truncated to ${MAX_TARGETS} of ${targets.length} lookups.`);
    }

    deps.logger.info('rdap.run', { targets: capped.length, named: namedTargets.length });

    // Concurrency 3: the shared limiter still serialises requests per registry
    // host, so this only overlaps different registries.
    const outcomes = await mapWithConcurrency(capped, 3, async (target) => {
      const discoveryMethod = namedTargets.includes(target) ? 'candidate_check' : 'provider_query';
      const local = emptyProviderResult();
      try {
        await lookupDomain({ deps, bootstrap, domain: target, discoveryMethod, result: local });
      } catch (error) {
        // A single failing registry must not fail the run: it becomes an
        // ingestion error and the remaining targets continue.
        const status = error instanceof ProviderError ? error.httpStatus : null;
        const code = error instanceof ProviderError ? error.code : 'lookup_failed';
        deps.logger.warn('rdap.target_failed', { target, code, status });
        return { target, errorCode: code, local };
      }
      return { target, errorCode: null, local };
    });

    for (const outcome of outcomes) {
      result.fetched += outcome.local.fetched;
      result.invalid += outcome.local.invalid;
      result.invalidReasons.push(...outcome.local.invalidReasons);
      result.assets.push(...outcome.local.assets);
      result.notes.push(...outcome.local.notes);
      if (outcome.errorCode) {
        // A transport/registry failure is recorded as a run note, not as an
        // invalid record: nothing was received to validate.
        result.notes.push(`lookup_failed:${outcome.target}:${outcome.errorCode}`);
      }
    }

    return result;
  },
};