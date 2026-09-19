/**
 * Ingestion domain types.
 *
 * The pipeline is:
 *   Source -> Fetch -> Validate -> Normalize -> Deduplicate -> Supabase
 *          -> Verify -> Score/Analyze -> Search -> Asset Detail -> User Action
 *
 * `NormalizedAsset` is the single contract between a provider and the pipeline,
 * which is what keeps providers modular: adding a source means adding one module
 * that produces these shapes, and nothing else changes.
 *
 * Node-loadable: this file is imported by `node --test` and by the CLI, so it
 * uses explicit `.ts` specifiers, has no `server-only` import and performs no I/O.
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
  ScoreClassification,
  SourceKind,
  VerificationStatus,
} from '../supabase/database.types.ts';
// Type-only import of the client contract. `http-client.ts` imports this module
// for its own types, so the cycle exists on paper only: `import type` is erased
// and neither module loads the other at runtime.
import type { PoliteFetch } from './http-client.ts';

export type IngestMode = 'manual' | 'cron' | 'admin';

/** What a caller asks the pipeline for. Every field has a safe default. */
export type IngestQuery = {
  /** Seed keywords used to generate candidate assets / search public APIs. */
  keywords: string[];
  /** TLDs to consider when generating domain candidates. */
  tlds: string[];
  /** Restrict to specific existing or candidate domains. */
  domains: string[];
  countries: string[];
  industries: string[];
  /** Hard cap on candidates per keyword, so a run cannot explode. */
  limitPerKeyword: number;
};

export const DEFAULT_TLDS = ['com', 'co.ke', 'io', 'org', 'net', 'app', 'dev', 'ai'] as const;

export const EMPTY_QUERY: IngestQuery = {
  keywords: [],
  tlds: [...DEFAULT_TLDS],
  domains: [],
  countries: [],
  industries: [],
  limitPerKeyword: 5,
};

/** Politeness policy for a source, resolved from the `sources` table. */
export type SourcePolicy = {
  key: string;
  minIntervalMs: number;
  maxRequestsPerMinute: number;
  robotsPolicy: 'respect' | 'api_only';
  userAgent: string;
};

/** A single raw record plus the exact URL it came from (provenance is required). */
export type RawRecord = {
  /** The provider's own id for the record, when it has one. */
  recordId: string | null;
  sourceUrl: string;
  payload: unknown;
};

export type ProviderReadiness =
  | { ready: true }
  | { ready: false; reason: string; missingEnv: string[] };

export type EvidenceSignals = {
  /** Independent public mentions observed in a signal feed (opinion, not revenue). */
  mentions: number | null;
  /** Distinct public crawl archives the host appeared in. */
  crawlArchives: number | null;
  /** Whether the public homepage answered a direct request successfully. */
  siteServes: boolean | null;
  /** Whether the homepage redirected to a different registrable domain. */
  redirectsElsewhere: boolean | null;
  /** Registry status codes, e.g. clientTransferProhibited. */
  registryStatuses: string[];
  /** Nameservers configured (a parked domain usually has few). */
  nameserverCount: number | null;
  /** Registrar from the registry response. */
  registrar: string | null;
  /** Days until registry expiry; negative means already past the expiry date. */
  daysUntilExpiry: number | null;
  /** Whether an official business-registry record was found. */
  companyFound: boolean | null;
  /** Company status from an official registry, e.g. 'Active'. */
  companyStatus: string | null;
  /** A human must consult the trademark register (no API permits automation). */
  trademarkManualResearch: boolean | null;
};

export const EMPTY_SIGNALS: EvidenceSignals = {
  mentions: null,
  crawlArchives: null,
  siteServes: null,
  redirectsElsewhere: null,
  registryStatuses: [],
  nameserverCount: null,
  registrar: null,
  daysUntilExpiry: null,
  companyFound: null,
  companyStatus: null,
  trademarkManualResearch: null,
};

export type ProvenanceInput = {
  sourceKey: string;
  sourceUrl: string;
  sourceRecordId: string | null;
  discoveryMethod: DiscoveryMethod;
  confidence: ProvenanceConfidence;
  observedAt: string;
  lastVerifiedAt: string | null;
  verificationStatus: VerificationStatus;
  /** Minimal normalised evidence. Never a full upstream payload, never PII. */
  excerpt: Record<string, unknown>;
};

export type VerificationInput = {
  checkKey: string;
  category: CheckCategory;
  status: CheckStatus;
  method: CheckMethod;
  evidenceUrl: string | null;
  evidence: Record<string, unknown>;
  checkVersion: string;
  checkedAt: string;
};

export type NormalizedAsset = {
  kind: AssetKind;
  /** Canonical identity used for deduplication. See `dedupeKey()`. */
  dedupeKey: string;
  name: string;
  identifier: string;
  url: string | null;
  tld: string | null;
  country: string | null;
  industry: string | null;
  niche: string | null;
  status: AssetStatus;
  acquisitionRoute: string | null;
  estimatedCostMin: number | null;
  estimatedCostMax: number | null;
  costCurrency: string | null;
  riskLevel: RiskLevel;
  verificationStatus: VerificationStatus;
  monetization: string[];
  attributes: Record<string, unknown>;
  signals: EvidenceSignals;
  provenance: ProvenanceInput[];
  verifications: VerificationInput[];
};

export type ProviderRunResult = {
  /** Raw records retrieved over the network. */
  fetched: number;
  /** Records that failed schema validation (never persisted). */
  invalid: number;
  /** Sanitized, deduped, capped reasons for the invalid records. */
  invalidReasons: string[];
  /** Validated + normalized assets ready for persistence. */
  assets: NormalizedAsset[];
  /** Human-readable run notes (rate limiting, truncation, coverage gaps). */
  notes: string[];
};

export function emptyProviderResult(): ProviderRunResult {
  return { fetched: 0, invalid: 0, invalidReasons: [], assets: [], notes: [] };
}

export type ProviderMeta = {
  key: string;
  label: string;
  kind: SourceKind;
  /** What this provider contributes, shown in the admin source list. */
  capability: 'discovery' | 'verification' | 'signal' | 'manual_research';
};

export type ProviderDeps = {
  policy: SourcePolicy;
  logger: IngestLogger;
  /**
   * The shared polite HTTP client (rate limited, timeout-bounded, retrying).
   * Injectable so tests never touch the network and so the limiter is shared
   * across providers rather than duplicated per adapter.
   */
  fetch: PoliteFetch;
  now: () => Date;
};

export type IngestProvider = {
  readonly meta: ProviderMeta;
  /** Whether the provider can run given the current environment. */
  readiness(env: Record<string, string | undefined>): ProviderReadiness;
  /** Fetch -> validate -> normalize. Throws ProviderError for a fatal failure. */
  run(deps: ProviderDeps, query: IngestQuery): Promise<ProviderRunResult>;
};

/**
 * Structured logger. Values are redacted on the way out so a provider response
 * can never smuggle a credential into the platform log.
 */
export type IngestLogger = {
  info(event: string, data?: Record<string, unknown>): void;
  warn(event: string, data?: Record<string, unknown>): void;
  error(event: string, data?: Record<string, unknown>): void;
  child(scope: string): IngestLogger;
};

/** Result of the whole pipeline for one provider. */
export type IngestRunSummary = {
  runId: string;
  sourceKey: string;
  correlationId: string;
  status: 'succeeded' | 'partial' | 'failed';
  fetched: number;
  valid: number;
  created: number;
  updated: number;
  duplicates: number;
  rejected: number;
  errorCount: number;
  /** Number of assets skipped because they were freshly verified already. */
  skippedFresh: number;
  notes: string[];
  startedAt: string;
  finishedAt: string;
  /** Present when the provider failed outright. */
  fatal: { code: string; message: string } | null;
};

/** 0-100 opportunity score to its published band (spec §4). */
export function classificationFor(total: number): ScoreClassification {
  if (total >= 90) return 'exceptional';
  if (total >= 80) return 'high_potential';
  if (total >= 70) return 'good_potential';
  if (total >= 60) return 'moderate';
  return 'low_potential';
}

export const CLASSIFICATION_LABELS: Record<ScoreClassification, string> = {
  exceptional: 'Exceptional',
  high_potential: 'High Potential',
  good_potential: 'Good Potential',
  moderate: 'Moderate',
  low_potential: 'Low Potential',
};