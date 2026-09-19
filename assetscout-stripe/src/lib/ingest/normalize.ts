/**
 * Normalization primitives for the ingestion pipeline.
 *
 * Every value that reaches the database passes through one of these functions,
 * which is what makes deduplication, filtering and sorting reliable: two
 * providers that report `WWW.Example.COM.` and `https://example.com/path` must
 * produce the SAME canonical identity.
 *
 * Pure, no I/O, no environment access and no `server-only` import, so it runs
 * under `node --test` (type stripping only) and inside the CLI.
 *
 * PUBLIC-SUFFIX NOTE (documented limitation, not a silent approximation)
 * --------------------------------------------------------------------
 * Registrable-domain extraction needs the Public Suffix List. This module ships
 * a curated set of the multi-label suffixes this product actually encounters
 * (`co.ke`, `co.uk`, `com.au`, …) instead of a bundled PSL, because adding the
 * `psl`/`tldts` dependency would require a package install this deployment
 * target cannot perform. The consequence is bounded and stated in the UI: for a
 * suffix outside the set, the last two labels are treated as the registrable
 * domain, which is correct for the overwhelming majority of names and never
 * invents data. Swapping in `tldts` later only requires changing
 * `publicSuffix()`.
 */

import { currencyExponent } from '../billing/money.ts';

/** Hosts that are never registrable domains. */
const NON_REGISTRABLE_SUFFIXES = new Set([
  'localhost', 'local', 'internal', 'invalid', 'test', 'example',
]);

/**
 * Multi-label public suffixes seen in practice. Longest match wins.
 * Kept as one flat list so a diff shows exactly which suffixes are supported.
 */
const TWO_LABEL_SUFFIXES = new Set([
  // Europe / UK & Ireland
  'co.uk', 'org.uk', 'ac.uk', 'gov.uk', 'me.uk', 'net.uk', 'sch.uk', 'ltd.uk', 'plc.uk',
  'co.im', 'org.im', 'ac.im', 'co.je', 'org.je', 'co.gg', 'org.gg',
  // Africa (Kenya first: it is a primary market for this product)
  'co.ke', 'or.ke', 'ne.ke', 'ac.ke', 'sc.ke', 'go.ke', 'me.ke', 'info.ke', 'mobi.ke',
  'co.tz', 'or.tz', 'go.tz', 'ac.tz', 'sc.tz', 'ne.tz',
  'co.ug', 'or.ug', 'go.ug', 'ac.ug', 'sc.ug', 'ne.ug',
  'co.rw', 'ac.rw', 'gov.rw', 'org.rw',
  'co.zw', 'org.zw', 'gov.zw', 'ac.zw',
  'co.zm', 'co.bw', 'co.mz', 'co.ao', 'co.mw',
  'com.gh', 'org.gh', 'gov.gh', 'edu.gh',
  'com.ng', 'net.ng', 'org.ng', 'gov.ng', 'edu.ng', 'sch.ng',
  'co.za', 'net.za', 'org.za', 'gov.za', 'ac.za', 'web.za',
  'com.eg', 'net.eg', 'org.eg', 'gov.eg', 'edu.eg',
  // Americas
  'com.br', 'net.br', 'org.br', 'gov.br', 'edu.br',
  'com.mx', 'net.mx', 'org.mx', 'edu.mx', 'gob.mx',
  'com.ar', 'net.ar', 'org.ar', 'gov.ar', 'edu.ar',
  'com.co', 'net.co', 'org.co', 'gov.co', 'edu.co',
  'com.pe', 'net.pe', 'org.pe', 'gov.pe', 'edu.pe',
  'com.ec', 'net.ec', 'org.ec', 'gob.ec', 'edu.ec',
  'com.ve', 'com.uy', 'com.py', 'com.bo', 'com.do', 'com.gt',
  // Asia / Middle East
  'co.in', 'net.in', 'org.in', 'gen.in', 'firm.in', 'ind.in', 'gov.in', 'ac.in', 'edu.in', 'res.in',
  'com.pk', 'net.pk', 'org.pk', 'gov.pk', 'edu.pk',
  'com.bd', 'net.bd', 'org.bd', 'gov.bd', 'edu.bd',
  'com.sa', 'net.sa', 'org.sa', 'gov.sa', 'edu.sa', 'med.sa', 'sch.sa',
  'co.il', 'org.il', 'net.il', 'ac.il', 'gov.il', 'muni.il',
  'com.tr', 'net.tr', 'org.tr', 'gov.tr', 'edu.tr', 'gen.tr', 'web.tr',
  'co.id', 'or.id', 'ac.id', 'go.id', 'web.id', 'sch.id', 'my.id', 'biz.id',
  'com.my', 'net.my', 'org.my', 'gov.my', 'edu.my', 'sch.my',
  'com.ph', 'net.ph', 'org.ph', 'gov.ph', 'edu.ph',
  'co.th', 'or.th', 'ac.th', 'go.th', 'in.th', 'mi.th', 'net.th',
  'com.vn', 'net.vn', 'org.vn', 'gov.vn', 'edu.vn',
  'com.cn', 'net.cn', 'org.cn', 'gov.cn', 'edu.cn', 'ac.cn',
  'com.hk', 'net.hk', 'org.hk', 'edu.hk', 'gov.hk', 'idv.hk',
  'com.sg', 'net.sg', 'org.sg', 'edu.sg', 'gov.sg', 'per.sg',
  'com.tw', 'net.tw', 'org.tw', 'edu.tw', 'gov.tw',
  'co.jp', 'ne.jp', 'or.jp', 'ac.jp', 'go.jp', 'ad.jp', 'ed.jp', 'gr.jp', 'lg.jp',
  'co.kr', 'ne.kr', 'or.kr', 're.kr', 'pe.kr', 'go.kr', 'ac.kr',
  // Oceania
  'com.au', 'net.au', 'org.au', 'edu.au', 'gov.au', 'id.au', 'asn.au',
  'co.nz', 'net.nz', 'org.nz', 'govt.nz', 'ac.nz', 'geek.nz', 'gen.nz', 'kiwi.nz', 'maori.nz', 'school.nz',
]);


/** True for an IPv4 literal. */
export function isIpv4(host: string): boolean {
  const parts = host.split('.');
  if (parts.length !== 4) return false;
  return parts.every((part) => /^\d{1,3}$/.test(part) && Number(part) <= 255);
}

/** True for an IPv6 literal (bracketed or not). */
export function isIpv6(host: string): boolean {
  const bare = host.startsWith('[') && host.endsWith(']') ? host.slice(1, -1) : host;
  return bare.includes(':') && /^[0-9a-fA-F:.]+$/.test(bare);
}

/** The public suffix of a host, or null when the host is not a DNS name. */
export function publicSuffix(host: string): string | null {
  const labels = host.split('.').filter((label) => label.length > 0);
  if (labels.length < 2) return null;

  const lastTwo = `${labels[labels.length - 2] ?? ''}.${labels[labels.length - 1] ?? ''}`;
  if (TWO_LABEL_SUFFIXES.has(lastTwo)) return lastTwo;
  return labels[labels.length - 1] ?? null;
}

/**
 * The registrable domain ("example.co.ke" from "www.blog.example.co.ke").
 * Null for IP literals, single-label hosts and bare suffixes.
 */
export function registrableDomain(host: string): string | null {
  const clean = host.trim().toLowerCase().replace(/\.$/, '');
  if (clean.length === 0 || isIpv4(clean) || isIpv6(clean)) return null;

  const suffix = publicSuffix(clean);
  if (!suffix || NON_REGISTRABLE_SUFFIXES.has(suffix)) return null;

  const labels = clean.split('.');
  const suffixLabels = suffix.split('.').length;
  if (labels.length <= suffixLabels) return null;

  return labels.slice(-(suffixLabels + 1)).join('.');
}

/**
 * Lowercased, port-less host from a URL, a `host/path` pair or a bare host.
 * IDN input is converted to its ASCII (punycode) form by `URL`.
 */
export function normalizeHost(input: string): string | null {
  const raw = input.trim();
  if (raw.length === 0) return null;

  const candidate = /^[a-z][a-z0-9+.-]*:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    const host = url.hostname.toLowerCase().replace(/\.$/, '');
    if (host.length === 0 || host.length > 253) return null;
    return host;
  } catch {
    return null;
  }
}

/** Canonical TLD for a host (the public suffix). */
export function tldOf(host: string): string | null {
  return publicSuffix(host);
}

/**
 * Query parameters that carry campaign attribution rather than identity, and are
 * therefore dropped before a URL is stored or compared.
 */
const TRACKING_PARAMS = new Set([
  'utm_source', 'utm_medium', 'utm_campaign', 'utm_term', 'utm_content',
  'gclid', 'fbclid', 'mc_cid', 'mc_eid',
]);

/**
 * Canonical http(s) URL.
 *
 * - forces a scheme (https when absent) and lowercases the host
 * - drops default ports, fragments, credentials and tracking parameters
 * - keeps the path and the remaining query string, because a provider's record
 *   identity can depend on them
 * Returns null for anything that is not an absolute http(s) URL.
 */
export function normalizeUrl(input: string): string | null {
  const raw = input.trim();
  if (raw.length === 0) return null;

  const candidate = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`;
  try {
    const url = new URL(candidate);
    if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
    if (url.username.length > 0 || url.password.length > 0) return null;

    url.hostname = url.hostname.toLowerCase().replace(/\.$/, '');
    if (url.port === '80' || url.port === '443') url.port = '';
    url.hash = '';

    for (const key of [...url.searchParams.keys()]) {
      if (TRACKING_PARAMS.has(key.toLowerCase())) url.searchParams.delete(key);
    }

    // `URL` renders an empty path as "/", which is the canonical form we keep.
    const rendered = url.toString();
    return rendered.length > 2048 ? null : rendered;
  } catch {
    return null;
  }
}


/** Collapses whitespace, strips control characters and caps the length. */
export function normalizeName(input: string, maxLength = 160): string {
  const flat = input
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
  return flat.length > maxLength ? flat.slice(0, maxLength).trimEnd() : flat;
}

/** Lowercase ASCII slug. Used for brand identities and candidate generation. */
export function slugify(input: string, maxLength = 63): string {
  return input
    .normalize('NFKD')
    .replace(/[\u0300-\u036f]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, maxLength)
    .replace(/-+$/g, '');
}

/**
 * Normalizes a currency to an uppercase ISO-4217 code.
 * Returns null when the value is not a plausible 3-letter code — never guesses.
 */
export function normalizeCurrency(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const code = input.trim().toUpperCase();
  return /^[A-Z]{3}$/.test(code) ? code : null;
}

/** Normalizes an ISO-3166-1 alpha-2 country code, or null. */
export function normalizeCountry(input: string | null | undefined): string | null {
  if (typeof input !== 'string') return null;
  const code = input.trim().toUpperCase();
  return /^[A-Z]{2}$/.test(code) ? code : null;
}

/**
 * Parses a timestamp from the shapes providers actually send (ISO 8601, epoch
 * seconds, epoch milliseconds) into an ISO string.
 *
 * Returns null when the value cannot be interpreted rather than substituting
 * "now": substituting the current time would silently fabricate a discovery or
 * expiry date.
 */
export function normalizeTimestamp(input: unknown): string | null {
  if (typeof input === 'number' && Number.isFinite(input)) {
    const ms = input > 1e12 ? input : input * 1000;
    const date = new Date(ms);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  if (typeof input === 'string') {
    const trimmed = input.trim();
    if (trimmed.length === 0) return null;
    if (/^\d{10}$/.test(trimmed) || /^\d{13}$/.test(trimmed)) {
      return normalizeTimestamp(Number(trimmed));
    }
    const date = new Date(trimmed);
    return Number.isNaN(date.getTime()) ? null : date.toISOString();
  }
  return null;
}

/** Whole days between `from` and `to` (negative when `to` is in the past). */
export function daysBetween(from: Date, to: Date): number {
  return Math.round((to.getTime() - from.getTime()) / 86_400_000);
}

/**
 * Decimal major-unit amount -> integer minor units.
 *
 * Delegates the exponent lookup to `billing/money.ts` so a stored amount and a
 * displayed amount can never disagree (JPY has no minor unit, KWD has three).
 */
export function toMinorUnits(amount: number, currency: string): number {
  if (!Number.isFinite(amount) || amount < 0) return 0;
  return Math.round(amount * 10 ** currencyExponent(currency));
}

/** Hard cap used for every free-text field taken from a provider. */
export function truncate(input: string, maxLength: number): string {
  return input.length > maxLength ? input.slice(0, maxLength) : input;
}

/**
 * Candidate registrable domains generated from a keyword.
 *
 * These are HYPOTHESES, and the pipeline treats them as such: nothing is stored
 * until an authoritative source (RDAP) has been consulted about the candidate.
 * A candidate the registry reports as unregistered becomes an `available` asset;
 * a candidate that resolves becomes an asset carrying real registry facts.
 */
export function candidateDomains(
  keyword: string,
  tlds: readonly string[],
  limitPerKeyword: number,
): string[] {
  const limit = Math.max(0, Math.trunc(limitPerKeyword));
  if (limit === 0) return [];

  const slug = slugify(keyword, 40);
  if (slug.length < 2) return [];
  const compact = slug.replace(/-/g, '');

  const shapes: string[] = [];
  if (compact.length >= 3) shapes.push(compact);
  if (slug.length >= 3 && slug !== compact) shapes.push(slug);

  const out: string[] = [];
  // Round-robin over extensions so one TLD cannot consume the whole budget.
  for (const shape of shapes) {
    for (const tld of tlds) {
      if (out.length >= limit) return out;
      const cleanTld = tld.trim().toLowerCase().replace(/^\./, '');
      if (!/^[a-z0-9-]+(\.[a-z0-9-]+)*$/.test(cleanTld)) continue;
      out.push(`${shape}.${cleanTld}`);
    }
  }
  return out;
}