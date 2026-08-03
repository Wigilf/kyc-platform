import {
  buildEnvelope,
  isEventType,
  newId,
  nextRetryDelayMs,
  signWebhook,
  type EventType,
} from '@kyc/core';
import { prisma } from '@kyc/db';
import { enqueueWebhook, type WebhookJob } from './queues.js';

/**
 * Outbound webhooks.
 *
 * Delivery is a two-phase affair on purpose: `emitEvent` writes a
 * WebhookDelivery row inside the caller's flow and only then enqueues the HTTP
 * attempt. That ordering means an event is never lost to a Redis blip — the row
 * is the source of truth and the queue is just the driver. A sweep can re-enqueue
 * anything the queue dropped.
 */

export async function emitEvent(
  tenantId: string,
  eventType: string,
  data: unknown,
  applicantId?: string,
): Promise<number> {
  if (!isEventType(eventType)) {
    console.warn(`[webhooks] refusing to emit unknown event type: ${eventType}`);
    return 0;
  }

  const endpoints = await prisma.webhookEndpoint.findMany({
    where: {
      tenantId,
      isActive: true,
      disabledAt: null,
      // An empty eventTypes list means "everything", which is the friendliest
      // default for a new integration.
      OR: [{ eventTypes: { has: eventType } }, { eventTypes: { isEmpty: true } }],
    },
  });

  if (endpoints.length === 0) return 0;

  const deliveries = await prisma.$transaction(
    endpoints.map((endpoint) => {
      const eventId = newId('evt');
      const envelope = buildEnvelope(eventType as EventType, data, {
        eventId,
        environment: endpoint.environment as 'SANDBOX' | 'PRODUCTION',
      });
      return prisma.webhookDelivery.create({
        data: {
          endpointId: endpoint.id,
          applicantId,
          eventType,
          eventId,
          payload: envelope as never,
          status: 'PENDING',
          nextAttemptAt: new Date(),
        },
      });
    }),
  );

  await Promise.all(deliveries.map((d) => enqueueWebhook({ deliveryId: d.id })));
  return deliveries.length;
}

export async function deliverWebhook(job: WebhookJob): Promise<{
  delivered: boolean;
  status: number | null;
}> {
  const delivery = await prisma.webhookDelivery.findUniqueOrThrow({
    where: { id: job.deliveryId },
    include: { endpoint: true },
  });

  if (delivery.status === 'DELIVERED') return { delivered: true, status: delivery.responseStatus };
  if (delivery.attempt >= delivery.maxAttempts) {
    await prisma.webhookDelivery.update({
      where: { id: delivery.id },
      data: { status: 'ABANDONED' },
    });
    return { delivered: false, status: null };
  }

  const rawBody = JSON.stringify(delivery.payload);
  const signature = signWebhook(
    rawBody,
    // Per-endpoint secret: rotating one integration must not break the others.
    delivery.endpoint.secret,
  );

  const attempt = delivery.attempt + 1;
  const controller = new AbortController();
  const timeout = setTimeout(() => controller.abort(), 15_000);

  try {
    const response = await fetch(delivery.endpoint.url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'user-agent': 'kyc-platform-webhooks/1.0',
        'x-kyc-signature': signature,
        'x-kyc-event-type': delivery.eventType,
        // Echoed so the receiver can dedupe retries on their side too.
        'x-kyc-event-id': delivery.eventId,
        'x-kyc-delivery-attempt': String(attempt),
      },
      body: rawBody,
      signal: controller.signal,
    });

    const body = await response.text().catch(() => '');
    const ok = response.status >= 200 && response.status < 300;

    if (ok) {
      await prisma.$transaction([
        prisma.webhookDelivery.update({
          where: { id: delivery.id },
          data: {
            status: 'DELIVERED',
            attempt,
            responseStatus: response.status,
            responseBody: body.slice(0, 2000),
            deliveredAt: new Date(),
          },
        }),
        prisma.webhookEndpoint.update({
          where: { id: delivery.endpoint.id },
          // One success clears the breaker.
          data: { consecutiveFailures: 0 },
        }),
      ]);
      return { delivered: true, status: response.status };
    }

    await recordFailure(delivery.id, delivery.endpoint.id, attempt, delivery.maxAttempts, {
      status: response.status,
      body: body.slice(0, 2000),
      // A 4xx other than 429 means the receiver rejected the payload itself;
      // retrying an unchanged payload against a definite rejection just burns
      // attempts, so those are abandoned early.
      permanent: response.status >= 400 && response.status < 500 && response.status !== 429,
    });
    return { delivered: false, status: response.status };
  } catch (error) {
    await recordFailure(delivery.id, delivery.endpoint.id, attempt, delivery.maxAttempts, {
      status: null,
      body: error instanceof Error ? error.message : 'network error',
      permanent: false,
    });
    return { delivered: false, status: null };
  } finally {
    clearTimeout(timeout);
  }
}

async function recordFailure(
  deliveryId: string,
  endpointId: string,
  attempt: number,
  maxAttempts: number,
  detail: { status: number | null; body: string; permanent: boolean },
): Promise<void> {
  const exhausted = detail.permanent || attempt >= maxAttempts;
  const nextAttemptAt = exhausted ? null : new Date(Date.now() + nextRetryDelayMs(attempt));

  await prisma.webhookDelivery.update({
    where: { id: deliveryId },
    data: {
      status: exhausted ? (detail.permanent ? 'FAILED' : 'ABANDONED') : 'RETRYING',
      attempt,
      responseStatus: detail.status,
      responseBody: detail.body,
      errorMessage: detail.permanent ? 'permanent failure; not retrying' : 'transient failure',
      nextAttemptAt,
    },
  });

  const endpoint = await prisma.webhookEndpoint.update({
    where: { id: endpointId },
    data: { consecutiveFailures: { increment: 1 } },
  });

  // Circuit breaker. A dead endpoint should be visible in the dashboard, not
  // silently absorbing thousands of retries.
  if (endpoint.consecutiveFailures >= 20 && !endpoint.disabledAt) {
    await prisma.webhookEndpoint.update({
      where: { id: endpointId },
      data: { disabledAt: new Date(), isActive: false },
    });
    console.error(
      `[webhooks] endpoint ${endpoint.url} disabled after ${endpoint.consecutiveFailures} consecutive failures`,
    );
  }

  if (!exhausted && nextAttemptAt) {
    await enqueueWebhook({ deliveryId }, { delay: nextAttemptAt.getTime() - Date.now() });
  }
}

/** Re-enqueues deliveries the queue lost (Redis flush, worker crash). */
export async function requeueStalledDeliveries(limit = 200): Promise<number> {
  const stalled = await prisma.webhookDelivery.findMany({
    where: {
      status: { in: ['PENDING', 'RETRYING'] },
      nextAttemptAt: { lte: new Date() },
    },
    take: limit,
    select: { id: true },
  });
  await Promise.all(stalled.map((d) => enqueueWebhook({ deliveryId: d.id })));
  return stalled.length;
}
