/**
 * ISO 3166-1 alpha-3 country codes, plus the codes ICAO 9303 adds for travel
 * documents.
 *
 * Used two ways: validating a nationality an applicant declares, and as an
 * oracle when repairing a misread machine-readable zone. The second is why the
 * ICAO extras matter — a German passport carries `D<<` rather than `DEU`, and a
 * reader that rejected it would reject every German passport.
 *
 * This is a snapshot. Codes are added and withdrawn by the ISO 3166 Maintenance
 * Agency, so treat it as reference data with a date on it rather than a
 * constant, and check it when a new state appears.
 */

export const ISO3166_LIST_VERSION = '2026-07-01';

/** The 249 officially assigned alpha-3 codes. */
export const ISO3166_ALPHA3: readonly string[] = [
  'ABW', 'AFG', 'AGO', 'AIA', 'ALA', 'ALB', 'AND', 'ARE', 'ARG', 'ARM',
  'ASM', 'ATA', 'ATF', 'ATG', 'AUS', 'AUT', 'AZE', 'BDI', 'BEL', 'BEN',
  'BES', 'BFA', 'BGD', 'BGR', 'BHR', 'BHS', 'BIH', 'BLM', 'BLR', 'BLZ',
  'BMU', 'BOL', 'BRA', 'BRB', 'BRN', 'BTN', 'BVT', 'BWA', 'CAF', 'CAN',
  'CCK', 'CHE', 'CHL', 'CHN', 'CIV', 'CMR', 'COD', 'COG', 'COK', 'COL',
  'COM', 'CPV', 'CRI', 'CUB', 'CUW', 'CXR', 'CYM', 'CYP', 'CZE', 'DEU',
  'DJI', 'DMA', 'DNK', 'DOM', 'DZA', 'ECU', 'EGY', 'ERI', 'ESH', 'ESP',
  'EST', 'ETH', 'FIN', 'FJI', 'FLK', 'FRA', 'FRO', 'FSM', 'GAB', 'GBR',
  'GEO', 'GGY', 'GHA', 'GIB', 'GIN', 'GLP', 'GMB', 'GNB', 'GNQ', 'GRC',
  'GRD', 'GRL', 'GTM', 'GUF', 'GUM', 'GUY', 'HKG', 'HMD', 'HND', 'HRV',
  'HTI', 'HUN', 'IDN', 'IMN', 'IND', 'IOT', 'IRL', 'IRN', 'IRQ', 'ISL',
  'ISR', 'ITA', 'JAM', 'JEY', 'JOR', 'JPN', 'KAZ', 'KEN', 'KGZ', 'KHM',
  'KIR', 'KNA', 'KOR', 'KWT', 'LAO', 'LBN', 'LBR', 'LBY', 'LCA', 'LIE',
  'LKA', 'LSO', 'LTU', 'LUX', 'LVA', 'MAC', 'MAF', 'MAR', 'MCO', 'MDA',
  'MDG', 'MDV', 'MEX', 'MHL', 'MKD', 'MLI', 'MLT', 'MMR', 'MNE', 'MNG',
  'MNP', 'MOZ', 'MRT', 'MSR', 'MTQ', 'MUS', 'MWI', 'MYS', 'MYT', 'NAM',
  'NCL', 'NER', 'NFK', 'NGA', 'NIC', 'NIU', 'NLD', 'NOR', 'NPL', 'NRU',
  'NZL', 'OMN', 'PAK', 'PAN', 'PCN', 'PER', 'PHL', 'PLW', 'PNG', 'POL',
  'PRI', 'PRK', 'PRT', 'PRY', 'PSE', 'PYF', 'QAT', 'REU', 'ROU', 'RUS',
  'RWA', 'SAU', 'SDN', 'SEN', 'SGP', 'SGS', 'SHN', 'SJM', 'SLB', 'SLE',
  'SLV', 'SMR', 'SOM', 'SPM', 'SRB', 'SSD', 'STP', 'SUR', 'SVK', 'SVN',
  'SWE', 'SWZ', 'SXM', 'SYC', 'SYR', 'TCA', 'TCD', 'TGO', 'THA', 'TJK',
  'TKL', 'TKM', 'TLS', 'TON', 'TTO', 'TUN', 'TUR', 'TUV', 'TWN', 'TZA',
  'UGA', 'UKR', 'UMI', 'URY', 'USA', 'UZB', 'VAT', 'VCT', 'VEN', 'VGB',
  'VIR', 'VNM', 'VUT', 'WLF', 'WSM', 'YEM', 'ZAF', 'ZMB', 'ZWE',
];

/**
 * Codes that appear in travel documents but not in ISO 3166-1.
 *
 * `D` is Germany's, kept from the pre-1990 convention. The `GB*` family
 * distinguishes the classes of British nationality, which are different
 * immigration statuses and not interchangeable. `XX*` cover people a state
 * cannot or will not claim — stateless persons and refugees — and a system that
 * refuses to parse them refuses exactly the people most in need of identifying
 * themselves.
 */
export const ICAO_EXTRA_CODES: readonly string[] = [
  'D', // Germany, as printed
  'GBD', // British overseas territories citizen
  'GBN', // British national (overseas)
  'GBO', // British overseas citizen
  'GBP', // British protected person
  'GBS', // British subject
  'EUE', // European Union
  'UNO', // United Nations organisation
  'UNA', // United Nations specialised agency
  'UNK', // UNMIK, Kosovo
  'XBA', 'XIM', 'XCC', 'XCO', 'XEC', 'XPO', 'XOM', 'XDC', 'XXA', 'XXB',
  'XXC', 'XXD', 'XXX',
  'RKS', // Kosovo, as issued
];

const KNOWN = new Set<string>([...ISO3166_ALPHA3, ...ICAO_EXTRA_CODES]);

/** True for a code a travel document could legitimately carry. */
export function isKnownAlpha3(code: string | null | undefined): boolean {
  if (!code) return false;
  // The MRZ pads short codes with filler, so `D<<` arrives as `D`.
  return KNOWN.has(code.replace(/</g, '').toUpperCase());
}

export function isIso3166Alpha3(code: string | null | undefined): boolean {
  return !!code && ISO3166_ALPHA3.includes(code.toUpperCase());
}
