/**
 * `manual-registry` provider — the honest alternative to scraping a register.
 *
 * Several registers that matter for brand acquisition expose NO terms-permitting
 * public API (Kenya BRS, Kenya KIPI, USPTO trademark search, WIPO Global Brand
 * Database, Kenya Gazette). The correct response is not to automate them anyway:
 * it is to create an explicit, visible "a human must consult this register" task
 * naming the official URL.
 *
 * So this provider performs ZERO network requests. `deps.fetch` is intentionally
 * unused. That is the point: it exists so the product can say "not checked" with
 * a real next step instead of leaving a silent gap or inventing a result.
 *
 * It only operates on domains the operator named in the query, so it cannot
 * manufacture assets out of thin air.
 */
import { webDedupeKey } from '../dedupe.ts';
import { normalizeHost, registrableDomain, tldOf } from '../normalize.ts';
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

export type ManualRegister = {
  name: string;
  url: string;
  jurisdiction: string;
  whatItCovers: string;
};

/**
 * The registers a human must consult, with their official URLs.
 *
 * `jurisdiction: 'global'` entries apply wherever the asset is used as a brand;
 * country-scoped entries apply when the asset targets that market.
 */
export const MANUAL_REGISTERS: readonly ManualRegister[] = [
  {
    name: 'Kenya Business Registration Service (BRS)',
    url: 'https://brs.go.ke/',
    jurisdiction: 'KE',
    whatItCovers: 'business name and company registration in Kenya',
  },
  {
    name: 'Kenya Industrial Property Institute (KIPI)',
    url: 'https://kipi.go.ke/',
    jurisdiction: 'KE',
    whatItCovers: 'Kenyan trade mark register',
  },
  {
    name: 'USPTO trademark search',
    url: 'https://tmsearch.uspto.gov/',
    jurisdiction: 'US',
    whatItCovers: 'United States trade mark register',
  },
  {
    name: 'WIPO Global Brand Database',
    url: 'https://branddb.wipo.int/',
    jurisdiction: 'global',
    whatItCovers: 'international trade mark collections',
  },
  {
    name: 'Kenya Gazette',
    url: 'http://kenyalaw.org/kenya_gazette/',
    jurisdiction: 'KE',
    whatItCovers: 'official statutory notices, including insolvency and name changes',
  },
];

/** Registers relevant to an asset's target markets. */
function registersFor(countries: readonly string[]): readonly ManualRegister[] {
  const wanted = new Set(countries.map((c) => c.trim().toUpperCase()));
  return MANUAL_REGISTERS.filter(
    (register) =>
      register.jurisdiction === 'global' || wanted.size === 0 || wanted.has(register.jurisdiction),
  );
}

/** Builds the asset carrying the manual-research tasks for one domain. */
function buildManualAsset(params: {
  registrable: string;
  observedAt: string;
  registers: readonly ManualRegister[];
}): NormalizedAsset | null {
  const { registrable, observedAt, registers } = params;
  const dedupeKey = webDedupeKey(registrable);
  if (!dedupeKey) return null;

  // This flag is what makes the scoring stage cap legal clarity and say a human
  // must check the register. It is set because it is true: no register lookup
  // has been performed.
  const signals: EvidenceSignals = { ...EMPTY_SIGNALS, trademarkManualResearch: true };

  const trademarkRegister =
    registers.find((register) => register.jurisdiction === 'global') ?? registers[0] ?? null;
  const businessRegister =
    registers.find((register) => register.jurisdiction !== 'global') ?? registers[0] ?? null;

  return {
    kind: 'domain',
    dedupeKey,
    name: registrable,
    identifier: registrable,
    url: `https://${registrable}/`,
    tld: tldOf(registrable),
    country: null,
    industry: null,
    niche: null,
    // Nothing has been established about ownership or availability.
    status: 'verification_required',
    acquisitionRoute: 'manual register research, then contact the registrant or owner',
    estimatedCostMin: null,
    estimatedCostMax: null,
    costCurrency: null,
    riskLevel: 'unknown',
    verificationStatus: 'verification_required',
    monetization: [],
    attributes: {
      manual_research_required: true,
      registers: registers.map((register) => ({ name: register.name, url: register.url })),
    },
    signals,
    provenance: [
      {
        sourceKey: 'manual-registry',
        // No request was made, so the recorded source URL is the asset's own
        // address. Citing an official register as the source of an observation
        // we did not make would be a false citation.
        sourceUrl: `https://${registrable}/`,
        sourceRecordId: null,
        discoveryMethod: 'manual',
        confidence: 'unknown',
        observedAt,
        lastVerifiedAt: null,
        verificationStatus: 'verification_required',
        excerpt: {
          note: 'No register was queried. These are the registers a human must consult.',
          registers: registers.map((register) => register.url),
        },
      },
    ],
    verifications: [
      {
        checkKey: 'trademark.register_search',
        category: 'trademark',
        status: 'requires_manual_research',
        method: 'manual',
        evidenceUrl: trademarkRegister ? trademarkRegister.url : null,
        evidence: {
          registers: registers.map((register) => ({
            name: register.name,
            url: register.url,
            covers: register.whatItCovers,
          })),
          note: 'These registers expose no terms-permitting public API, so they are linked rather than scraped.',
        },
        checkVersion: 'manual-v1',
        checkedAt: observedAt,
      },
      {
        checkKey: 'business.registry_search',
        category: 'business',
        status: 'requires_manual_research',
        method: 'manual',
        evidenceUrl: businessRegister ? businessRegister.url : null,
        evidence: {
          registers: registers
            .filter((register) => register.jurisdiction !== 'global')
            .map((register) => ({
              name: register.name,
              url: register.url,
              covers: register.whatItCovers,
            })),
          note: 'A human must confirm whether a registered business already uses this name.',
        },
        checkVersion: 'manual-v1',
        checkedAt: observedAt,
      },
      {
        checkKey: 'ownership.registrant_contact',
        category: 'ownership',
        status: 'requires_manual_research',
        method: 'manual',
        evidenceUrl: `https://${registrable}/`,
        evidence: {
          note: 'Who controls this asset has not been established. Contact details must be found and verified by a human.',
        },
        checkVersion: 'manual-v1',
        checkedAt: observedAt,
      },
    ],
  };
}

export const manualRegistryProvider: IngestProvider = {
  meta: {
    key: 'manual-registry',
    label: 'Manual official-registry research route (BRS / KIPI / USPTO / WIPO)',
    kind: 'manual_registry',
    capability: 'manual_research',
  },

  readiness() {
    return { ready: true };
  },

  async run(deps: ProviderDeps, query: IngestQuery): Promise<ProviderRunResult> {
    const result = emptyProviderResult();

    const targets = Array.from(
      new Set(
        query.domains
          .map((domain) => normalizeHost(domain))
          .map((host) => (host ? registrableDomain(host) : null))
          .filter((value): value is string => value !== null),
      ),
    ).slice(0, 40);

    if (targets.length === 0) {
      result.notes.push(
        'No named domains were supplied. Manual research tasks are only raised for assets an operator is actually considering.',
      );
      return result;
    }

    const registers = registersFor(query.countries);
    const observedAt = deps.now().toISOString();

    for (const registrable of targets) {
      const asset = buildManualAsset({ registrable, observedAt, registers });
      if (asset) result.assets.push(asset);
    }

    if (result.assets.length > 0) {
      result.notes.push(
        `Raised manual register research tasks for ${result.assets.length} asset(s) across ${registers.length} official register(s). No request was made to any register.`,
      );
    }

    return result;
  },
};