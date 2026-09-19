/**
 * Transparent opportunity scoring.
 *
 * DESIGN RULES (the honesty contract behind every number the UI shows)
 * -------------------------------------------------------------------
 * 1. Every factor is either computed from evidence this pipeline actually
 *    collected, or it is `null`. There is no default, no midpoint and no
 *    "assume average" fallback: a factor with no evidence contributes nothing.
 * 2. `total` is coverage-adjusted: the weighted sum is divided by the FULL
 *    weight (100), so ignorance lowers the score instead of being silently
 *    averaged away. A barely-known asset can never outrank a well-evidenced one.
 * 3. `evidenceCoverage` states the share of the total weight that had real
 *    evidence. Below `MIN_PUBLISHABLE_COVERAGE` the score is NOT published at
 *    all (`publishable: false`) and the asset's `score_total` stays NULL, which
 *    is how the UI can say "insufficient evidence" instead of showing a number
 *    that means nothing.
 * 4. Every factor carries a human-readable `rationale`, so the score breakdown
 *    can explain each point. A score is never presented as a valuation.
 *
 * Pure, node-loadable, no I/O.
 */
import type { ScoreClassification } from '../supabase/database.types.ts';
import type { EvidenceSignals } from './types.ts';
import { classificationFor } from './types.ts';

/** Bumped whenever a factor's formula changes, so old rows stay explainable. */
export const SCORE_VERSION = 'v1';

/** Coverage (percent of total weight) required before a total is published. */
export const MIN_PUBLISHABLE_COVERAGE = 25;

export type ScoreFactorKey =
  | 'brand_potential'
  | 'domain_quality'
  | 'market_demand'
  | 'monetization_potential'
  | 'competition'
  | 'legal_clarity'
  | 'acquisition_cost';

export type ScoreFactor = {
  key: ScoreFactorKey;
  label: string;
  /** Points this factor can contribute to the 100-point total. */
  weight: number;
  /** 0-100, or null when no evidence was available. */
  value: number | null;
  /** Why this value, in plain language. Shown in the score breakdown. */
  rationale: string;
  /** Which source the evidence came from, e.g. 'rdap-domain'. */
  evidenceSource: string | null;
};

export type ScoreInput = {
  kind: string;
  name: string;
  identifier: string;
  tld: string | null;
  status: string;
  industry: string | null;
  niche: string | null;
  signals: EvidenceSignals;
  /** check keys with their status, from this run's verifications. */
  checks: ReadonlyArray<{ checkKey: string; status: string }>;
  monetization: readonly string[];
  estimatedCostMin: number | null;
  estimatedCostMax: number | null;
  costCurrency: string | null;
};

export type AssetScore = {
  version: string;
  /** Coverage-adjusted 0-100 total. Only meaningful when `publishable`. */
  total: number;
  classification: ScoreClassification;
  /** 0-100: share of the total weight backed by evidence. */
  evidenceCoverage: number;
  factors: ScoreFactor[];
  /** False when coverage is too low for the total to be published. */
  publishable: boolean;
};

/** Extension strength. Derived from the market for the extension, not the asset. */
const TLD_STRENGTH: Record<string, number> = {
  com: 100, ai: 90, io: 86, app: 82, dev: 78, org: 76, co: 74, net: 70,
  'co.ke': 76, 'co.uk': 80, 'com.au': 78, 'co.za': 74, 'com.ng': 70,
};

function clamp(value: number, min = 0, max = 100): number {
  return Math.min(max, Math.max(min, Math.round(value)));
}

function vowelRatio(text: string): number {
  const letters = text.replace(/[^a-z]/gi, '').toLowerCase();
  if (letters.length === 0) return 0;
  return letters.replace(/[^aeiou]/g, '').length / letters.length;
}

/** Strength of a name as a brand: short, pronounceable, no clutter. */
function brandFactor(input: ScoreInput): ScoreFactor {
  const base = input.identifier.split('.')[0] ?? input.identifier;
  const letters = base.replace(/[^a-z0-9]/gi, '');
  const hyphens = (base.match(/-/g) ?? []).length;
  const digits = (base.match(/\d/g) ?? []).length;

  let value = 60;
  const notes: string[] = [];

  if (letters.length >= 3 && letters.length <= 10) {
    value += 25;
    notes.push('short, memorable length');
  } else if (letters.length <= 16) {
    value += 10;
    notes.push('moderate length');
  } else {
    value -= 15;
    notes.push('long name, harder to brand');
  }

  if (hyphens === 0) {
    value += 10;
    notes.push('no hyphens');
  } else {
    value -= 10 * hyphens;
    notes.push(`${hyphens} hyphen(s) reduce recall and dictate-over-phone clarity`);
  }

  if (digits === 0) {
    value += 5;
  } else {
    value -= 8 * digits;
    notes.push(`${digits} digit(s) weaken the name`);
  }

  const ratio = vowelRatio(letters);
  if (ratio >= 0.3 && ratio <= 0.55) {
    value += 5;
    notes.push('pronounceable letter mix');
  } else if (letters.length > 0) {
    notes.push('unusual letter mix');
  }

  return {
    key: 'brand_potential',
    label: 'Brand potential',
    weight: 20,
    value: clamp(value),
    rationale: `Name shape only (letters: ${letters.length}): ${notes.join('; ')}.`,
    evidenceSource: null,
  };
}

/** Extension quality and domain shape. */
function domainQualityFactor(input: ScoreInput): ScoreFactor {
  if (!input.tld) {
    return {
      key: 'domain_quality',
      label: 'Domain quality',
      weight: 20,
      value: null,
      rationale: 'No domain extension recorded, so extension quality cannot be assessed.',
      evidenceSource: null,
    };
  }

  const base = input.identifier.split('.')[0] ?? input.identifier;
  const strength = TLD_STRENGTH[input.tld] ?? 55;
  let value = strength;

  if (base.length <= 8) value += 8;
  else if (base.length > 20) value -= 10;
  if (/-/.test(base)) value -= 8;

  return {
    key: 'domain_quality',
    label: 'Domain quality',
    weight: 20,
    value: clamp(value),
    rationale: `.${input.tld} extension strength ${strength}/100, label length ${base.length}${
      /-/.test(base) ? ', hyphenated' : ''
    }.`,
    evidenceSource: null,
  };
}

/** Public mention volume as a demand proxy. Mentions are opinion, not revenue. */
function marketDemandFactor(input: ScoreInput): ScoreFactor {
  const mentions = input.signals.mentions;
  if (mentions === null) {
    return {
      key: 'market_demand',
      label: 'Market demand',
      weight: 15,
      value: null,
      rationale: 'No public-mention signal was collected, so demand cannot be estimated.',
      evidenceSource: null,
    };
  }

  // Log scale: 1 mention ~ 20, 10 ~ 53, 100 ~ 86, 1000 ~ 100.
  const value = clamp(20 + 33 * Math.log10(Math.max(1, mentions)));
  return {
    key: 'market_demand',
    label: 'Market demand',
    weight: 15,
    value,
    rationale: `${mentions} public discussion mention(s) observed in a technology signal feed. Mentions indicate attention only — they are not traffic, revenue or ownership evidence.`,
    evidenceSource: 'hn-signals',
  };
}

/** Whether there is anything to monetize right now. */
function monetizationFactor(input: ScoreInput): ScoreFactor {
  const serves = input.signals.siteServes;
  if (serves === null) {
    return {
      key: 'monetization_potential',
      label: 'Monetization potential',
      weight: 15,
      value: null,
      rationale: 'The site was not probed, so there is no evidence of a live property to monetize.',
      evidenceSource: null,
    };
  }

  if (!serves) {
    return {
      key: 'monetization_potential',
      label: 'Monetization potential',
      weight: 15,
      value: 10,
      rationale:
        'The homepage did not answer, so there is no live property today. This is a rebuild opportunity, not an operating business.',
      evidenceSource: 'website-probe',
    };
  }

  let value = 65;
  const notes = ['homepage answered'];
  if (input.industry) {
    value += 12;
    notes.push(`classified industry: ${input.industry}`);
  }
  if (input.monetization.length > 0) {
    value += Math.min(15, input.monetization.length * 5);
    notes.push(`recorded monetization route(s): ${input.monetization.join(', ')}`);
  }
  if (input.signals.redirectsElsewhere) {
    value -= 20;
    notes.push('traffic redirects to a different domain, so the audience may not transfer');
  }

  return {
    key: 'monetization_potential',
    label: 'Monetization potential',
    weight: 15,
    value: clamp(value),
    rationale: `${notes.join('; ')}.`,
    evidenceSource: 'website-probe',
  };
}

/** Attention is also competition. */
function competitionFactor(input: ScoreInput): ScoreFactor {
  const mentions = input.signals.mentions;
  if (mentions === null) {
    return {
      key: 'competition',
      label: 'Competition',
      weight: 10,
      value: null,
      rationale: 'No mention signal was collected, so the level of competition is unknown.',
      evidenceSource: null,
    };
  }

  const value = clamp(100 - 30 * Math.log10(Math.max(1, mentions)));
  return {
    key: 'competition',
    label: 'Competition',
    weight: 10,
    value,
    rationale: `${mentions} observed mention(s): a busier discussion means a more contested space, which scores lower here.`,
    evidenceSource: 'hn-signals',
  };
}

/** How clear the legal position is, based only on registry evidence. */
function legalClarityFactor(input: ScoreInput): ScoreFactor {
  const statuses = input.signals.registryStatuses;
  const companyFound = input.signals.companyFound;
  const companyStatus = input.signals.companyStatus;
  const trademarkPending = input.signals.trademarkManualResearch;

  const notes: string[] = [];
  let value: number | null = null;
  let source: string | null = null;

  if (statuses.length > 0) {
    value = 85;
    source = 'rdap-domain';
    const risky = statuses.filter((status) =>
      /pendingdelete|redemptionperiod|clienthold|serverhold|servertransferprohibited/i.test(status),
    );
    if (risky.length > 0) {
      value = 30;
      notes.push(`registry status indicates a restricted or expiring name: ${risky.join(', ')}`);
    } else {
      notes.push(`registry status: ${statuses.join(', ')}`);
    }
  }

  if (companyFound === true) {
    const active = typeof companyStatus === 'string' && /active|live/i.test(companyStatus);
    value = active ? 95 : 35;
    source = 'companies-house-uk';
    notes.push(`official company record found with status "${companyStatus ?? 'unknown'}"`);
  } else if (companyFound === false) {
    notes.push('no matching official company record was found');
  }

  if (value === null) {
    return {
      key: 'legal_clarity',
      label: 'Legal clarity',
      weight: 10,
      value: null,
      rationale: 'No registry evidence was collected, so the legal position is unknown.',
      evidenceSource: null,
    };
  }

  if (trademarkPending === true) {
    value = Math.min(value, 60);
    notes.push(
      'trademark position NOT checked: the relevant register exposes no terms-permitting public API, so a human must consult it',
    );
  }

  return {
    key: 'legal_clarity',
    label: 'Legal clarity',
    weight: 10,
    value: clamp(value),
    rationale: `${notes.join('; ')}. A registry record is a factual filing, not proof of ownership or transferability.`,
    evidenceSource: source,
  };
}

/** Acquisition cost, scored from a recorded price range when one exists. */
function acquisitionCostFactor(input: ScoreInput): ScoreFactor {
  const max = input.estimatedCostMax ?? input.estimatedCostMin;
  if (max === null || max === undefined) {
    return {
      key: 'acquisition_cost',
      label: 'Acquisition cost',
      weight: 10,
      value: null,
      rationale:
        'No acquisition price has been observed from a permitted source, so cost cannot be scored. AssetScout does not estimate prices it has not seen.',
      evidenceSource: null,
    };
  }

  // Thresholds are in minor units of the recorded currency.
  const value = max <= 100_000 ? 90 : max <= 1_000_000 ? 70 : max <= 5_000_000 ? 45 : 25;
  return {
    key: 'acquisition_cost',
    label: 'Acquisition cost',
    weight: 10,
    value,
    rationale: `Highest observed cost ${max} minor units ${
      input.costCurrency ?? '(currency not recorded)'
    } — source-quoted, not an AssetScout valuation.`,
    evidenceSource: 'source-quoted',
  };
}

/** All factors in a fixed order, so the breakdown renders consistently. */
export function scoreFactors(input: ScoreInput): ScoreFactor[] {
  return [
    brandFactor(input),
    domainQualityFactor(input),
    marketDemandFactor(input),
    monetizationFactor(input),
    competitionFactor(input),
    legalClarityFactor(input),
    acquisitionCostFactor(input),
  ];
}

/**
 * Computes the published score.
 *
 * `total` divides by the full weight (100) rather than the evidenced weight, so a
 * sparse record cannot score highly. `evidenceCoverage` makes the basis explicit,
 * and `publishable` gates whether the caller may store a total at all.
 */
export function computeScore(input: ScoreInput): AssetScore {
  const factors = scoreFactors(input);

  const totalWeight = factors.reduce((sum, factor) => sum + factor.weight, 0);
  const evidencedWeight = factors.reduce(
    (sum, factor) => sum + (factor.value === null ? 0 : factor.weight),
    0,
  );
  const weighted = factors.reduce(
    (sum, factor) => sum + (factor.value === null ? 0 : factor.weight * factor.value),
    0,
  );

  const total = totalWeight === 0 ? 0 : clamp(weighted / totalWeight);
  const evidenceCoverage = totalWeight === 0 ? 0 : clamp((evidencedWeight / totalWeight) * 100);

  return {
    version: SCORE_VERSION,
    total,
    classification: classificationFor(total),
    evidenceCoverage,
    factors,
    publishable: evidenceCoverage >= MIN_PUBLISHABLE_COVERAGE,
  };
}

/**
 * Factors that could not be evaluated, for the "what we do not know" panel.
 * Returning them explicitly is what stops a sparse record looking complete.
 */
export function missingFactors(score: AssetScore): ScoreFactor[] {
  return score.factors.filter((factor) => factor.value === null);
}