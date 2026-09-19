/**
 * robots.txt handling (RFC 9309) for the sources that crawl rather than call an
 * API. Only the `website-probe` provider uses this: it fetches one public page
 * per host, so the polite thing is to ask permission first and honour
 * Crawl-delay.
 *
 * Design notes
 *  - Only the groups that apply to our token (or `*`) are considered, and the
 *    most specific matching rule wins, with `Allow` beating `Disallow` on an
 *    equal-length match (RFC 9309 §2.2.2).
 *  - A robots.txt that cannot be fetched (404/410) means "no restrictions".
 *    A 5xx or a network error means "unknown", and the caller must decide; the
 *    probe treats unknown as "do not fetch", which is the conservative choice.
 *  - Parsed files are cached per origin with a TTL, because a run probes many
 *    hosts and must not refetch robots.txt per request.
 *
 * No network access here — the caller supplies the fetched body. Pure and
 * unit-testable.
 */
export type RobotsRule = {
  allow: boolean;
  /** Path prefix. `''` means "everything". */
  path: string;
};

export type RobotsPolicy = {
  rules: RobotsRule[];
  crawlDelaySeconds: number | null;
  /** Which agent group the rules came from. */
  matchedAgent: string | null;
  sitemaps: string[];
};

export const ALLOW_ALL: RobotsPolicy = {
  rules: [],
  crawlDelaySeconds: null,
  matchedAgent: null,
  sitemaps: [],
};

const OUR_AGENT = 'assetscoutbot';

/**
 * Parses a robots.txt body for a given agent token.
 *
 * `agentToken` is matched case-insensitively as a substring of the User-agent
 * value, which is how real crawlers match `Googlebot` to `Googlebot-News`.
 */
export function parseRobots(body: string, agentToken = OUR_AGENT): RobotsPolicy {
  const lines = body.split(/\r?\n/);
  const groups: Array<{ agents: string[]; rules: RobotsRule[]; crawlDelay: number | null }> = [];
  const sitemaps: string[] = [];

  let current: { agents: string[]; rules: RobotsRule[]; crawlDelay: number | null } | null = null;
  let lastLineWasAgent = false;

  for (const rawLine of lines) {
    const line = rawLine.replace(/#.*$/, '').trim();
    if (line.length === 0) continue;

    const separator = line.indexOf(':');
    if (separator === -1) continue;

    const field = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();

    if (field === 'sitemap') {
      sitemaps.push(value);
      continue;
    }

    if (field === 'user-agent') {
      if (!current || !lastLineWasAgent) {
        current = { agents: [], rules: [], crawlDelay: null };
        groups.push(current);
      }
      current.agents.push(value.toLowerCase());
      lastLineWasAgent = true;
      continue;
    }

    if (!current) continue;
    lastLineWasAgent = false;

    if (field === 'disallow' || field === 'allow') {
      // `Disallow:` with an empty value means "allow everything" — it is not a
      // rule, it is the absence of one.
      if (value.length === 0 && field === 'disallow') continue;
      current.rules.push({ allow: field === 'allow', path: value });
      continue;
    }

    if (field === 'crawl-delay') {
      const parsed = Number.parseFloat(value);
      if (Number.isFinite(parsed) && parsed >= 0) {
        current.crawlDelay = parsed;
      }
    }
  }

  const token = agentToken.toLowerCase();
  const specific = groups.find((group) => group.agents.some((agent) => agent.includes(token)));
  const wildcard = groups.find((group) => group.agents.includes('*'));
  const chosen = specific ?? wildcard;

  if (!chosen) {
    return { ...ALLOW_ALL, sitemaps };
  }

  return {
    rules: chosen.rules,
    crawlDelaySeconds: chosen.crawlDelay,
    matchedAgent: chosen.agents[0] ?? null,
    sitemaps,
  };
}

/**
 * Longest-match wins; on a tie `Allow` wins (RFC 9309 §2.2.2).
 * `*` and `$` wildcards are supported.
 */
export function isPathAllowed(policy: RobotsPolicy, path: string): boolean {
  const target = path.startsWith('/') ? path : `/${path}`;
  let best: { length: number; allow: boolean } | null = null;

  for (const rule of policy.rules) {
    if (rule.path === '' || rule.path === '/') {
      // `Disallow: /` blocks everything that no longer rule allows.
      if (rule.path === '' && rule.allow) continue;
      if (rule.path === '/' && rule.allow) {
        if (!best || best.length < 1) best = { length: 0, allow: true };
        continue;
      }
    }
    if (!matchesRule(rule.path, target)) continue;
    const length = rule.path.length;
    if (!best || length > best.length || (length === best.length && rule.allow && !best.allow)) {
      best = { length, allow: rule.allow };
    }
  }

  return best ? best.allow : true;
}

function matchesRule(rulePath: string, target: string): boolean {
  if (rulePath === '' || rulePath === '*') return true;

  const anchored = rulePath.endsWith('$');
  const pattern = anchored ? rulePath.slice(0, -1) : rulePath;
  const segments = pattern.split('*');

  let index = 0;
  for (let i = 0; i < segments.length; i += 1) {
    const segment = segments[i] ?? '';
    if (segment === '') continue;
    const found = target.indexOf(segment, i === 0 ? 0 : index);
    if (found === -1) return false;
    if (i === 0 && !pattern.startsWith('*') && found !== 0) return false;
    index = found + segment.length;
  }

  if (anchored) return target.length === index || pattern === target;
  return true;
}

/** Effective minimum interval for a host, including any Crawl-delay. */
export function effectiveIntervalMs(
  policy: RobotsPolicy,
  configuredMinIntervalMs: number,
): number {
  const crawlDelayMs = policy.crawlDelaySeconds === null
    ? 0
    : Math.ceil(policy.crawlDelaySeconds * 1000);
  return Math.max(configuredMinIntervalMs, crawlDelayMs);
}