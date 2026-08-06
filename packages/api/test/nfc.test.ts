// Trust anchors are read once, when the adapter registry is built.
process.env.CSCA_DIR = '';

import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, provisionTenant } from '@kyc/db';
import { buildSod, issuedBy, selfSigned, type Authority } from '../../core/test/passport-pki.js';
import { signToken } from '../src/auth.js';
import { buildServer } from '../src/server.js';

/**
 * Submitting a chip read over HTTP.
 *
 * The endpoint a mobile app calls. What matters here is that the verdict
 * survives the trip intact: a tampered chip must not become a passing check
 * because the failure got lost in translation between the verifier and the
 * database row a reviewer eventually reads.
 */

const SLUG = 'kyc-nfc-test';
const DATA_GROUPS = {
  DG1: Buffer.from('P<UTOSPECIMEN<<ADA<MARIE<<<<<<<<<<<<<<<<<<<<', 'ascii'),
  DG2: Buffer.from('a portrait, as far as this test is concerned', 'ascii'),
};

let app: Awaited<ReturnType<typeof buildServer>>;
let tenantId: string;
let csca: Authority;
let signer: Authority;

async function newApplicant() {
  const level = await prisma.verificationLevel.findFirstOrThrow({ where: { tenantId } });
  const applicant = await prisma.applicant.create({
    data: {
      tenantId,
      externalUserId: `nfc-${Math.abs(level.id.split('').reduce((a, c) => a * 31 + c.charCodeAt(0), 7))}-${await nextSuffix()}`,
      levelId: level.id,
      reviewStatus: 'NOT_STARTED',
      status: 'INIT',
    },
  });
  const token = signToken(
    { sub: applicant.id, kind: 'applicant', tenantId, externalUserId: applicant.externalUserId },
    3600,
  );
  return { applicant, token };
}

let counter = 0;
const nextSuffix = async () => `${counter++}`;

async function submit(token: string, id: string, dataGroups: Record<string, string>) {
  return app.inject({
    method: 'POST',
    url: `/v1/applicants/${id}/nfc`,
    headers: { authorization: `Bearer ${token}` },
    payload: {
      dataGroups,
      documentNumber: 'UT7431852',
      dateOfBirth: '900512',
      dateOfExpiry: '310814',
    },
  });
}

beforeAll(async () => {
  csca = await selfSigned('Utopia Country Signing CA');
  signer = await issuedBy(csca, 'Utopia Document Signer 01');

  // A trust store on disk, the way a deployment supplies one.
  const dir = mkdtempSync(join(tmpdir(), 'csca-'));
  writeFileSync(join(dir, 'utopia.pem'), csca.pem);
  process.env.CSCA_DIR = dir;

  const tenant = await provisionTenant({
    slug: SLUG,
    name: 'NFC Test',
    homeCountry: 'GBR',
    industry: 'FINTECH',
  });
  tenantId = tenant.id;

  app = await buildServer();
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.tenant.deleteMany({ where: { slug: SLUG } });
});

describe('submitting a chip read', () => {
  it('records a passing check for a genuine chip', async () => {
    const { applicant, token } = await newApplicant();
    const sod = await buildSod(signer, DATA_GROUPS);

    const response = await submit(token, applicant.id, {
      SOD: sod.toString('base64'),
      DG1: DATA_GROUPS.DG1.toString('base64'),
      DG2: DATA_GROUPS.DG2.toString('base64'),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().passiveAuthPassed).toBe(true);
    // Never asserted as true: passive authentication cannot detect a clone.
    expect(response.json().activeAuthPassed).toBeNull();

    const check = await prisma.check.findFirstOrThrow({
      where: { applicantId: applicant.id, type: 'NFC_CHIP' },
    });
    expect(check.result).toBe('PASS');
    expect(check.rejectLabels).toEqual([]);
  }, 120_000);

  it('records a failing check when the chip data has been altered', async () => {
    const { applicant, token } = await newApplicant();
    const sod = await buildSod(signer, DATA_GROUPS);

    const response = await submit(token, applicant.id, {
      SOD: sod.toString('base64'),
      DG1: Buffer.from('P<UTOSPECIMEN<<BOB<<<<<<<<<<<<<<<<<<<<<<<<<<').toString('base64'),
      DG2: DATA_GROUPS.DG2.toString('base64'),
    });

    expect(response.statusCode).toBe(200);
    expect(response.json().passiveAuthPassed).toBe(false);

    const check = await prisma.check.findFirstOrThrow({
      where: { applicantId: applicant.id, type: 'NFC_CHIP' },
    });
    expect(check.result).toBe('FAIL');
    expect(check.rejectLabels).toContain('CHIP_AUTHENTICATION_FAILED');
  }, 120_000);

  it('refuses a submission with no security object', async () => {
    const { applicant, token } = await newApplicant();

    const response = await submit(token, applicant.id, {
      DG1: DATA_GROUPS.DG1.toString('base64'),
    });

    // Rejected by the schema: a bag of data groups with nothing to verify them
    // against is not a chip read, it is whatever the phone chose to send.
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    const checks = await prisma.check.count({
      where: { applicantId: applicant.id, type: 'NFC_CHIP' },
    });
    expect(checks).toBe(0);
  }, 120_000);

  it('is not accepted for someone else\'s applicant', async () => {
    const { applicant } = await newApplicant();
    const { token: otherToken } = await newApplicant();
    const sod = await buildSod(signer, DATA_GROUPS);

    const response = await submit(otherToken, applicant.id, {
      SOD: sod.toString('base64'),
      DG1: DATA_GROUPS.DG1.toString('base64'),
    });

    expect(response.statusCode).toBe(404);
  }, 120_000);
});

describe('when no trust store is configured', () => {
  it('refuses to answer rather than returning a simulated verdict', async () => {
    // The simulated chip reader returns passiveAuthPassed for anything, and
    // this endpoint's whole claim is that its answer cannot be fabricated. It
    // shipped that way for one deploy: production, with no CSCA_DIR, reported a
    // payload of nonsense as verified by the issuing state.
    // A separate tenant, because the adapter set is built once per tenant and
    // cached — which is right in a deployment, where the environment is fixed
    // at boot, and means a test cannot change its mind by editing process.env.
    const previous = process.env.CSCA_DIR;
    process.env.CSCA_DIR = '';

    const bare = await provisionTenant({
      slug: `${SLUG}-unconfigured`,
      name: 'NFC Test Without Trust Anchors',
      homeCountry: 'GBR',
      industry: 'FINTECH',
    });
    try {
      const level = await prisma.verificationLevel.findFirstOrThrow({
        where: { tenantId: bare.id },
      });
      const applicant = await prisma.applicant.create({
        data: {
          tenantId: bare.id,
          externalUserId: 'nfc-unconfigured',
          levelId: level.id,
          reviewStatus: 'NOT_STARTED',
          status: 'INIT',
        },
      });
      const token = signToken(
        {
          sub: applicant.id,
          kind: 'applicant',
          tenantId: bare.id,
          externalUserId: applicant.externalUserId,
        },
        3600,
      );
      const sod = await buildSod(signer, DATA_GROUPS);

      const response = await app.inject({
        method: 'POST',
        url: `/v1/applicants/${applicant.id}/nfc`,
        headers: { authorization: `Bearer ${token}` },
        payload: {
          dataGroups: { SOD: sod.toString('base64'), DG1: DATA_GROUPS.DG1.toString('base64') },
          documentNumber: 'UT7431852',
          dateOfBirth: '900512',
          dateOfExpiry: '310814',
        },
      });

      expect(response.statusCode).toBe(501);
      expect(response.json().error).toBe('CHIP_VERIFICATION_NOT_CONFIGURED');
      expect(response.json()).not.toHaveProperty('passiveAuthPassed');
    } finally {
      await prisma.tenant.deleteMany({ where: { slug: `${SLUG}-unconfigured` } });
      process.env.CSCA_DIR = previous;
    }
  }, 120_000);
});
