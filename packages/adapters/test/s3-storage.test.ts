import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { S3StorageAdapter } from '../src/storage.js';

/**
 * The S3 driver, against a real S3 server.
 *
 * Documents live in Postgres today because the alternative on the deployed
 * host was an ephemeral disk that lost them. That is a compromise with a stated
 * exit — `STORAGE_DRIVER=s3` — and an exit nobody has driven is not an exit.
 * These run against the MinIO container in docker-compose, which speaks the
 * same protocol as S3, R2 and B2, so the switch is a configuration change
 * rather than a leap.
 *
 * Skipped when MinIO is not running, because a developer without the container
 * should not be blocked; CI has it.
 */

const CONFIG = {
  endpoint: process.env.TEST_S3_ENDPOINT ?? 'http://127.0.0.1:9010',
  region: 'us-east-1',
  bucket: process.env.TEST_S3_BUCKET ?? 'kyc-storage-test',
  accessKeyId: process.env.TEST_S3_ACCESS_KEY ?? 'kycadmin',
  secretAccessKey: process.env.TEST_S3_SECRET_KEY ?? 'kycadminsecret',
  forcePathStyle: true,
};

const storage = new S3StorageAdapter(CONFIG);
const written: string[] = [];

/**
 * Whether an object store is reachable, decided at run time.
 *
 * Not at collection time, and not with a top-level await. Whether a test is
 * skipped is fixed while the test tree is being built, and that happens before
 * hooks run *and* before a top-level await resolves — so both of the obvious
 * approaches report a tidy row of skips however healthy the server is. This
 * file did exactly that twice, which is six tests' worth of nothing dressed as
 * a pass.
 *
 * `ctx.skip()` inside the test is evaluated when the test runs, which is the
 * only point at which the answer is known.
 */
let available = false;

function requireStore(ctx: { skip: () => void }) {
  if (!available) ctx.skip();
}

function key(name: string): string {
  const k = `tenants/s3-test/applicants/a1/documents/${Date.now()}-${name}`;
  written.push(k);
  return k;
}

beforeAll(async () => {
  try {
    const probe = await fetch(`${CONFIG.endpoint}/minio/health/live`, {
      signal: AbortSignal.timeout(2000),
    });
    available = probe.ok;
  } catch {
    available = false;
  }
  if (!available) {
    console.log(`  (no object store at ${CONFIG.endpoint}; S3 tests will skip)`);
    return;
  }
  // The bucket is the deployment's to create; making it here keeps the test
  // self-contained without pretending the adapter does it.
  await storage.ensureBucket();
}, 30_000);

afterAll(async () => {
  if (!available) return;
  for (const k of written) await storage.delete(k).catch(() => undefined);
});


describe('storing a document in object storage', () => {
  it('returns exactly what was put in', async (ctx) => {
    requireStore(ctx);
    const k = key('roundtrip.png');
    const bytes = randomBytes(8192);

    const put = await storage.put(k, bytes, 'image/png');
    const got = await storage.get(k);

    expect(put.bytes).toBe(8192);
    expect(got.bytes.equals(bytes)).toBe(true);
    expect(got.contentType).toContain('image/png');
  }, 30_000);

  it('reports whether an object is there', async (ctx) => {
    requireStore(ctx);
    const k = key('exists.png');
    expect(await storage.exists(k)).toBe(false);
    await storage.put(k, randomBytes(64), 'image/png');
    expect(await storage.exists(k)).toBe(true);
  }, 30_000);

  it('deletes', async (ctx) => {
    requireStore(ctx);
    const k = key('gone.png');
    await storage.put(k, randomBytes(64), 'image/png');
    await storage.delete(k);
    expect(await storage.exists(k)).toBe(false);
  }, 30_000);

  it('handles a key with the characters a real one contains', async (ctx) => {
    requireStore(ctx);
    // Slashes must stay slashes in the object name rather than being escaped,
    // or the bucket fills with one flat namespace and the tenant prefix that
    // authorisation relies on stops being a prefix.
    const k = key('nested/deeply/front_side.png');
    const bytes = randomBytes(256);
    await storage.put(k, bytes, 'image/png');
    expect((await storage.get(k)).bytes.equals(bytes)).toBe(true);
  }, 30_000);

  it('signs a URL the store itself will honour', async (ctx) => {
    requireStore(ctx);
    const k = key('presigned.png');
    const bytes = randomBytes(512);
    await storage.put(k, bytes, 'image/png');

    const url = await storage.presignGet(k, 300);
    // A real presigned URL is absolute and fetched directly from the store —
    // the API never sees it, which is the point of moving off the database.
    expect(url.startsWith('http')).toBe(true);

    const response = await fetch(url);
    expect(response.status).toBe(200);
    expect(Buffer.from(await response.arrayBuffer()).equals(bytes)).toBe(true);
  }, 30_000);

  it('refuses a tampered signature', async (ctx) => {
    requireStore(ctx);
    const k = key('tampered.png');
    await storage.put(k, randomBytes(128), 'image/png');
    const url = await storage.presignGet(k, 300);

    const forged = url.replace(/X-Amz-Signature=[0-9a-f]+/, `X-Amz-Signature=${'0'.repeat(64)}`);
    const response = await fetch(forged);
    expect(response.status).toBeGreaterThanOrEqual(400);
  }, 30_000);
});
