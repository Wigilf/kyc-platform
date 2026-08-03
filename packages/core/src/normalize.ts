import { sha256 } from './crypto.js';

/**
 * Name and identifier normalisation.
 *
 * Screening quality is mostly a normalisation problem, not a matching problem:
 * "MÜLLER, Hans-Jürgen" and "Hans Jurgen Mueller" must reduce to the same
 * tokens before any similarity metric is applied.
 */

// Latin-script substitutions that transliteration to NFD does not handle.
const DIGRAPHS: Array<[RegExp, string]> = [
  [/ß/g, 'ss'],
  [/æ/g, 'ae'],
  [/œ/g, 'oe'],
  [/ø/g, 'o'],
  [/đ/g, 'd'],
  [/ð/g, 'd'],
  [/þ/g, 'th'],
  [/ł/g, 'l'],
  [/ı/g, 'i'],
];

// German/Nordic vowel expansion, applied only when the umlaut is present, so we
// generate an alternate form rather than replacing the primary one.
const UMLAUT_EXPANSION: Array<[RegExp, string]> = [
  [/ä/g, 'ae'],
  [/ö/g, 'oe'],
  [/ü/g, 'ue'],
];

/** Honorifics and suffixes that carry no identifying information. */
const NOISE_TOKENS = new Set([
  'mr', 'mrs', 'ms', 'miss', 'dr', 'prof', 'sir', 'dame', 'lord', 'lady',
  'hon', 'rev', 'capt', 'col', 'gen', 'sgt', 'jr', 'sr', 'ii', 'iii', 'iv',
  'md', 'phd', 'esq', 'the',
]);

/** Legal-form suffixes stripped before comparing company names. */
const COMPANY_SUFFIXES = new Set([
  'ltd', 'limited', 'llc', 'llp', 'lp', 'inc', 'incorporated', 'corp',
  'corporation', 'co', 'company', 'plc', 'gmbh', 'ag', 'ug', 'kg', 'ohg',
  'sa', 'sas', 'sarl', 'sl', 'srl', 'spa', 'bv', 'nv', 'oy', 'ab', 'as',
  'aps', 'pte', 'pty', 'sdn', 'bhd', 'kk', 'jsc', 'ooo', 'pao', 'zoo',
  'holding', 'holdings', 'group', 'trust', 'foundation',
]);

export function foldDiacritics(input: string): string {
  let out = input.toLowerCase();
  for (const [re, sub] of DIGRAPHS) out = out.replace(re, sub);
  return out.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

/** Alternate transliteration where umlauts expand to two letters. */
export function expandUmlauts(input: string): string {
  let out = input.toLowerCase();
  for (const [re, sub] of UMLAUT_EXPANSION) out = out.replace(re, sub);
  for (const [re, sub] of DIGRAPHS) out = out.replace(re, sub);
  return out.normalize('NFD').replace(/[\u0300-\u036f]/g, '');
}

export function normalizeName(input: string): string {
  return foldDiacritics(input)
    // Hyphens and apostrophes join name parts; treat as separators.
    .replace(/[-'’`]/g, ' ')
    .replace(/[^a-z0-9 ]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export function nameTokens(input: string, opts: { company?: boolean } = {}): string[] {
  const stop = opts.company ? COMPANY_SUFFIXES : NOISE_TOKENS;
  const tokens = normalizeName(input)
    .split(' ')
    .filter((t) => t.length > 0 && !stop.has(t));
  // Single-letter tokens are initials; keep them, they are weak but real signal.
  return tokens;
}

/**
 * All normalisation variants worth indexing for one name. Indexing variants is
 * cheaper than doing transliteration-aware comparison at query time.
 */
export function nameVariants(input: string): string[] {
  const variants = new Set<string>();
  variants.add(normalizeName(input));
  variants.add(normalizeName(expandUmlauts(input)));
  const tokens = nameTokens(input);
  variants.add(tokens.join(' '));
  // Reversed order catches "LASTNAME FIRSTNAME" list conventions.
  if (tokens.length > 1) variants.add([...tokens].reverse().join(' '));
  variants.delete('');
  return [...variants];
}

export function normalizeCompanyName(input: string): string {
  return nameTokens(input, { company: true }).join(' ');
}

/** Document numbers: strip punctuation, uppercase, and drop leading zeros. */
export function normalizeDocNumber(input: string): string {
  return input.toUpperCase().replace(/[^A-Z0-9]/g, '').replace(/^0+/, '');
}

export function normalizeCountry(input: string | null | undefined): string | null {
  if (!input) return null;
  const v = input.trim().toUpperCase();
  if (v.length === 3) return v;
  if (v.length === 2) return ALPHA2_TO_ALPHA3[v] ?? v;
  return COUNTRY_NAME_TO_ALPHA3[normalizeName(v)] ?? v;
}

export function normalizePhone(input: string): string {
  const digits = input.replace(/[^0-9]/g, '');
  return digits.length ? `+${digits.replace(/^0+/, '')}` : '';
}

export function normalizeEmail(input: string): string {
  const [localRaw, domainRaw] = input.trim().toLowerCase().split('@');
  if (!domainRaw || !localRaw) return input.trim().toLowerCase();
  // Gmail-style aliasing: dots are insignificant and +tags are disposable.
  const gmail = domainRaw === 'gmail.com' || domainRaw === 'googlemail.com';
  let local = localRaw.split('+')[0] ?? localRaw;
  if (gmail) local = local.replace(/\./g, '');
  return `${local}@${gmail ? 'gmail.com' : domainRaw}`;
}

export function toDateOnly(value: Date | string | null | undefined): string | null {
  if (!value) return null;
  const d = value instanceof Date ? value : new Date(value);
  if (Number.isNaN(d.getTime())) return null;
  return d.toISOString().slice(0, 10);
}

/**
 * Deterministic identity key used to detect the same natural person arriving
 * twice. Deliberately excludes anything the applicant can trivially vary
 * (email, phone, address) and includes only strong identifiers.
 */
export function identityFingerprint(args: {
  firstName?: string | null;
  lastName?: string | null;
  dob?: Date | string | null;
  country?: string | null;
}): string | null {
  const first = args.firstName ? nameTokens(args.firstName)[0] : undefined;
  const last = args.lastName ? nameTokens(args.lastName).at(-1) : undefined;
  const dob = toDateOnly(args.dob);
  // Without a date of birth the key is too weak to be worth having; name
  // collisions across a large population are common.
  if (!first || !last || !dob) return null;
  const country = normalizeCountry(args.country) ?? 'XXX';
  return sha256(`v1|${first}|${last}|${dob}|${country}`);
}

export function docNumberHash(
  number: string | null | undefined,
  country?: string | null,
): string | null {
  if (!number) return null;
  const normalized = normalizeDocNumber(number);
  if (normalized.length < 4) return null;
  return sha256(`v1|${normalizeCountry(country) ?? 'XXX'}|${normalized}`);
}

// ---------------------------------------------------------------------------
// Similarity metrics
// ---------------------------------------------------------------------------

export function levenshtein(a: string, b: string): number {
  if (a === b) return 0;
  if (!a.length) return b.length;
  if (!b.length) return a.length;
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const curr = [i];
    for (let j = 1; j <= b.length; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1;
      curr[j] = Math.min(
        (curr[j - 1] ?? 0) + 1,
        (prev[j] ?? 0) + 1,
        (prev[j - 1] ?? 0) + cost,
      );
    }
    prev = curr;
  }
  return prev[b.length] ?? 0;
}

/**
 * Jaro-Winkler: the standard choice for person names because it rewards common
 * prefixes, which is where real names agree and typos usually do not.
 */
export function jaroWinkler(a: string, b: string): number {
  if (a === b) return 1;
  if (!a.length || !b.length) return 0;

  const matchWindow = Math.max(0, Math.floor(Math.max(a.length, b.length) / 2) - 1);
  const aMatched = new Array<boolean>(a.length).fill(false);
  const bMatched = new Array<boolean>(b.length).fill(false);

  let matches = 0;
  for (let i = 0; i < a.length; i++) {
    const start = Math.max(0, i - matchWindow);
    const end = Math.min(i + matchWindow + 1, b.length);
    for (let j = start; j < end; j++) {
      if (bMatched[j] || a[i] !== b[j]) continue;
      aMatched[i] = true;
      bMatched[j] = true;
      matches++;
      break;
    }
  }
  if (matches === 0) return 0;

  let transpositions = 0;
  let k = 0;
  for (let i = 0; i < a.length; i++) {
    if (!aMatched[i]) continue;
    while (!bMatched[k]) k++;
    if (a[i] !== b[k]) transpositions++;
    k++;
  }
  transpositions /= 2;

  const jaro =
    (matches / a.length + matches / b.length + (matches - transpositions) / matches) / 3;

  let prefix = 0;
  const maxPrefix = Math.min(4, a.length, b.length);
  while (prefix < maxPrefix && a[prefix] === b[prefix]) prefix++;

  return jaro + prefix * 0.1 * (1 - jaro);
}

/**
 * Token-set name similarity. Handles reordered names, missing middle names, and
 * initials, which per-string edit distance handles badly.
 *
 * Returns 0-1. Every token in the shorter name must find a partner in the
 * longer one; unmatched tokens in the longer name are penalised only lightly,
 * because watchlists routinely carry extra middle names.
 */
export function nameSimilarity(a: string, b: string): number {
  const ta = nameTokens(a);
  const tb = nameTokens(b);
  if (!ta.length || !tb.length) return 0;

  const [shorter, longer] = ta.length <= tb.length ? [ta, tb] : [tb, ta];
  const available = [...longer];
  let total = 0;

  for (const token of shorter) {
    let bestScore = 0;
    let bestIdx = -1;
    for (let i = 0; i < available.length; i++) {
      const candidate = available[i]!;
      // An initial matching a full token is partial credit, not a full match.
      const score =
        (token.length === 1 || candidate.length === 1) && token[0] === candidate[0]
          ? 0.85
          : jaroWinkler(token, candidate);
      if (score > bestScore) {
        bestScore = score;
        bestIdx = i;
      }
    }
    if (bestIdx >= 0) available.splice(bestIdx, 1);
    total += bestScore;
  }

  const base = total / shorter.length;
  // Light penalty for extra tokens: 2% per unmatched token, capped at 10%.
  const extras = longer.length - shorter.length;
  const penalty = Math.min(0.1, extras * 0.02);
  return Math.max(0, Math.min(1, base - penalty));
}

// ---------------------------------------------------------------------------
// Country code tables (subset covering the codes this platform reasons about)
// ---------------------------------------------------------------------------

export const ALPHA2_TO_ALPHA3: Record<string, string> = {
  AF: 'AFG', AL: 'ALB', DZ: 'DZA', AR: 'ARG', AM: 'ARM', AU: 'AUS', AT: 'AUT',
  AZ: 'AZE', BS: 'BHS', BH: 'BHR', BD: 'BGD', BB: 'BRB', BY: 'BLR', BE: 'BEL',
  BZ: 'BLZ', BJ: 'BEN', BO: 'BOL', BA: 'BIH', BW: 'BWA', BR: 'BRA', BG: 'BGR',
  BF: 'BFA', BI: 'BDI', KH: 'KHM', CM: 'CMR', CA: 'CAN', KY: 'CYM', CF: 'CAF',
  TD: 'TCD', CL: 'CHL', CN: 'CHN', CO: 'COL', CD: 'COD', CG: 'COG', CR: 'CRI',
  HR: 'HRV', CU: 'CUB', CY: 'CYP', CZ: 'CZE', DK: 'DNK', DO: 'DOM', EC: 'ECU',
  EG: 'EGY', SV: 'SLV', EE: 'EST', ET: 'ETH', FI: 'FIN', FR: 'FRA', GE: 'GEO',
  DE: 'DEU', GH: 'GHA', GI: 'GIB', GR: 'GRC', GT: 'GTM', GN: 'GIN', GW: 'GNB',
  GY: 'GUY', HT: 'HTI', HN: 'HND', HK: 'HKG', HU: 'HUN', IS: 'ISL', IN: 'IND',
  ID: 'IDN', IR: 'IRN', IQ: 'IRQ', IE: 'IRL', IL: 'ISR', IT: 'ITA', JM: 'JAM',
  JP: 'JPN', JE: 'JEY', JO: 'JOR', KZ: 'KAZ', KE: 'KEN', KP: 'PRK', KR: 'KOR',
  KW: 'KWT', KG: 'KGZ', LA: 'LAO', LV: 'LVA', LB: 'LBN', LR: 'LBR', LY: 'LBY',
  LI: 'LIE', LT: 'LTU', LU: 'LUX', MO: 'MAC', MG: 'MDG', MW: 'MWI', MY: 'MYS',
  MV: 'MDV', ML: 'MLI', MT: 'MLT', MR: 'MRT', MU: 'MUS', MX: 'MEX', MD: 'MDA',
  MC: 'MCO', MN: 'MNG', ME: 'MNE', MA: 'MAR', MZ: 'MOZ', MM: 'MMR', NA: 'NAM',
  NP: 'NPL', NL: 'NLD', NZ: 'NZL', NI: 'NIC', NE: 'NER', NG: 'NGA', NO: 'NOR',
  OM: 'OMN', PK: 'PAK', PA: 'PAN', PY: 'PRY', PE: 'PER', PH: 'PHL', PL: 'POL',
  PT: 'PRT', PR: 'PRI', QA: 'QAT', RO: 'ROU', RU: 'RUS', RW: 'RWA', SA: 'SAU',
  SN: 'SEN', RS: 'SRB', SC: 'SYC', SL: 'SLE', SG: 'SGP', SK: 'SVK', SI: 'SVN',
  SO: 'SOM', ZA: 'ZAF', SS: 'SSD', ES: 'ESP', LK: 'LKA', SD: 'SDN', SR: 'SUR',
  SE: 'SWE', CH: 'CHE', SY: 'SYR', TW: 'TWN', TJ: 'TJK', TZ: 'TZA', TH: 'THA',
  TG: 'TGO', TT: 'TTO', TN: 'TUN', TR: 'TUR', TM: 'TKM', UG: 'UGA', UA: 'UKR',
  AE: 'ARE', GB: 'GBR', US: 'USA', UY: 'URY', UZ: 'UZB', VE: 'VEN', VN: 'VNM',
  VG: 'VGB', YE: 'YEM', ZM: 'ZMB', ZW: 'ZWE',
};

export const ALPHA3_TO_ALPHA2: Record<string, string> = Object.fromEntries(
  Object.entries(ALPHA2_TO_ALPHA3).map(([a2, a3]) => [a3, a2]),
);

export const COUNTRY_NAME_TO_ALPHA3: Record<string, string> = {
  'united states': 'USA',
  'united states of america': 'USA',
  usa: 'USA',
  'united kingdom': 'GBR',
  'great britain': 'GBR',
  england: 'GBR',
  uk: 'GBR',
  germany: 'DEU',
  deutschland: 'DEU',
  france: 'FRA',
  italy: 'ITA',
  spain: 'ESP',
  netherlands: 'NLD',
  'the netherlands': 'NLD',
  belgium: 'BEL',
  poland: 'POL',
  portugal: 'PRT',
  ireland: 'IRL',
  switzerland: 'CHE',
  austria: 'AUT',
  sweden: 'SWE',
  norway: 'NOR',
  denmark: 'DNK',
  finland: 'FIN',
  russia: 'RUS',
  'russian federation': 'RUS',
  ukraine: 'UKR',
  china: 'CHN',
  japan: 'JPN',
  india: 'IND',
  brazil: 'BRA',
  canada: 'CAN',
  australia: 'AUS',
  'north korea': 'PRK',
  'south korea': 'KOR',
  iran: 'IRN',
  'united arab emirates': 'ARE',
  nigeria: 'NGA',
  'south africa': 'ZAF',
  singapore: 'SGP',
  turkey: 'TUR',
  mexico: 'MEX',
};
