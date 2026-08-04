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
