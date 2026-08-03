import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { appendAuditEntry, prisma, verifyAuditChain } from '../src/index.js';

/**
 * The audit chain is only worth having if it can actually detect tampering, and
 * it could not: the writer hashed a timestamp taken in Node while the column
 * defaulted to the database's `now()`, so honest entries failed their own
 * verification whenever the two clocks landed in different milliseconds.
 *
 * These run against a tenant of their own so a failure here cannot be confused
 * with real activity, and so the chain under test is not interleaved with it.
 */

const SLUG = 'audit-test-tenant';
let tenantId: string;

beforeAll(async () => {
  const tenant = await prisma.tenant.upsert({
    where: { slug: SLUG },
    create: { slug: SLUG, name: 'Audit Test' },
    update: {},
  });
  tenantId = tenant.id;
  await prisma.auditLog.deleteMany({ where: { tenantId } });
});

afterAll(async () => {
  await prisma.auditLog.deleteMany({ where: { tenantId } });
  await prisma.tenant.deleteMany({ where: { slug: SLUG } });
});

function entry(resourceId: string, actorType: 'SYSTEM' | 'USER' | 'API' = 'SYSTEM') {
  return { tenantId, actorType, action: 'test.event', resourceType: 'Test', resourceId };
}

describe('an honest chain', () => {
  it('verifies — the entries it wrote are the entries it hashed', async () => {
    await appendAuditEntry(entry('a'));
    await appendAuditEntry(entry('b'));
    await appendAuditEntry(entry('c'));

    const result = await verifyAuditChain(tenantId);
    expect(result.entries).toBe(3);
    expect(result.breaks).toEqual([]);
    expect(result.intact).toBe(true);
  });

  it('starts from genesis and links each entry to the one before', async () => {
    const rows = await prisma.auditLog.findMany({
      where: { tenantId },
      orderBy: { seq: 'asc' },
      select: { prevHash: true, hash: true },
    });
    expect(rows[0]!.prevHash).toBeNull();
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.prevHash).toBe(rows[i - 1]!.hash);
    }
  });
});

describe('concurrent writers', () => {
  it('do not fork the chain', async () => {
    // The original read the tail and appended in two separate statements, so two
    // writers could read the same predecessor and produce two branches that each
    // verify in isolation.
    const CONCURRENT = 30;
    await Promise.all(
      Array.from({ length: CONCURRENT }, (_, i) =>
        appendAuditEntry(entry(`race-${i}`, i % 2 === 0 ? 'SYSTEM' : 'API')),
      ),
    );

    const result = await verifyAuditChain(tenantId);
    expect(result.intact).toBe(true);

    const prevs = (
      await prisma.auditLog.findMany({
        where: { tenantId, prevHash: { not: null } },
        select: { prevHash: true },
      })
    ).map((r) => r.prevHash);
    // A fork shows up as two entries claiming the same predecessor.
    expect(new Set(prevs).size).toBe(prevs.length);
  });
});

describe('tampering', () => {
  it('is detected when an entry is edited', async () => {
    const victim = await prisma.auditLog.findFirstOrThrow({
      where: { tenantId },
      orderBy: { seq: 'asc' },
    });
    await prisma.auditLog.update({
      where: { id: victim.id },
      data: { action: 'applicant.approved' },
    });

    const result = await verifyAuditChain(tenantId);
    expect(result.intact).toBe(false);
    expect(result.breaks.some((b) => /edited/.test(b.reason))).toBe(true);

    await prisma.auditLog.update({
      where: { id: victim.id },
      data: { action: victim.action },
    });
    expect((await verifyAuditChain(tenantId)).intact).toBe(true);
  });

  it('is detected when an entry is removed from the middle', async () => {
    const rows = await prisma.auditLog.findMany({
      where: { tenantId },
      orderBy: { seq: 'asc' },
      select: { id: true },
    });
    const middle = rows[Math.floor(rows.length / 2)]!;
    const removed = await prisma.auditLog.findUniqueOrThrow({ where: { id: middle.id } });
    await prisma.auditLog.delete({ where: { id: middle.id } });

    const result = await verifyAuditChain(tenantId);
    expect(result.intact).toBe(false);
    expect(result.breaks.some((b) => /deleted or reordered/.test(b.reason))).toBe(true);

    // Put it back so later assertions in this file see an intact chain.
    const { id, ...rest } = removed;
    await prisma.auditLog.create({ data: { id, ...rest } as never });
    expect((await verifyAuditChain(tenantId)).intact).toBe(true);
  });
});

describe('actor attribution', () => {
  it('keeps actorId only for human actors', async () => {
    // actorId is a foreign key to User; a SYSTEM entry pointing at one would be
    // attributing an automated act to a person.
    await appendAuditEntry({ ...entry('sys'), actorId: 'someone' });
    const row = await prisma.auditLog.findFirstOrThrow({
      where: { tenantId, resourceId: 'sys' },
    });
    expect(row.actorType).toBe('SYSTEM');
    expect(row.actorId).toBeNull();
  });
});
