/**
 * Country risk reference data.
 *
 * These lists change by political decision, not by code change, so in
 * production they belong in a versioned reference table that compliance owns.
 * They live here as the seeded default, with the version stamped so a decision
 * made today remains explainable when the lists move.
 */

export const COUNTRY_LIST_VERSION = '2026-07-01';

/**
 * Comprehensively sanctioned jurisdictions: onboarding is blocked outright
 * rather than risk-scored, because there is no compliant path to a business
 * relationship.
 */
export const EMBARGOED_COUNTRIES: readonly string[] = [
  'PRK', // North Korea
  'IRN', // Iran
  'SYR', // Syria
  'CUB', // Cuba
];

/**
 * Partially restricted: specific regions, sectors, or listed persons. These
 * require enhanced due diligence and a human decision, not an auto-block, since
 * a lawful relationship may still be possible.
 */
export const RESTRICTED_COUNTRIES: readonly string[] = [
  'RUS', 'BLR', 'VEN', 'MMR', 'AFG', 'LBY', 'SDN', 'SSD', 'SOM', 'YEM',
  'IRQ', 'LBN', 'ZWE', 'NIC', 'MLI', 'HTI', 'CAF', 'COD',
];

/** FATF "black list" — Call for Action. */
export const FATF_BLACKLIST: readonly string[] = ['PRK', 'IRN', 'MMR'];

/** FATF "grey list" — Increased Monitoring. */
export const FATF_GREYLIST: readonly string[] = [
  'DZA', 'AGO', 'BGR', 'BFA', 'CMR', 'CIV', 'COD', 'HRV', 'HTI', 'KEN',
  'LAO', 'LBN', 'MLI', 'MCO', 'MOZ', 'MMR', 'NAM', 'NPL', 'NGA', 'SEN',
  'ZAF', 'SSD', 'SYR', 'TZA', 'VEN', 'VNM', 'YEM',
];

/** EU list of high-risk third countries (AMLD Art. 9). */
export const EU_HIGH_RISK_THIRD_COUNTRIES: readonly string[] = [
  'AFG', 'BRB', 'BFA', 'CMR', 'CAF', 'COD', 'GIB', 'HTI', 'IRN', 'JAM',
  'JOR', 'MLI', 'MOZ', 'MMR', 'NAM', 'NIC', 'PAN', 'PHL', 'SEN', 'SYR',
  'PRK', 'SSD', 'TZA', 'TTO', 'UGA', 'ARE', 'VUT', 'VNM', 'YEM', 'ZWE',
];

/**
 * Jurisdictions whose corporate structures routinely obscure beneficial
 * ownership. Not a sanctions concept — it drives UBO evidence requirements.
 */
export const OFFSHORE_SECRECY_JURISDICTIONS: readonly string[] = [
  'VGB', 'CYM', 'BHS', 'BLZ', 'PAN', 'SYC', 'MUS', 'LIE', 'MCO', 'AND',
  'VUT', 'WSM', 'MHL', 'CUW', 'ATG', 'KNA', 'VCT', 'LCA', 'DMA', 'GRD',
  'COK', 'NRU', 'MAC',
];

/** Countries with elevated corruption risk, used to weight PEP exposure. */
export const HIGH_CORRUPTION_RISK: readonly string[] = [
  'SOM', 'SSD', 'SYR', 'VEN', 'YEM', 'LBY', 'PRK', 'HTI', 'GNQ', 'TKM',
  'ERI', 'NIC', 'AFG', 'MMR', 'ZWE', 'BDI', 'COD', 'TCD', 'GNB', 'IRQ',
];

/**
 * Tax-transparency non-cooperative jurisdictions. Relevant for tax-driven
 * onboarding questions rather than AML per se.
 */
export const TAX_NONCOOPERATIVE: readonly string[] = [
  'ASM', 'AIA', 'FJI', 'GUM', 'PLW', 'PAN', 'RUS', 'WSM', 'TTO', 'VIR', 'VUT',
];

export type CountryRiskCategory =
  | 'EMBARGOED'
  | 'RESTRICTED'
  | 'FATF_BLACKLIST'
  | 'FATF_GREYLIST'
  | 'EU_HIGH_RISK'
  | 'OFFSHORE_SECRECY'
  | 'HIGH_CORRUPTION'
  | 'TAX_NONCOOPERATIVE';

export interface CountryRisk {
  country: string;
  categories: CountryRiskCategory[];
  /** 0-100. Contributes to the applicant risk score. */
  score: number;
  /** Onboarding must not proceed automatically. */
  blocked: boolean;
  /** Enhanced due diligence is mandatory. */
  requiresEdd: boolean;
  listVersion: string;
}

const CATEGORY_WEIGHTS: Record<CountryRiskCategory, number> = {
  EMBARGOED: 100,
  FATF_BLACKLIST: 85,
  RESTRICTED: 60,
  EU_HIGH_RISK: 45,
  FATF_GREYLIST: 40,
  HIGH_CORRUPTION: 30,
  OFFSHORE_SECRECY: 25,
  TAX_NONCOOPERATIVE: 15,
};

const MEMBERSHIP: Array<[CountryRiskCategory, readonly string[]]> = [
  ['EMBARGOED', EMBARGOED_COUNTRIES],
  ['RESTRICTED', RESTRICTED_COUNTRIES],
  ['FATF_BLACKLIST', FATF_BLACKLIST],
  ['FATF_GREYLIST', FATF_GREYLIST],
  ['EU_HIGH_RISK', EU_HIGH_RISK_THIRD_COUNTRIES],
  ['OFFSHORE_SECRECY', OFFSHORE_SECRECY_JURISDICTIONS],
  ['HIGH_CORRUPTION', HIGH_CORRUPTION_RISK],
  ['TAX_NONCOOPERATIVE', TAX_NONCOOPERATIVE],
];

/**
 * Country risk is the maximum category weight, not the sum. A country on four
 * overlapping lists for the same underlying reason is not four times as risky,
 * and summing would push every grey-listed country straight to blocked.
 */
export function assessCountry(alpha3: string | null | undefined): CountryRisk {
  const country = (alpha3 ?? '').toUpperCase();
  const categories = MEMBERSHIP.filter(([, list]) => list.includes(country)).map(
    ([category]) => category,
  );
  const score = categories.reduce(
    (max, c) => Math.max(max, CATEGORY_WEIGHTS[c]),
    0,
  );
  return {
    country,
    categories,
    score,
    blocked: categories.includes('EMBARGOED'),
    requiresEdd: score >= CATEGORY_WEIGHTS.FATF_GREYLIST,
    listVersion: COUNTRY_LIST_VERSION,
  };
}

export function isEmbargoed(alpha3: string | null | undefined): boolean {
  return EMBARGOED_COUNTRIES.includes((alpha3 ?? '').toUpperCase());
}

/**
 * Level gating. Explicit allow-lists win over block-lists, but an embargoed
 * country is never permitted even if a tenant mistakenly allow-lists it.
 */
export function isCountryAllowedForLevel(
  country: string | null | undefined,
  level: { allowedCountries?: string[]; blockedCountries?: string[] },
): { allowed: boolean; reason?: string } {
  const c = (country ?? '').toUpperCase();
  if (!c) return { allowed: false, reason: 'country unknown' };
  if (isEmbargoed(c)) {
    return { allowed: false, reason: `${c} is comprehensively sanctioned` };
  }
  if (level.blockedCountries?.includes(c)) {
    return { allowed: false, reason: `${c} is blocked for this level` };
  }
  const allow = level.allowedCountries ?? [];
  if (allow.length > 0 && !allow.includes(c)) {
    return { allowed: false, reason: `${c} is not in this level's allow-list` };
  }
  return { allowed: true };
}
