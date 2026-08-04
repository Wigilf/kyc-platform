// Must be set before anything builds an adapter registry: the choice of reader
// is read once, at construction, and cached per tenant.
process.env.ADAPTER_OCR = 'tesseract';

import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import sharp from 'sharp';
import { prisma } from '@kyc/db';
import { runVerificationPipeline } from '../src/pipeline.js';
import { cleanupTestData, createApplicant } from './helpers.js';

/**
 * The pipeline with a reader that can actually fail.
 *
 * Every other pipeline test runs against the simulated reader, which always
 * returns a plausible document. That hides a whole category of outcome: what
 * happens when the reader returns *nothing*. The fixtures upload a one-pixel
 * image, so with real OCR that is exactly what happens.
 *
 * The answer used to be "the applicant is approved". Not because anything
 * decided they should be, but because every check in the document step is a
 * comparison — name against name, date against date, expiry against today — and
 * a document with no fields in it fails none of them. Nothing to compare read as
 * nothing wrong. That is the failure mode this file exists to prevent.
 *
 * The image below is deliberately sharp and well exposed. A blurred one proves
 * nothing here: the quality checks already reject those, and testing against one
 * would let the real gap — a good photograph of something that is not a document
 * — go on passing while the suite stayed green. It did, until this test used a
 * better photo.
 */

/**
 * A crisp, well-lit photograph containing no document whatsoever.
 *
 * Sensor noise included deliberately. Flat vector shapes have almost no
 * high-frequency detail, so a focus measure reads them as blurred and the photo
 * gets rejected for the wrong reason — leaving the behaviour under test
 * untouched and the test passing for free.
 */
async function photoOfNothing(): Promise<Buffer> {
  const base = await sharp({
    create: {
      width: 1200,
      height: 800,
      channels: 3,
      background: '#6b7a5e',
      noise: { type: 'gaussian', mean: 128, sigma: 26 },
    },
  })
    .png()
    .toBuffer();

  const scene = Buffer.from(
    `<svg width="1200" height="800" xmlns="http://www.w3.org/2000/svg">
      <circle cx="820" cy="520" r="120" fill="#7d6a55" opacity="0.8"/>
      <text x="90" y="180" font-family="Helvetica" font-size="70" fill="#2f3a2a">a dog on a sofa</text>
    </svg>`,
  );
  return sharp(base).composite([{ input: scene }]).png().toBuffer();
}

let image: Buffer;
beforeAll(async () => {
  image = await photoOfNothing();
});

afterAll(cleanupTestData);

describe('a document the reader cannot read', () => {
  it('is not approved', async () => {
    const { applicant, tenant } = await createApplicant('real-ocr-unreadable', { documentImage: image });

    const result = await runVerificationPipeline({
      tenantId: tenant.id,
      applicantId: applicant.id,
      trigger: 'SUBMITTED',
    });

    expect(result.reviewStatus).not.toBe('APPROVED');
  }, 120_000);

  it('fails the OCR check and says why, rather than passing silently', async () => {
    const { applicant, tenant } = await createApplicant('real-ocr-labels', { documentImage: image });

    await runVerificationPipeline({
      tenantId: tenant.id,
      applicantId: applicant.id,
      trigger: 'SUBMITTED',
    });

    const check = await prisma.check.findFirstOrThrow({
      where: { applicantId: applicant.id, type: 'DOCUMENT_OCR' },
      orderBy: { createdAt: 'desc' },
    });

    expect(check.result).toBe('FAIL');
    expect(check.rejectLabels).toContain('DOCUMENT_UNREADABLE');
    // Not merely "the photo was bad" — the photo is fine, there is no document
    // in it. Reporting it as blur would send the applicant back to retake a
    // picture that was never going to work.
    expect(check.rejectLabels).not.toContain('BLURRY_IMAGE');
    expect(check.rejectLabels).not.toContain('GLARE_OR_REFLECTION');
    // The provider is named, so a reviewer can tell which reader produced this.
    expect(check.provider).toBe('tesseract-ocr');
  }, 120_000);

  it('leaves the document unextracted rather than storing invented fields', async () => {
    const { applicant, tenant } = await createApplicant('real-ocr-document', { documentImage: image });

    await runVerificationPipeline({
      tenantId: tenant.id,
      applicantId: applicant.id,
      trigger: 'SUBMITTED',
    });

    const document = await prisma.document.findFirstOrThrow({
      where: { applicantId: applicant.id, type: 'PASSPORT' },
    });

    expect(document.status).toBe('REJECTED');
    expect(document.number).toBeNull();
    expect(document.expiryDate).toBeNull();
  }, 120_000);
});
