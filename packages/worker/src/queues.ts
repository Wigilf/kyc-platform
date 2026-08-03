import { Queue, Worker, type JobsOptions, type Processor } from 'bullmq';
// ioredis ships as CJS: the class is the default export at runtime but the
// module namespace is not constructable under NodeNext, so import the named type.
import { Redis } from 'ioredis';

/**
 * Queue topology.
 *
 * Separate queues rather than one, because the failure modes are different and
 * should not share a head-of-line: a stuck webhook endpoint must never delay a
 * verification decision, and the nightly monitoring sweep must never crowd out
 * an applicant waiting on their result.
 */

export const QUEUE_NAMES = {
  verification: 'kyc.verification',
  screening: 'kyc.screening',
  monitoring: 'kyc.monitoring',
  webhooks: 'kyc.webhooks',
  transactions: 'kyc.transactions',
  reports: 'kyc.reports',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

let connection: Redis | undefined;

export function redis(): Redis {
  if (!connection) {
    connection = new Redis(process.env.REDIS_URL ?? 'redis://localhost:6380', {
      // BullMQ blocks on commands; retrying forever inside the client is what
      // lets a worker survive a Redis restart instead of dying.
      maxRetriesPerRequest: null,
      enableReadyCheck: false,
    });
  }
  return connection;
}

const queues = new Map<string, Queue>();

export function queue<T = unknown>(name: QueueName): Queue<T> {
  const existing = queues.get(name);
  if (existing) return existing as Queue<T>;
  const q = new Queue<T>(name, {
    connection: redis(),
    defaultJobOptions: {
      attempts: 5,
      backoff: { type: 'exponential', delay: 2_000 },
      // Keep a window of history for debugging without unbounded growth.
      removeOnComplete: { age: 86_400, count: 5_000 },
      removeOnFail: { age: 604_800 },
    },
  });
  queues.set(name, q);
  return q as Queue<T>;
}

export function createWorker<T = unknown>(
  name: QueueName,
  processor: Processor<T>,
  concurrency = 5,
): Worker<T> {
  const worker = new Worker<T>(name, processor, {
    connection: redis(),
    concurrency,
    // A verification run can legitimately take a while when several providers are
    // involved; a short lock would make BullMQ think the job was abandoned and
    // run it twice.
    lockDuration: 120_000,
  });

  worker.on('failed', (job, err) => {
    console.error(`[${name}] job ${job?.id} failed (attempt ${job?.attemptsMade}):`, err.message);
  });
  worker.on('error', (err) => {
    console.error(`[${name}] worker error:`, err.message);
  });

  return worker;
}

// ---------------------------------------------------------------------------
// Job payloads
// ---------------------------------------------------------------------------

export interface VerificationJob {
  tenantId: string;
  applicantId: string;
  trigger: 'SUBMITTED' | 'RESUBMITTED' | 'MANUAL_RERUN' | 'PERIODIC_REVIEW';
}

export interface ScreeningJob {
  tenantId: string;
  applicantId?: string;
  companyId?: string;
  trigger: string;
  listTypes?: string[];
  fuzziness?: number;
}

export interface WebhookJob {
  deliveryId: string;
}

export interface TransactionJob {
  tenantId: string;
  transactionId: string;
}

export interface MonitoringJob {
  tenantId?: string;
  /** Cap per sweep so one tenant cannot monopolise the worker. */
  batchSize?: number;
}

/** Enqueues a verification run, collapsing duplicates for the same applicant. */
export async function enqueueVerification(
  job: VerificationJob,
  opts: JobsOptions = {},
): Promise<void> {
  await queue<VerificationJob>(QUEUE_NAMES.verification).add('run', job, {
    // Deduplication: several documents uploaded in quick succession should
    // produce one pipeline run, not one per upload.
    jobId: `verify-${job.applicantId}-${job.trigger}`,
    delay: 1_000,
    ...opts,
  });
}

export async function enqueueScreening(job: ScreeningJob, opts: JobsOptions = {}): Promise<void> {
  await queue<ScreeningJob>(QUEUE_NAMES.screening).add('screen', job, opts);
}

export async function enqueueWebhook(job: WebhookJob, opts: JobsOptions = {}): Promise<void> {
  await queue<WebhookJob>(QUEUE_NAMES.webhooks).add('deliver', job, {
    jobId: `webhook-${job.deliveryId}`,
    ...opts,
  });
}

export async function enqueueTransaction(
  job: TransactionJob,
  opts: JobsOptions = {},
): Promise<void> {
  await queue<TransactionJob>(QUEUE_NAMES.transactions).add('evaluate', job, {
    jobId: `tx-${job.transactionId}`,
    ...opts,
  });
}

/** Registers the recurring monitoring sweep. Idempotent. */
export async function scheduleMonitoring(): Promise<void> {
  await queue<MonitoringJob>(QUEUE_NAMES.monitoring).add(
    'sweep',
    { batchSize: 200 },
    {
      repeat: { pattern: '*/15 * * * *' },
      jobId: 'monitoring-sweep',
    },
  );
  await queue<MonitoringJob>(QUEUE_NAMES.monitoring).add(
    'periodic-review',
    {},
    {
      repeat: { pattern: '0 2 * * *' },
      jobId: 'periodic-review-sweep',
    },
  );
}

export async function closeQueues(): Promise<void> {
  await Promise.all([...queues.values()].map((q) => q.close()));
  queues.clear();
  await connection?.quit();
  connection = undefined;
}
