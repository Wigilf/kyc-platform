/**
 * Machine Readable Zone parsing and validation (ICAO 9303).
 *
 * The MRZ is the highest-value field in document verification because it is
 * self-checking: every data group carries a check digit, and a composite digit
 * covers the whole record. A forger who edits the printed date of birth but not
 * the MRZ produces an arithmetically impossible document.
 *
 * Supported formats:
 *   TD1 — ID cards, 3 lines × 30 characters
 *   TD2 — older passports / travel documents, 2 lines × 36
 *   TD3 — passports, 2 lines × 44
 */

export type MrzFormat = 'TD1' | 'TD2' | 'TD3';

/**
 * Document types that carry a machine-readable zone.
 *
 * Travel documents do, by treaty. Most other identity documents do not: a
 * driving licence generally has a barcode or a chip instead, and a utility bill
 * is a letter. A reader that expects an MRZ on those will find none — which is
 * a fact about the document, not a fault in the applicant's photograph, and
 * must not be reported as one.
 */
export const MRZ_DOCUMENT_TYPES: readonly string[] = [
  'PASSPORT',
  'ID_CARD',
  'VISA',
  'RESIDENCE_PERMIT',
];

export function hasMachineReadableZone(documentType: string): boolean {
  return MRZ_DOCUMENT_TYPES.includes(documentType);
}

export interface MrzFields {
  format: MrzFormat;
  documentCode: string;
  issuingState: string;
  documentNumber: string;
  surname: string;
  givenNames: string;
  nationality: string;
  /** ISO date, or null when the two-digit year is unusable. */
  dateOfBirth: string | null;
  sex: 'M' | 'F' | 'X';
  dateOfExpiry: string | null;
  optionalData: string;
  personalNumber?: string;
}

export interface MrzCheckDigits {
  documentNumber: boolean;
  dateOfBirth: boolean;
  dateOfExpiry: boolean;
  /** Composite digit over the concatenated data groups. */
  composite: boolean | null;
  personalNumber?: boolean;
}

export interface MrzParseResult {
  ok: boolean;
  format?: MrzFormat;
  fields?: MrzFields;
  checkDigits?: MrzCheckDigits;
  /** True only when every present check digit validates. */
  valid: boolean;
  errors: string[];
  warnings: string[];
}

const WEIGHTS = [7, 3, 1];

/** ICAO 9303 check digit: weighted mod-10 over 7-3-1 repeating weights. */
export function computeCheckDigit(input: string): number {
  let sum = 0;
  for (let i = 0; i < input.length; i++) {
    const ch = input[i]!;
    let value: number;
    if (ch >= '0' && ch <= '9') value = ch.charCodeAt(0) - 48;
    else if (ch >= 'A' && ch <= 'Z') value = ch.charCodeAt(0) - 55; // A=10
    else if (ch === '<') value = 0;
    else value = 0; // unknown glyph contributes nothing; the digit will mismatch
    sum += value * WEIGHTS[i % 3]!;
  }
  return sum % 10;
}

/**
 * Verifies one check digit.
 *
 * `optional: true` is only correct where ICAO 9303 actually permits the digit to
 * be filler — the optional-data group, and then only when that group is itself
 * empty. Everywhere else a blank must fail.
 *
 * Treating a blank as a pass everywhere is how a zone with its check digits
 * scrubbed out validates cleanly, which is the opposite of what the digits are
 * for: an altered date of birth would only have to take the check digit with it.
 * This did exactly that until it was fixed.
 */
function verifyDigit(data: string, digit: string, optional = false): boolean {
  if (digit === '<') {
    // Filler is only acceptable against an empty field.
    return optional && /^<*$/.test(data);
  }
  if (!/^[0-9]$/.test(digit)) return false;
  const expected = computeCheckDigit(data);
  return String(expected) === digit;
}

/**
 * Two-digit years are ambiguous. Convention: a birth year is in the past, an
 * expiry year is in the near future. Applying that rather than a fixed pivot is
 * what keeps 1998-born and 2028-expiring documents both parsing correctly.
 */
function expandYear(yy: string, kind: 'birth' | 'expiry', now = new Date()): number | null {
  const n = Number(yy);
  if (!Number.isInteger(n) || yy.length !== 2) return null;
  const currentYY = now.getUTCFullYear() % 100;
  const century = Math.floor(now.getUTCFullYear() / 100) * 100;
  if (kind === 'birth') {
    // A birth date cannot be in the future.
    return n > currentYY ? century - 100 + n : century + n;
  }
  // Expiry dates are assumed within roughly the next 20 years; anything further
  // back than a couple of years is read as the current century.
  return n < currentYY - 80 ? century + 100 + n : century + n;
}

function parseMrzDate(
  yymmdd: string,
  kind: 'birth' | 'expiry',
  now = new Date(),
): string | null {
  if (!/^\d{6}$/.test(yymmdd)) return null;
  const year = expandYear(yymmdd.slice(0, 2), kind, now);
  const month = Number(yymmdd.slice(2, 4));
  const day = Number(yymmdd.slice(4, 6));
  if (year === null || month < 1 || month > 12 || day < 1 || day > 31) return null;
  const date = new Date(Date.UTC(year, month - 1, day));
  // Rejects impossible dates like 31 February, which Date silently rolls over.
  if (date.getUTCMonth() !== month - 1 || date.getUTCDate() !== day) return null;
  return date.toISOString().slice(0, 10);
}

function cleanField(raw: string): string {
  return raw.replace(/</g, ' ').replace(/\s+/g, ' ').trim();
}

/** Splits the `SURNAME<<GIVEN<NAMES` name field. */
function parseNames(raw: string): { surname: string; givenNames: string } {
  const [surnameRaw = '', givenRaw = ''] = raw.split('<<');
  return {
    surname: cleanField(surnameRaw),
    givenNames: cleanField(givenRaw),
  };
}

function parseSex(raw: string): 'M' | 'F' | 'X' {
  return raw === 'M' || raw === 'F' ? raw : 'X';
}

function normalizeLines(input: string): string[] {
  return input
    .toUpperCase()
    .split(/\r?\n/)
    .map((l) => l.replace(/\s/g, ''))
    .filter((l) => l.length > 0);
}

export function detectFormat(lines: string[]): MrzFormat | null {
  if (lines.length === 3 && lines.every((l) => l.length === 30)) return 'TD1';
  if (lines.length === 2 && lines.every((l) => l.length === 36)) return 'TD2';
  if (lines.length === 2 && lines.every((l) => l.length === 44)) return 'TD3';
  return null;
}

export function parseMrz(input: string, now = new Date()): MrzParseResult {
  const errors: string[] = [];
  const warnings: string[] = [];
  const lines = normalizeLines(input);
  const format = detectFormat(lines);

  if (!format) {
    return {
      ok: false,
      valid: false,
      errors: [
        `unrecognised MRZ shape: ${lines.length} line(s) of length ${lines.map((l) => l.length).join('/')}`,
      ],
      warnings,
    };
  }

  const result =
    format === 'TD3' ? parseTd3(lines, now) :
    format === 'TD2' ? parseTd2(lines, now) :
    parseTd1(lines, now);

  const { fields, checkDigits } = result;

  if (!fields.dateOfBirth) errors.push('date of birth is not a valid date');
  if (!fields.dateOfExpiry) errors.push('expiry date is not a valid date');
  if (!checkDigits.documentNumber) errors.push('document number check digit failed');
  if (!checkDigits.dateOfBirth) errors.push('date of birth check digit failed');
  if (!checkDigits.dateOfExpiry) errors.push('expiry date check digit failed');
  if (checkDigits.composite === false) errors.push('composite check digit failed');
  if (checkDigits.personalNumber === false) {
    // Several states leave this group blank or non-conformant; it is not a
    // reliable fraud signal on its own.
    warnings.push('personal number check digit failed');
  }
  if (fields.documentNumber.length === 0) errors.push('document number is empty');
  if (fields.surname.length === 0) warnings.push('surname is empty');

  return {
    ok: true,
    format,
    fields,
    checkDigits,
    valid: errors.length === 0,
    errors,
    warnings,
  };
}

function parseTd3(
  lines: string[],
  now: Date,
): { fields: MrzFields; checkDigits: MrzCheckDigits } {
  const l1 = lines[0]!;
  const l2 = lines[1]!;

  const documentNumberRaw = l2.slice(0, 9);
  const documentNumberCd = l2.slice(9, 10);
  const dobRaw = l2.slice(13, 19);
  const dobCd = l2.slice(19, 20);
  const expiryRaw = l2.slice(21, 27);
  const expiryCd = l2.slice(27, 28);
  const personalNumberRaw = l2.slice(28, 42);
  const personalNumberCd = l2.slice(42, 43);
  const compositeCd = l2.slice(43, 44);

  const composite =
    documentNumberRaw + documentNumberCd +
    dobRaw + dobCd +
    expiryRaw + expiryCd +
    personalNumberRaw + personalNumberCd;

  const names = parseNames(l1.slice(5));

  return {
    fields: {
      format: 'TD3',
      documentCode: cleanField(l1.slice(0, 2)),
      issuingState: cleanField(l1.slice(2, 5)),
      documentNumber: cleanField(documentNumberRaw).replace(/\s/g, ''),
      surname: names.surname,
      givenNames: names.givenNames,
      nationality: cleanField(l2.slice(10, 13)),
      dateOfBirth: parseMrzDate(dobRaw, 'birth', now),
      sex: parseSex(l2.slice(20, 21)),
      dateOfExpiry: parseMrzDate(expiryRaw, 'expiry', now),
      optionalData: cleanField(personalNumberRaw),
      personalNumber: cleanField(personalNumberRaw).replace(/\s/g, ''),
    },
    checkDigits: {
      documentNumber: verifyDigit(documentNumberRaw, documentNumberCd),
      dateOfBirth: verifyDigit(dobRaw, dobCd),
      dateOfExpiry: verifyDigit(expiryRaw, expiryCd),
      personalNumber: verifyDigit(personalNumberRaw, personalNumberCd, true),
      composite: verifyDigit(composite, compositeCd),
    },
  };
}

function parseTd2(
  lines: string[],
  now: Date,
): { fields: MrzFields; checkDigits: MrzCheckDigits } {
  const l1 = lines[0]!;
  const l2 = lines[1]!;

  const documentNumberRaw = l2.slice(0, 9);
  const documentNumberCd = l2.slice(9, 10);
  const dobRaw = l2.slice(13, 19);
  const dobCd = l2.slice(19, 20);
  const expiryRaw = l2.slice(21, 27);
  const expiryCd = l2.slice(27, 28);
  const optionalRaw = l2.slice(28, 35);
  const compositeCd = l2.slice(35, 36);

  const composite =
    documentNumberRaw + documentNumberCd +
    dobRaw + dobCd +
    expiryRaw + expiryCd +
    optionalRaw;

  const names = parseNames(l1.slice(5));

  return {
    fields: {
      format: 'TD2',
      documentCode: cleanField(l1.slice(0, 2)),
      issuingState: cleanField(l1.slice(2, 5)),
      documentNumber: cleanField(documentNumberRaw).replace(/\s/g, ''),
      surname: names.surname,
      givenNames: names.givenNames,
      nationality: cleanField(l2.slice(10, 13)),
      dateOfBirth: parseMrzDate(dobRaw, 'birth', now),
      sex: parseSex(l2.slice(20, 21)),
      dateOfExpiry: parseMrzDate(expiryRaw, 'expiry', now),
      optionalData: cleanField(optionalRaw),
    },
    checkDigits: {
      documentNumber: verifyDigit(documentNumberRaw, documentNumberCd),
      dateOfBirth: verifyDigit(dobRaw, dobCd),
      dateOfExpiry: verifyDigit(expiryRaw, expiryCd),
      composite: verifyDigit(composite, compositeCd),
    },
  };
}

function parseTd1(
  lines: string[],
  now: Date,
): { fields: MrzFields; checkDigits: MrzCheckDigits } {
  const l1 = lines[0]!;
  const l2 = lines[1]!;
  const l3 = lines[2]!;

  const documentNumberRaw = l1.slice(5, 14);
  const documentNumberCd = l1.slice(14, 15);
  const optional1 = l1.slice(15, 30);

  const dobRaw = l2.slice(0, 6);
  const dobCd = l2.slice(6, 7);
  const expiryRaw = l2.slice(8, 14);
  const expiryCd = l2.slice(14, 15);
  const optional2 = l2.slice(18, 29);
  const compositeCd = l2.slice(29, 30);

  // TD1's composite covers fields drawn from both of the first two lines.
  const composite =
    documentNumberRaw + documentNumberCd + optional1 +
    dobRaw + dobCd +
    expiryRaw + expiryCd + optional2;

  const names = parseNames(l3);

  return {
    fields: {
      format: 'TD1',
      documentCode: cleanField(l1.slice(0, 2)),
      issuingState: cleanField(l1.slice(2, 5)),
      documentNumber: cleanField(documentNumberRaw).replace(/\s/g, ''),
      surname: names.surname,
      givenNames: names.givenNames,
      nationality: cleanField(l2.slice(15, 18)),
      dateOfBirth: parseMrzDate(dobRaw, 'birth', now),
      sex: parseSex(l2.slice(7, 8)),
      dateOfExpiry: parseMrzDate(expiryRaw, 'expiry', now),
      optionalData: `${cleanField(optional1)} ${cleanField(optional2)}`.trim(),
    },
    checkDigits: {
      documentNumber: verifyDigit(documentNumberRaw, documentNumberCd),
      dateOfBirth: verifyDigit(dobRaw, dobCd),
      dateOfExpiry: verifyDigit(expiryRaw, expiryCd),
      composite: verifyDigit(composite, compositeCd),
    },
  };
}

/** Builds a conformant TD3 MRZ. Used by the mock OCR adapter and by tests. */
export function buildTd3Mrz(args: {
  documentCode?: string;
  issuingState: string;
  surname: string;
  givenNames: string;
  documentNumber: string;
  nationality: string;
  dateOfBirth: string; // YYYY-MM-DD
  sex: 'M' | 'F' | 'X';
  dateOfExpiry: string; // YYYY-MM-DD
  personalNumber?: string;
}): string {
  const pad = (s: string, n: number) => s.slice(0, n).padEnd(n, '<');
  const toYymmdd = (iso: string) => iso.replace(/-/g, '').slice(2);
  const sanitize = (s: string) => s.toUpperCase().replace(/[^A-Z0-9]+/g, '<');

  const nameField = pad(
    `${sanitize(args.surname)}<<${sanitize(args.givenNames)}`,
    39,
  );
  const line1 = `${pad(args.documentCode ?? 'P', 2)}${pad(args.issuingState, 3)}${nameField}`;

  const docNum = pad(sanitize(args.documentNumber), 9);
  const docNumCd = String(computeCheckDigit(docNum));
  const dob = toYymmdd(args.dateOfBirth);
  const dobCd = String(computeCheckDigit(dob));
  const expiry = toYymmdd(args.dateOfExpiry);
  const expiryCd = String(computeCheckDigit(expiry));
  const personal = pad(sanitize(args.personalNumber ?? ''), 14);
  const personalCd = String(computeCheckDigit(personal));

  const composite =
    docNum + docNumCd + dob + dobCd + expiry + expiryCd + personal + personalCd;
  const compositeCd = String(computeCheckDigit(composite));

  const line2 =
    docNum + docNumCd + pad(args.nationality, 3) + dob + dobCd + args.sex +
    expiry + expiryCd + personal + personalCd + compositeCd;

  return `${line1}\n${line2}`;
}
