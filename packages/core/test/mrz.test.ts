import { describe, expect, it } from 'vitest';
import { buildTd3Mrz, computeCheckDigit, detectFormat, parseMrz } from '../src/mrz.js';

/**
 * MRZ parsing is the check most likely to hide a subtle bug: it is pure
 * arithmetic over a fixed layout, so it either implements ICAO 9303 or it
 * quietly does not, and a wrong check digit means forged documents validate.
 */

describe('computeCheckDigit', () => {
  // Worked examples from ICAO 9303 Part 3.
  it.each([
    ['D23145890734', 9],
    ['340712', 7],
    ['950712', 2],
  ])('%s -> %i', (input, expected) => {
    expect(computeCheckDigit(input)).toBe(expected);
  });

  it('weights 7-3-1 cyclically', () => {
    // A single digit in position 0 is multiplied by 7; 7*7=49, 49 mod 10 = 9.
    expect(computeCheckDigit('7')).toBe(9);
  });

  it('treats filler as zero', () => {
    expect(computeCheckDigit('<<<')).toBe(0);
  });
});

describe('buildTd3Mrz / parseMrz round trip', () => {
  const args = {
    documentCode: 'P' as const,
    issuingState: 'ITA',
    surname: 'Rossi',
    givenNames: 'Anna',
    documentNumber: 'I12345678',
    nationality: 'ITA',
    dateOfBirth: '1990-05-12',
    sex: 'F' as const,
    dateOfExpiry: '2030-10-20',
  };

  it('produces two lines of 44 characters', () => {
    const lines = buildTd3Mrz(args).split('\n');
    expect(lines).toHaveLength(2);
    expect(lines[0]).toHaveLength(44);
    expect(lines[1]).toHaveLength(44);
  });

  it('validates and recovers every field it was given', () => {
    const result = parseMrz(buildTd3Mrz(args));
    expect(result.valid).toBe(true);
    expect(result.errors).toEqual([]);
    expect(result.fields).toMatchObject({
      documentNumber: 'I12345678',
      dateOfBirth: '1990-05-12',
      dateOfExpiry: '2030-10-20',
      nationality: 'ITA',
      sex: 'F',
    });
    expect(result.fields?.surname?.toUpperCase()).toBe('ROSSI');
  });

  it('is detected as TD3', () => {
    expect(detectFormat(buildTd3Mrz(args).split('\n'))).toBe('TD3');
  });
});

describe('parseMrz rejects tampering', () => {
  const mrz = buildTd3Mrz({
    documentCode: 'P',
    issuingState: 'GBR',
    surname: 'Kowalski',
    givenNames: 'Blurry',
    documentNumber: 'G87654321',
    nationality: 'GBR',
    dateOfBirth: '1985-02-03',
    sex: 'M',
    dateOfExpiry: '2029-01-01',
  });

  it('fails when a check digit is altered', () => {
    const lines = mrz.split('\n');
    const line2 = lines[1]!;
    const corrupted = String((Number(line2[9]) + 1) % 10);
    lines[1] = `${line2.slice(0, 9)}${corrupted}${line2.slice(10)}`;

    const result = parseMrz(lines.join('\n'));
    expect(result.valid).toBe(false);
    expect(result.errors.length).toBeGreaterThan(0);
  });

  it('fails when the document number is edited but the check digit is not', () => {
    const lines = mrz.split('\n');
    const line2 = lines[1]!;
    lines[1] = `G87654322${line2.slice(9)}`;

    expect(parseMrz(lines.join('\n')).valid).toBe(false);
  });

  it('rejects input that is not an MRZ at all', () => {
    expect(parseMrz('not an mrz').valid).toBe(false);
  });
});

describe('blank check digits', () => {
  /**
   * A check digit that is not there cannot have been verified.
   *
   * This treated filler in any check-digit position as a pass, on the reasoning
   * that optional groups legitimately carry none. The reasoning was right for
   * the optional-data group and wrong everywhere else: it meant a zone with its
   * mandatory digits scrubbed out validated cleanly, so altering a date of birth
   * only required deleting the digit that would have caught it.
   */
  it('rejects a zone whose mandatory check digits have been blanked', () => {
    const mrz = buildTd3Mrz({
      issuingState: 'ITA',
      surname: 'LOVELACE',
      givenNames: 'ADA',
      documentNumber: 'YA1234567',
      nationality: 'ITA',
      dateOfBirth: '1990-05-12',
      sex: 'F',
      dateOfExpiry: '2031-08-14',
    });
    expect(parseMrz(mrz).valid).toBe(true);

    const lines = mrz.split('\n');
    // Alter the birth date and remove the digit that protects it.
    lines[1] = `${lines[1]!.slice(0, 13)}800512<${lines[1]!.slice(20)}`;

    const parsed = parseMrz(lines.join('\n'));
    expect(parsed.checkDigits!.dateOfBirth).toBe(false);
    expect(parsed.valid).toBe(false);
  });

  it('still accepts filler against an empty optional-data group', () => {
    // A passport with no personal number carries filler in both the group and
    // its check digit, and is perfectly valid.
    const mrz = buildTd3Mrz({
      issuingState: 'GBR',
      surname: 'HOPPER',
      givenNames: 'GRACE',
      documentNumber: '123456789',
      nationality: 'GBR',
      dateOfBirth: '1980-12-09',
      sex: 'F',
      dateOfExpiry: '2030-01-01',
      personalNumber: '',
    });

    const parsed = parseMrz(mrz);
    expect(parsed.checkDigits!.personalNumber).toBe(true);
    expect(parsed.valid).toBe(true);
  });
});
