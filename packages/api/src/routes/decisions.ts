import type { FastifyPluginAsync } from 'fastify';
import {
  ResolveHitSchema,
  ScreeningRequestSchema,
  SubmitDecisionSchema,
  clientMessagesFor,
  conflict,
  isFinalRejection,
  transition,
} from '@kyc/core';
import { prisma } from '@kyc/db';
import { enqueueScreening, resolveHit } from '@kyc/worker';
import { emitEvent } from '@kyc/worker';
import { requireBackend, requireRole, tenantOf, writeAudit } from '../auth.js';

/**
 * Decision, case, and screening endpoints.
 *
 * These are the endpoints where accountability matters most, so they are the most
 * restrictive in the codebase: a decision requires a named human of at least
 * AGENT rank, a sanctions true-positive confirmation requires an MLRO, and every
 * one of them writes to the audit chain.
 */

const decisionRoutes: FastifyPluginAsync = async (app) => {
  // --- Review queue ---
  app.get<{
    Querystring: { queue?: string; assignedToMe?: string; limit?: string; status?: string };
  }>('/v1/cases', async (request) => {
    const caller = requireBackend(request);
    const limit = Math.min(Number(request.query.limit ?? 25), 100);

    const cases = await prisma.case.findMany({
      where: {
        tenantId: caller.tenantId,
        ...(request.query.status
          ? { status: request.query.status as never }
          : { status: { in: ['OPEN', 'ASSIGNED', 'IN_PROGRESS', 'ESCALATED'] } }),
        ...(request.query.queue ? { queue: { name: request.query.queue } } : {}),
        ...(request.query.assignedToMe === 'true' && caller.kind === 'user'
          ? { assigneeId: caller.userId }
          : {}),
      },
      // Oldest-highest-priority first: the SLA clock is already running on these.
      orderBy: [{ priority: 'desc' }, { createdAt: 'asc' }],
      take: limit,
      include: {
        applicant: {
          select: {
            id: true,
            externalUserId: true,
            firstName: true,
            lastName: true,
            country: true,
            riskScore: true,
            riskLevel: true,
            reviewStatus: true,
          },
        },
        queue: { select: { name: true } },
        assignee: { select: { id: true, name: true } },
        _count: { select: { notes: true, alerts: true } },
      },
    });

    return {
      cases: cases.map((c) => ({
        id: c.id,
        reference: c.reference,
        type: c.type,
        status: c.status,
        priority: c.priority,
        title: c.title,
        summary: c.summary,
        context: c.context,
        queue: c.queue?.name ?? null,
        assignee: c.assignee,
        applicant: c.applicant,
        dueAt: c.dueAt,
        breachedSla: c.dueAt ? c.dueAt < new Date() : false,
        noteCount: c._count.notes,
        alertCount: c._count.alerts,
        createdAt: c.createdAt,
      })),
    };
  });

  // --- Case detail ---
  app.get<{ Params: { id: string } }>('/v1/cases/:id', async (request) => {
    const caller = requireBackend(request);
    const record = await prisma.case.findFirstOrThrow({
      where: { id: request.params.id, tenantId: caller.tenantId },
      include: {
        notes: { orderBy: { createdAt: 'asc' }, include: { author: { select: { name: true } } } },
        alerts: { include: { alert: true } },
        applicant: {
          include: {
            checks: { orderBy: { createdAt: 'desc' } },
            documents: { include: { images: { select: { id: true, storageKey: true, side: true } } } },
            screeningRuns: { orderBy: { startedAt: 'desc' }, take: 1, include: { hits: true } },
            devices: { orderBy: { createdAt: 'desc' }, take: 1 },
            statusEvents: { orderBy: { createdAt: 'desc' }, take: 20 },
          },
        },
        tickets: { select: { id: true, reference: true, intent: true, status: true } },
      },
    });

    await writeAudit(request, {
      action: 'case.viewed',
      resourceType: 'Case',
      resourceId: record.id,
    });

    return { case: record };
  });

  // --- Assign ---
  app.post<{ Params: { id: string }; Body: { userId?: string } }>(
    '/v1/cases/:id/assign',
    async (request) => {
      const user = requireRole(request, 'AGENT');
      const assigneeId = request.body?.userId ?? user.userId;

      const record = await prisma.case.update({
        where: { id: request.params.id },
        data: {
          assigneeId,
          status: 'ASSIGNED',
          firstTouchedAt: new Date(),
        },
      });

      await writeAudit(request, {
        action: 'case.assigned',
        resourceType: 'Case',
        resourceId: record.id,
        after: { assigneeId },
      });

      return { assigned: true, assigneeId };
    },
  );

  // --- Case note ---
  app.post<{ Params: { id: string }; Body: { body: string; isInternal?: boolean } }>(
    '/v1/cases/:id/notes',
    async (request, reply) => {
      const user = requireRole(request, 'AGENT');
      const note = await prisma.caseNote.create({
        data: {
          caseId: request.params.id,
          authorId: user.userId,
          actorType: 'USER',
          body: request.body.body,
          isInternal: request.body.isInternal ?? true,
        },
      });
      return reply.status(201).send({ note });
    },
  );

  // --- The decision ---
  app.post<{ Params: { id: string } }>(
    '/v1/applicants/:id/decision',
    async (request) => {
      // A decision must be attributable to a person; service credentials are
      // rejected by requireRole.
      const user = requireRole(request, 'AGENT');
      const body = SubmitDecisionSchema.parse(request.body);

      const applicant = await prisma.applicant.findFirstOrThrow({
        where: { id: request.params.id, tenantId: user.tenantId },
        include: { level: true },
      });

      // A final rejection is a legal position; overturning it needs seniority.
      const isFinal =
        body.decision === 'REJECTED_FINAL' || isFinalRejection(body.rejectLabels);
      if (isFinal && !['COMPLIANCE_OFFICER', 'MLRO', 'ADMIN', 'OWNER'].includes(user.role)) {
        throw conflict(
          'A final rejection requires a compliance officer, MLRO, or administrator.',
        );
      }

      // Reversing an existing terminal decision is a separate, privileged act.
      if (
        (applicant.reviewStatus === 'APPROVED' || applicant.reviewStatus === 'REJECTED_FINAL') &&
        !['COMPLIANCE_OFFICER', 'MLRO', 'ADMIN', 'OWNER'].includes(user.role)
      ) {
        throw conflict(
          `Applicant already has a terminal decision (${applicant.reviewStatus}). Overturning it requires a compliance officer or administrator.`,
        );
      }

      const trigger =
        body.decision === 'APPROVED'
          ? 'REVIEWER_APPROVED'
          : body.decision === 'REJECTED_FINAL'
            ? 'REVIEWER_REJECTED_FINAL'
            : body.decision === 'ON_HOLD'
              ? 'PUT_ON_HOLD'
              : 'REVIEWER_REJECTED_RETRY';

      const next = transition(applicant.reviewStatus as never, trigger, {
        actorType: 'USER',
        actorRole: user.role,
      });

      const previous = await prisma.review.findFirst({
        where: { applicantId: applicant.id },
        orderBy: { createdAt: 'desc' },
        select: { id: true },
      });

      const [, review] = await prisma.$transaction([
        prisma.applicant.update({
          where: { id: applicant.id },
          data: {
            reviewStatus: next.to as never,
            status: next.applicantStatus as never,
            reviewedAt: new Date(),
            ...(applicant.level.reverifyAfterDays > 0 && body.decision === 'APPROVED'
              ? {
                  nextReviewAt: new Date(
                    Date.now() + applicant.level.reverifyAfterDays * 86_400_000,
                  ),
                }
              : {}),
          },
        }),
        prisma.review.create({
          data: {
            applicantId: applicant.id,
            decision: body.decision as never,
            source: 'MANUAL',
            reviewerId: user.userId,
            rejectLabels: body.rejectLabels,
            // Two audiences, two fields: the applicant sees clientComment, the
            // auditor sees moderationComment. Never merged.
            clientComment:
              body.clientComment ?? clientMessagesFor(body.rejectLabels).join(' ') ?? null,
            moderationComment: body.moderationComment ?? null,
            riskScoreAtDecision: applicant.riskScore,
            supersedesId: previous?.id ?? null,
          },
        }),
        prisma.applicantStatusEvent.create({
          data: {
            applicantId: applicant.id,
            fromStatus: next.from as never,
            toStatus: next.to as never,
            reason: `Manual decision by ${user.email}`,
            actorType: 'USER',
            actorId: user.userId,
            metadata: { rejectLabels: body.rejectLabels } as never,
          },
        }),
        prisma.case.updateMany({
          where: {
            applicantId: applicant.id,
            type: 'MANUAL_REVIEW',
            status: { in: ['OPEN', 'ASSIGNED', 'IN_PROGRESS'] },
          },
          data: {
            status: 'RESOLVED',
            outcome: body.decision === 'APPROVED' ? 'APPROVED' : 'REJECTED',
            closedAt: new Date(),
          },
        }),
      ]);

      await writeAudit(request, {
        action: `applicant.${body.decision.toLowerCase()}`,
        resourceType: 'Applicant',
        resourceId: applicant.id,
        before: { reviewStatus: applicant.reviewStatus },
        after: { reviewStatus: next.to, rejectLabels: body.rejectLabels },
      });

      await emitEvent(
        user.tenantId,
        'applicant.reviewed',
        {
          applicantId: applicant.id,
          externalUserId: applicant.externalUserId,
          levelName: applicant.level.name,
          reviewStatus: next.to,
          reviewedAt: new Date().toISOString(),
          riskScore: applicant.riskScore,
          riskLevel: applicant.riskLevel,
          rejectLabels: body.rejectLabels,
          clientComment: review.clientComment ?? undefined,
          canResubmit: next.to === 'REJECTED_RETRY',
          reviewSource: 'MANUAL',
        },
        applicant.id,
      );

      return { reviewStatus: next.to, reviewId: review.id };
    },
  );

  // --- Ad-hoc screening ---
  app.post('/v1/screening/runs', async (request, reply) => {
    const caller = requireBackend(request);
    const body = ScreeningRequestSchema.parse(request.body);

    await enqueueScreening({
      tenantId: caller.tenantId,
      applicantId: body.applicantId,
      companyId: body.companyId,
      trigger: body.trigger,
      listTypes: body.listTypes,
      fuzziness: body.fuzziness,
    });

    return reply.status(202).send({ queued: true });
  });

  // --- Open AML hits ---
  app.get<{ Querystring: { status?: string; limit?: string } }>(
    '/v1/screening/hits',
    async (request) => {
      const caller = requireBackend(request);
      const hits = await prisma.amlHit.findMany({
        where: {
          status: (request.query.status as never) ?? { in: ['OPEN', 'IN_REVIEW'] },
          run: {
            OR: [
              { applicant: { tenantId: caller.tenantId } },
              { company: { tenantId: caller.tenantId } },
            ],
          },
        },
        orderBy: [{ matchScore: 'desc' }, { createdAt: 'asc' }],
        take: Math.min(Number(request.query.limit ?? 50), 200),
        include: {
          run: {
            select: {
              id: true,
              queryName: true,
              queryDob: true,
              trigger: true,
              applicant: {
                select: {
                  id: true,
                  externalUserId: true,
                  firstName: true,
                  lastName: true,
                  dob: true,
                  country: true,
                  reviewStatus: true,
                },
              },
              company: { select: { id: true, legalName: true, country: true } },
            },
          },
        },
      });
      return { hits };
    },
  );

  // --- Resolve a hit ---
  app.post<{ Params: { id: string } }>('/v1/screening/hits/:id/resolve', async (request) => {
    const body = ResolveHitSchema.parse(request.body);

    // Confirming a sanctions match is a reportable determination, so it needs the
    // MLRO. Clearing a false positive is ordinary analyst work.
    const user =
      body.resolution === 'TRUE_POSITIVE'
        ? requireRole(request, 'MLRO')
        : requireRole(request, 'AGENT');

    const result = await resolveHit({
      tenantId: user.tenantId,
      hitId: request.params.id,
      userId: user.userId,
      resolution: body.resolution,
      note: body.note,
      addToAllowlist: body.addToAllowlist,
    });

    await writeAudit(request, {
      action: `screening.hit.${body.resolution.toLowerCase()}`,
      resourceType: 'AmlHit',
      resourceId: request.params.id,
      after: { resolution: body.resolution, suppressed: result.suppressed },
    });

    return result;
  });

  // --- SAR filing (MLRO only) ---
  app.post<{ Params: { id: string }; Body: { reference: string; narrative: string } }>(
    '/v1/cases/:id/sar',
    async (request) => {
      const user = requireRole(request, 'MLRO');

      const record = await prisma.case.update({
        where: { id: request.params.id },
        data: {
          sarFiledAt: new Date(),
          sarReference: request.body.reference,
          outcome: 'SAR_FILED',
          status: 'RESOLVED',
          closedAt: new Date(),
          notes: {
            create: {
              authorId: user.userId,
              actorType: 'USER',
              body: `SAR filed (${request.body.reference}):\n${request.body.narrative}`,
              isInternal: true,
            },
          },
        },
      });

      await writeAudit(request, {
        action: 'sar.filed',
        resourceType: 'Case',
        resourceId: record.id,
        after: { sarReference: request.body.reference },
      });

      // Deliberately no webhook: a SAR filing must not be disclosed to the
      // customer, and a client-side integration is a disclosure path.
      return { filed: true, reference: request.body.reference };
    },
  );
};

export default decisionRoutes;
