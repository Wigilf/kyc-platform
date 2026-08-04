import { afterAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { buildTd3Mrz, parseMrz } from '@kyc/core';
import { TesseractOcrAdapter } from '../src/live/ocr-tesseract.js';

/**
 * Real OCR, against real pixels.
 *
 * These tests render a passport data page and photograph it badly, because the
 * only interesting question about a document reader is what it does with input
 * that is not perfect. There is no mocking of Tesseract here — a test that
 * mocked the reader would be testing the mapping code and nothing else, and the
 * mapping code is not where reading goes wrong.
 *
 * The synthetic page is rendered in a plain monospace face rather than OCR-B,
 * which makes it *harder* to read than a real passport, not easier.
 */

const SUBJECT = {
  documentCode: 'P',
  issuingState: 'ITA',
  surname: 'LOVELACE',
  givenNames: 'ADA MARIE',
  documentNumber: 'YA1234567',
  nationality: 'ITA',
  dateOfBirth: '1990-05-12',
  sex: 'F' as const,
  dateOfExpiry: '2031-08-14',
};

const MRZ = buildTd3Mrz(SUBJECT);

const ocr = new TesseractOcrAdapter();
const ctx = { tenantId: 'test', applicantId: 'test', requestId: 'test' };

afterAll(() => ocr.close());

const esc = (t: string) => t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

/** A passport data page: printed fields above, the machine-readable zone below. */
async function dataPage(mrzText = MRZ, w = 1000, h = 650): Promise<Buffer> {
  const [l1, l2] = mrzText.split('\n').map(esc);
  const svg = `<svg width="${w}" height="${h}" xmlns="http://www.w3.org/2000/svg">
    <rect width="${w}" height="${h}" fill="#f4f1e8"/>
    <rect x="30" y="24" width="${w - 60}" height="120" fill="#e8e2d0"/>
    <text x="46" y="72" font-family="Helvetica" font-size="26">REPUBBLICA ITALIANA</text>
    <text x="46" y="112" font-family="Helvetica" font-size="20" fill="#555">PASSAPORTO</text>
    <rect x="46" y="170" width="180" height="230" fill="#cfc7b4"/>
    <text x="260" y="224" font-family="Helvetica" font-size="24">${SUBJECT.surname}</text>
    <text x="260" y="294" font-family="Helvetica" font-size="24">${SUBJECT.givenNames}</text>
    <text x="640" y="224" font-family="Helvetica" font-size="24">${SUBJECT.documentNumber}</text>
    <text x="46" y="${h - 92}" font-family="monospace" font-size="30" letter-spacing="2.6">${l1}</text>
    <text x="46" y="${h - 46}" font-family="monospace" font-size="30" letter-spacing="2.6">${l2}</text>
  </svg>`;
  return sharp(Buffer.from(svg)).png().toBuffer();
}

async function read(bytes: Buffer) {
  const result = await ocr.extract(
    { images: [{ bytes, contentType: 'image/png', side: 'PAGE' }], documentType: 'PASSPORT' },
    ctx,
  );
  return result;
}

const codes = (r: Awaited<ReturnType<typeof read>>) =>
  (r.data?.findings ?? []).map((f) => f.code);

describe('reading a document', () => {
  it('extracts the identity from a clean scan', async () => {
    const result = await read(await dataPage());

    expect(result.ok).toBe(true);
    expect(result.data!.fields).toMatchObject({
      lastName: 'LOVELACE',
      firstName: 'ADA',
      dob: '1990-05-12',
      documentNumber: 'YA1234567',
      expiryDate: '2031-08-14',
      nationality: 'ITA',
    });
    expect(result.data!.detectedCountry).toBe('ITA');
    expect(parseMrz(result.data!.mrz!).valid).toBe(true);
  }, 60_000);

  it('still reads a poor phone photo, and says it could not fully verify it', async () => {
    // Rotated, softened, under-exposed and heavily compressed: the trailing
    // characters of the zone do not survive, which is the commonest real failure.
    const photo = await sharp(await dataPage())
      .rotate(1.4, { background: '#f4f1e8' })
      .blur(0.9)
      .modulate({ brightness: 0.86 })
      .jpeg({ quality: 52 })
      .toBuffer();

    const result = await read(photo);

    expect(result.data!.fields.dob).toBe('1990-05-12');
    expect(result.data!.fields.documentNumber).toBe('YA1234567');
    // The composite check digit did not survive the compression, so the zone
    // could not be fully verified. That is a retake, not an accusation.
    expect(codes(result)).toContain('MRZ_INCOMPLETE');
    expect(codes(result)).not.toContain('MRZ_CHECK_DIGIT_FAILED');
  }, 60_000);
});

describe('refusing to invent a document', () => {
  it('reports nothing readable when the zone is out of frame', async () => {
    const page = await dataPage();
    const { width, height } = await sharp(page).metadata();
    const cropped = await sharp(page)
      .extract({ left: 0, top: 0, width: width!, height: Math.floor(height! * 0.62) })
      .png()
      .toBuffer();

    const result = await read(cropped);

    expect(result.data!.fields).toEqual({});
    expect(codes(result)).toContain('MRZ_NOT_FOUND');
  }, 60_000);

  it('reports nothing readable for a photo with no document in it', async () => {
    const blank = await sharp({
      create: { width: 900, height: 600, channels: 3, background: '#8899aa' },
    })
      .png()
      .toBuffer();

    const result = await read(blank);

    expect(result.data!.fields).toEqual({});
    expect(codes(result)).toContain('MRZ_NOT_FOUND');
  }, 60_000);
});

describe('an altered document', () => {
  it('fails the checksum when the date of birth has been changed', async () => {
    // One digit of the birth date changed and the check digit left alone —
    // the cheapest possible forgery, and the one the check digits exist for.
    const lines = MRZ.split('\n');
    lines[1] = `${lines[1]!.slice(0, 13)}8${lines[1]!.slice(14)}`;

    const result = await read(await dataPage(lines.join('\n')));

    expect(codes(result)).toContain('MRZ_CHECK_DIGIT_FAILED');
    // Escalated, not filed as a photo problem.
    expect(
      result.data!.findings.find((f) => f.code === 'MRZ_CHECK_DIGIT_FAILED')!.severity,
    ).toBe('HIGH');
    // Extracted, but never presented as trustworthy.
    expect(result.data!.fieldConfidence.dob).toBeLessThan(0.4);
  }, 60_000);

  it('does not let a repair launder an inconsistent zone into a pass', async () => {
    const lines = MRZ.split('\n');
    // Corrupt the document number without touching its check digit. No
    // substitution of confusable glyphs can make this validate.
    lines[1] = `YB1234567${lines[1]!.slice(9)}`;

    const result = await read(await dataPage(lines.join('\n')));

    expect(result.data!.findings.some((f) => f.code.startsWith('MRZ_'))).toBe(true);
    expect(parseMrz(result.data!.mrz!).valid).toBe(false);
  }, 60_000);
});
