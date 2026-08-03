import { prisma } from '@kyc/db';
import { normalizeCountry, toDateOnly } from '@kyc/core';
import { adaptersFor } from './context.js';
import { emitEvent } from './webhooks.js';

/**
 * AML screening.
 *
 * The subtle requirement is suppression. A monitoring subscription re-screens
 * daily; without suppression, an analyst who cleared "not the same Ivan Petrov"
 * on Monday sees the identical hit on Tuesday, and every day after. So a
 * false-positive disposition is recorded as an allowlist entry keyed to that
 * applicant plus that list entry, and later runs pass it to the adapter as
 * suppressed.
 *
 * The equally subtle failure is silence. If the corpus cannot be read, the run
 * must end FAILED — never COMPLETED with zero hits, which is indistinguishable
 * from "we checked and they are clean".
 */

export async function runScreening(args: {
  tenantId: string;
  applicantId?: string;
  companyId?: string;
  trigger: string;
  listTypes: string[];
  fuzziness: number;
}): Promise<{ runId: string; hitCount: number; openHitCount: number; status: string }> {
  const adapters = adaptersFor(args.tenantId);

  let name: string | undefined;
  let dob: string | undefined;
  let country: string | undefined;
  let entityType: 'INDIVIDUAL' | 'COMPANY' = 'INDIVIDUAL';

  if (args.applicantId) {
    const applicant = await prisma.applicant.findFirstOrThrow({
      where: { id: args.applicantId, tenantId: args.tenantId },
      select: { firstName: true, lastName: true, dob: true, country: true, nationality: true },
    });
    name = [applicant.firstName, applicant.lastName].filter(Boolean).join(' ');
    dob = toDateOnly(applicant.dob) ?? undefined;
    country = normalizeCountry(applicant.country ?? applicant.nationality) ?? undefined;
  } else if (args.companyId) {
    const company = await prisma.company.findFirstOrThrow({
      where: { id: args.companyId, tenantId: args.tenantId },
      select: { legalName: true, country: true },
    });
    name = company.legalName;
    country = normalizeCountry(company.country) ?? undefined;
    entityType = 'COMPANY';
  }

  if (!name || name.trim().length < 2) {
    throw new Error('Screening requires a name of at least two characters.');
  }

  const run = await prisma.amlScreeningRun.create({
    data: {
      applicantId: args.applicantId,
      companyId: args.companyId,
      trigger: args.trigger as never,
      queryName: name,
      queryDob: dob ? new Date(dob) : null,
      queryCountry: country,
      listTypes: args.listTypes as never[],
      fuzziness: args.fuzziness,
      status: 'RUNNING',
    },
  });

  // Entries this applicant has already had cleared as false positives.
  const suppressed = args.applicantId
    ? await prisma.watchlistEntry.findMany({
        where: {
          tenantId: args.tenantId,
          listType: 'INTERNAL_ALLOWLIST',
          raw: { path: ['applicantId'], equals: args.applicantId },
        },
        select: { sourceRef: true },
      })
    : [];

  const result = await adapters.screening.search(
    {
      name,
      entityType,
      dob,
      country,
      listTypes: args.listTypes,
      fuzziness: args.fuzziness,
      suppressedEntryIds: suppressed
        .map((s) => s.sourceRef)
        .filter((r): r is string => Boolean(r)),
    },
    { tenantId: args.tenantId, applicantId: args.applicantId },
  );

  if (!result.ok || !result.data) {
    // Explicitly FAILED. A screening we could not perform must never read as a
    // clean result downstream.
    await prisma.amlScreeningRun.update({
      where: { id: run.id },
      data: {
        status: 'FAILED',
        completedAt: new Date(),
        raw: { error: result.error } as never,
      },
    });
    if (args.applicantId) {
      await prisma.check.create({
        data: {
          applicantId: args.applicantId,
          type: 'AML_SCREENING',
          status: 'FAILED',
          errorCode: result.error?.code ?? 'SCREENING_FAILED',
          errorMessage: result.error?.message,
          provider: result.provider,
        },
      });
    }
    throw new Error(`Screening failed: ${result.error?.message ?? 'unknown error'}`);
  }

  const hits = result.data.hits;

  // What has this applicant's analyst already seen, and what did they decide?
  //
  // Every run records its own hit rows — that is the audit trail — but a hit the
  // analyst has already dispositioned must not come back as OPEN. Re-opening it
  // means a false positive cleared once reappears in the queue after every
  // re-screen, and the queue fills with the same handful of people forever.
  // A disposition is not permanent, though. Two things end it:
  //
  //  1. **The listing changed.** A cleared match is a judgement about a specific
  //     listed entity as it stood. If the issuing body later adds an alias, a new
  //     programme, or a date of birth, the analyst cleared something that no
  //     longer exists and the match has to be looked at again.
  //  2. **It got old.** Ongoing monitoring re-screens indefinitely, so without an
  //     expiry a decision made once is never revisited for the life of the
  //     relationship.
  const priorByEntry = new Map<
    string,
    {
      status: string;
      resolution: string | null;
      note: string | null;
      resolvedAt: Date | null;
    }
  >();
  if (args.applicantId) {
    const prior = await prisma.amlHit.findMany({
      where: { run: { applicantId: args.applicantId, id: { not: run.id } } },
      select: {
        entryId: true,
        status: true,
        resolution: true,
        note: true,
        resolvedAt: true,
        createdAt: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    for (const p of prior) {
      // Newest first, so the first sighting of an entry is its current disposition.
      if (p.entryId && !priorByEntry.has(p.entryId)) {
        priorByEntry.set(p.entryId, {
          status: p.status,
          resolution: p.resolution,
          note: p.note,
          resolvedAt: p.resolvedAt ?? p.createdAt,
        });
      }
    }
  }

  // When each matched listing was last amended.
  const entryUpdatedAt = new Map<string, Date>(
    (
      await prisma.watchlistEntry.findMany({
        where: { id: { in: [...new Set(hits.map((h) => h.entryId))] } },
        select: { id: true, updatedAt: true },
      })
    ).map((e) => [e.id, e.updatedAt]),
  );

  const maxAgeDays = Number(process.env.SCREENING_DISPOSITION_MAX_AGE_DAYS ?? 365);
  const staleBefore = new Date(Date.now() - maxAgeDays * 86_400_000);

  /** Why a prior decision no longer holds, or null if it still does. */
  function expiryReason(
    prior: { status: string; resolvedAt: Date | null },
    entryId: string,
  ): string | null {
    if (prior.status === 'OPEN' || prior.status === 'IN_REVIEW') return null;
    const resolvedAt = prior.resolvedAt;
    if (!resolvedAt) return 'DISPOSITION_UNDATED';
    const changed = entryUpdatedAt.get(entryId);
    if (changed && changed > resolvedAt) return 'LISTING_AMENDED';
    if (resolvedAt < staleBefore) return 'DISPOSITION_EXPIRED';
    return null;
  }

  const created = await prisma.$transaction(
    hits.map((hit) => {
      const prior = priorByEntry.get(hit.entryId);
      // A prior disposition carries forward unless it has expired. Anything
      // unseen, undecided, or reopened lands in the queue as OPEN.
      const reopenBecause = prior ? expiryReason(prior, hit.entryId) : null;
      const settled =
        prior && prior.status !== 'OPEN' && prior.status !== 'IN_REVIEW' && !reopenBecause;
      return prisma.amlHit.create({
        data: {
          runId: run.id,
          entryId: hit.entryId,
          listType: hit.listType as never,
          listName: hit.listName,
          matchedName: hit.matchedName,
          matchScore: hit.matchScore,
          matchedFields: hit.matchedFields,
          status: (settled ? prior.status : 'OPEN') as never,
          resolution: (settled ? prior.resolution : null) as never,
          // The analyst's own words, unaltered. Prefixing them each time would
          // compound "carried forward from…" on every subsequent re-screen; that
          // the disposition was inherited is recorded in the snapshot instead.
          note: settled ? prior.note : null,
          snapshot: {
            ...hit.snapshot,
            pepTier: hit.pepTier,
            categories: hit.categories,
            positions: hit.positions,
            isNew: !prior,
            carriedForward: Boolean(settled),
            // The analyst needs to know they are re-reviewing something rather
            // than seeing it for the first time, and why it came back.
            ...(reopenBecause
              ? {
                  reopenedBecause: reopenBecause,
                  previousResolution: prior?.resolution ?? null,
                  previousNote: prior?.note ?? null,
                  previouslyResolvedAt: prior?.resolvedAt?.toISOString() ?? null,
                }
              : {}),
          } as never,
        },
      });
    }),
  );

  const newHits = created.filter(
    (h) => (h.snapshot as { isNew?: boolean })?.isNew !== false,
  );

  await prisma.amlScreeningRun.update({
    where: { id: run.id },
    data: {
      status: 'COMPLETED',
      hitCount: hits.length,
      // Hits carried forward already dispositioned are not open work.
      openHitCount: created.filter((h) => h.status === 'OPEN' || h.status === 'IN_REVIEW').length,
      provider: result.provider,
      completedAt: new Date(),
      raw: {
        searchedEntries: result.data.searchedEntries,
        listsSearched: result.data.listsSearched,
      } as never,
    },
  });

  if (args.applicantId) {
    await prisma.check.create({
      data: {
        applicantId: args.applicantId,
        type: 'AML_SCREENING',
        status: 'COMPLETED',
        result: hits.length === 0 ? 'PASS' : 'WARNING',
        score: hits.length === 0 ? 100 : 0,
        riskContribution: hits.length === 0 ? 0 : Math.min(60, 25 + hits.length * 10),
        provider: result.provider,
        findings: result.data.findings as never,
        raw: {
          runId: run.id,
          searchedEntries: result.data.searchedEntries,
          listsSearched: result.data.listsSearched,
        } as never,
      },
    });
  }

  if (hits.length > 0) {
    await emitEvent(
      args.tenantId,
      'screening.hitFound',
      {
        applicantId: args.applicantId,
        runId: run.id,
        trigger: args.trigger,
        hits: created.map((h) => ({
          hitId: h.id,
          listType: h.listType,
          listName: h.listName,
          matchedName: h.matchedName,
          matchScore: h.matchScore,
          matchedFields: h.matchedFields,
        })),
      },
      args.applicantId,
    );
  }

  // A watchlist update that matches an *already approved* customer is the event
  // that most needs to be loud: it means someone we onboarded is now listed.
  if (
    newHits.length > 0 &&
    (args.trigger === 'ONGOING_MONITORING' || args.trigger === 'LIST_UPDATE') &&
    args.applicantId
  ) {
    await handleMonitoringHit(args.tenantId, args.applicantId, run.id, newHits.length);
  }

  return {
    runId: run.id,
    hitCount: hits.length,
    openHitCount: hits.length,
    status: 'COMPLETED',
  };
}

async function handleMonitoringHit(
  tenantId: string,
  applicantId: string,
  runId: string,
  newHitCount: number,
): Promise<void> {
  const applicant = await prisma.applicant.findFirstOrThrow({
    where: { id: applicantId },
    select: { reviewStatus: true, externalUserId: true },
  });

  if (applicant.reviewStatus === 'APPROVED') {
    // Freeze rather than silently leave approved. Whether the relationship ends
    // is a human decision; whether it pauses is not.
    await prisma.$transaction([
      prisma.applicant.update({
        where: { id: applicantId },
        data: { reviewStatus: 'ON_HOLD', status: 'ON_HOLD' },
      }),
      prisma.applicantStatusEvent.create({
        data: {
          applicantId,
          fromStatus: 'APPROVED',
          toStatus: 'ON_HOLD',
          reason: `Ongoing monitoring matched ${newHitCount} new watchlist entry/entries`,
          actorType: 'SCHEDULER',
          metadata: { runId } as never,
        },
      }),
    ]);
  }

  const queue = await prisma.queue.findFirst({ where: { tenantId, name: 'aml-hits' } });
  const count = await prisma.case.count({ where: { tenantId } });

  await prisma.case.create({
    data: {
      tenantId,
      reference: `CASE-${1000 + count + 1}`,
      type: 'AML_HIT_REVIEW',
      applicantId,
      queueId: queue?.id,
      priority: 'CRITICAL',
      title: 'Existing customer matched a watchlist update',
      summary: `${newHitCount} new hit(s) from ongoing monitoring. Account frozen pending review.`,
      context: { runId, newHitCount, source: 'ongoing-monitoring' } as never,
      dueAt: new Date(Date.now() + 4 * 3_600_000),
    },
  });

  await emitEvent(
    tenantId,
    'monitoring.listUpdateMatch',
    { applicantId, externalUserId: applicant.externalUserId, runId, newHitCount },
    applicantId,
  );
}

/**
 * Records an analyst's disposition of a hit.
 *
 * A false positive optionally becomes a suppression entry, which is what stops
 * the same hit resurfacing on every subsequent monitoring cycle. A true positive
 * is a compliance event, not a support one — it drives a final rejection.
 */
export async function resolveHit(args: {
  tenantId: string;
  hitId: string;
  userId: string;
  resolution: 'TRUE_POSITIVE' | 'FALSE_POSITIVE' | 'UNABLE_TO_DETERMINE';
  note: string;
  addToAllowlist: boolean;
}): Promise<{ resolved: true; suppressed: boolean }> {
  const hit = await prisma.amlHit.findFirstOrThrow({
    where: { id: args.hitId, run: { OR: [{ applicant: { tenantId: args.tenantId } }, { company: { tenantId: args.tenantId } }] } },
    include: { run: { select: { applicantId: true } } },
  });

  await prisma.$transaction([
    prisma.amlHit.update({
      where: { id: hit.id },
      data: {
        status: 'RESOLVED',
        resolution: args.resolution as never,
        resolvedBy: args.userId,
        resolvedAt: new Date(),
        note: args.note,
      },
    }),
    prisma.amlScreeningRun.update({
      where: { id: hit.runId },
      data: { openHitCount: { decrement: 1 } },
    }),
  ]);

  let suppressed = false;
  if (args.resolution === 'FALSE_POSITIVE' && args.addToAllowlist && hit.run.applicantId) {
    await prisma.watchlistEntry.create({
      data: {
        tenantId: args.tenantId,
        listType: 'INTERNAL_ALLOWLIST',
        listName: 'false-positive-suppressions',
        sourceRef: hit.entryId,
        fullName: hit.matchedName,
        raw: {
          applicantId: hit.run.applicantId,
          suppressedHitId: hit.id,
          decidedBy: args.userId,
          note: args.note,
          decidedAt: new Date().toISOString(),
        } as never,
      },
    });
    suppressed = true;
  }

  await emitEvent(
    args.tenantId,
    'screening.hitResolved',
    {
      hitId: hit.id,
      applicantId: hit.run.applicantId,
      resolution: args.resolution,
      suppressedFromFutureRuns: suppressed,
    },
    hit.run.applicantId ?? undefined,
  );

  return { resolved: true, suppressed };
}
