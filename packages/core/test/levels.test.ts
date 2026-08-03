import { describe, expect, it } from 'vitest';
import {
  APPLICANT_FACING_STEPS,
  DEFAULT_REQUIRED_APPLICANT_FIELDS,
  LEVEL_TEMPLATES,
  documentTypesForStep,
  missingApplicantFields,
  parseLevelSteps,
  stepLabel,
} from '../src/levels.js';

/**
 * What satisfies a step.
 *
 * Satisfaction used to be read from `acceptedDocumentTypes` alone, so a step
 * that did not set one — selfie and liveness, in every built-in template — could
 * never be ticked off. The requirements endpoint therefore never reported a
 * flow as complete and no applicant using the SDK could reach submission.
 */

const standard = parseLevelSteps(LEVEL_TEMPLATES['standard-kyc-aml']!.steps as never);
const stepOf = (id: string) => standard.find((s) => s.id === id)!;

describe('documentTypesForStep', () => {
  it('honours the level when it narrows the choice', () => {
    expect(documentTypesForStep(stepOf('id-doc'))).toEqual([
      'PASSPORT',
      'ID_CARD',
      'DRIVERS_LICENSE',
    ]);
  });

  it('falls back to what the step type implies', () => {
    expect(documentTypesForStep(stepOf('selfie'))).toContain('SELFIE');
    expect(documentTypesForStep(stepOf('liveness'))).toContain('VIDEO_SELFIE');
  });

  it('leaves genuinely document-less steps empty', () => {
    // Applicant data is supplied as fields, not a file. Empty here is what tells
    // the widget to show a form instead of a camera.
    expect(documentTypesForStep(stepOf('data'))).toEqual([]);
  });

  it('gives every applicant-facing step in every template a way to be satisfied', () => {
    for (const [name, template] of Object.entries(LEVEL_TEMPLATES)) {
      for (const step of parseLevelSteps(template.steps as never)) {
        if (!step.required || !APPLICANT_FACING_STEPS.has(step.type)) continue;
        const satisfiable =
          documentTypesForStep(step).length > 0 ||
          step.type === 'APPLICANT_DATA' ||
          // These are collected outside the document flow.
          ['QUESTIONNAIRE', 'PHONE_VERIFICATION', 'EMAIL_VERIFICATION', 'VIDEO_INTERVIEW',
           'E_SIGNATURE', 'COMPANY_DATA', 'WALLET_OWNERSHIP'].includes(step.type);
        expect(satisfiable, `${name}/${step.id} (${step.type}) cannot be satisfied`).toBe(true);
      }
    }
  });
});

describe('missingApplicantFields', () => {
  const supplied = { firstName: 'Ada', lastName: 'Lovelace', dob: '1990-05-12', country: 'ITA' };

  it('is empty when everything asked for is present', () => {
    expect(missingApplicantFields(DEFAULT_REQUIRED_APPLICANT_FIELDS, supplied)).toEqual([]);
  });

  it('names what is absent', () => {
    expect(missingApplicantFields(['firstName', 'address'], supplied)).toEqual(['address']);
  });

  it('treats blank and whitespace as absent', () => {
    expect(missingApplicantFields(['a', 'b'], { a: '', b: '   ' })).toEqual(['a', 'b']);
  });

  it('accepts a structured value such as an address object', () => {
    expect(
      missingApplicantFields(['address'], { address: { line1: 'x', city: 'y', country: 'ITA' } }),
    ).toEqual([]);
  });
});

describe('stepLabel', () => {
  it('reads as prose rather than an enum', () => {
    // This reaches the applicant, so "APPLICANT_DATA" is not acceptable copy.
    expect(stepLabel(stepOf('data'))).toBe('Applicant data');
    expect(stepLabel(stepOf('poa'))).toBe('Proof of address');
  });

  it('prefers an explicit label when the level sets one', () => {
    expect(stepLabel({ ...stepOf('data'), label: 'About you' })).toBe('About you');
  });
});
