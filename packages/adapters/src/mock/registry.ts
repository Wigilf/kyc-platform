import { normalizeCompanyName, normalizeCountry } from '@kyc/core';
import type {
  AdapterContext,
  AdapterResult,
  Finding,
  RegistryAdapter,
  RegistryLookupRequest,
  RegistryResult,
  RegistryOfficer,
  RegistryShareholder,
} from '../types.js';
import {
  detectScenarios,
  hasScenario,
  isoDaysFromNow,
  seededFloat,
  seededInt,
  seededPick,
  simulateLatency,
} from '../deterministic.js';

/**
 * Mock company registry.
 *
 * Generates ownership structures that are actually worth resolving: single
 * owners, split ownership, holding chains, nominee arrangements, and — for the
 * shell scenario — a structure that deliberately fails to resolve. Without those
 * shapes the UBO resolver has nothing meaningful to be tested against.
 */

const REGISTRIES: Record<string, string> = {
  GBR: 'Companies House',
  DEU: 'Handelsregister',
  FRA: 'Registre du Commerce et des Sociétés',
  NLD: 'Kamer van Koophandel',
  ITA: 'Registro delle Imprese',
  ESP: 'Registro Mercantil',
  USA: 'Delaware Division of Corporations',
  IRL: 'Companies Registration Office',
  CYM: 'Cayman Islands General Registry',
  VGB: 'BVI Registry of Corporate Affairs',
  SGP: 'ACRA',
  CHE: 'Zefix',
};

const LEGAL_FORMS: Record<string, string> = {
  GBR: 'Private limited company',
  DEU: 'Gesellschaft mit beschränkter Haftung',
  FRA: 'Société par actions simplifiée',
  NLD: 'Besloten vennootschap',
  ITA: 'Società a responsabilità limitata',
  USA: 'Limited Liability Company',
  CYM: 'Exempted Company',
  VGB: 'BVI Business Company',
};

const PERSON_NAMES = [
  'Helena Voss', 'Marcus Lindqvist', 'Aisha Rahman', 'Tomás Ferreira',
  'Nadia Belkacem', 'Peter Nowak', 'Chen Wei', 'Laura Bianchi',
  'Dmitri Sokolov', 'Grace Adeyemi', 'Johan de Vries', 'Sara Kowalczyk',
];

export class MockRegistryAdapter implements RegistryAdapter {
  readonly name = 'mock-registry';

  async lookup(
    req: RegistryLookupRequest,
    ctx: AdapterContext,
  ): Promise<AdapterResult<RegistryResult>> {
    const country = normalizeCountry(req.country) ?? 'GBR';
    const key = req.registrationNumber ?? normalizeCompanyName(req.legalName ?? '');
    const seed = `${ctx.tenantId}:registry:${country}:${key}`;
    const latencyMs = await simulateLatency(seed, 80, 500);
    const scenarios = detectScenarios(req.legalName, req.registrationNumber, ctx.seed);
    const findings: Finding[] = [];

    if (hasScenario(scenarios, 'PROVIDER_ERROR')) {
      return {
        ok: false,
        provider: this.name,
        latencyMs,
        error: {
          code: 'REGISTRY_UNAVAILABLE',
          message: 'Simulated registry outage',
          retryable: true,
        },
      };
    }

    // No identifier at all means we cannot claim a match; guessing from a name
    // alone is how the wrong company ends up in a KYB file.
    if (!req.registrationNumber && !req.legalName) {
      return {
        ok: true,
        data: notFound(country),
        provider: this.name,
        latencyMs,
      };
    }

    // A registration number that does not look like one is treated as not found
    // rather than fabricated into a match.
    if (req.registrationNumber && !/^[A-Za-z0-9-]{5,20}$/.test(req.registrationNumber)) {
      findings.push({
        code: 'REGISTRATION_NUMBER_MALFORMED',
        severity: 'MEDIUM',
        message: 'Registration number does not match the expected format for this registry.',
      });
      return {
        ok: true,
        data: { ...notFound(country), findings },
        provider: this.name,
        latencyMs,
      };
    }

    const legalName = req.legalName ?? `${seededPick(`${seed}:n`, ['Northwind', 'Aurora', 'Meridian', 'Blackwood', 'Cascade'])} ${seededPick(`${seed}:s`, ['Trading', 'Holdings', 'Capital', 'Ventures', 'Logistics'])} Ltd`;

    const dissolved = hasScenario(scenarios, 'DISSOLVED');
    const shell = hasScenario(scenarios, 'SHELL_COMPANY');
    const nominee = hasScenario(scenarios, 'NOMINEE');

    const incorporatedDaysAgo = shell
      ? seededInt(`${seed}:inc`, 10, 80)
      : seededInt(`${seed}:inc`, 400, 8000);

    const officers = buildOfficers(seed, country, nominee);
    const shareholders = buildShareholders(seed, country, { shell, nominee });

    const declared = shareholders.reduce((s, h) => s + h.ownershipPercent, 0);
    if (declared < 99.5) {
      findings.push({
        code: 'INCOMPLETE_SHARE_REGISTER',
        severity: 'HIGH',
        message: `Registry accounts for only ${declared.toFixed(1)}% of shares; the remainder is unattributed.`,
        detail: { declaredPercent: declared },
      });
    }
    if (dissolved) {
      findings.push({
        code: 'COMPANY_NOT_ACTIVE',
        severity: 'CRITICAL',
        message: 'Registry status is dissolved or in liquidation.',
      });
    }
    if (nominee) {
      findings.push({
        code: 'NOMINEE_SHAREHOLDER',
        severity: 'HIGH',
        message: 'One or more holdings are recorded as nominee arrangements.',
      });
    }

    const result: RegistryResult = {
      found: true,
      registry: REGISTRIES[country] ?? `${country} Companies Registry`,
      legalName,
      registrationNumber:
        req.registrationNumber ?? String(seededInt(`${seed}:regno`, 1000000, 99999999)),
      status: dissolved
        ? seededPick(`${seed}:status`, ['DISSOLVED', 'LIQUIDATION'] as const)
        : 'ACTIVE',
      legalForm: LEGAL_FORMS[country] ?? 'Limited company',
      incorporatedAt: isoDaysFromNow(-incorporatedDaysAgo),
      ...(dissolved ? { dissolvedAt: isoDaysFromNow(-seededInt(`${seed}:dis`, 10, 300)) } : {}),
      registeredAddress: {
        line1: `${seededInt(`${seed}:num`, 1, 200)} ${seededPick(`${seed}:st`, ['High Street', 'Bahnhofstrasse', 'Rue de la Paix', 'Keizersgracht'])}`,
        city: seededPick(`${seed}:city`, ['London', 'Berlin', 'Paris', 'Amsterdam', 'Dublin']),
        postCode: `${seededInt(`${seed}:pc`, 10000, 99999)}`,
        country,
      },
      industryCodes: [String(seededInt(`${seed}:sic`, 10000, 99999))],
      officers,
      shareholders,
      substance: {
        employeeCount: shell ? seededInt(`${seed}:emp`, 0, 1) : seededInt(`${seed}:emp`, 4, 320),
        filingsCount: shell ? 0 : seededInt(`${seed}:fil`, 2, 18),
        lastFilingAt: shell ? null : isoDaysFromNow(-seededInt(`${seed}:lf`, 20, 400)),
        registeredOfficeOnly: shell,
        companiesAtSameAddress: shell
          ? seededInt(`${seed}:same`, 25, 400)
          : seededInt(`${seed}:same`, 1, 6),
      },
      findings,
    };

    return {
      ok: true,
      data: result,
      provider: this.name,
      providerRef: `mock-reg-${seededInt(seed, 100000, 999999)}`,
      latencyMs,
      raw: { scenarios: [...scenarios] },
    };
  }
}

function notFound(country: string): RegistryResult {
  return {
    found: false,
    registry: REGISTRIES[country] ?? `${country} Companies Registry`,
    legalName: '',
    registrationNumber: '',
    status: 'UNKNOWN',
    industryCodes: [],
    officers: [],
    shareholders: [],
    substance: {},
    findings: [
      {
        code: 'COMPANY_NOT_FOUND',
        severity: 'HIGH',
        message: 'No matching record in the registry.',
      },
    ],
  };
}

function buildOfficers(seed: string, country: string, nominee: boolean): RegistryOfficer[] {
  const count = seededInt(`${seed}:offc`, 1, 3);
  const officers: RegistryOfficer[] = [];
  for (let i = 0; i < count; i++) {
    officers.push({
      fullName: seededPick(`${seed}:off:${i}`, PERSON_NAMES),
      role: i === 0 ? 'DIRECTOR' : seededPick(`${seed}:role:${i}`, ['DIRECTOR', 'SECRETARY']),
      dob: `${seededInt(`${seed}:offdob:${i}`, 1955, 1995)}-0${seededInt(`${seed}:offm:${i}`, 1, 9)}-1${seededInt(`${seed}:offd:${i}`, 0, 9)}`,
      country,
      appointedAt: isoDaysFromNow(-seededInt(`${seed}:app:${i}`, 100, 3000)),
      resignedAt: null,
    });
  }
  if (nominee) {
    officers.push({
      fullName: 'Corporate Nominees Limited',
      role: 'NOMINEE',
      country: 'VGB',
      appointedAt: isoDaysFromNow(-seededInt(`${seed}:napp`, 100, 2000)),
      resignedAt: null,
    });
  }
  return officers;
}

function buildShareholders(
  seed: string,
  country: string,
  opts: { shell: boolean; nominee: boolean },
): RegistryShareholder[] {
  // Shell structures deliberately terminate at an offshore company with no
  // further disclosure — the resolver must report unresolved ownership, not
  // invent a natural person.
  if (opts.shell) {
    return [
      {
        name: `${seededPick(`${seed}:sh`, ['Ridgeline', 'Vantage', 'Solstice'])} Holdings Ltd`,
        isCompany: true,
        registrationNumber: String(seededInt(`${seed}:shreg`, 100000, 999999)),
        country: seededPick(`${seed}:shc`, ['VGB', 'CYM', 'SYC', 'PAN']),
        ownershipPercent: 100,
        isNominee: false,
      },
    ];
  }

  if (opts.nominee) {
    return [
      {
        name: 'Corporate Nominees Limited',
        isCompany: true,
        registrationNumber: String(seededInt(`${seed}:nomreg`, 100000, 999999)),
        country: 'VGB',
        ownershipPercent: 60,
        isNominee: true,
      },
      {
        name: seededPick(`${seed}:np`, PERSON_NAMES),
        isCompany: false,
        country,
        ownershipPercent: 40,
        dob: `${seededInt(`${seed}:npdob`, 1960, 1992)}-05-14`,
      },
    ];
  }

  const shape = seededFloat(`${seed}:shape`, 0, 1);

  // Sole owner.
  if (shape < 0.4) {
    return [
      {
        name: seededPick(`${seed}:solo`, PERSON_NAMES),
        isCompany: false,
        country,
        ownershipPercent: 100,
        dob: `${seededInt(`${seed}:sdob`, 1958, 1994)}-03-22`,
      },
    ];
  }

  // Two or three natural persons.
  if (shape < 0.7) {
    const a = seededInt(`${seed}:splitA`, 40, 70);
    const b = seededInt(`${seed}:splitB`, 15, Math.max(16, 100 - a));
    const c = 100 - a - b;
    const holders: RegistryShareholder[] = [
      {
        name: seededPick(`${seed}:p1`, PERSON_NAMES),
        isCompany: false,
        country,
        ownershipPercent: a,
        dob: `${seededInt(`${seed}:d1`, 1955, 1990)}-07-11`,
      },
      {
        name: seededPick(`${seed}:p2`, PERSON_NAMES.slice(4)),
        isCompany: false,
        country,
        ownershipPercent: b,
        dob: `${seededInt(`${seed}:d2`, 1955, 1990)}-11-02`,
      },
    ];
    if (c > 0) {
      holders.push({
        name: seededPick(`${seed}:p3`, PERSON_NAMES.slice(8)),
        isCompany: false,
        country,
        ownershipPercent: c,
        dob: `${seededInt(`${seed}:d3`, 1960, 1996)}-01-30`,
      });
    }
    return holders;
  }

  // Holding-company chain: one intermediate company plus a minority person.
  const parentPercent = seededInt(`${seed}:hp`, 55, 90);
  return [
    {
      name: `${seededPick(`${seed}:hn`, ['Meridian', 'Kestrel', 'Aldgate'])} Group ${seededPick(`${seed}:hs`, ['Holdings', 'Investments'])} Ltd`,
      isCompany: true,
      registrationNumber: String(seededInt(`${seed}:hreg`, 100000, 999999)),
      country: seededPick(`${seed}:hc`, [country, 'NLD', 'LUX', 'IRL']),
      ownershipPercent: parentPercent,
    },
    {
      name: seededPick(`${seed}:hm`, PERSON_NAMES),
      isCompany: false,
      country,
      ownershipPercent: 100 - parentPercent,
      dob: `${seededInt(`${seed}:hdob`, 1957, 1993)}-09-08`,
    },
  ];
}
