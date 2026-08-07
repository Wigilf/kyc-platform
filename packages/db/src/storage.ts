import { createHash, createHmac, timingSafeEqual } from 'node:crypto';
import { decryptBytes, encryptBytes } from '@kyc/core';
import { prisma } from './index.js';

/**
 * Document storage in the database.
 *
 * Deliberately against the advice in the storage adapter next door, which says
 * images do not belong in Postgres — and at scale that advice is right. It is
 * here because the deployed alternative was the container's `/tmp`, and the
 * host wipes that on every restart and deploy. An applicant's passport survived
 * until the next push; the review queue filled with cases whose evidence no
 * longer existed. Durable and in the imperfect place beats correct and gone.
 *
 * Three properties that make it defensible rather than merely expedient:
 *
 * **Everything is encrypted.** Objects are sealed with AES-256-GCM before they
 * are written, so a database dump, a backup on someone's laptop, or a support
 * engineer with read access does not amount to a pile of passports. The
 * filesystem driver it replaces wrote them in the clear.
 *
 * **Reads are by key, never by scan.** The key is the primary key, so this adds
 * one indexed lookup rather than anything that grows with the table.
 *
 * **It is one config change from S3.** Same interface; `STORAGE_DRIVER=s3`
 * switches without touching a caller. That is the exit, and the schema comment
 * says when to take it.
 *
 * Lives in @kyc/db rather than @kyc/adapters because it needs Prisma, and
 * @kyc/adapters is deliberately free of a database dependency.
 */
export class PostgresStorageAdapter {
  readonly name = 'postgres';

  constructor(
    private readonly signingSecret: string,
    /**
     * Hex AES key. Required: an unencrypted passport in a shared database is a
     * worse outcome than the ephemeral disk this replaces, so there is no
     * plaintext fallback to quietly land in.
     */
    private readonly encryptionKey: string,
  ) {
    if (!encryptionKey) {
      throw new Error(
        'PostgresStorageAdapter requires an encryption key. Set PII_ENCRYPTION_KEY; ' +
          'storing identity documents unencrypted is not an available option.',
      );
    }
  }

  async put(key: string, bytes: Buffer, contentType: string) {
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    // Prisma's Bytes maps to Uint8Array, and Node's Buffer is only assignable
    // to it when its backing store is a plain ArrayBuffer. Copying once is
    // cheaper than fighting the type.
    const sealed = new Uint8Array(encryptBytes(bytes, this.encryptionKey));

    // Upsert rather than create: re-uploading the same side of a document is a
    // normal thing for an applicant to do, and it should replace rather than
    // collide.
    await prisma.storedObject.upsert({
      where: { key },
      create: {
        key,
        tenantId: tenantFromKey(key),
        contentType,
        bytes: sealed,
        sha256,
        size: bytes.length,
      },
      update: { contentType, bytes: sealed, sha256, size: bytes.length },
    });

    return { key, bytes: bytes.length, sha256 };
  }

  async get(key: string): Promise<{ bytes: Buffer; contentType: string }> {
    const row = await prisma.storedObject.findUnique({ where: { key } });
    if (!row) throw new Error(`No stored object for key: ${key}`);

    const bytes = decryptBytes(Buffer.from(row.bytes), this.encryptionKey);

    // The stored digest is of the plaintext, so this catches a bad key, a
    // truncated write, or someone editing the row — the authentication tag
    // catches tampering with the ciphertext, and this catches the rest.
    const actual = createHash('sha256').update(bytes).digest('hex');
    if (actual !== row.sha256) {
      throw new Error(
        `Stored object ${key} does not match its recorded digest; refusing to return it.`,
      );
    }

    return { bytes, contentType: row.contentType };
  }

  /**
   * A signed, expiring URL the API serves itself.
   *
   * Same security property as a real presigned URL — time-limited and
   * tamper-evident — without an object store to delegate to.
   */
  async presignGet(key: string, ttlSeconds: number): Promise<string> {
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    const signature = this.sign(key, expires);
    return `/v1/files/${encodeURIComponent(key)}?expires=${expires}&signature=${signature}`;
  }

  verifyPresigned(key: string, expires: number, signature: string): boolean {
    if (!Number.isFinite(expires) || expires < Math.floor(Date.now() / 1000)) return false;
    const expected = Buffer.from(this.sign(key, expires), 'hex');
    const given = Buffer.from(signature, 'hex');
    // Constant time, and length-checked first: timingSafeEqual throws on a
    // length mismatch, and a thrown error is itself a signal about the guess.
    return expected.length === given.length && timingSafeEqual(expected, given);
  }

  private sign(key: string, expires: number): string {
    return createHmac('sha256', this.signingSecret).update(`${key}:${expires}`).digest('hex');
  }

  async delete(key: string): Promise<void> {
    await prisma.storedObject.deleteMany({ where: { key } });
  }

  async exists(key: string): Promise<boolean> {
    const found = await prisma.storedObject.findUnique({
      where: { key },
      select: { key: true },
    });
    return found !== null;
  }
}

/**
 * How much the database is carrying in documents.
 *
 * Exposed so the schema comment's "revisit before this passes a few GB" is
 * something the system says out loud rather than a note nobody reads. `/ready`
 * reports it and warns past the threshold.
 */
export async function storedObjectFootprint(): Promise<{
  objects: number;
  bytes: number;
  overThreshold: boolean;
  thresholdBytes: number;
}> {
  const [aggregate] = await prisma.$queryRaw<Array<{ objects: bigint; bytes: bigint | null }>>`
    select count(*)::bigint as objects, coalesce(sum(size), 0)::bigint as bytes
    from "StoredObject"
  `;

  // Two gigabytes. Chosen as the point where the trade stops being obviously
  // right rather than as a hard limit: backups get slow, the free tier's disk
  // is finite, and object storage is what this should be by then.
  const thresholdBytes = Number(process.env.STORAGE_WARN_BYTES ?? 2 * 1024 ** 3);
  const bytes = Number(aggregate?.bytes ?? 0);

  return {
    objects: Number(aggregate?.objects ?? 0),
    bytes,
    overThreshold: bytes > thresholdBytes,
    thresholdBytes,
  };
}

/**
 * The tenant a key belongs to, for reporting and bulk deletion.
 *
 * Keys are built by `documentStorageKey` as `tenant/<id>/applicant/<id>/...`.
 * Best effort: a key in another shape stores null rather than throwing, since
 * failing an upload over a label would be the wrong trade.
 */
function tenantFromKey(key: string): string | null {
  const match = /(?:^|\/)tenants?\/([^/]+)\//.exec(key);
  return match?.[1] ?? null;
}
