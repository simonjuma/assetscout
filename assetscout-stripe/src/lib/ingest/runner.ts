/**
 * The ingestion runner — the missing execution layer between the provider
 * registry and the database.
 *
 * WHAT IT DOES (one function, one responsibility)
 * ----------------------------------------------
 *   provider readiness -> fetch -> validate -> normalize -> dedupe -> verify
 *   -> score -> persist (Supabase) -> record run summary -> record errors
 *
 * The pure steps live in `pipeline.ts`; every database write goes through the
 * `IngestStore` port; every network request goes through the shared polite
 * client. This module is what glues them together, and it is deliberately
 * loadable by `node --test` (no `server-only`, no Supabase import, no `@/`
 * alias) so the whole flow can be exercised with a fake store and a fake fetch.
 *
 * HONESTY RULES ENFORCED HERE
 * --------------------------
 *  - Only catalogued providers run: a provider with no `public.sources` row is
 *    skipped and reported, so nothing is ingested by an undocumented source.
 *  - A provider whose credentials are missing is recorded as a failed run with a
 *    `provider_not_ready` error naming the missing variable, and the remaining
 *    providers still run. No substitute data is invented for it.
 *  - Every counter on `public.ingestion_runs` comes from the pipeline's own
 *    result, so the telemetry cannot claim more than was really processed.
 */
import { ProviderError, redactSecrets } from '../errors.ts';
import { ingestUserAgent, type EnvSource } from '../env-core.ts';
import { createPoliteFetch } from './http-client.ts';
import { createLogger } from './log.ts';
import { prepareAssets } from './pipeline.ts';
import { PROVIDERS, validateProviderCatalog, type CatalogMismatch } from './providers/index.ts';
import { sharedRateLimiter } from './rate-limit.ts';
import type {
  FinishRunInput,
  IngestStore,
  SourceCatalogRow,
} from './store.ts';
import type {
  IngestMode,
  IngestLogger,
  IngestProvider,
  IngestQuery,
  IngestRunSummary,
  ProviderDeps,
  ProviderReadiness,
  SourcePolicy,
} from './types.ts';

/** Provider keys are the join between the code registry and the catalog. */
export type ProviderReadinessReport = {
  key: string;
  label: string;
  capability: IngestProvider['meta']['capability'];
  ready: boolean;
  /** Why it cannot run, when it cannot. Names variables, never values. */
  reason: string | null;
  missingEnv: string[];
  /** Whether a catalog row exists (a provider without one is never executed). */
  catalogued: boolean;
  enabled: boolean;
};

export type IngestRunOptions = {
  store: IngestStore;
  query: IngestQuery;
  mode: IngestMode;
  /** Restrict the run to these provider keys. Default: every enabled source. */
  sourceKeys?: readonly string[];
  /** The authenticated operator, when a run is triggered from the app. */
  initiatedBy?: string | null;
  correlationId?: string;
  /** Defaults to `process.env`; injected by tests. */
  env?: EnvSource;
  now?: () => Date;
  /** Defaults to the real registry; injected by tests. */
  providers?: readonly IngestProvider[];
  logger?: IngestLogger;
};

export type IngestRunReport = {
  correlationId: string;
  mode: IngestMode;
  startedAt: string;
  finishedAt: string;
  /** Catalog/registry consistency, surfaced so an operator can fix drift. */
  catalog: CatalogMismatch & { keys: string[]; enabled: number; consistent: boolean };
  readiness: ProviderReadinessReport[];
  summaries: IngestRunSummary[];
  /** Configuration-level problems that stopped part of the run. */
  problems: string[];
  totals: {
    sourcesRun: number;
    fetched: number;
    valid: number;
    created: number;
    updated: number;
    duplicates: number;
    rejected: number;
    errors: number;
  };
};
