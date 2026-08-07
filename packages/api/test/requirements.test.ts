import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, provisionTenant } from '@kyc/db';
import { signToken } from '../src/auth.js';
import { buildServer } from '../src/server.js';

/**
 * What /requirements promises the applicant widget.
 *
 * The widget renders the whole flow from this one response, so a field quietly
 * dropping out of it does not break the API — it breaks the screen, silently,
 * in a way only a browser notices. Two of those shipped:
 *
 *  - Completed steps carried no document types, so a "change" control had
 *    nothing to build a capture screen from and going back was impossible.
 *  - Nothing handed back what the applicant had already typed, so correcting a
 *    misspelt city meant retyping the other seven fields.
 */

const SLUG = 'kyc-requirements-test';

let app: Awaited<ReturnType<typeof buildServer>>;
let tenantId: string;
let applicantId: string;
let token: string;

/** A token for this applicant's own record — what the browser holds. */
function tokenFor(id: string): string {
  return signToken(
    { sub: id, kind: 'applicant', tenantId, externalUserId: `ext-${id}` },
    3600,
  );
}

beforeAll(async () => {
  const tenant = await provisionTenant({
    slug: SLUG,
    name: 'Requirements Test',
    homeCountry: 'GBR',
    industry: 'FINTECH',
  });
  tenantId = tenant.id;

  const level = await prisma.verificationLevel.findFirstOrThrow({
    where: { tenantId, name: 'standard-kyc-aml' },
  });
  const applicant = await prisma.applicant.create({
    data: {
      tenantId,
      externalUserId: 'requirements-subject',
      levelId: level.id,
      reviewStatus: 'NOT_STARTED',
      status: 'INIT',
    },
  });
  applicantId = applicant.id;
  token = tokenFor(applicantId);

  app = await buildServer();
  await app.ready();
});

afterAll(async () => {
  await app?.close();
  await prisma.tenant.deleteMany({ where: { slug: SLUG } });
});

async function requirements(as = token) {
  const response = await app.inject({
    method: 'GET',
    url: `/v1/applicants/${applicantId}/requirements`,
    headers: { authorization: `Bearer ${as}` },
  });
  expect(response.statusCode).toBe(200);
  return response.json();
}

describe('every step, not only the outstanding ones', () => {
  it('carries the document types a completed step would need to be redone', async () => {
    const body = await requirements();
    const idDoc = body.allSteps.find((s: { type: string }) => s.type === 'IDENTITY_DOCUMENT');

    expect(idDoc.acceptedDocumentTypes).toContain('PASSPORT');
    expect(idDoc.requireBothSides).toBe(true);
  });
});

describe('a document with two sides', () => {
  /** Uploads one side of a document through the real multipart endpoint. */
  async function uploadSide(side: 'FRONT_SIDE' | 'BACK_SIDE') {
    const boundary = '----kyctest';
    const png = Buffer.from(
      'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
      'base64',
    );
    const body = Buffer.concat([
      Buffer.from(
        `--${boundary}\r\nContent-Disposition: form-data; name="type"\r\n\r\nID_CARD\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="subType"\r\n\r\n${side}\r\n` +
          `--${boundary}\r\nContent-Disposition: form-data; name="file"; filename="s.png"\r\n` +
          `Content-Type: image/png\r\n\r\n`,
      ),
      png,
      Buffer.from(`\r\n--${boundary}--\r\n`),
    ]);

    return app.inject({
      method: 'POST',
      url: `/v1/applicants/${applicantId}/documents`,
      headers: {
        authorization: `Bearer ${token}`,
        'content-type': `multipart/form-data; boundary=${boundary}`,
      },
      payload: body,
    });
  }

  it('is one document carrying both sides, not two documents', async () => {
    expect((await uploadSide('FRONT_SIDE')).statusCode).toBeLessThan(300);
    expect((await uploadSide('BACK_SIDE')).statusCode).toBeLessThan(300);

    const documents = await prisma.document.findMany({
      where: { applicantId, type: 'ID_CARD', status: { not: 'SUPERSEDED' } },
      include: { images: true },
    });

    // Two rows here means the pipeline picks one with `.find()` and never looks
    // at the other — on a real card, a coin toss between reading the data side
    // and declaring a blank back unreadable.
    expect(documents).toHaveLength(1);
    expect(documents[0]!.images.map((i) => i.side).sort()).toEqual(['BACK_SIDE', 'FRONT_SIDE']);
  }, 60_000);

  it('replaces only the side that was re-uploaded', async () => {
    const before = await prisma.documentImage.findFirstOrThrow({
      where: { document: { applicantId, type: 'ID_CARD' }, side: 'BACK_SIDE' },
    });

    await uploadSide('FRONT_SIDE');

    const after = await prisma.documentImage.findMany({
      where: { document: { applicantId, type: 'ID_CARD' } },
    });
    // The back must survive the front being retaken.
    expect(after.map((i) => i.side).sort()).toEqual(['BACK_SIDE', 'FRONT_SIDE']);
    expect(after.find((i) => i.side === 'BACK_SIDE')!.id).toBe(before.id);
  }, 60_000);

  it('sends the document back to be re-examined when a side changes', async () => {
    await prisma.document.updateMany({
      where: { applicantId, type: 'ID_CARD' },
      data: { status: 'EXTRACTED', rejectLabels: ['BLURRY_IMAGE'] },
    });

    await uploadSide('FRONT_SIDE');

    const document = await prisma.document.findFirstOrThrow({
      where: { applicantId, type: 'ID_CARD', status: { not: 'SUPERSEDED' } },
    });
    // Leaving the old verdict attached would judge the new photo on the old one.
    expect(document.status).toBe('UPLOADED');
    expect(document.rejectLabels).toEqual([]);
  }, 60_000);
});

describe('what the applicant already supplied', () => {
  it('is empty before anything is supplied', async () => {
    const body = await requirements();
    expect(body.applicantData).toEqual({});
  });

  it('is handed back, including the fields held in the sealed blob', async () => {
    const patch = await app.inject({
      method: 'PATCH',
      url: `/v1/applicants/${applicantId}`,
      headers: { authorization: `Bearer ${token}` },
      payload: {
        info: {
          firstName: 'Ada',
          lastName: 'Lovelace',
          dob: '1990-05-12',
          country: 'ITA',
          email: 'ada@example.test',
          address: { line1: 'Via Torino 42', city: 'Milano', country: 'ITA', postCode: '20123' },
        },
      },
    });
    expect(patch.statusCode).toBe(200);

    const body = await requirements();
    expect(body.applicantData).toMatchObject({
      firstName: 'Ada',
      lastName: 'Lovelace',
      // Date only. An ISO timestamp does not populate an <input type="date">.
      dob: '1990-05-12',
      country: 'ITA',
      email: 'ada@example.test',
      addressLine1: 'Via Torino 42',
      addressCity: 'Milano',
      addressPostCode: '20123',
    });

    // And the step it satisfies is now done, so the widget shows it as a
    // "change" row rather than an outstanding one.
    const data = body.allSteps.find((s: { type: string }) => s.type === 'APPLICANT_DATA');
    expect(data.satisfied).toBe(true);
  });

  it('is not handed to a token for a different applicant', async () => {
    const other = await prisma.applicant.create({
      data: {
        tenantId,
        externalUserId: 'someone-else',
        levelId: (await prisma.verificationLevel.findFirstOrThrow({ where: { tenantId } })).id,
        reviewStatus: 'NOT_STARTED',
        status: 'INIT',
      },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/applicants/${applicantId}/requirements`,
      headers: { authorization: `Bearer ${tokenFor(other.id)}` },
    });

    // 404, not 403 — confirming another applicant exists is itself a disclosure.
    expect(response.statusCode).toBe(404);
    expect(response.json()).not.toHaveProperty('applicantData');
  });
});
