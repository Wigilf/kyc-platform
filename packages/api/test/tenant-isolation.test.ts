import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { prisma, provisionTenant } from '@kyc/db';
import { signToken } from '../src/auth.js';
import { buildServer } from '../src/server.js';

/**
 * One tenant must not be able to touch another's records.
 *
 * Three case routes wrote by id alone — assign, add a note, and file a
 * suspicious activity report — so any agent anywhere could act on any case
 * anywhere. The SAR one stamps a regulatory record onto somebody else's case
 * and closes it, which is not a mistake that can be quietly undone.
 *
 * These tests exist because "the handler looks up the record with the caller's
 * tenant" is a convention, and a convention is only as good as the next
 * handler somebody adds.
 */

const SLUG_A = 'kyc-isolation-a';
const SLUG_B = 'kyc-isolation-b';

let app: Awaited<ReturnType<typeof buildServer>>;
let caseInA: string;
let intruderFromB: string;
let mlroFromB: string;
let ownerInA: string;

async function reviewer(tenantId: string, email: string, role: string) {
  const user = await prisma.user.create({
    data: { tenantId, email, name: email, role: role as never, passwordHash: 'unused' },
  });
  return signToken(
    { sub: user.id, kind: 'user', tenantId, role: user.role, email: user.email },
    3600,
  );
}

beforeAll(async () => {
  const a = await provisionTenant({ slug: SLUG_A, name: 'A', homeCountry: 'GBR', industry: 'FINTECH' });
  const b = await provisionTenant({ slug: SLUG_B, name: 'B', homeCountry: 'GBR', industry: 'FINTECH' });

  const level = await prisma.verificationLevel.findFirstOrThrow({ where: { tenantId: a.id } });
  const applicant = await prisma.applicant.create({
    data: {
      tenantId: a.id,
      externalUserId: 'isolation-subject',
      levelId: level.id,
      reviewStatus: 'QUEUED',
      status: 'QUEUED',
    },
  });
  const queue = await prisma.queue.findFirstOrThrow({ where: { tenantId: a.id } });
  const record = await prisma.case.create({
    data: {
      tenantId: a.id,
      applicantId: applicant.id,
      queueId: queue.id,
      reference: 'CASE-ISOLATION-1',
      title: 'Isolation test case',
      type: 'MANUAL_REVIEW',
      status: 'OPEN',
      priority: 'MEDIUM',
    },
  });
  caseInA = record.id;

  ownerInA = await reviewer(a.id, 'owner@isolation-a.test', 'MLRO');
  intruderFromB = await reviewer(b.id, 'agent@isolation-b.test', 'AGENT');
  mlroFromB = await reviewer(b.id, 'mlro@isolation-b.test', 'MLRO');

  app = await buildServer();
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.tenant.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
});

const post = (url: string, token: string, payload?: unknown) =>
  app.inject({ method: 'POST', url, headers: { authorization: `Bearer ${token}` }, payload: payload ?? {} });

describe('a case belonging to another tenant', () => {
  it('cannot be assigned', async () => {
    const response = await post(`/v1/cases/${caseInA}/assign`, intruderFromB);

    expect(response.statusCode).toBe(404);
    const record = await prisma.case.findUniqueOrThrow({ where: { id: caseInA } });
    expect(record.assigneeId).toBeNull();
  }, 60_000);

  it('cannot be annotated', async () => {
    const response = await post(`/v1/cases/${caseInA}/notes`, intruderFromB, {
      body: 'I should not be able to write this',
    });

    expect(response.statusCode).toBe(404);
    expect(await prisma.caseNote.count({ where: { caseId: caseInA } })).toBe(0);
  }, 60_000);

  it('cannot have a suspicious activity report filed against it', async () => {
    const response = await post(`/v1/cases/${caseInA}/sar`, mlroFromB, {
      reference: 'SAR-INTRUDER-1',
      narrative: 'Filed by someone else entirely',
    });

    expect(response.statusCode).toBe(404);
    const record = await prisma.case.findUniqueOrThrow({ where: { id: caseInA } });
    expect(record.sarFiledAt).toBeNull();
    expect(record.status).toBe('OPEN');
  }, 60_000);
});

describe('the tenant that owns it', () => {
  it('can still do all three', async () => {
    expect((await post(`/v1/cases/${caseInA}/assign`, ownerInA)).statusCode).toBeLessThan(300);
    expect(
      (await post(`/v1/cases/${caseInA}/notes`, ownerInA, { body: 'Looked at it' })).statusCode,
    ).toBeLessThan(300);
    expect(
      (await post(`/v1/cases/${caseInA}/sar`, ownerInA, { reference: 'SAR-1', narrative: 'x' }))
        .statusCode,
    ).toBeLessThan(300);
  }, 60_000);

  it('cannot assign a case to somebody from another tenant', async () => {
    const stranger = await prisma.user.findFirstOrThrow({
      where: { email: 'agent@isolation-b.test' },
    });

    const response = await post(`/v1/cases/${caseInA}/assign`, ownerInA, { userId: stranger.id });

    // Otherwise the case lands in a queue its owner cannot see, and a
    // stranger's name goes into the audit log.
    expect(response.statusCode).toBe(404);
  }, 60_000);
});
