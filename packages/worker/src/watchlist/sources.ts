import { XMLParser } from 'fast-xml-parser';

/**
 * The public consolidated sanctions lists.
 *
 * OFAC, the EU and the UN all publish theirs free and without authentication,
 * which is what makes real screening possible here at all. Each uses its own
 * schema, so each gets its own parser and they all produce the same shape.
 *
 * What this deliberately does not include is PEP data. There is no free
 * authoritative PEP source — the commercial registers are the product — so a
 * deployment that needs PEP screening has to buy it. Pretending otherwise, by
 * scraping something approximate, would be worse than the honest gap.
 */

export interface ParsedEntry {
  /** Stable id within the source, so refreshes update rather than duplicate. */
  sourceRef: string;
  listName: string;
  listType: 'SANCTIONS';
  entityType: 'INDIVIDUAL' | 'COMPANY';
  fullName: string;
  aliases: string[];
  /** ISO yyyy-mm-dd when the source gives a full date. */
  dob: string | null;
  /** Year alone, when that is all the source has. */
  yobOnly: number | null;
  countries: string[];
  program: string | null;
  remarks: string | null;
}

export interface WatchlistSourceSpec {
  key: string;
  listName: string;
  url: string;
  parse(xml: string): ParsedEntry[];
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: '@',
  // A single child and a list of children must both arrive as arrays, or every
  // access needs a defensive branch.
  isArray: (_name, jpath) =>
    [
      'sdnList.sdnEntry',
      'sdnList.sdnEntry.programList.program',
      'sdnList.sdnEntry.akaList.aka',
      'sdnList.sdnEntry.addressList.address',
      'sdnList.sdnEntry.nationalityList.nationality',
      'sdnList.sdnEntry.citizenshipList.citizenship',
      'sdnList.sdnEntry.dateOfBirthList.dateOfBirthItem',
      'CONSOLIDATED_LIST.INDIVIDUALS.INDIVIDUAL',
      'CONSOLIDATED_LIST.ENTITIES.ENTITY',
      'CONSOLIDATED_LIST.INDIVIDUALS.INDIVIDUAL.INDIVIDUAL_ALIAS',
      'CONSOLIDATED_LIST.INDIVIDUALS.INDIVIDUAL.INDIVIDUAL_DATE_OF_BIRTH',
      'CONSOLIDATED_LIST.INDIVIDUALS.INDIVIDUAL.NATIONALITY.VALUE',
      'CONSOLIDATED_LIST.ENTITIES.ENTITY.ENTITY_ALIAS',
      'export.sanctionEntity',
      'export.sanctionEntity.nameAlias',
      'export.sanctionEntity.birthdate',
      'export.sanctionEntity.citizenship',
      'export.sanctionEntity.regulation',
      'export.sanctionEntity.remark',
    ].includes(String(jpath)) as boolean,
});

const text = (value: unknown): string =>
  value === null || value === undefined ? '' : String(value).trim();

const clean = (values: Array<string | null | undefined>): string[] => [
  ...new Set(values.map((v) => text(v)).filter(Boolean)),
];

/** "01 Jan 1950" and "1950-01-01" both appear across these sources. */
function toIsoDate(raw: string): string | null {
  const value = text(raw);
  if (!value) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) return value;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return parsed.toISOString().slice(0, 10);
}

function toYear(raw: string): number | null {
  const match = text(raw).match(/\b(1[89]\d{2}|20\d{2})\b/);
  return match ? Number(match[1]) : null;
}

// ---------------------------------------------------------------------------
// OFAC — Specially Designated Nationals
// ---------------------------------------------------------------------------

const ofac: WatchlistSourceSpec = {
  key: 'ofac-sdn',
  listName: 'OFAC SDN',
  url: 'https://sanctionslistservice.ofac.treas.gov/api/PublicationPreview/exports/SDN.XML',
  parse(xml) {
    const doc = parser.parse(xml) as {
      sdnList?: { sdnEntry?: Record<string, never>[] };
    };
    const entries = doc.sdnList?.sdnEntry ?? [];
    const out: ParsedEntry[] = [];

    for (const raw of entries as unknown as Array<Record<string, never>>) {
      const e = raw as unknown as {
        uid?: number;
        firstName?: string;
        lastName?: string;
        sdnType?: string;
        remarks?: string;
        programList?: { program?: string[] };
        akaList?: { aka?: Array<{ firstName?: string; lastName?: string }> };
        addressList?: { address?: Array<{ country?: string }> };
        nationalityList?: { nationality?: Array<{ country?: string }> };
        citizenshipList?: { citizenship?: Array<{ country?: string }> };
        dateOfBirthList?: { dateOfBirthItem?: Array<{ dateOfBirth?: string }> };
      };

      const fullName = clean([e.firstName, e.lastName]).join(' ');
      if (!fullName) continue;

      const dobs = e.dateOfBirthList?.dateOfBirthItem ?? [];
      const firstDob = text(dobs[0]?.dateOfBirth);

      out.push({
        sourceRef: String(e.uid ?? fullName),
        listName: 'OFAC SDN',
        listType: 'SANCTIONS',
        // "Individual" vs "Entity"/"Vessel"/"Aircraft".
        entityType: text(e.sdnType).toLowerCase() === 'individual' ? 'INDIVIDUAL' : 'COMPANY',
        fullName,
        aliases: clean(
          (e.akaList?.aka ?? []).map((a) => clean([a.firstName, a.lastName]).join(' ')),
        ),
        dob: toIsoDate(firstDob),
        yobOnly: toIsoDate(firstDob) ? null : toYear(firstDob),
        countries: clean([
          ...(e.nationalityList?.nationality ?? []).map((n) => n.country),
          ...(e.citizenshipList?.citizenship ?? []).map((c) => c.country),
          ...(e.addressList?.address ?? []).map((a) => a.country),
        ]),
        program: clean(e.programList?.program ?? []).join(', ') || null,
        remarks: text(e.remarks) || null,
      });
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// UN — Security Council consolidated list
// ---------------------------------------------------------------------------

const un: WatchlistSourceSpec = {
  key: 'un-consolidated',
  listName: 'UN Consolidated',
  url: 'https://scsanctions.un.org/resources/xml/en/consolidated.xml',
  parse(xml) {
    const doc = parser.parse(xml) as {
      CONSOLIDATED_LIST?: {
        INDIVIDUALS?: { INDIVIDUAL?: Record<string, never>[] };
        ENTITIES?: { ENTITY?: Record<string, never>[] };
      };
    };
    const out: ParsedEntry[] = [];

    for (const raw of (doc.CONSOLIDATED_LIST?.INDIVIDUALS?.INDIVIDUAL ??
      []) as unknown as Array<Record<string, never>>) {
      const e = raw as unknown as {
        DATAID?: number;
        FIRST_NAME?: string;
        SECOND_NAME?: string;
        THIRD_NAME?: string;
        FOURTH_NAME?: string;
        UN_LIST_TYPE?: string;
        COMMENTS1?: string;
        NATIONALITY?: { VALUE?: string[] };
        INDIVIDUAL_ALIAS?: Array<{ ALIAS_NAME?: string }>;
        INDIVIDUAL_DATE_OF_BIRTH?: Array<{ DATE?: string; YEAR?: string | number }>;
      };
      const fullName = clean([e.FIRST_NAME, e.SECOND_NAME, e.THIRD_NAME, e.FOURTH_NAME]).join(' ');
      if (!fullName) continue;

      const birth = e.INDIVIDUAL_DATE_OF_BIRTH?.[0];
      const iso = toIsoDate(text(birth?.DATE));

      out.push({
        sourceRef: String(e.DATAID ?? fullName),
        listName: 'UN Consolidated',
        listType: 'SANCTIONS',
        entityType: 'INDIVIDUAL',
        fullName,
        aliases: clean((e.INDIVIDUAL_ALIAS ?? []).map((a) => a.ALIAS_NAME)),
        dob: iso,
        yobOnly: iso ? null : toYear(text(birth?.YEAR ?? birth?.DATE)),
        countries: clean(e.NATIONALITY?.VALUE ?? []),
        program: text(e.UN_LIST_TYPE) || null,
        remarks: text(e.COMMENTS1) || null,
      });
    }

    for (const raw of (doc.CONSOLIDATED_LIST?.ENTITIES?.ENTITY ??
      []) as unknown as Array<Record<string, never>>) {
      const e = raw as unknown as {
        DATAID?: number;
        FIRST_NAME?: string;
        UN_LIST_TYPE?: string;
        COMMENTS1?: string;
        ENTITY_ALIAS?: Array<{ ALIAS_NAME?: string }>;
      };
      const fullName = text(e.FIRST_NAME);
      if (!fullName) continue;
      out.push({
        sourceRef: String(e.DATAID ?? fullName),
        listName: 'UN Consolidated',
        listType: 'SANCTIONS',
        entityType: 'COMPANY',
        fullName,
        aliases: clean((e.ENTITY_ALIAS ?? []).map((a) => a.ALIAS_NAME)),
        dob: null,
        yobOnly: null,
        countries: [],
        program: text(e.UN_LIST_TYPE) || null,
        remarks: text(e.COMMENTS1) || null,
      });
    }
    return out;
  },
};

// ---------------------------------------------------------------------------
// EU — Financial Sanctions Database consolidated list
// ---------------------------------------------------------------------------

const eu: WatchlistSourceSpec = {
  key: 'eu-consolidated',
  listName: 'EU Consolidated',
  // The token is a fixed public one published in the EU's own documentation,
  // not a credential.
  url: 'https://webgate.ec.europa.eu/fsd/fsf/public/files/xmlFullSanctionsList_1_1/content?token=dG9rZW4tMjAxNw',
  parse(xml) {
    const doc = parser.parse(xml) as { export?: { sanctionEntity?: Record<string, never>[] } };
    const out: ParsedEntry[] = [];

    for (const raw of (doc.export?.sanctionEntity ?? []) as unknown as Array<
      Record<string, never>
    >) {
      const e = raw as unknown as {
        '@logicalId'?: string | number;
        subjectType?: { '@classificationCode'?: string };
        nameAlias?: Array<{ '@wholeName'?: string; '@firstName'?: string; '@lastName'?: string }>;
        birthdate?: Array<{ '@birthdate'?: string; '@year'?: string | number }>;
        citizenship?: Array<{ '@countryIso2Code'?: string }>;
        regulation?: Array<{ '@programme'?: string }>;
        remark?: Array<string> | string;
      };

      const names = e.nameAlias ?? [];
      const primary = names[0];
      const fullName =
        text(primary?.['@wholeName']) ||
        clean([primary?.['@firstName'], primary?.['@lastName']]).join(' ');
      if (!fullName) continue;

      const birth = e.birthdate?.[0];
      const iso = toIsoDate(text(birth?.['@birthdate']));

      out.push({
        sourceRef: String(e['@logicalId'] ?? fullName),
        listName: 'EU Consolidated',
        listType: 'SANCTIONS',
        // classificationCode P = person, E = enterprise.
        entityType: text(e.subjectType?.['@classificationCode']).toUpperCase() === 'P'
          ? 'INDIVIDUAL'
          : 'COMPANY',
        fullName,
        aliases: clean(
          names.slice(1).map((n) =>
            text(n['@wholeName']) || clean([n['@firstName'], n['@lastName']]).join(' '),
          ),
        ),
        dob: iso,
        yobOnly: iso ? null : toYear(text(birth?.['@year'] ?? birth?.['@birthdate'])),
        countries: clean((e.citizenship ?? []).map((c) => c['@countryIso2Code'])),
        program: clean((e.regulation ?? []).map((r) => r['@programme'])).join(', ') || null,
        remarks:
          (Array.isArray(e.remark) ? clean(e.remark).join(' ') : text(e.remark)) || null,
      });
    }
    return out;
  },
};

export const WATCHLIST_SOURCES: WatchlistSourceSpec[] = [ofac, un, eu];
