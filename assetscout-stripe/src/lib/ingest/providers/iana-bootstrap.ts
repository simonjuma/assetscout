/**
 * `iana-bootstrap` provider — RDAP endpoint coverage.
 *
 * Contributes no assets of its own: it exists to load and validate the public
 * IANA RDAP bootstrap registry that `rdap-domain` then uses. The run records
 * coverage in `notes` so the admin source list can show whether the registry was
 * reachable and how many extensions it covers.
 *
 * This is the honest shape for a support source: it reports what it observed and
 * creates nothing it cannot evidence.
 */
import { emptyProviderResult, type IngestProvider, type ProviderRunResult } from '../types.ts';
import { loadBootstrap } from './rdap-bootstrap.ts';

export const ianaBootstrapProvider: IngestProvider = {
  meta: {
    key: 'iana-bootstrap',
    label: 'IANA RDAP bootstrap registry',
    kind: 'domain_registry',
    capability: 'verification',
  },

  readiness() {
    // Public, unauthenticated, no contact requirement beyond the User-Agent.
    return { ready: true };
  },

  async run(deps): Promise<ProviderRunResult> {
    const result = emptyProviderResult();
    const bootstrap = await loadBootstrap({
      fetch: deps.fetch,
      logger: deps.logger,
      policy: deps.policy,
      now: deps.now,
    });

    result.fetched = 1;
    result.notes.push(
      `RDAP bootstrap covers ${bootstrap.tldCount} extensions (publication ${bootstrap.fetchedAt}).`,
    );
    return result;
  },
};