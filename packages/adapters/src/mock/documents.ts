import { buildTd3Mrz, parseMrz, normalizeCountry } from '@kyc/core';
import type {
  AdapterContext,
  AdapterResult,
  DocAuthAdapter,
  DocAuthRequest,
  DocAuthResult,
  Finding,
  NfcAdapter,
  NfcRequest,
  NfcResult,
  OcrAdapter,
  OcrRequest,
  OcrResult,
} from '../types.js';
import {
  detectScenarios,
  hasScenario,
  isoDaysFromNow,
  isoYearsAgo,
  seededFloat,
  seededInt,
  seededPick,
  simulateLatency,
  type Scenario,
} from '../deterministic.js';

/**
 * Mock document adapters.
 *
 * These generate internally consistent documents: the MRZ they emit really does
 * validate against the check-digit algorithm, and the printed fields really do
 * agree with it. That matters — a mock that produced garbage MRZs would make the
 * MRZ validation check untestable, which is the one check most likely to have a
 * subtle bug.
 */

const FIRST_NAMES = [
  'Anna', 'Marco', 'Sofia', 'Liam', 'Ines', 'Tomas', 'Priya', 'Yusuf', 'Elena',
  'Noah', 'Chiara', 'Andre', 'Fatima', 'Lukas', 'Mei', 'Omar', 'Klara', 'Diego',
];
const LAST_NAMES = [
  'Rossi', 'Novak', 'Silva', 'Ahmed', 'Muller', 'Dubois', 'Kowalski', 'Nakamura',
  'Okafor', 'Fernandez', 'Larsen', 'Petrov', 'Haddad', 'Bergstrom', 'Costa',
];
const AUTHORITIES: Record<string, string> = {
  GBR: 'HM Passport Office',
  DEU: 'Bundesdruckerei',
  FRA: 'Préfecture de Police',
  ITA: 'Questura di Roma',
  ESP: 'Dirección General de la Policía',
  NLD: 'Gemeente Amsterdam',
  USA: 'U.S. Department of State',
  POL: 'Wojewoda Mazowiecki',
};

function seedOf(ctx: AdapterContext, extra = ''): string {
  return `${ctx.seed ?? ctx.applicantId ?? ctx.tenantId}:${extra}`;
}

function docNumberFor(seed: string, country: string): string {
  const digits = String(seededInt(seed, 100000000, 999999999));
  return country === 'USA' ? digits : `${country.slice(0, 1)}${digits.slice(0, 8)}`;
}

export class MockOcrAdapter implements OcrAdapter {
  readonly name = 'mock-ocr';

  async extract(
    req: OcrRequest,
    ctx: AdapterContext,
  ): Promise<AdapterResult<OcrResult>> {
    const seed = seedOf(ctx, `ocr:${req.documentType}`);
    const latencyMs = await simulateLatency(seed);
    const scenarios = detectScenarios(
      ctx.seed,
      ctx.applicantId,
      req.expectedCountry,
      ...req.images.map((i) => i.storageKey),
    );

    if (hasScenario(scenarios, 'PROVIDER_ERROR')) {
      return {
        ok: false,
        provider: this.name,
        latencyMs,
        error: {
          code: 'PROVIDER_TIMEOUT',
          message: 'Simulated OCR provider timeout',
          retryable: true,
        },
      };
    }

    const country = normalizeCountry(req.expectedCountry) ?? 'GBR';
    const findings: Finding[] = [];

    // Quality first: if the image is unusable, a real provider returns quality
    // failures and low-confidence fields rather than confident wrong data.
    const quality = buildQuality(seed, scenarios);
    if (quality.sharpness < 0.4) {
      findings.push({
        code: 'LOW_SHARPNESS',
        severity: 'HIGH',
        message: 'Image is too blurry for reliable extraction.',
        detail: { sharpness: quality.sharpness },
      });
    }
    if (quality.glare > 0.6) {
      findings.push({
        code: 'GLARE_DETECTED',
        severity: 'MEDIUM',
        message: 'Reflections obscure part of the data page.',
        detail: { glare: quality.glare },
      });
    }
    if (quality.screenCaptureSuspected) {
      findings.push({
        code: 'SCREEN_CAPTURE_SUSPECTED',
        severity: 'HIGH',
        message: 'Moiré pattern suggests a photograph of a screen.',
      });
    }
    if (!quality.fullDocumentVisible) {
      findings.push({
        code: 'DOCUMENT_CROPPED',
        severity: 'MEDIUM',
        message: 'One or more document edges fall outside the frame.',
      });
    }

    const firstName = seededPick(`${seed}:first`, FIRST_NAMES);
    const lastName = seededPick(`${seed}:last`, LAST_NAMES);
    const age = hasScenario(scenarios, 'UNDERAGE')
      ? seededInt(`${seed}:age`, 14, 17)
      : seededInt(`${seed}:age`, 21, 68);
    const dob = isoYearsAgo(age);
    const expiryDate = hasScenario(scenarios, 'EXPIRED')
      ? isoDaysFromNow(-seededInt(`${seed}:exp`, 30, 900))
      : isoDaysFromNow(seededInt(`${seed}:exp`, 200, 3200));
    const issuedDate = isoDaysFromNow(-seededInt(`${seed}:iss`, 400, 3000));
    const documentNumber = docNumberFor(`${seed}:num`, country);
    const sex = seededPick(`${seed}:sex`, ['M', 'F'] as const);

    const isTravelDoc = ['PASSPORT', 'ID_CARD', 'RESIDENCE_PERMIT'].includes(
      req.documentType,
    );

    let mrz: string | undefined;
    if (isTravelDoc) {
      mrz = buildTd3Mrz({
        documentCode: req.documentType === 'PASSPORT' ? 'P' : 'I',
        issuingState: country,
        surname: lastName,
        givenNames: firstName,
        documentNumber,
        nationality: country,
        dateOfBirth: dob,
        sex,
        dateOfExpiry: expiryDate,
      });

      if (hasScenario(scenarios, 'MRZ_FAIL')) {
        // Corrupt exactly one check digit. This is what a hand-edited MRZ looks
        // like: the data reads plausibly, the arithmetic does not.
        const lines = mrz.split('\n');
        const l2 = lines[1]!;
        const badDigit = String((Number(l2[9]) + 1) % 10);
        lines[1] = `${l2.slice(0, 9)}${badDigit}${l2.slice(10)}`;
        mrz = lines.join('\n');
        findings.push({
          code: 'MRZ_CHECK_DIGIT_MISMATCH',
          severity: 'HIGH',
          message: 'MRZ document-number check digit does not validate.',
        });
      }
    }

    const degraded = quality.sharpness < 0.4 || quality.glare > 0.6;
    const confidence = (field: string) => {
      const base = seededFloat(`${seed}:conf:${field}`, 0.9, 0.995);
      return Math.round((degraded ? base * 0.55 : base) * 1000) / 1000;
    };

    const result: OcrResult = {
      documentType: req.documentType,
      detectedCountry: country,
      fields: {
        firstName,
        lastName,
        fullName: `${firstName} ${lastName}`,
        documentNumber,
        dob,
        sex,
        nationality: country,
        issuedDate,
        expiryDate,
        issuingAuthority: AUTHORITIES[country] ?? `${country} Authority`,
        placeOfBirth: seededPick(`${seed}:pob`, ['London', 'Milan', 'Berlin', 'Lisbon', 'Warsaw']),
      },
      ...(mrz ? { mrz } : {}),
      fieldConfidence: {
        firstName: confidence('firstName'),
        lastName: confidence('lastName'),
        documentNumber: confidence('documentNumber'),
        dob: confidence('dob'),
        expiryDate: confidence('expiryDate'),
      },
      quality,
      findings,
    };

    // Cross-check our own output the same way the pipeline will, so an
    // inconsistent mock surfaces here rather than as a mysterious check failure.
    if (mrz) {
      const parsed = parseMrz(mrz);
      if (!parsed.valid && !hasScenario(scenarios, 'MRZ_FAIL')) {
        findings.push({
          code: 'MOCK_MRZ_INCONSISTENT',
          severity: 'CRITICAL',
          message: 'Mock generated an MRZ that fails its own validation.',
          detail: { errors: parsed.errors },
        });
      }
    }

    return {
      ok: true,
      data: result,
      provider: this.name,
      providerRef: `mock-ocr-${seededInt(seed, 100000, 999999)}`,
      latencyMs,
      raw: { scenarios: [...scenarios], seed },
    };
  }
}

function buildQuality(seed: string, scenarios: Set<Scenario>): OcrResult['quality'] {
  const blurry = hasScenario(scenarios, 'BLURRY');
  const glare = hasScenario(scenarios, 'GLARE');
  const screencap = hasScenario(scenarios, 'SCREEN_CAPTURE');
  return {
    sharpness: blurry
      ? Math.round(seededFloat(`${seed}:sharp`, 0.1, 0.35) * 100) / 100
      : Math.round(seededFloat(`${seed}:sharp`, 0.72, 0.98) * 100) / 100,
    glare: glare
      ? Math.round(seededFloat(`${seed}:glare`, 0.65, 0.95) * 100) / 100
      : Math.round(seededFloat(`${seed}:glare`, 0.02, 0.25) * 100) / 100,
    brightness: Math.round(seededFloat(`${seed}:bright`, 0.4, 0.8) * 100) / 100,
    resolution: { width: blurry ? 640 : 1920, height: blurry ? 420 : 1280 },
    isColour: true,
    fullDocumentVisible: !hasScenario(scenarios, 'GLARE') || seededFloat(`${seed}:crop`, 0, 1) > 0.4,
    screenCaptureSuspected: screencap,
  };
}

export class MockDocAuthAdapter implements DocAuthAdapter {
  readonly name = 'mock-docauth';

  async verify(
    req: DocAuthRequest,
    ctx: AdapterContext,
  ): Promise<AdapterResult<DocAuthResult>> {
    const seed = seedOf(ctx, `docauth:${req.documentType}`);
    const latencyMs = await simulateLatency(seed);
    const scenarios = detectScenarios(
      ctx.seed,
      ctx.applicantId,
      req.ocr?.fields.fullName,
      req.ocr?.fields.documentNumber,
    );

    const forged = hasScenario(scenarios, 'FORGED', 'TAMPERED');
    const findings: Finding[] = [];
    const tamperFlags: string[] = [];

    if (forged) {
      // Pick a couple of specific indicators rather than a vague low score: a
      // reviewer needs to know *what* looked wrong.
      const candidates = ['DIGITAL_EDIT', 'FONT_MISMATCH', 'PHOTO_SUBSTITUTION', 'TEMPLATE_MISMATCH'];
      tamperFlags.push(
        candidates[seededInt(`${seed}:flag1`, 0, candidates.length - 1)]!,
        candidates[seededInt(`${seed}:flag2`, 0, candidates.length - 1)]!,
      );
      findings.push({
        code: 'TAMPER_INDICATORS',
        severity: 'CRITICAL',
        message: 'Document shows evidence of alteration.',
        detail: { flags: [...new Set(tamperFlags)] },
      });
    }
    if (hasScenario(scenarios, 'SCREEN_CAPTURE')) {
      tamperFlags.push('SCREEN_REPLAY');
      findings.push({
        code: 'SCREEN_REPLAY',
        severity: 'HIGH',
        message: 'Document appears to be displayed on a screen rather than physical.',
      });
    }

    // MRZ vs printed-field consistency is a genuine authenticity check, so the
    // mock actually performs it rather than fabricating a verdict.
    if (req.ocr?.mrz) {
      const parsed = parseMrz(req.ocr.mrz);
      if (parsed.fields && req.ocr.fields.dob && parsed.fields.dateOfBirth) {
        if (parsed.fields.dateOfBirth !== req.ocr.fields.dob) {
          tamperFlags.push('MRZ_PRINTED_MISMATCH');
          findings.push({
            code: 'MRZ_PRINTED_MISMATCH',
            severity: 'CRITICAL',
            message: 'Date of birth in the MRZ disagrees with the printed value.',
            detail: { mrz: parsed.fields.dateOfBirth, printed: req.ocr.fields.dob },
          });
        }
      }
      if (!parsed.valid) {
        findings.push({
          code: 'MRZ_INVALID',
          severity: 'HIGH',
          message: 'MRZ failed check-digit validation.',
          detail: { errors: parsed.errors },
        });
      }
    }

    const unique = [...new Set(tamperFlags)];
    const authenticityScore = unique.length
      ? seededInt(`${seed}:score:bad`, 5, 28)
      : seededInt(`${seed}:score:good`, 82, 99);

    const country = normalizeCountry(req.country) ?? 'GBR';

    return {
      ok: true,
      data: {
        authenticityScore,
        tamperFlags: unique,
        templateMatched: !unique.includes('TEMPLATE_MISMATCH'),
        templateName: `${country}-${req.documentType}-2021`,
        securityFeatures: [
          { feature: 'MRZ', present: Boolean(req.ocr?.mrz), confidence: 0.99 },
          { feature: 'HOLOGRAM', present: !unique.length, confidence: 0.72 },
          { feature: 'MICROPRINT', present: !unique.length, confidence: 0.68 },
          { feature: 'UV_PATTERN', present: null, confidence: 0 }, // needs UV capture
          { feature: 'GHOST_PORTRAIT', present: !unique.length, confidence: 0.81 },
        ],
        findings,
      },
      provider: this.name,
      providerRef: `mock-docauth-${seededInt(seed, 100000, 999999)}`,
      latencyMs,
      raw: { scenarios: [...scenarios] },
    };
  }
}

export class MockNfcAdapter implements NfcAdapter {
  readonly name = 'mock-nfc';

  async read(req: NfcRequest, ctx: AdapterContext): Promise<AdapterResult<NfcResult>> {
    const seed = seedOf(ctx, 'nfc');
    const latencyMs = await simulateLatency(seed);
    const scenarios = detectScenarios(ctx.seed, ctx.applicantId, req.documentNumber);
    const findings: Finding[] = [];

    // The chip is signed by the issuing state, so a cloned or edited chip fails
    // passive authentication. This is the strongest document check that exists.
    const forged = hasScenario(scenarios, 'FORGED', 'TAMPERED');
    if (forged) {
      findings.push({
        code: 'PASSIVE_AUTH_FAILED',
        severity: 'CRITICAL',
        message: 'Document security object signature does not verify against the issuer certificate.',
      });
    }

    const hasDg1 = Object.keys(req.dataGroups).some((k) => /dg1/i.test(k));
    if (!hasDg1) {
      findings.push({
        code: 'DG1_MISSING',
        severity: 'HIGH',
        message: 'Data group 1 (MRZ) was not read from the chip.',
      });
    }

    return {
      ok: true,
      data: {
        passiveAuthPassed: !forged && hasDg1,
        // Active authentication needs chip support; not all documents have it.
        activeAuthPassed: forged ? false : hasScenario(scenarios, 'CLEAN') ? true : null,
        certificateChainValid: !forged,
        fields: {
          documentNumber: req.documentNumber,
          dob: req.dateOfBirth,
          expiryDate: req.dateOfExpiry,
        },
        portraitStorageKey: `mock/nfc/${ctx.applicantId ?? 'unknown'}/portrait.jpg`,
        findings,
      },
      provider: this.name,
      latencyMs,
      raw: { dataGroupsRead: Object.keys(req.dataGroups) },
    };
  }
}
