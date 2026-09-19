/**
 * Money formatting + ISO-4217 minor-unit arithmetic.
 *
 * Isomorphic on purpose: pricing cards are Server Components here, but this
 * helper must stay importable from a Client Component without dragging in
 * `server-only`. It performs no I/O and reads no environment.
 *
 * Plan §5.2 rule 5: "Display formatting is centralized ... No page interpolates
 * `$` or `KSh` itself." Everything money-shaped in this app goes through
 * `formatMoney()` / `formatRecurring()`.
 */

/** ISO-4217 currencies whose minor-unit exponent is 0 (Stripe "zero-decimal"). */
const ZERO_DECIMAL = new Set([
  'BIF', 'CLP', 'DJF', 'GNF', 'JPY', 'KMF', 'KRW', 'MGA',
  'PYG', 'RWF', 'UGX', 'VND', 'VUV', 'XAF', 'XOF', 'XPF',
]);

/** ISO-4217 currencies whose minor-unit exponent is 3. */
const THREE_DECIMAL = new Set(['BHD', 'JOD', 'KWD', 'OMR', 'TND']);

/**
 * Minor-unit exponent for a currency.
 *
 * Never assume ×100: JPY has no minor unit and KWD has three. Stripe's
 * `unit_amount` is expressed in this exponent, so the same function must be
 * used for display and for any amount comparison (plan §5.2 rule 2).
 */
export function currencyExponent(currency: string): number {
  const c = currency.trim().toUpperCase();
  if (ZERO_DECIMAL.has(c)) return 0;
  if (THREE_DECIMAL.has(c)) return 3;
  return 2;
}

/** Minor units -> major-unit number (e.g. 1900 USD cents -> 19). */
export function toMajorUnits(minorUnits: number, currency: string): number {
  if (!Number.isFinite(minorUnits)) return 0;
  return Math.trunc(minorUnits) / 10 ** currencyExponent(currency);
}

/**
 * Formats integer minor units as a localised currency string, e.g.
 * `formatMoney(1900, 'USD')` -> `"$19.00"`, `formatMoney(250000, 'KES')` -> `"KSh 2,500.00"`.
 *
 * Never throws: an unknown/invalid ISO code degrades to `"19.00 XYZ"` so a
 * pricing page cannot be taken down by one bad database row.
 */
export function formatMoney(minorUnits: number, currency: string, locale = 'en-US'): string {
  const code = currency.trim().toUpperCase();
  const exponent = currencyExponent(code);
  const value = toMajorUnits(minorUnits, code);

  try {
    return new Intl.NumberFormat(locale, {
      style: 'currency',
      currency: code,
      currencyDisplay: 'narrowSymbol',
      minimumFractionDigits: exponent,
      maximumFractionDigits: exponent,
    }).format(value);
  } catch {
    return `${value.toFixed(exponent)} ${code}`;
  }
}

/**
 * Price plus billing cadence, e.g. `"$19.00 / month"`.
 * The cadence word is spelled out (not just a colour or a toggle) so the
 * currency/interval choice is not conveyed visually alone — plan §8.5.
 */
export function formatRecurring(
  minorUnits: number,
  currency: string,
  interval: 'month' | 'year',
  locale = 'en-US',
): string {
  const amount = formatMoney(minorUnits, currency, locale);
  return `${amount} / ${interval}`;
}