import { documentStorageKey } from '@kyc/adapters';
import { prisma, provisionTenant } from '@kyc/db';
import { adaptersFor } from '../src/context.js';

/**
 * Test fixtures.
 *
 * The suite runs against a tenant of its own, provisioned from the same
 * templates the seed uses, and drops it afterwards.
 *
 * Two reasons. Mutating the demo tenant makes the demo lie — a run that leaves
 * demo-clean-001 rejected is worse than no demo. And the audit log cannot be
 * cleaned up selectively: deleting an entry from the middle of a hash chain
 * breaks it by design, which is the whole point. A tenant of our own gets its
 * own chain, and `AuditLog.tenantId` cascades, so dropping the tenant takes the
 * chain with it and leaves the demo's intact.
 */

const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);

export const TEST_TENANT_SLUG = 'kyc-test-suite';

/**
 * The suite's tenant, created on first use.
 *
 * Provisioning is ~60 upserts, so it is done once per process and memoised
 * rather than per fixture.
 */
let provisioned: Promise<{ id: string }> | null = null;

export function testTenant(): Promise<{ id: string }> {
  provisioned ??= provisionTenant({
    slug: TEST_TENANT_SLUG,
    name: 'KYC Test Suite',
    homeCountry: 'GBR',
    industry: 'FINTECH',
  });
  return provisioned;
}

export async function testLevel(tenantId: string) {
  return prisma.verificationLevel.findFirstOrThrow({
    where: { tenantId, name: 'standard-kyc-aml' },
  });
}

/**
 * Distinct dates of birth per fixture.
 *
 * The identity fingerprint is a hash of name, date of birth, and country, and
 * duplicate detection keys off it. Fixtures that all share one identity are a
 * cohort of the same person and trip the duplicate rules, which then leaks into
 * every assertion about risk. Varying the date of birth keeps them separate
 * without touching the name, which is what the mock scenario keywords read.
 */
function dobForSlug(slug: string): string {
  let hash = 0;
  for (let i = 0; i < slug.length; i++) hash = (hash * 31 + slug.charCodeAt(i)) >>> 0;
  return new Date(Date.UTC(1970 + (hash % 40), hash % 12, 1 + (hash % 28)))
    .toISOString()
    .slice(0, 10);
}

export interface FixtureOptions {
  /** Appended to the name, so the mock adapters' keyword triggers apply. */
  firstName?: string;
  lastName?: string;
  country?: string;
  dob?: string;
}

/**
 * An applicant with the documents the standard level requires, ready to run
 * through the pipeline. `slug` must be unique within a test file.
 */
export async function createApplicant(slug: string, opts: FixtureOptions = {}) {
  const tenant = await testTenant();
  const level = await testLevel(tenant.id);
  const { encryptJson } = await import('@kyc/core');
  const piiKey = process.env.PII_ENCRYPTION_KEY;

  const applicant = await prisma.applicant.create({
    data: {
      // A fixed id, not a generated cuid.
      //
      // The mock adapters seed their pseudo-randomness on the applicant id, and
      // they deliberately give a minority of clean applicants imperfect signals
      // — a VPN, a weak liveness score — so the scoring model is exercised
      // rather than trivially satisfied. With a fresh cuid each run, whether a
      // fixture is squeaky clean is a coin toss and the tests flake. Pinning the
      // id makes each fixture a specific, reproducible person.
      id: `test-${slug}`,
      tenantId: tenant.id,
      externalUserId: `test-${slug}`,
      levelId: level.id,
      firstName: opts.firstName ?? 'Test',
      lastName: opts.lastName ?? 'Person',
      dob: new Date(opts.dob ?? dobForSlug(slug)),
      country: opts.country ?? 'ITA',
      nationality: opts.country ?? 'ITA',
      email: `${slug}@example.test`,
      // An IP with no prefix in the mock's table, so it infers the declared
      // country and does not manufacture a geo mismatch.
      ipAddress: '203.0.113.9',
      userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) Safari/604.1',
      reviewStatus: 'PENDING',
      status: 'QUEUED',
      submittedAt: new Date(),
      piiCiphertext: piiKey
        ? encryptJson({ address: 'Via Test 1, 20100 Milano' }, piiKey)
        : null,
    },
  });

  const storage = adaptersFor(tenant.id).storage;
  for (const spec of [
    { type: 'PASSPORT' as const, side: 'FRONT_SIDE' as const },
    { type: 'SELFIE' as const, side: 'FRONT_SIDE' as const },
    { type: 'UTILITY_BILL' as const, side: 'PAGE' as const },
  ]) {
    const document = await prisma.document.create({
      data: {
        applicantId: applicant.id,
        type: spec.type,
        subType: spec.side,
        status: 'UPLOADED',
      },
    });
    const stored = await storage.put(
      documentStorageKey({
        tenantId: tenant.id,
        applicantId: applicant.id,
        documentId: document.id,
        side: spec.side,
        extension: 'png',
      }),
      PNG_1X1,
      'image/png',
    );
    await prisma.documentImage.create({
      data: {
        documentId: document.id,
        storageKey: stored.key,
        contentType: 'image/png',
        bytes: stored.bytes,
        sha256: stored.sha256,
        side: spec.side,
        capturedBy: 'WEB_SDK_CAMERA',
      },
    });
  }

  return { applicant, tenant, level };
}

/**
 * Drops the suite's tenant, and with it everything the tests created —
 * applicants, checks, cases, screening runs, and the tenant's own audit chain,
 * all by cascade. The demo tenant is never touched.
 */
export async function cleanupTestData() {
  await prisma.tenant.deleteMany({ where: { slug: TEST_TENANT_SLUG } });
  provisioned = null;
}
