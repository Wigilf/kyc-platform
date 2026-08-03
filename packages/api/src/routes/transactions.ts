import type { FastifyPluginAsync } from 'fastify';
import {
  IngestTransactionSchema,
  ReportRequestSchema,
  invalid,
  sha256,
  toIvms101,
  validateInboundPayload,
} from '@kyc/core';
import { prisma, verifyAuditChain } from '@kyc/db';
import { enqueueTransaction } from '@kyc/worker';
import { requireBackend, requireRole, writeAudit } from '../auth.js';

/**
 * Transaction monitoring, travel rule, reporting, and audit access.
 */

const transactionRoutes: FastifyPluginAsync = async (app) => {
  // --- Ingest ---
  app.post('/v1/transactions', async (request, reply) => {
    const caller = requireBackend(request);
    const body = IngestTransactionSchema.parse(request.body);

    let applicantId: string | null = null;
    if (body.applicantExternalUserId) {
      const applicant = await prisma.applicant.findUnique({
        where: {
          tenantId_externalUserId: {
            tenantId: caller.tenantId,
            externalUserId: body.applicantExternalUserId,
          },
        },
        select: { id: true },
      });
      applicantId = applicant?.id ?? null;
    }

    // Idempotent on the client's own id: payment systems retry, and a duplicate
    // transaction would corrupt every velocity aggregate downstream.
    const existing = await prisma.transaction.findUnique({
      where: { tenantId_externalId: { tenantId: caller.tenantId, externalId: body.externalId } },
    });
    if (existing) {
      return reply.status(200).send({
        transaction: { id: existing.id, status: existing.status, isFlagged: existing.isFlagged },
        created: false,
      });
    }

    const tx = await prisma.transaction.create({
      data: {
        tenantId: caller.tenantId,
        applicantId,
        externalId: body.externalId,
        direction: body.direction as never,
        type: body.type as never,
        amount: body.amount,
        currency: body.currency.toUpperCase(),
        // Without an FX rate we cannot honestly convert, so the caller's own base
        // amount is used when supplied and the raw amount otherwise.
        amountBase: body.amountBase ?? body.amount,
        baseCurrency: body.amountBase ? 'EUR' : body.currency.toUpperCase(),
        counterpartyName: body.counterpartyName,
        counterpartyCountry: body.counterpartyCountry,
        // Account identifiers are hashed: we need to correlate counterparties
        // across transactions without retaining their bank details.
        counterpartyAccountHash: body.counterpartyAccount
          ? sha256(body.counterpartyAccount.toUpperCase().replace(/\s/g, ''))
          : null,
        counterpartyWallet: body.counterpartyWallet,
        chain: body.chain,
        txHash: body.txHash,
        paymentMethod: body.paymentMethod,
        deviceId: body.deviceId,
        ipAddress: body.ipAddress,
        occurredAt: new Date(body.occurredAt),
        metadata: body.metadata as never,
      },
    });

    await enqueueTransaction({ tenantId: caller.tenantId, transactionId: tx.id });

    return reply.status(202).send({
      transaction: { id: tx.id, status: tx.status },
      created: true,
      // Rules run asynchronously; the caller polls or waits for the webhook.
      note: 'Queued for rule evaluation. Subscribe to transaction.flagged / transaction.blocked.',
    });
  });

  app.get<{ Params: { id: string } }>('/v1/transactions/:id', async (request) => {
    const caller = requireBackend(request);
    const tx = await prisma.transaction.findFirstOrThrow({
      where: { id: request.params.id, tenantId: caller.tenantId },
      include: {
        alerts: true,
        screenings: true,
        travelRule: true,
        applicant: { select: { id: true, externalUserId: true, reviewStatus: true } },
      },
    });
    return { transaction: tx };
  });

  app.get<{ Querystring: { flagged?: string; applicantId?: string; limit?: string } }>(
    '/v1/transactions',
    async (request) => {
      const caller = requireBackend(request);
      const transactions = await prisma.transaction.findMany({
        where: {
          tenantId: caller.tenantId,
          ...(request.query.flagged === 'true' ? { isFlagged: true } : {}),
          ...(request.query.applicantId ? { applicantId: request.query.applicantId } : {}),
        },
        orderBy: { occurredAt: 'desc' },
        take: Math.min(Number(request.query.limit ?? 50), 200),
        include: {
          alerts: { select: { id: true, title: true, severity: true, status: true } },
          applicant: { select: { externalUserId: true } },
        },
      });
      return { transactions };
    },
  );

  // --- Alerts ---
  app.get<{ Querystring: { status?: string } }>('/v1/alerts', async (request) => {
    const caller = requireBackend(request);
    const alerts = await prisma.alert.findMany({
      where: {
        transaction: { tenantId: caller.tenantId },
        status: (request.query.status as never) ?? { in: ['OPEN', 'IN_CASE'] },
      },
      orderBy: [{ severity: 'desc' }, { createdAt: 'asc' }],
      take: 100,
      include: {
        transaction: {
          select: {
            id: true,
            externalId: true,
            amountBase: true,
            currency: true,
            direction: true,
            occurredAt: true,
            applicant: { select: { id: true, externalUserId: true } },
          },
        },
        rule: { select: { name: true } },
      },
    });
    return { alerts };
  });

  app.post<{ Params: { id: string }; Body: { status: string; note?: string } }>(
    '/v1/alerts/:id/status',
    async (request) => {
      const user = requireRole(request, 'AGENT');
      const alert = await prisma.alert.update({
        where: { id: request.params.id },
        data: { status: request.body.status as never },
      });
      await writeAudit(request, {
        action: 'alert.status.changed',
        resourceType: 'Alert',
        resourceId: alert.id,
        after: { status: request.body.status, note: request.body.note },
      });
      return { alert };
    },
  );

  // --- Release a blocked transaction (privileged) ---
  app.post<{ Params: { id: string }; Body: { justification: string } }>(
    '/v1/transactions/:id/release',
    async (request) => {
      const user = requireRole(request, 'COMPLIANCE_OFFICER');
      if (!request.body?.justification || request.body.justification.length < 20) {
        throw invalid('Releasing a blocked transaction requires a written justification.');
      }

      const tx = await prisma.transaction.findFirstOrThrow({
        where: { id: request.params.id, tenantId: user.tenantId },
      });
      if (tx.status !== 'BLOCKED' && tx.status !== 'UNDER_REVIEW') {
        throw invalid(`Transaction is ${tx.status}, not blocked.`);
      }

      await prisma.$transaction([
        prisma.transaction.update({
          where: { id: tx.id },
          data: { status: 'APPROVED', isFlagged: false },
        }),
        prisma.alert.updateMany({
          where: { transactionId: tx.id, status: { in: ['OPEN', 'IN_CASE'] } },
          data: { status: 'DISMISSED' },
        }),
      ]);

      // The justification is the record. Releasing a blocked transfer is exactly
      // the decision an examiner will want to read the reasoning for.
      await writeAudit(request, {
        action: 'transaction.released',
        resourceType: 'Transaction',
        resourceId: tx.id,
        before: { status: tx.status },
        after: { status: 'APPROVED', justification: request.body.justification },
      });

      return { released: true };
    },
  );

  // --- Travel Rule ---
  app.post<{ Params: { id: string } }>(
    '/v1/travel-rule/:id/originator',
    async (request) => {
      const caller = requireBackend(request);
      const body = request.body as {
        originator: Parameters<typeof toIvms101>[0]['originator'];
        beneficiary: Parameters<typeof toIvms101>[0]['beneficiary'];
        assetType: string;
        amount: string;
        network?: string;
      };

      const message = await prisma.travelRuleMessage.findFirstOrThrow({
        where: { id: request.params.id, transaction: { tenantId: caller.tenantId } },
      });

      const payload = toIvms101({
        originator: body.originator,
        beneficiary: body.beneficiary,
        assetType: body.assetType,
        amount: body.amount,
        network: body.network,
      });

      const piiKey = process.env.PII_ENCRYPTION_KEY;
      const { encryptJson } = await import('@kyc/core');

      await prisma.travelRuleMessage.update({
        where: { id: message.id },
        data: {
          // Counterparty PII we are only permitted to hold for the transfer, so it
          // is encrypted at rest rather than stored as plain JSON.
          originatorPayload: piiKey ? encryptJson(payload.originator, piiKey) : null,
          beneficiaryPayload: piiKey ? encryptJson(payload.beneficiary, piiKey) : null,
          status: 'SENT',
          sentAt: new Date(),
        },
      });

      return { status: 'SENT', ivms101: payload };
    },
  );

  app.post('/v1/travel-rule/inbound', async (request) => {
    const caller = requireBackend(request);
    const body = request.body as { transactionExternalId: string; payload: unknown };

    // Sufficiency check: a name with no address or identifier is not enough to
    // screen a counterparty, and recording that is itself an obligation.
    const validation = validateInboundPayload(body.payload);

    const tx = await prisma.transaction.findUnique({
      where: {
        tenantId_externalId: {
          tenantId: caller.tenantId,
          externalId: body.transactionExternalId,
        },
      },
    });

    if (tx) {
      await prisma.travelRuleMessage.create({
        data: {
          transactionId: tx.id,
          direction: 'INBOUND',
          status: validation.valid && validation.sufficient ? 'ACCEPTED' : 'REJECTED',
          rejectReason: validation.sufficient
            ? null
            : `Insufficient originator data: missing ${validation.missing.join(', ')}`,
          respondedAt: new Date(),
        },
      });
    }

    return {
      accepted: validation.valid && validation.sufficient,
      valid: validation.valid,
      sufficient: validation.sufficient,
      missing: validation.missing,
      errors: validation.errors,
    };
  });

  // --- Reports ---
  app.post('/v1/reports', async (request, reply) => {
    const user = requireRole(request, 'AGENT');
    const body = ReportRequestSchema.parse(request.body);

    const report = await prisma.report.create({
      data: {
        tenantId: user.tenantId,
        type: body.type as never,
        format: body.format,
        parameters: {
          from: body.from,
          to: body.to,
          ...body.parameters,
        } as never,
        requestedBy: user.userId,
        status: 'QUEUED',
      },
    });

    await writeAudit(request, {
      action: 'report.requested',
      resourceType: 'Report',
      resourceId: report.id,
      after: { type: report.type },
    });

    return reply.status(202).send({ report: { id: report.id, status: report.status } });
  });

  /** Live conversion funnel. Answers "where are we losing applicants?". */
  app.get<{ Querystring: { days?: string } }>('/v1/reports/funnel', async (request) => {
    const caller = requireBackend(request);
    const days = Math.min(Number(request.query.days ?? 30), 365);
    const since = new Date(Date.now() - days * 86_400_000);

    const byStatus = await prisma.applicant.groupBy({
      by: ['reviewStatus'],
      where: { tenantId: caller.tenantId, createdAt: { gte: since } },
      _count: true,
    });

    const total = byStatus.reduce((sum, s) => sum + s._count, 0);
    const counts = Object.fromEntries(byStatus.map((s) => [s.reviewStatus, s._count]));

    // Reject reasons, ranked. This is the single most actionable report a
    // conversion-focused team gets: the top label is usually a UX problem, not a
    // fraud problem.
    const rejections = await prisma.review.findMany({
      where: {
        applicant: { tenantId: caller.tenantId },
        createdAt: { gte: since },
        decision: { in: ['REJECTED_RETRY', 'REJECTED_FINAL'] },
      },
      select: { rejectLabels: true, source: true },
    });

    const labelCounts = new Map<string, number>();
    for (const review of rejections) {
      for (const label of review.rejectLabels) {
        labelCounts.set(label, (labelCounts.get(label) ?? 0) + 1);
      }
    }

    const approved = counts.APPROVED ?? 0;
    const decided = approved + (counts.REJECTED_RETRY ?? 0) + (counts.REJECTED_FINAL ?? 0);

    return {
      windowDays: days,
      total,
      byStatus: counts,
      // Two different questions: of everyone who started, and of everyone who
      // reached a decision.
      completionRate: total > 0 ? Math.round((decided / total) * 100) : 0,
      approvalRateOfDecided: decided > 0 ? Math.round((approved / decided) * 100) : 0,
      abandonedInFlow: (counts.NOT_STARTED ?? 0) + (counts.PENDING ?? 0),
      automationRate:
        rejections.length > 0
          ? Math.round(
              (rejections.filter((r) => r.source === 'AUTOMATED').length / rejections.length) * 100,
            )
          : 0,
      topRejectReasons: [...labelCounts.entries()]
        .sort(([, a], [, b]) => b - a)
        .slice(0, 12)
        .map(([label, count]) => ({ label, count })),
    };
  });

  // --- Audit log ---
  app.get<{ Querystring: { resourceId?: string; action?: string; limit?: string } }>(
    '/v1/audit',
    async (request) => {
      // Auditors can read this and nothing else; that is the point of the role.
      const user = requireRole(request, 'AUDITOR');
      const entries = await prisma.auditLog.findMany({
        where: {
          tenantId: user.tenantId,
          ...(request.query.resourceId ? { resourceId: request.query.resourceId } : {}),
          ...(request.query.action ? { action: request.query.action } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: Math.min(Number(request.query.limit ?? 100), 500),
        include: { actor: { select: { name: true, email: true, role: true } } },
      });
      return { entries };
    },
  );

  /**
   * Verifies the audit hash chain.
   *
   * The chain is only worth having if someone checks it, so checking it is an
   * endpoint rather than a manual exercise.
   */
  app.get('/v1/audit/verify', async (request) => {
    const user = requireRole(request, 'AUDITOR');
    // Recomputation lives beside the writer in @kyc/db: a verifier that derives
    // the hash differently from the writer reports honest entries as tampered,
    // which is exactly what happened when the two drifted apart.
    return verifyAuditChain(user.tenantId);
  });
};

export default transactionRoutes;
