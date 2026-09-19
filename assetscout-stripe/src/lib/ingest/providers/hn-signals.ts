/**
 * `hn-signals` provider — public discussion signal.
 *
 * Uses the public Hacker News search API (Algolia) to answer one question per
 * keyword: "how many public stories mention this, and which websites do those
 * stories link to?" The linked domains are real, observed websites, so they are
 * legitimate discovery candidates; the mention count is recorded as a `signal`
 * and is never presented as revenue, traffic, valuation or ownership.
 *
 * The provider deliberately contributes no score of its own: `mentions` feeds the
 * scoring stage, which labels it as attention and adjusts downward for
 * competition.
 *
 * Posture: `api_only` (a documented public API, no crawling).
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

const HN_SEARCH_URL = 'https://hn.algolia.com/api/v1/search';
const HITS_PER_PAGE = 30;

export type HnStory = { objectId: string; title: string; url: string | null };

/** Reads the story list out of the Algolia response, ignoring malformed hits. */
export function parseHnStories(payload: unknown): { totalMentions: number; stories: HnStory[] } {
  if (typeof payload !== 'object' || payload === null) return { totalMentions: 0, stories: [] };
  const record = payload as Record<string, unknown>;

  const totalMentions =
    typeof record.nbHits === 'number' && Number.isFinite(record.nbHits) && record.nbHits >= 0
      ? Math.min(Math.trunc(record.nbHits), 1_000_000)
      : 0;

  const stories: HnStory[] = [];
  if (Array.isArray(record.hits)) {
    for (const hit of record.hits) {
      if (typeof hit !== 'object' || hit === null) continue;
      const item = hit as Record<string, unknown>;
      const objectId = typeof item.objectID === 'string' ? item.objectID : null;
      if (!objectId) continue;
      const rawUrl =
        typeof item.url === 'string' ? item.url : typeof item.story_url === 'string' ? item.story_url : null;
      stories.push({
        objectId,
        title: typeof item.title === 'string' ? item.title.slice(0, 200) : '',
        url: rawUrl,
      });
    }
  }

  return { totalMentions, stories };
}

/** Aggregates stories by registrable domain, most-mentioned first. */
export function domainsFromStories(
  stories: readonly HnStory[],
): Array<{ registrable: string; mentions: number; sample: HnStory[] }> {
  const buckets = new Map<string, HnStory[]>();
  for (const story of stories) {
    if (!story.url) continue;
    const host = normalizeHost(story.url);
    if (!host) continue;
    const registrable = registrableDomain(host);
    if (!registrable) continue;
    const existing = buckets.get(registrable);
    if (existing) existing.push(story);
    else buckets.set(registrable, [story]);
  }

  return [...buckets.entries()]
    .map(([registrable, sample]) => ({ registrable, mentions: sample.length, sample }))
    .sort((a, b) => b.mentions - a.mentions);
}

/** Builds the signal-only asset for one linked domain. */
function buildSignalAsset(params: {
  registrable: string;
  keyword: string;
  keywordTotalStories: number;
  sample: HnStory[];
  sourceUrl: string;
  observedAt: string;
}): NormalizedAsset | null {
  const { registrable, keyword, keywordTotalStories, sample, sourceUrl, observedAt } = params;
  const dedupeKey = webDedupeKey(registrable);
  if (!dedupeKey) return null;

  const signals: EvidenceSignals = { ...EMPTY_SIGNALS, mentions: sample.length };

  return {
    kind: 'website',
    dedupeKey,
    name: registrable,
    identifier: registrable,
    url: `https://${registrable}/`,
    tld: tldOf(registrable),
    country: null,
    industry: null,
    niche: keyword.slice(0, 120),
    // Nothing about this site's current state was observed.
    status: 'unknown',
    acquisitionRoute: null,
    estimatedCostMin: null,
    estimatedCostMax: null,
    costCurrency: null,
    riskLevel: 'unknown',
    verificationStatus: 'unverified',
    monetization: [],
    attributes: {
      signal_keyword: keyword,
      keyword_total_stories: keywordTotalStories,
      linked_story_count: sample.length,
      sample_story_ids: sample.slice(0, 3).map((story) => story.objectId),
    },
    signals,
    provenance: [
      {
        sourceKey: 'hn-signals',
        sourceUrl,
        sourceRecordId: sample[0]?.objectId ?? null,
        discoveryMethod: 'provider_query',
        confidence: 'signal',
        observedAt,
        lastVerifiedAt: null,
        verificationStatus: 'unverified',
        excerpt: {
          keyword,
          linked_stories: sample.length,
          keyword_total_stories: keywordTotalStories,
        },
      },
    ],
    verifications: [
      {
        checkKey: 'website.discussion_signal',
        category: 'risk',
        status: 'inconclusive',
        method: 'api',
        evidenceUrl: sourceUrl,
        evidence: {
          keyword,
          linked_stories: sample.length,
          note: 'Public discussion volume is attention, not demand, traffic or revenue. It is recorded as a signal only.',
        },
        checkVersion: 'hn-v1',
        checkedAt: observedAt,
      },
    ],
  };
}

export const hnSignalsProvider: IngestProvider = {
  meta: {
    key: 'hn-signals',
    label: 'Hacker News technology signal',
    kind: 'signal_feed',
    capability: 'signal',
  },

  readiness() {
    return { ready: true };
  },

  async run(deps: ProviderDeps, query: IngestQuery): Promise<ProviderRunResult> {
    const result = emptyProviderResult();

    const keywords = query.keywords
      .map((k) => k.trim())
      .filter((k) => k.length >= 2)
      .slice(0, 10);

    if (keywords.length === 0) {
      result.notes.push('No keywords were supplied, so no discussion signal was collected.');
      return result;
    }

    for (const keyword of keywords) {
      const sourceUrl = `${HN_SEARCH_URL}?query=${encodeURIComponent(keyword)}&tags=story&hitsPerPage=${HITS_PER_PAGE}`;
      const response = await deps.fetch({
        provider: deps.policy.key,
        stage: 'fetch',
        url: sourceUrl,
        headers: { accept: 'application/json' },
        timeoutMs: 12_000,
        maxAttempts: 2,
        acceptStatuses: [200],
      });
      result.fetched += 1;

      let parsed: { totalMentions: number; stories: HnStory[] };
      try {
        parsed = parseHnStories(JSON.parse(response.body));
      } catch {
        result.invalid += 1;
        result.invalidReasons.push('hn:not-json');
        continue;
      }

      if (parsed.totalMentions === 0) {
        result.notes.push(`no_discussion_signal:"${keyword}"`);
        continue;
      }

      const observedAt = deps.now().toISOString();
      const byDomain = domainsFromStories(parsed.stories);

      if (byDomain.length === 0) {
        // Real, honest outcome: the keyword is discussed, but no story linked to
        // a usable domain, so there is no asset to attach the signal to.
        result.notes.push(
          `discussion_without_linked_domain:"${keyword}" (${parsed.totalMentions} stories, none linking a registrable domain)`,
        );
        continue;
      }

      for (const bucket of byDomain) {
        const asset = buildSignalAsset({
          registrable: bucket.registrable,
          keyword,
          keywordTotalStories: parsed.totalMentions,
          sample: bucket.sample,
          sourceUrl,
          observedAt,
        });
        if (asset) result.assets.push(asset);
      }
    }

    return result;
  },
};