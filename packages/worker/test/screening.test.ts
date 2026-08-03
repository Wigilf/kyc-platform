import { afterAll, describe, expect, it } from 'vitest';
import { prisma } from '@kyc/db';
import { runScreening } from '../src/screening.js';
import { cleanupTestData, createApplicant } from './helpers.js';

/**
 * Screening dispositions.
 *
 * Two failure modes pull in opposite directions and both are real. Re-opening
 * every match on every re-screen fills the queue with people an analyst already
 * cleared. Never re-opening means a clearance is permanent, and since monitoring
 * re-screens for the life of the relationship, a match cleared once would never
 * be looked at again — not even after the issuing body amends the listing.
 */

afterAll(cleanupTestData);

/** Someone who actually appears on the seeded PEP list. */
async function listedApplicant(slug: string) {
  return createApplicant(slug, {
    firstName: 'Helena',
    lastName: 'Voss',
    dob: '1971-06-30',
    country: 'DEU',
  });
}

async function screen(tenantId: string, applicantId: string) {
  const run = await runScreening({ tenantId, applicantId, trigger: 'ONGOING_MONITORING' });
  return prisma.amlHit.findMany({
    where: { runId: run.runId },
    select: { status: true, resolution: true, note: true, snapshot: true, entryId: true },
  });
}

async function disposition(applicantId: string, resolvedAt: Date) {
  const open = await prisma.amlHit.findMany({
    where: { run: { applicantId }, status: { in: ['OPEN', 'IN_REVIEW'] } },
    select: { id: true },
  });
  await prisma.amlHit.updateMany({
    where: { id: { in: open.map((h) => h.id) } },
    data: {
      status: 'RESOLVED',
      resolution: 'FALSE_POSITIVE',
      note: 'Date of birth differs.',
      resolvedAt,
    },
  });
  return open.length;
}

/** Backdates the listing itself. `updatedAt` is Prisma-managed, hence raw SQL. */
async function settleListing(entryId: string, daysAgo: number) {
  await prisma.$executeRawUnsafe(
    `UPDATE "WatchlistEntry" SET "updatedAt" = now() - interval '${daysAgo} days' WHERE id = $1`,
    entryId,
  );
}

describe('a match nobody has ruled on', () => {
  it('is open', async () => {
    const { applicant, tenant } = await listedApplicant('screen-fresh');
    const hits = await screen(tenant.id, applicant.id);

    expect(hits.length).toBeGreaterThan(0);
    expect(hits.every((h) => h.status === 'OPEN')).toBe(true);
    expect((hits[0]!.snapshot as { isNew?: boolean }).isNew).toBe(true);
  });
});

describe('a disposition still in date', () => {
  it('carries forward instead of refilling the queue', async () => {
    const { applicant, tenant } = await listedApplicant('screen-carry');
    const first = await screen(tenant.id, applicant.id);
    await settleListing(first[0]!.entryId!, 500);
    expect(await disposition(applicant.id, new Date())).toBeGreaterThan(0);

    const hits = await screen(tenant.id, applicant.id);
    expect(hits.every((h) => h.status === 'RESOLVED')).toBe(true);
    expect(hits[0]!.resolution).toBe('FALSE_POSITIVE');
    expect((hits[0]!.snapshot as { carriedForward?: boolean }).carriedForward).toBe(true);
  });

  it('keeps the analyst’s own note rather than re-annotating it', async () => {
    const { applicant, tenant } = await listedApplicant('screen-note');
    const first = await screen(tenant.id, applicant.id);
    await settleListing(first[0]!.entryId!, 500);
    await disposition(applicant.id, new Date());

    await screen(tenant.id, applicant.id);
    const hits = await screen(tenant.id, applicant.id);
    // Prefixing on each carry-forward compounded across re-screens.
    expect(hits[0]!.note).toBe('Date of birth differs.');
  });
});

describe('a disposition that no longer holds', () => {
  it('reopens when the listing is amended afterwards', async () => {
    const { applicant, tenant } = await listedApplicant('screen-amended');
    const first = await screen(tenant.id, applicant.id);
    const entryId = first[0]!.entryId!;
    await settleListing(entryId, 500);
    await disposition(applicant.id, new Date(Date.now() - 60_000));

    // The issuing body adds something after the analyst cleared it.
    await prisma.watchlistEntry.update({
      where: { id: entryId },
      data: { remarks: 'Amended during test' },
    });

    const hits = await screen(tenant.id, applicant.id);
    expect(hits[0]!.status).toBe('OPEN');
    expect((hits[0]!.snapshot as { reopenedBecause?: string }).reopenedBecause).toBe(
      'LISTING_AMENDED',
    );
    // The analyst can see what was decided last time and why it is back.
    expect((hits[0]!.snapshot as { previousResolution?: string }).previousResolution).toBe(
      'FALSE_POSITIVE',
    );
  });

  it('reopens when it ages past the review cycle', async () => {
    const { applicant, tenant } = await listedApplicant('screen-expired');
    const first = await screen(tenant.id, applicant.id);
    await settleListing(first[0]!.entryId!, 900);
    // Older than the 365-day default, with the listing itself older still, so
    // age is the only thing wrong with the decision.
    await disposition(applicant.id, new Date(Date.now() - 400 * 86_400_000));

    const hits = await screen(tenant.id, applicant.id);
    expect(hits[0]!.status).toBe('OPEN');
    expect((hits[0]!.snapshot as { reopenedBecause?: string }).reopenedBecause).toBe(
      'DISPOSITION_EXPIRED',
    );
  });
});

describe('the run summary', () => {
  it('counts only genuinely open work', async () => {
    const { applicant, tenant } = await listedApplicant('screen-count');
    const first = await screen(tenant.id, applicant.id);
    await settleListing(first[0]!.entryId!, 500);
    await disposition(applicant.id, new Date());

    const run = await runScreening({
      tenantId: tenant.id,
      applicantId: applicant.id,
      trigger: 'ONGOING_MONITORING',
    });
    const stored = await prisma.amlScreeningRun.findUniqueOrThrow({
      where: { id: run.runId },
      select: { hitCount: true, openHitCount: true },
    });
    expect(stored.hitCount).toBeGreaterThan(0);
    expect(stored.openHitCount).toBe(0);
  });
});
