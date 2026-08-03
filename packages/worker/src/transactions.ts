import {
  buildTransactionFacts,
  evaluateRules,
  isTravelRuleRequired,
  summarizeActions,
  type TransactionSnapshot,
} from '@kyc/core';
import { prisma } from '@kyc/db';
import { adaptersFor, loadRules } from './context.js';
import { emitEvent } from './webhooks.js';
import type { TransactionJob } from './queues.js';

/**
 * Transaction monitoring.
 *
 * The aggregates are computed here rather than expressed in rules, for two
 * reasons: rule authors should not have to write arithmetic in a JSON AST, and
 * the aggregate queries need to be indexed and bounded, which a generic rule
 * evaluator cannot guarantee.
 */

export async function evaluateTransaction(job: TransactionJob): Promise<{
  transactionId: string;
  action: 'APPROVED' | 'FLAGGED' | 'BLOCKED';
  alerts: number;
  firedRules: string[];
}> {
  const tx = await prisma.transaction.findFirstOrThrow({
    where: { id: job.transactionId, tenantId: job.tenantId },
    include: {
      applicant: {
        select: { id: true, reviewStatus: true, riskLevel: true, country: true, ddLevel: true },
      },
    },
  });

  const adapters = adaptersFor(job.tenantId);

  // --- Wallet screening for crypto transfers ---
  let walletCategories: string[] = [];
  let walletHops: number | null = null;
  let walletRisk: number | null = null;
  let counterpartySanctioned = false;

  if (tx.chain && tx.counterpartyWallet) {
    const screening = await adapters.chain.screenAddress(
      {
        chain: tx.chain,
        address: tx.counterpartyWallet,
        txHash: tx.txHash ?? undefined,
        direction: tx.direction as 'INBOUND' | 'OUTBOUND',
      },
      { tenantId: job.tenantId, applicantId: tx.applicantId ?? undefined },
    );

    if (screening.ok && screening.data) {
      walletCategories = screening.data.categories;
      walletHops = screening.data.exposureHops;
      walletRisk = screening.data.riskScore;
      counterpartySanctioned = screening.data.isSanctioned;

      await prisma.walletScreening.create({
        data: {
          transactionId: tx.id,
          chain: tx.chain,
          address: tx.counterpartyWallet,
          riskScore: screening.data.riskScore,
          severity: screening.data.severity as never,
          categories: screening.data.categories,
          clusterName: screening.data.clusterName,
          exposureHops: screening.data.exposureHops,
          provider: screening.provider,
          raw: (screening.raw ?? {}) as never,
        },
      });
    }
  }

  const aggregates = await computeAggregates(tx.tenantId, tx.applicantId, tx.occurredAt, tx.id);

  const snapshot: TransactionSnapshot = {
    tx: {
      id: tx.id,
      externalId: tx.externalId,
      direction: tx.direction,
      type: tx.type,
      amountBase: Number(tx.amountBase),
      currency: tx.currency,
      counterpartyName: tx.counterpartyName,
      counterpartyCountry: tx.counterpartyCountry,
      counterpartySanctioned,
      counterpartyWallet: tx.counterpartyWallet,
      chain: tx.chain,
      walletCategories,
      walletRiskScore: walletRisk,
      walletExposureHops: walletHops,
      ipCountry: tx.ipCountry,
      occurredAt: tx.occurredAt,
      paymentMethod: tx.paymentMethod,
    },
    ...(tx.applicant
      ? {
          applicant: {
            id: tx.applicant.id,
            reviewStatus: tx.applicant.reviewStatus,
            riskLevel: tx.applicant.riskLevel,
            country: tx.applicant.country,
            ddLevel: tx.applicant.ddLevel,
          },
        }
      : {}),
    aggregates,
  };

  const facts = buildTransactionFacts(snapshot);
  const rules = await loadRules(job.tenantId, ['TRANSACTION']);
  const evaluation = evaluateRules(rules, facts, { scope: 'TRANSACTION' });
  const hints = summarizeActions(evaluation.actions);

  const action: 'APPROVED' | 'FLAGGED' | 'BLOCKED' = hints.blockTransaction
    ? 'BLOCKED'
    : hints.flagTransaction
      ? 'FLAGGED'
      : 'APPROVED';

  const riskScore = Math.min(
    100,
    evaluation.riskDelta + (walletRisk ?? 0) / 2 + (counterpartySanctioned ? 100 : 0),
  );

  const alerts = await prisma.$transaction([
    prisma.transaction.update({
      where: { id: tx.id },
      data: {
        status: action === 'BLOCKED' ? 'BLOCKED' : action === 'FLAGGED' ? 'UNDER_REVIEW' : 'APPROVED',
        isFlagged: action !== 'APPROVED',
        riskScore: Math.round(riskScore),
      },
    }),
    ...hints.alerts.map((alert) =>
      prisma.alert.create({
        data: {
          transactionId: tx.id,
          severity: alert.severity as never,
          title: alert.title,
          detail: {
            ...(alert.detail as Record<string, unknown>),
            firedRules: evaluation.fired.filter((f) => !f.isShadow).map((f) => f.ruleName),
            aggregates,
          } as never,
          status: 'OPEN',
        },
      }),
    ),
  ]);

  const alertRows = alerts.slice(1) as Array<{ id: string; title: string; severity: string }>;

  // A blocked or high-severity transfer needs a case, not just an alert: someone
  // has to decide whether to release it, and that decision needs an owner.
  if (action === 'BLOCKED' || hints.alerts.some((a) => a.severity === 'CRITICAL')) {
    const queue = await prisma.queue.findFirst({
      where: { tenantId: job.tenantId, name: 'transaction-alerts' },
    });
    const count = await prisma.case.count({ where: { tenantId: job.tenantId } });
    const created = await prisma.case.create({
      data: {
        tenantId: job.tenantId,
        reference: `CASE-${1000 + count + 1}`,
        type: 'TRANSACTION_ALERT',
        applicantId: tx.applicantId,
        queueId: queue?.id,
        priority: action === 'BLOCKED' ? 'CRITICAL' : 'HIGH',
        title: `${action} transaction ${tx.externalId}`,
        summary: hints.alerts.map((a) => a.title).join('; ') || 'Transaction requires review',
        context: {
          transactionId: tx.id,
          amountBase: Number(tx.amountBase),
          currency: tx.currency,
          firedRules: evaluation.fired.filter((f) => !f.isShadow).map((f) => f.ruleName),
          walletCategories,
          aggregates,
        } as never,
        dueAt: new Date(Date.now() + 4 * 3_600_000),
      },
    });
    await prisma.$transaction(
      alertRows.map((a) =>
        prisma.caseAlert.create({ data: { caseId: created.id, alertId: a.id } }),
      ),
    );
  }

  // Travel Rule assessment for crypto transfers at or above threshold.
  if (tx.chain) {
    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: job.tenantId },
      select: { homeCountry: true },
    });
    const assessment = isTravelRuleRequired({
      jurisdiction: tenant.homeCountry,
      amountBase: Number(tx.amountBase),
      baseCurrency: tx.baseCurrency,
      isCrypto: true,
      // Absent a VASP directory match, treat the counterparty as self-hosted:
      // over-claiming a counterparty VASP would send customer PII to an
      // unverified endpoint.
      counterpartyIsVasp: false,
    });

    await prisma.travelRuleMessage.create({
      data: {
        transactionId: tx.id,
        direction: tx.direction as never,
        status: assessment.required ? 'PENDING' : 'EXEMPT',
        thresholdExempt: !assessment.required,
        rejectReason: assessment.required ? null : assessment.reason,
      },
    });
  }

  if (action !== 'APPROVED') {
    await emitEvent(
      job.tenantId,
      action === 'BLOCKED' ? 'transaction.blocked' : 'transaction.flagged',
      {
        transactionId: tx.id,
        externalId: tx.externalId,
        applicantId: tx.applicantId,
        action,
        riskScore: Math.round(riskScore),
        firedRules: evaluation.fired
          .filter((f) => !f.isShadow)
          .map((f) => ({ ruleId: f.ruleId, ruleName: f.ruleName })),
        alerts: alertRows.map((a) => ({ alertId: a.id, title: a.title, severity: a.severity })),
      },
      tx.applicantId ?? undefined,
    );
  }

  return {
    transactionId: tx.id,
    action,
    alerts: alertRows.length,
    firedRules: evaluation.fired.filter((f) => !f.isShadow).map((f) => f.ruleName),
  };
}

/**
 * Windowed aggregates for the current transaction.
 *
 * The baseline deliberately excludes the last 24 hours: comparing a spike against
 * a window that contains the spike is how velocity rules fail to fire.
 */
async function computeAggregates(
  tenantId: string,
  applicantId: string | null,
  occurredAt: Date,
  excludeId: string,
): Promise<NonNullable<TransactionSnapshot['aggregates']>> {
  if (!applicantId) return {};

  const now = occurredAt.getTime();
  const since24h = new Date(now - 86_400_000);
  const since7d = new Date(now - 7 * 86_400_000);
  const since30d = new Date(now - 30 * 86_400_000);

  const [window24h, window7d, window30d, lifetime, lastInbound, counterparties] =
    await Promise.all([
      prisma.transaction.aggregate({
        where: {
          tenantId,
          applicantId,
          id: { not: excludeId },
          occurredAt: { gte: since24h, lte: occurredAt },
        },
        _sum: { amountBase: true },
        _count: true,
      }),
      prisma.transaction.aggregate({
        where: { tenantId, applicantId, id: { not: excludeId }, occurredAt: { gte: since7d } },
        _sum: { amountBase: true },
        _count: true,
      }),
      prisma.transaction.aggregate({
        where: { tenantId, applicantId, id: { not: excludeId }, occurredAt: { gte: since30d } },
        _sum: { amountBase: true },
        _count: true,
      }),
      prisma.transaction.aggregate({
        where: { tenantId, applicantId, id: { not: excludeId } },
        _sum: { amountBase: true },
        _count: true,
      }),
      prisma.transaction.findFirst({
        where: { tenantId, applicantId, direction: 'INBOUND', occurredAt: { lte: occurredAt } },
        orderBy: { occurredAt: 'desc' },
        select: { occurredAt: true },
      }),
      prisma.transaction.findMany({
        where: { tenantId, applicantId, occurredAt: { gte: since30d } },
        select: { counterpartyAccountHash: true, counterpartyWallet: true },
        distinct: ['counterpartyAccountHash'],
      }),
    ]);

  const [inbound24h, outbound24h] = await Promise.all([
    prisma.transaction.aggregate({
      where: {
        tenantId,
        applicantId,
        direction: 'INBOUND',
        occurredAt: { gte: since24h, lte: occurredAt },
      },
      _sum: { amountBase: true },
    }),
    prisma.transaction.aggregate({
      where: {
        tenantId,
        applicantId,
        direction: 'OUTBOUND',
        occurredAt: { gte: since24h, lte: occurredAt },
      },
      _sum: { amountBase: true },
    }),
  ]);

  const sum30d = Number(window30d._sum.amountBase ?? 0);
  const sum24h = Number(window24h._sum.amountBase ?? 0);
  // Baseline over days 2-30 only, so today's activity cannot dilute the very
  // spike we are trying to detect.
  const baselineDailyAvg = Math.max(0, (sum30d - sum24h) / 29);

  return {
    count24h: window24h._count,
    sum24h,
    count7d: window7d._count,
    sum7d: Number(window7d._sum.amountBase ?? 0),
    count30d: window30d._count,
    sum30d,
    lifetimeCount: lifetime._count,
    lifetimeSum: Number(lifetime._sum.amountBase ?? 0),
    baselineDailyAvg,
    minutesSinceLastInbound: lastInbound
      ? Math.floor((now - lastInbound.occurredAt.getTime()) / 60_000)
      : null,
    inboundSum24h: Number(inbound24h._sum.amountBase ?? 0),
    outboundSum24h: Number(outbound24h._sum.amountBase ?? 0),
    distinctCounterparties30d: counterparties.length,
  };
}
