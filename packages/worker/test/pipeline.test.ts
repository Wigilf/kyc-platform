import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '@kyc/db';
import { runVerificationPipeline } from '../src/pipeline.js';
import { cleanupTestData, createApplicant } from './helpers.js';

/**
 * Pipeline regressions.
 *
 * Fixture slugs are load-bearing. The mock adapters seed on the applicant id and
 * deliberately give a minority of otherwise-clean applicants a weak signal, so
 * the identities used by tests that assert a clean outcome are ones the mocks
 * treat as clean — the same reason the seed file has a specific demo-clean-001.
 * Renaming a slug changes the person and may change the verdict.
 *
 * Every case here corresponds to a bug that shipped: the pipeline read an
 * applicant's whole check history instead of their current state, so a failure
 * they had corrected kept rejecting them, a required step with no automated
 * check made auto-approval unreachable, and re-running inflated its own
 * reported work. These run against the real database because that is where the
 * bugs were — in how records are read back, not in a pure function.
 */

afterAll(cleanupTestData);

async function run(applicantId: string, tenantId: string) {
  return runVerificationPipeline({ tenantId, applicantId, trigger: 'SUBMITTED' });
}

describe('a clean applicant', () => {
  it('is approved automatically', async () => {
    const { applicant, tenant } = await createApplicant('clean');
    const result = await run(applicant.id, tenant.id);

    expect(result.reviewStatus).toBe('APPROVED');
    expect(result.decided).toBe(true);
    expect(result.riskScore).toBeLessThan(30);
  });

  it('reports the checks this run executed, not the lifetime total', async () => {
    const { applicant, tenant } = await createApplicant('count-a');

    const first = await run(applicant.id, tenant.id);
    const second = await run(applicant.id, tenant.id);

    // Previously this returned applicant.checks.length, so it grew every run.
    expect(second.checksRun).toBe(first.checksRun);

    const stored = await prisma.check.count({ where: { applicantId: applicant.id } });
    expect(stored).toBeGreaterThan(first.checksRun);
  });

  it('reaches the same decision when re-run', async () => {
    const { applicant, tenant } = await createApplicant('idempotent');

    const first = await run(applicant.id, tenant.id);
    const second = await run(applicant.id, tenant.id);

    expect(second.reviewStatus).toBe(first.reviewStatus);
    expect(second.riskScore).toBe(first.riskScore);
  });
});

describe('scenario applicants fail on their own check', () => {
  it('rejects a forged document as final', async () => {
    const { applicant, tenant } = await createApplicant('forged', { firstName: 'Forged' });
    const result = await run(applicant.id, tenant.id);

    expect(result.reviewStatus).toBe('REJECTED_FINAL');

    const failed = await prisma.check.findMany({
      where: { applicantId: applicant.id, result: 'FAIL' },
      select: { type: true, rejectLabels: true },
    });
    expect(failed.flatMap((c) => c.rejectLabels)).toContain('FORGED_DOCUMENT');
  });

  it('does not fail a clean applicant on identity or address', async () => {
    // The mocks used to invent a name, a date of birth, and a proof-of-address
    // issue date, so NAME_MISMATCH, DOB_MISMATCH and PROOF_OF_ADDRESS_TOO_OLD
    // fired for everyone.
    const { applicant, tenant } = await createApplicant('nomismatch');
    await run(applicant.id, tenant.id);

    const labels = (
      await prisma.check.findMany({
        where: { applicantId: applicant.id },
        select: { rejectLabels: true },
      })
    ).flatMap((c) => c.rejectLabels);

    expect(labels).not.toContain('NAME_MISMATCH');
    expect(labels).not.toContain('DOB_MISMATCH');
    expect(labels).not.toContain('PROOF_OF_ADDRESS_TOO_OLD');
  });
});

describe('current state, not history', () => {
  it('lets an applicant recover from a failure they have since fixed', async () => {
    const { applicant, tenant } = await createApplicant('resub-c');

    // The shape a real resubmission leaves behind: the rejected document is
    // superseded, its failing check stays on the record, and a fresh document
    // takes its place.
    const passport = await prisma.document.findFirstOrThrow({
      where: { applicantId: applicant.id, type: 'PASSPORT' },
    });
    await prisma.check.create({
      data: {
        applicantId: applicant.id,
        documentId: passport.id,
        type: 'DOCUMENT_OCR',
        status: 'COMPLETED',
        result: 'FAIL',
        rejectLabels: ['BLURRY_IMAGE'],
        riskContribution: 35,
        provider: 'mock-ocr',
      },
    });
    await prisma.document.update({
      where: { id: passport.id },
      data: { status: 'SUPERSEDED' },
    });

    // The replacement.
    const { documentStorageKey } = await import('@kyc/adapters');
    const { adaptersFor } = await import('../src/context.js');
    const replacement = await prisma.document.create({
      data: {
        applicantId: applicant.id,
        type: 'PASSPORT',
        subType: 'FRONT_SIDE',
        status: 'UPLOADED',
      },
    });
    const stored = await adaptersFor(tenant.id).storage.put(
      documentStorageKey({
        tenantId: tenant.id,
        applicantId: applicant.id,
        documentId: replacement.id,
        side: 'FRONT_SIDE',
        extension: 'png',
      }),
      Buffer.from(
        'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
        'base64',
      ),
      'image/png',
    );
    await prisma.documentImage.create({
      data: {
        documentId: replacement.id,
        storageKey: stored.key,
        contentType: 'image/png',
        bytes: stored.bytes,
        sha256: stored.sha256,
        side: 'FRONT_SIDE',
        capturedBy: 'WEB_SDK_CAMERA',
      },
    });

    const result = await run(applicant.id, tenant.id);

    // The superseded document's failure must not follow them. Before the fix it
    // did, and auto-approval after any resubmission was unreachable.
    expect(result.reviewStatus).toBe('APPROVED');
  });

  it('still fails when the most recent check is the failing one', async () => {
    const { applicant, tenant } = await createApplicant('stillfails');
    await run(applicant.id, tenant.id);

    // A newer failure must win over the older pass.
    await prisma.check.create({
      data: {
        applicantId: applicant.id,
        type: 'DOCUMENT_OCR',
        status: 'COMPLETED',
        result: 'FAIL',
        rejectLabels: ['BLURRY_IMAGE'],
        riskContribution: 35,
        provider: 'mock-ocr',
        createdAt: new Date(Date.now() + 60_000),
      },
    });

    const { finalize } = await import('../src/pipeline.js');
    const result = await finalize(applicant.id, tenant.id, {});
    expect(result.reviewStatus).not.toBe('APPROVED');
  });
});

describe('the applicant-data step', () => {
  it('passes when the level required fields are present', async () => {
    const { applicant, tenant } = await createApplicant('hasdata');
    await run(applicant.id, tenant.id);

    const check = await prisma.check.findFirst({
      where: { applicantId: applicant.id, type: 'APPLICANT_DATA' },
      orderBy: { createdAt: 'desc' },
    });
    // It used to record MANUAL/SKIPPED, which could never satisfy a required
    // step, so allRequiredPassed was false for every applicant alive.
    expect(check?.status).toBe('COMPLETED');
    expect(check?.result).toBe('PASS');
  });

  it('fails, rather than silently passing, when a required field is missing', async () => {
    const { applicant, tenant } = await createApplicant('nodata');
    await prisma.applicant.update({
      where: { id: applicant.id },
      data: { piiCiphertext: null },
    });

    await run(applicant.id, tenant.id);

    const check = await prisma.check.findFirst({
      where: { applicantId: applicant.id, type: 'APPLICANT_DATA' },
      orderBy: { createdAt: 'desc' },
    });
    expect(check?.result).toBe('FAIL');
  });
});

describe('device sessions', () => {
  it('does not accumulate a row per run, or look like a device farm', async () => {
    const { applicant, tenant } = await createApplicant('device');
    await run(applicant.id, tenant.id);
    await run(applicant.id, tenant.id);
    await run(applicant.id, tenant.id);

    const sessions = await prisma.deviceSession.count({
      where: { applicantId: applicant.id },
    });
    expect(sessions).toBe(1);
  });

  it('gives separate applicants separate fingerprints', async () => {
    const a = await createApplicant('fingerprint-a');
    const b = await createApplicant('fingerprint-b');
    await run(a.applicant.id, a.tenant.id);
    await run(b.applicant.id, b.tenant.id);

    const rows = await prisma.deviceSession.findMany({
      where: { applicantId: { in: [a.applicant.id, b.applicant.id] } },
      select: { fingerprint: true },
    });
    expect(new Set(rows.map((r) => r.fingerprint)).size).toBe(2);
  });
});

describe('audit trail', () => {
  it('records an automated decision against the SYSTEM actor', async () => {
    const { applicant, tenant } = await createApplicant('audit-b');
    const result = await run(applicant.id, tenant.id);
    expect(result.decided).toBe(true);

    const entry = await prisma.auditLog.findFirst({
      where: { tenantId: tenant.id, resourceId: applicant.id },
      orderBy: { seq: 'desc' },
    });

    expect(entry).not.toBeNull();
    expect(entry?.actorType).toBe('SYSTEM');
    expect(entry?.action).toBe('applicant.approved');
    expect(entry?.hash).toBeTruthy();
  });

  it('writes nothing for an applicant left for a human', async () => {
    // Screening matches against the real watchlist by name and date of birth,
    // not on a scenario keyword, so this has to be someone actually listed. A
    // PEP match goes to enhanced diligence and a human rather than to a rule.
    const { applicant, tenant } = await createApplicant('queued', {
      firstName: 'Helena',
      lastName: 'Voss',
      dob: '1971-06-30',
      country: 'DEU',
    });
    const result = await run(applicant.id, tenant.id);
    expect(result.decided).toBe(false);
    expect(result.reviewStatus).toBe('QUEUED');

    const entries = await prisma.auditLog.count({
      where: { tenantId: tenant.id, resourceId: applicant.id },
    });
    // Queuing is not a decision; there is nothing to attribute.
    expect(entries).toBe(0);
  });
});
