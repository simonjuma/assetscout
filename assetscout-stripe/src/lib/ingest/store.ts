/**
 * The persistence port of the ingestion runner.
 *
 * WHY A PORT
 * ----------
 * `runner.ts` owns the production flow (readiness -> fetch -> validate ->
 * normalize -> dedupe -> verify -> score -> persist) but must not import
 * Supabase: the same orchestration has to run inside a Next.js route (service
 * role client from `@/lib/supabase/admin`) and inside the `npm run ingest` CLI
 * (a plain `@supabase/supabase-js` client). Both callers satisfy this interface,
 * and tests satisfy it with an in-memory double.
 *
 * The port is deliberately narrow: it exposes exactly the reads and writes the
 * flow needs, using the ingestion domain types. Nothing here knows about
 * PostgREST or SQL — that lives in `store-supabase.ts`.
 *
 * Pure types only, so this module stays loadable by `node --test`.
 */
import type { AssetScore } from './score.ts';
import type {
  AssetKind,
  AssetStatus,
  IngestionStage,
  RiskLevel,
  ScoreClassification,
  SourceKind,
  SourceRobotsPolicy,
  VerificationStatus,
} from '../supabase/database.types.ts';
import type { IngestMode, IngestQuery, NormalizedAsset, ProviderRunResult } from './types.ts';

/** One row of `public.sources`, camelCased. The provider catalog is DB-driven. */
export type SourceCatalogRow = {
  key: string;
  name: string;
  kind: SourceKind;
  description: string;
  homepageUrl: string;
  termsUrl: string | null;
  termsNote: string | null;
  requiresAuth: boolean;
  /** Variable NAMES only (e.g. `COMPANIES_HOUSE_API_KEY`); never values. */
  requiredEnvVars: string[];
  robotsPolicy: SourceRobotsPolicy;
  isEnabled: boolean;
  minIntervalMs: number;
  maxRequestsPerMinute: number;
};

/** The stored shape of an asset, as far as a merge decision needs it. */
export type StoredAsset = {
  id: string;
  kind: AssetKind;
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
  scoreTotal: number | null;
  scoreClassification: ScoreClassification | null;
  scoreEvidenceCoverage: number | null;
  /** Raw `assets.attributes` jsonb — carries the reserved observed-signals key. */
  attributes: Record<string, unknown>;
  firstSeenAt: string;
  lastVerifiedAt: string | null;
};

export type StartRunInput = {
  sourceKey: string;
  mode: IngestMode;
  correlationId: string;
  query: IngestQuery;
  initiatedBy: string | null;
};

export type FinishRunInput = {
  runId: string;
  status: 'succeeded' | 'partial' | 'failed';
  /** The query the run was executed with, re-stored with the run notes. */
  query: IngestQuery;
  /** ISO timestamp the run ended. Passed in so the store is clock-free. */
  finishedAt: string;
  /** The provider's raw counters, recorded verbatim on the run row. */
  result: ProviderRunResult;
  created: number;
  updated: number;
  duplicates: number;
  rejected: number;
  errorCount: number;
  /**
   * Run notes (truncation, coverage gaps, "no keywords supplied").
   *
   * Persisted inside the run row's `query` jsonb as `notes`, because
   * `ingestion_runs` has no dedicated notes column and the notes are operator
   * telemetry, not errors — they must not inflate `error_count`.
   */
  notes: string[];
};

export type RecordErrorInput = {
  runId: string;
  sourceKey: string;
  stage: IngestionStage;
  /** Stable machine code, e.g. `provider_not_ready` or `http_429`. */
  code: string;
  /** Already redacted by the caller; never an upstream response body. */
  message: string;
  context?: Record<string, unknown>;
};

export type PersistAssetInput = {
  asset: NormalizedAsset;
  score: AssetScore;
  /**
   * The provider that produced this observation. `asset_verifications` has no
   * provider column, so the check rows are attributed to the run's source.
   */
  sourceKey: string;
  /** ISO timestamp of the observation, used for `last_verified_at`. */
  observedAt: string;
};
/**
 * Everything the runner needs from durable storage.
 *
 * Implementations must be idempotent per `dedupe_key`: re-running a provider
 * over the same source data must update the existing asset rather than create a
 * second opportunity.
 */
export interface IngestStore {
  /** The provider catalog (`public.sources`), enabled or not. */
  loadSources(): Promise<SourceCatalogRow[]>;
  /** Creates the run row and returns its id. */
  startRun(input: StartRunInput): Promise<string>;
  /** Appends a sanitized failure to the ingestion error log. */
  recordError(input: RecordErrorInput): Promise<void>;
  /** Closes the run with its final counters, status and notes. */
  finishRun(input: FinishRunInput): Promise<void>;
  /** Upserts one scored asset plus its provenance, checks and score. */
  persistAsset(input: PersistAssetInput): Promise<PersistOutcome>;
}


export type PersistOutcome = 'created' | 'updated';

/** The subset of run rows a history view needs. */
export type IngestionRunSummaryRow = {
  runId: string;
  sourceKey: string;
  mode: IngestMode;
  status: 'running' | 'succeeded' | 'partial' | 'failed';
  startedAt: string;
  finishedAt: string | null;
  fetched: number;
  valid: number;
  created: number;
  updated: number;
  duplicates: number;
  rejected: number;
  errorCount: number;
  notes: string[];
};
