import { randomBytes } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { PostgresStorageAdapter, prisma } from '../src/index.js';

/**
 * Durable document storage.
 *
 * What is being guarded is not really the round trip — it is the two
 * properties that made putting images in the database defensible in the first
 * place: nothing is written in the clear, and nothing is handed back that
 * cannot be shown to be what was stored.
 */

const KEY_A = '1111111111111111111111111111111111111111111111111111111111111111';
const KEY_B = '2222222222222222222222222222222222222222222222222222222222222222';
const SECRET = 'storage-test-signing-secret-0000000000';

const store = new PostgresStorageAdapter(SECRET, KEY_A);
const written: string[] = [];

function key(name: string): string {
  const k = `tenants/storage-test/applicants/a1/documents/${name}`;
  written.push(k);
  return k;
}

afterAll(async () => {
  await prisma.storedObject.deleteMany({ where: { key: { in: written } } });
});

describe('storing a document', () => {
  it('returns exactly what was put in', async () => {
    const k = key('roundtrip.png');
    const bytes = randomBytes(4096);

    const put = await store.put(k, bytes, 'image/png');
    const got = await store.get(k);

    expect(put.bytes).toBe(4096);
    expect(got.bytes.equals(bytes)).toBe(true);
    expect(got.contentType).toBe('image/png');
  });

  it('never writes the image in the clear', async () => {
    const k = key('secret.png');
    // A recognisable run of bytes: if any of it appears in the row, the
    // encryption is not doing what the schema comment promises.
    const bytes = Buffer.from('PASSPORT-NUMBER-UT7431852-'.repeat(40));

    await store.put(k, bytes, 'image/png');
    const row = await prisma.storedObject.findUniqueOrThrow({ where: { key: k } });

    expect(Buffer.from(row.bytes).includes('PASSPORT-NUMBER')).toBe(false);
    expect(Buffer.from(row.bytes).equals(bytes)).toBe(false);
    // The digest is of the plaintext, so it must not equal the ciphertext's.
    expect(row.size).toBe(bytes.length);
  });

  it('refuses to decrypt with the wrong key rather than returning rubbish', async () => {
    const k = key('wrongkey.png');
    await store.put(k, randomBytes(1024), 'image/png');

    const otherTenant = new PostgresStorageAdapter(SECRET, KEY_B);

    await expect(otherTenant.get(k)).rejects.toThrow();
  });

  it('refuses to return an object whose bytes have been meddled with', async () => {
    const k = key('tampered.png');
    await store.put(k, randomBytes(1024), 'image/png');

    // Replace the ciphertext with a validly-sealed different image. The
    // authentication tag is intact — only the recorded digest disagrees.
    const other = new PostgresStorageAdapter(SECRET, KEY_A);
    const swapped = key('source.png');
    await other.put(swapped, randomBytes(1024), 'image/png');
    const donor = await prisma.storedObject.findUniqueOrThrow({ where: { key: swapped } });
    await prisma.storedObject.update({ where: { key: k }, data: { bytes: donor.bytes } });

    await expect(store.get(k)).rejects.toThrow(/does not match its recorded digest/);
  });

  it('replaces rather than collides when a side is re-uploaded', async () => {
    const k = key('replaced.png');
    await store.put(k, Buffer.from('first attempt'), 'image/png');
    await store.put(k, Buffer.from('better photo'), 'image/jpeg');

    const got = await store.get(k);
    expect(got.bytes.toString()).toBe('better photo');
    expect(got.contentType).toBe('image/jpeg');
  });

  it('records which tenant an object belongs to', async () => {
    const k = key('tenanted.png');
    await store.put(k, randomBytes(64), 'image/png');

    const row = await prisma.storedObject.findUniqueOrThrow({ where: { key: k } });
    expect(row.tenantId).toBe('storage-test');
  });
});

describe('signed access', () => {
  it('accepts its own signature and rejects a forged one', async () => {
    const k = key('signed.png');
    const url = await store.presignGet(k, 300);
    const params = new URL(url, 'https://example.test').searchParams;

    expect(
      store.verifyPresigned(k, Number(params.get('expires')), params.get('signature')!),
    ).toBe(true);
    expect(store.verifyPresigned(k, Number(params.get('expires')), 'deadbeef')).toBe(false);
    // Same signature, different object: the key is part of what is signed.
    expect(
      store.verifyPresigned('tenants/x/other.png', Number(params.get('expires')), params.get('signature')!),
    ).toBe(false);
  });

  it('rejects a link that has expired', async () => {
    const k = key('expired.png');
    const expires = Math.floor(Date.now() / 1000) - 1;
    const url = await store.presignGet(k, -1);
    const signature = new URL(url, 'https://example.test').searchParams.get('signature')!;

    expect(store.verifyPresigned(k, expires, signature)).toBe(false);
  });
});

describe('refusing to store unencrypted', () => {
  it('will not construct without a key', () => {
    // A passport sitting unencrypted in a shared database would be worse than
    // the ephemeral disk this replaces, so there is no plaintext fallback.
    expect(() => new PostgresStorageAdapter(SECRET, '')).toThrow(/requires an encryption key/);
  });
});
