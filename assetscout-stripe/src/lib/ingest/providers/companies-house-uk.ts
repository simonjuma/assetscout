/**
 * `companies-house-uk` provider — official UK company register.
 *
 * Companies House publishes a free, documented REST API under the Open
 * Government Licence. It is an authoritative register, so company status,
 * incorporation date and SIC codes are recorded with `registry` confidence.
 *
 * WHAT IT DOES NOT CLAIM: a register entry is a filing, not proof that a company
 * owns a domain, that a website belongs to it, or that anything is
 * transferable. The resulting asset is therefore `partially_verified`, and the
 * ownership check is recorded as `not_checked`.
 *
 * CREDENTIALS: requires `COMPANIES_HOUSE_API_KEY` (free, from
 * https://developer.company-information.service.gov.uk/). `readiness()` reports
 * the missing variable NAME (never a value) so the admin source list can show
 * exactly what an operator must set. The key is sent as HTTP Basic auth — the
 * scheme this API documents — and is redacted from every log by
 * `redactSecrets`.
 */
import { companyDedupeKey } from '../dedupe.ts';
import { normalizeCountry, normalizeTimestamp, registrableDomain, tldOf } from '../normalize.ts';
import {
  EMPTY_SIGNALS,
  emptyProviderResult,
  type EvidenceSignals,
  type IngestProvider,
  type IngestQuery,
  type NormalizedAsset,
  type ProviderDeps,
  type ProviderReadiness,
  type ProviderRunResult,
} from '../types.ts';

const SEARCH_URL = 'https://api.company-information.service.gov.uk/search/companies';
const MAX_ITEMS_PER_PAGE = 10;
const OFFICER_REGISTER_BASE = 'https://find-and-update.company-information.service.gov.uk/company/';

/** HTTP Basic auth, the scheme this API documents: key as user, blank password. */
function basicAuthHeader(apiKey: string): string {
  const raw = `${apiKey}:`;
  // `Buffer` is available in the Node runtime these routes declare. The `btoa`
  // fallback keeps the module loadable anywhere else without a polyfill.
  if (typeof Buffer !== 'undefined') {
    return `Basic ${Buffer.from(raw, 'utf8').toString('base64')}`;
  }
  return `Basic ${globalThis.btoa(raw)}`;
}

/** Normalizes a Companies House status into our closed status set. */
export function mapCompanyStatus(companyStatus: string | null): 'active' | 'struck_off' | 'unknown' {
  if (!companyStatus) return 'unknown';
  const status = companyStatus.trim().toLowerCase();
  if (status === 'active' || status === 'active-proposal-to-strike-off') return 'active';
  if (
    status === 'dissolved' ||
    status === 'liquidation' ||
    status === 'receivership' ||
    status === 'administration' ||
    status === 'voluntary-arrangement' ||
    status === 'converted-closed' ||
    status === 'insolvency-proceedings'
  ) {
    return 'struck_off';
  }
  return 'unknown';
}

export type CompanyRecord = {
  companyNumber: string;
  title: string;
  companyStatus: string | null;
  companyType: string | null;
  dateOfCreation: string | null;
  addressSnippet: string | null;
  sicCodes: string[];
};

/** Parses the search response, skipping entries without a usable identifier. */
export function parseCompanySearch(payload: unknown): { totalResults: number; items: CompanyRecord[] } {
  if (typeof payload !== 'object' || payload === null) return { totalResults: 0, items: [] };
  const record = payload as Record<string, unknown>;

  const totalResults =
    typeof record.total_results === 'number' &&
    Number.isFinite(record.total_results) &&
    record.total_results >= 0
      ? Math.min(Math.trunc(record.total_results), 1_000_000)
      : 0;

  const items: CompanyRecord[] = [];
  if (Array.isArray(record.items)) {
    for (const entry of record.items) {
      if (typeof entry !== 'object' || entry === null) continue;
      const item = entry as Record<string, unknown>;
      const companyNumber = typeof item.company_number === 'string' ? item.company_number : null;
      const title = typeof item.title === 'string' ? item.title : null;
      if (!companyNumber || !title) continue;

      const sicCodes: string[] = [];
      if (Array.isArray(item.sic_codes)) {
        for (const code of item.sic_codes) {
          if (typeof code === 'string' && code.length <= 16) sicCodes.push(code);
        }
      }

      items.push({
        companyNumber,
        title: title.slice(0, 160),
        companyStatus: typeof item.company_status === 'string' ? item.company_status : null,
        companyType: typeof item.company_type === 'string' ? item.company_type : null,
        dateOfCreation: normalizeTimestamp(item.date_of_creation),
        addressSnippet: typeof item.address_snippet === 'string' ? item.address_snippet.slice(0, 240) : null,
        sicCodes: sicCodes.slice(0, 10),
      });
    }
  }

  return { totalResults, items };
}

/** Builds the asset for one register entry. */
function buildCompanyAsset(params: {
  company: CompanyRecord;
  keyword: string;
  sourceUrl: string;
  observedAt: string;
}): NormalizedAsset | null {
  const { company, keyword, sourceUrl, observedAt } = params;

  // Identity is the register's own number and jurisdiction, so two companies
  // that share a name can never collapse into one asset.
  const dedupeKey = companyDedupeKey('gb', company.companyNumber);
  if (!dedupeKey) return null;

  const status = mapCompanyStatus(company.companyStatus);
  const signals: EvidenceSignals = {
    ...EMPTY_SIGNALS,
    companyFound: true,
    companyStatus: company.companyStatus,
  };

  // A register title may itself be a domain (rare but real); only then is there
  // a web identity to record. Nothing is inferred from the title otherwise.
  const titleHost = registrableDomain(company.title.trim().toLowerCase());
  const registerUrl = `${OFFICER_REGISTER_BASE}${encodeURIComponent(company.companyNumber)}`;

  return {
    kind: 'digital_business',
    dedupeKey,
    name: company.title,
    identifier: company.companyNumber,
    url: titleHost ? `https://${titleHost}/` : registerUrl,
    tld: titleHost ? tldOf(titleHost) : null,
    country: normalizeCountry('gb'),
    industry: company.sicCodes.length > 0 ? `SIC ${company.sicCodes[0] ?? ''}` : null,
    niche: keyword.slice(0, 120),
    status,
    acquisitionRoute: null,
    estimatedCostMin: null,
    estimatedCostMax: null,
    costCurrency: null,
    riskLevel: status === 'struck_off' ? 'high' : 'low',
    // The register facts are authoritative; whether there is a business to buy
    // around them is not.
    verificationStatus: 'partially_verified',
    monetization: [],
    attributes: {
      company_number: company.companyNumber,
      company_type: company.companyType,
      company_status: company.companyStatus,
      date_of_creation: company.dateOfCreation,
      registered_address: company.addressSnippet,
      sic_codes: company.sicCodes,
      register_url: registerUrl,
    },
    signals,
    provenance: [
      {
        sourceKey: 'companies-house-uk',
        sourceUrl,
        sourceRecordId: company.companyNumber,
        discoveryMethod: 'provider_query',
        confidence: 'registry',
        observedAt,
        lastVerifiedAt: observedAt,
        verificationStatus: 'partially_verified',
        excerpt: {
          company_number: company.companyNumber,
          company_status: company.companyStatus,
          date_of_creation: company.dateOfCreation,
        },
      },
    ],
    verifications: [
      {
        checkKey: 'business.registry_record',
        category: 'business',
        status: 'verified',
        method: 'registry_lookup',
        evidenceUrl: registerUrl,
        evidence: {
          company_number: company.companyNumber,
          company_status: company.companyStatus,
          company_type: company.companyType,
        },
        checkVersion: 'ch-v1',
        checkedAt: observedAt,
      },
      {
        checkKey: 'business.trading_status',
        category: 'business',
        status: status === 'active' ? 'verified' : 'inconclusive',
        method: 'registry_lookup',
        evidenceUrl: registerUrl,
        evidence: {
          mapped_status: status,
          register_status: company.companyStatus,
          note: 'A register filing is not evidence of trading activity, revenue or solvency.',
        },
        checkVersion: 'ch-v1',
        checkedAt: observedAt,
      },
      {
        checkKey: 'ownership.company_asset_link',
        category: 'ownership',
        status: 'not_checked',
        method: 'not_available',
        evidenceUrl: null,
        evidence: {
          note: 'No link between this company and any domain or website has been established.',
        },
        checkVersion: 'ch-v1',
        checkedAt: observedAt,
      },
    ],
  };
}

export const companiesHouseUkProvider: IngestProvider = {
  meta: {
    key: 'companies-house-uk',
    label: 'UK Companies House (official company registry)',
    kind: 'business_registry',
    capability: 'discovery',
  },

  readiness(env): ProviderReadiness {
    const key = env.COMPANIES_HOUSE_API_KEY;
    if (typeof key !== 'string' || key.trim().length === 0) {
      return {
        ready: false,
        reason:
          'COMPANIES_HOUSE_API_KEY is not configured. This source is an official register that requires a free API key; AssetScout will not query it anonymously or substitute another source.',
        missingEnv: ['COMPANIES_HOUSE_API_KEY'],
      };
    }
    return { ready: true };
  },

  async run(deps: ProviderDeps, query: IngestQuery): Promise<ProviderRunResult> {
    const result = emptyProviderResult();

    // Guard: a provider must never run without its credential, even if a caller
    // bypasses the readiness check.
    const apiKey = process.env.COMPANIES_HOUSE_API_KEY;
    if (typeof apiKey !== 'string' || apiKey.trim().length === 0) {
      result.notes.push('COMPANIES_HOUSE_API_KEY is not configured; no register queries were made.');
      return result;
    }

    const keywords = query.keywords
      .map((k) => k.trim())
      .filter((k) => k.length >= 2)
      .slice(0, 5);

    if (keywords.length === 0) {
      result.notes.push('No keywords were supplied, so no company register searches were made.');
      return result;
    }

    for (const keyword of keywords) {
      const sourceUrl = `${SEARCH_URL}?q=${encodeURIComponent(keyword)}&items_per_page=${MAX_ITEMS_PER_PAGE}`;
      const response = await deps.fetch({
        provider: deps.policy.key,
        stage: 'fetch',
        url: sourceUrl,
        headers: {
          accept: 'application/json',
          authorization: basicAuthHeader(apiKey.trim()),
        },
        timeoutMs: 12_000,
        maxAttempts: 2,
        acceptStatuses: [200],
      });
      result.fetched += 1;

      let parsed: { totalResults: number; items: CompanyRecord[] };
      try {
        parsed = parseCompanySearch(JSON.parse(response.body));
      } catch {
        result.invalid += 1;
        result.invalidReasons.push('companies_house:not-json');
        continue;
      }

      if (parsed.items.length === 0) {
        result.notes.push(`no_register_match:"${keyword}"`);
        continue;
      }

      const observedAt = deps.now().toISOString();
      for (const company of parsed.items) {
        const asset = buildCompanyAsset({ company, keyword, sourceUrl, observedAt });
        if (asset) result.assets.push(asset);
      }

      if (parsed.totalResults > parsed.items.length) {
        result.notes.push(
          `register_truncated:"${keyword}" (showed ${parsed.items.length} of ${parsed.totalResults})`,
        );
      }
    }

    return result;
  },
};