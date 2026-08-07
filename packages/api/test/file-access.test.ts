import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { documentStorageKey } from '@kyc/adapters';
import { prisma, provisionTenant, PostgresStorageAdapter } from '@kyc/db';
import { signToken } from '../src/auth.js';
import { buildServer } from '../src/server.js';

/**
 * Who may fetch a document image.
 *
 * The rule is that access comes from a short-lived signature and nothing else.
 * It briefly did not: the signature was demanded only of the local filesystem
 * driver, and every other driver fell back to "is this request authenticated
 * at all" — under which an applicant's own upload token would fetch any
 * object in any tenant given its key. Which storage driver a deployment
 * happens to use is not an access control decision.
 */

const SLUG_A = 'kyc-files-test-a';
const SLUG_B = 'kyc-files-test-b';
const IMAGE = randomBytes(2048);
/** Built from the real tenant id: the presigner checks ownership by id, not slug. */
let KEY: string;

let app: Awaited<ReturnType<typeof buildServer>>;
let tenantA: string;
let tenantB: string;
let applicantToken: string;
let officerToken: string;
/** A reviewer in the tenant that owns the document. */
let ownerToken: string;

beforeAll(async () => {
  process.env.STORAGE_DRIVER = 'postgres';

  const a = await provisionTenant({ slug: SLUG_A, name: 'A', homeCountry: 'GBR', industry: 'FINTECH' });
  const b = await provisionTenant({ slug: SLUG_B, name: 'B', homeCountry: 'GBR', industry: 'FINTECH' });
  tenantA = a.id;
  tenantB = b.id;
  // Realistic ids, not `a1`/`d1`. A key built from short placeholders encodes
  // to under a hundred characters and slips under the router's parameter cap —
  // which is how a route that answered 414 to every real request passed its
  // tests.
  KEY = documentStorageKey({
    tenantId: tenantA,
    applicantId: 'cmsj6apt000019wf99bqqigdn',
    documentId: 'cmsj6aq1p00039wf9hqx1r2yz',
    side: 'FRONT_SIDE',
    extension: 'png',
  });

  await new PostgresStorageAdapter(
    process.env.APP_SECRET ?? 'dev-secret',
    process.env.PII_ENCRYPTION_KEY ?? '1111111111111111111111111111111111111111111111111111111111111111',
  ).put(KEY, IMAGE, 'image/png');

  const level = await prisma.verificationLevel.findFirstOrThrow({ where: { tenantId: tenantA } });
  const applicant = await prisma.applicant.create({
    data: {
      tenantId: tenantA,
      externalUserId: 'files-test-subject',
      levelId: level.id,
      reviewStatus: 'NOT_STARTED',
      status: 'INIT',
    },
  });
  applicantToken = signToken(
    { sub: applicant.id, kind: 'applicant', tenantId: tenantA, externalUserId: 'files-test-subject' },
    3600,
  );

  const officerA = await prisma.user.create({
    data: {
      tenantId: tenantA,
      email: 'officer@files-test-a.test',
      name: 'Officer A',
      role: 'COMPLIANCE_OFFICER',
      passwordHash: 'unused-in-this-test',
    },
  });
  ownerToken = signToken(
    { sub: officerA.id, kind: 'user', tenantId: tenantA, role: officerA.role, email: officerA.email },
    3600,
  );

  const user = await prisma.user.create({
    data: {
      tenantId: tenantB,
      email: 'officer@files-test-b.test',
      name: 'Officer B',
      role: 'COMPLIANCE_OFFICER',
      passwordHash: 'unused-in-this-test',
    },
  });
  officerToken = signToken(
    { sub: user.id, kind: 'user', tenantId: tenantB, role: user.role, email: user.email },
    3600,
  );

  app = await buildServer();
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.storedObject.deleteMany({ where: { key: KEY } });
  await prisma.tenant.deleteMany({ where: { slug: { in: [SLUG_A, SLUG_B] } } });
});

const fetchFile = (query: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url: `/v1/files/${encodeURIComponent(KEY)}${query}`, headers });

describe('fetching a document image', () => {
  it('serves it with a valid signature', async () => {
    const presigned = await app.inject({
      method: 'POST',
      url: '/v1/files/presign',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { storageKey: KEY },
    });
    expect(presigned.statusCode).toBe(200);

    const url = presigned.json().url as string;
    const response = await app.inject({ method: 'GET', url });

    expect(response.statusCode).toBe(200);
    expect(response.headers['content-type']).toContain('image/png');
    expect(Buffer.from(response.rawPayload).equals(IMAGE)).toBe(true);
  }, 60_000);

  it('refuses an applicant token holding no signature', async () => {
    const response = await fetchFile('', { authorization: `Bearer ${applicantToken}` });

    // Being logged in is not permission to read a document.
    expect(response.statusCode).toBe(403);
    expect(response.rawPayload.length).toBeLessThan(IMAGE.length);
  }, 60_000);

  it('refuses a reviewer from another tenant holding no signature', async () => {
    const response = await fetchFile('', { authorization: `Bearer ${officerToken}` });

    expect(response.statusCode).toBe(403);
  }, 60_000);

  it('refuses a forged signature', async () => {
    const expires = Math.floor(Date.now() / 1000) + 300;
    const response = await fetchFile(`?expires=${expires}&signature=${'a'.repeat(64)}`);

    expect(response.statusCode).toBe(403);
  }, 60_000);

  it('refuses an expired signature', async () => {
    const presigned = await app.inject({
      method: 'POST',
      url: '/v1/files/presign',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { storageKey: KEY, ttlSeconds: 1 },
    });
    const url = new URL(presigned.json().url as string, 'https://x.test');
    // Same signature, replayed after it lapsed.
    url.searchParams.set('expires', String(Math.floor(Date.now() / 1000) - 10));

    const response = await app.inject({ method: 'GET', url: url.pathname + url.search });
    expect(response.statusCode).toBe(403);
  }, 60_000);
});

describe('the length of a storage key', () => {
  it('does not exceed what the router will accept', async () => {
    // Keys are tenant id + applicant id + document id + filename, and encode to
    // around 130 characters. Fastify caps path parameters at 100 by default, so
    // this route answered 414 to every request ever made to it and the console
    // had no working way to show an image. A unit test would not have caught
    // it; only asking the server did.
    const presigned = await app.inject({
      method: 'POST',
      url: '/v1/files/presign',
      headers: { authorization: `Bearer ${ownerToken}` },
      payload: { storageKey: KEY },
    });
    const url = presigned.json().url as string;
    expect(encodeURIComponent(KEY).length).toBeGreaterThan(100);

    const response = await app.inject({ method: 'GET', url });
    expect(response.statusCode).not.toBe(414);
    expect(response.statusCode).toBe(200);
  }, 60_000);
});

describe('presigning', () => {
  it('refuses to presign another tenant\'s object', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/files/presign',
      headers: { authorization: `Bearer ${officerToken}` },
      payload: { storageKey: KEY },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  }, 60_000);

  it('refuses an applicant token outright', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/files/presign',
      headers: { authorization: `Bearer ${applicantToken}` },
      payload: { storageKey: KEY },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  }, 60_000);
});
