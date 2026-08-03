import { auditHash } from '@kyc/core';
import { prisma } from './index.js';

/**
 * The audit log.
 *
 * Every entry is chained to the one before it — `hash = sha256(prevHash |
 * canonical(entry))` — so deleting, reordering, or editing a row breaks the
 * chain at that point and `/v1/audit/verify` can say where.
 *
 * That property is easy to state and easy to lose. Three things it depends on:
 *
 *  1. **The hashed timestamp must be the stored timestamp.** Hashing a
 *     `new Date()` taken in application code while the column defaults to the
 *     database's `now()` produces two different instants, and the entry then
 *     fails its own verification. `createdAt` is therefore set explicitly here,
 *     to the exact value that goes into the hash.
 *  2. **Reading the tail and appending must be atomic.** A concurrent writer
 *     that reads the same predecessor forks the chain into two branches that
 *     both look valid in isolation. Serialised per tenant with an advisory lock
 *     held for the length of the transaction.
 *  3. **Order must be total.** `createdAt` has millisecond resolution and
 *     collides under load, so the chain is ordered by `seq`.
 *
 * This lives in @kyc/db rather than the API because the verification pipeline
 * decides applicants without an HTTP request in sight, and an automated
 * approval is exactly as auditable an act as a human one.
 */

export type AuditActorType = 'SYSTEM' | 'USER' | 'APPLICANT' | 'AI_AGENT' | 'API' | 'SCHEDULER';

export interface AuditEntryInput {
  tenantId: string | null;
  actorType: AuditActorType;
  /** Only set for USER actors; a foreign key to User. */
  actorId?: string | null;
  action: string;
  resourceType: string;
  resourceId?: string | null;
  before?: unknown;
  after?: unknown;
  ipAddress?: string | null;
  userAgent?: string | null;
  requestId?: string | null;
}

/** The fields the hash covers. Kept in one place so writer and verifier agree. */
export function auditPayload(entry: {
  action: string;
  resourceType: string;
  resourceId: string | null;
  actorId: string | null;
  createdAt: Date;
}): Record<string, unknown> {
  return {
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId,
    actorId: entry.actorId,
    at: entry.createdAt.toISOString(),
  };
}

/** Stable 64-bit lock key. Postgres advisory locks are per-database integers. */
function lockKeyFor(tenantId: string | null): string {
  return `audit:${tenantId ?? 'global'}`;
}

export async function appendAuditEntry(input: AuditEntryInput): Promise<void> {
  const createdAt = new Date();
  const actorId = input.actorType === 'USER' ? (input.actorId ?? null) : null;
  const resourceId = input.resourceId ?? null;

  await prisma.$transaction(async (tx) => {
    // Held until the transaction commits or rolls back, so the read of the tail
    // and the append that follows it cannot interleave with another writer.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKeyFor(input.tenantId)})::bigint)`;

    const previous = await tx.auditLog.findFirst({
      where: { tenantId: input.tenantId },
      orderBy: { seq: 'desc' },
      select: { hash: true },
    });

    const payload = auditPayload({
      action: input.action,
      resourceType: input.resourceType,
      resourceId,
      actorId,
      createdAt,
    });

    await tx.auditLog.create({
      data: {
        tenantId: input.tenantId,
        actorType: input.actorType as never,
        actorId,
        action: input.action,
        resourceType: input.resourceType,
        resourceId,
        before: (input.before ?? null) as never,
        after: (input.after ?? null) as never,
        ipAddress: input.ipAddress ?? null,
        userAgent: input.userAgent ?? null,
        requestId: input.requestId ?? null,
        createdAt,
        prevHash: previous?.hash ?? null,
        hash: auditHash(previous?.hash ?? null, payload),
      },
    });
  });
}

export interface AuditChainBreak {
  id: string;
  seq: string;
  reason: string;
}

/** Walks a tenant's chain in order and reports where it stops being intact. */
export async function verifyAuditChain(tenantId: string): Promise<{
  entries: number;
  intact: boolean;
  breaks: AuditChainBreak[];
}> {
  const entries = await prisma.auditLog.findMany({
    where: { tenantId },
    orderBy: { seq: 'asc' },
    select: {
      id: true,
      seq: true,
      prevHash: true,
      hash: true,
      action: true,
      resourceType: true,
      resourceId: true,
      actorId: true,
      createdAt: true,
    },
  });

  const breaks: AuditChainBreak[] = [];
  let previousHash: string | null = null;

  for (const entry of entries) {
    if (entry.prevHash !== previousHash) {
      breaks.push({
        id: entry.id,
        seq: String(entry.seq),
        reason: 'prevHash does not match the preceding entry (an entry was deleted or reordered)',
      });
    }
    const expected = auditHash(entry.prevHash, auditPayload(entry));
    if (expected !== entry.hash) {
      breaks.push({
        id: entry.id,
        seq: String(entry.seq),
        reason: 'hash does not match its content (entry was edited)',
      });
    }
    previousHash = entry.hash;
  }

  return { entries: entries.length, intact: breaks.length === 0, breaks };
}
