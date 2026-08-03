import 'dotenv/config';
import { prisma } from '@kyc/db';
import { runVerificationPipeline } from './pipeline.js';
import { runScreening } from './screening.js';
import { deliverWebhook, requeueStalledDeliveries } from './webhooks.js';
import { evaluateTransaction } from './transactions.js';
import {
  QUEUE_NAMES,
  closeQueues,
  createWorker,
  enqueueScreening,
  enqueueVerification,
  scheduleMonitoring,
  type MonitoringJob,
  type ScreeningJob,
  type TransactionJob,
  type VerificationJob,
  type WebhookJob,
} from './queues.js';

/**
 * Worker entrypoint.
 *
 * Concurrency per queue is set by what the work actually costs. Verification runs
 * hold provider connections and database transactions, so they are the tightest;
 * webhook delivery is mostly waiting on someone else's server, so it is the
 * loosest.
 */

/**
 * Starts the queue consumers.
 *
 * Exported so a single process can host the API and the workers together.
 * Render's free tier has no background-worker service type, and for small
 * volumes one process is a legitimate topology anyway — the tradeoff is that
 * the two can no longer be scaled apart, and a slow job competes with request
 * handling for the event loop.
 */
export async function startWorkers() {
  console.log('[worker] starting');

  const workers = [
    createWorker<VerificationJob>(
      QUEUE_NAMES.verification,
      async (job) => runVerificationPipeline(job.data),
      4,
    ),

    createWorker<ScreeningJob>(
      QUEUE_NAMES.screening,
      async (job) =>
        runScreening({
          tenantId: job.data.tenantId,
          applicantId: job.data.applicantId,
          companyId: job.data.companyId,
          trigger: job.data.trigger,
          listTypes: job.data.listTypes ?? ['SANCTIONS', 'PEP'],
          fuzziness: job.data.fuzziness ?? 0.75,
        }),
      6,
    ),

    createWorker<WebhookJob>(
      QUEUE_NAMES.webhooks,
      async (job) => deliverWebhook(job.data),
      20,
    ),

    createWorker<TransactionJob>(
      QUEUE_NAMES.transactions,
      async (job) => evaluateTransaction(job.data),
      8,
    ),

    createWorker<MonitoringJob>(
      QUEUE_NAMES.monitoring,
      async (job) =>
        job.name === 'periodic-review'
          ? runPeriodicReviewSweep()
          : runMonitoringSweep(job.data.batchSize ?? 200),
      2,
    ),
  ];

  await scheduleMonitoring();

  const shutdown = async (signal: string) => {
    console.log(`[worker] ${signal} received, draining`);
    // Close workers first so in-flight jobs finish rather than being re-run.
    await Promise.all(workers.map((w) => w.close()));
    await closeQueues();
    await prisma.$disconnect();
    process.exit(0);
  };

  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  console.log(`[worker] ready: ${workers.length} queues`);
}

/**
 * Ongoing monitoring sweep: re-screens customers whose next screen is due.
 *
 * Batched and ordered by due time so a large tenant cannot starve a small one,
 * and so a backlog drains oldest-first rather than at random.
 */
export async function runMonitoringSweep(batchSize: number): Promise<{
  screened: number;
  requeuedWebhooks: number;
}> {
  const due = await prisma.monitoringSubscription.findMany({
    where: {
      isActive: true,
      OR: [{ nextScreenAt: null }, { nextScreenAt: { lte: new Date() } }],
    },
    orderBy: { nextScreenAt: 'asc' },
    take: batchSize,
    include: {
      applicant: { select: { id: true, tenantId: true, reviewStatus: true } },
    },
  });

  let screened = 0;
  for (const subscription of due) {
    // A finally-rejected applicant has no ongoing relationship to monitor.
    if (subscription.applicant.reviewStatus === 'REJECTED_FINAL') {
      await prisma.monitoringSubscription.update({
        where: { id: subscription.id },
        data: { isActive: false },
      });
      continue;
    }

    await enqueueScreening({
      tenantId: subscription.applicant.tenantId,
      applicantId: subscription.applicant.id,
      trigger: 'ONGOING_MONITORING',
      listTypes: subscription.listTypes,
    });

    await prisma.monitoringSubscription.update({
      where: { id: subscription.id },
      data: {
        lastScreenedAt: new Date(),
        nextScreenAt: new Date(Date.now() + intervalFor(subscription.frequency)),
      },
    });
    screened++;
  }

  // Same sweep also recovers webhook deliveries the queue lost.
  const requeuedWebhooks = await requeueStalledDeliveries();

  if (screened || requeuedWebhooks) {
    console.log(
      `[monitoring] queued ${screened} re-screen(s), requeued ${requeuedWebhooks} webhook(s)`,
    );
  }
  return { screened, requeuedWebhooks };
}

/** Periodic review: approved customers whose re-verification date has passed. */
export async function runPeriodicReviewSweep(): Promise<{ queued: number }> {
  const due = await prisma.applicant.findMany({
    where: {
      reviewStatus: 'APPROVED',
      nextReviewAt: { lte: new Date() },
      redactedAt: null,
    },
    take: 100,
    select: { id: true, tenantId: true },
  });

  for (const applicant of due) {
    await enqueueVerification({
      tenantId: applicant.tenantId,
      applicantId: applicant.id,
      trigger: 'PERIODIC_REVIEW',
    });
    // Push the next date forward immediately so a slow run does not cause the
    // same applicant to be queued again on the next sweep.
    await prisma.applicant.update({
      where: { id: applicant.id },
      data: { nextReviewAt: new Date(Date.now() + 30 * 86_400_000) },
    });
  }

  if (due.length) console.log(`[periodic-review] queued ${due.length} re-verification(s)`);
  return { queued: due.length };
}

function intervalFor(frequency: string): number {
  switch (frequency) {
    case 'WEEKLY':
      return 7 * 86_400_000;
    case 'MONTHLY':
      return 30 * 86_400_000;
    case 'QUARTERLY':
      return 90 * 86_400_000;
    default:
      return 86_400_000;
  }
}

export { runVerificationPipeline } from './pipeline.js';
export { runScreening, resolveHit } from './screening.js';
export { evaluateTransaction } from './transactions.js';
export { emitEvent, deliverWebhook } from './webhooks.js';
export * from './queues.js';
export * from './context.js';

// Only boot the workers when run as a process, so the same module can be
// imported by the API and the tests without starting queue consumers.
const isEntrypoint =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('worker/src/index.ts') ||
    process.argv[1].endsWith('worker/dist/index.js'));

if (isEntrypoint) {
  startWorkers().catch((error) => {
    console.error('[worker] fatal', error);
    process.exit(1);
  });
}

export { ingestAllSources, ingestSource, type IngestReport } from './watchlist/ingest.js';
export { WATCHLIST_SOURCES } from './watchlist/sources.js';
