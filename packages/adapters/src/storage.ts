import { createHash, createHmac } from 'node:crypto';
import { mkdir, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { dirname, join, normalize, resolve, sep } from 'node:path';
import type { StorageAdapter } from './types.js';

/**
 * Document storage.
 *
 * Document images never live in Postgres. They are large, they are read rarely
 * relative to the rows around them, and they carry the strictest retention and
 * access requirements in the system — so they belong behind an object-store
 * interface with presigned, expiring access.
 */

function sha256Hex(bytes: Buffer): string {
  return createHash('sha256').update(bytes).digest('hex');
}

/** Local filesystem driver for development. */
export class LocalStorageAdapter implements StorageAdapter {
  readonly name = 'local-fs';
  private readonly root: string;
  private readonly signingSecret: string;

  constructor(root: string, signingSecret: string) {
    this.root = resolve(root);
    this.signingSecret = signingSecret;
  }

  /**
   * Resolves a key to a path inside the storage root. Keys come from request
   * data, so path traversal has to be rejected explicitly rather than assumed
   * impossible.
   */
  private pathFor(key: string): string {
    const cleaned = normalize(key).replace(/^(\.\.(\/|\\|$))+/, '');
    const full = resolve(join(this.root, cleaned));
    if (full !== this.root && !full.startsWith(this.root + sep)) {
      throw new Error(`storage key escapes the storage root: ${key}`);
    }
    return full;
  }

  async put(key: string, bytes: Buffer, _contentType: string) {
    const path = this.pathFor(key);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, bytes);
    return { key, bytes: bytes.length, sha256: sha256Hex(bytes) };
  }

  async get(key: string) {
    const bytes = await readFile(this.pathFor(key));
    return { bytes, contentType: guessContentType(key) };
  }

  /**
   * Local stand-in for a presigned URL: an HMAC over key and expiry that the API
   * verifies before streaming the file. Same security property as the real thing
   * (time-limited, tamper-evident), served by our own process.
   */
  async presignGet(key: string, ttlSeconds: number): Promise<string> {
    const expires = Math.floor(Date.now() / 1000) + ttlSeconds;
    const sig = createHmac('sha256', this.signingSecret)
      .update(`${key}:${expires}`)
      .digest('hex');
    return `/v1/files/${encodeURIComponent(key)}?expires=${expires}&signature=${sig}`;
  }

  verifyPresigned(key: string, expires: number, signature: string): boolean {
    if (!Number.isFinite(expires) || expires < Math.floor(Date.now() / 1000)) return false;
    const expected = createHmac('sha256', this.signingSecret)
      .update(`${key}:${expires}`)
      .digest('hex');
    return expected === signature;
  }

  async delete(key: string): Promise<void> {
    await rm(this.pathFor(key), { force: true });
  }

  async exists(key: string): Promise<boolean> {
    try {
      await stat(this.pathFor(key));
      return true;
    } catch {
      return false;
    }
  }
}

/**
 * S3-compatible driver (AWS S3, MinIO, R2) using SigV4 over fetch, so we do not
 * pull in the AWS SDK for four operations.
 */
export class S3StorageAdapter implements StorageAdapter {
  readonly name = 's3';

  constructor(
    private readonly config: {
      endpoint: string;
      region: string;
      bucket: string;
      accessKeyId: string;
      secretAccessKey: string;
      forcePathStyle?: boolean;
    },
  ) {}

  private urlFor(key: string): string {
    const base = this.config.endpoint.replace(/\/$/, '');
    return this.config.forcePathStyle
      ? `${base}/${this.config.bucket}/${encodeKey(key)}`
      : `${base.replace('://', `://${this.config.bucket}.`)}/${encodeKey(key)}`;
  }

  private sign(
    method: string,
    key: string,
    payloadHash: string,
    extraHeaders: Record<string, string> = {},
  ): Record<string, string> {
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const url = new URL(this.urlFor(key));

    const headers: Record<string, string> = {
      host: url.host,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      ...Object.fromEntries(
        Object.entries(extraHeaders).map(([k, v]) => [k.toLowerCase(), v]),
      ),
    };
    const signedHeaders = Object.keys(headers).sort();
    const canonicalHeaders = signedHeaders.map((h) => `${h}:${headers[h]}\n`).join('');
    const canonicalRequest = [
      method,
      url.pathname,
      '',
      canonicalHeaders,
      signedHeaders.join(';'),
      payloadHash,
    ].join('\n');

    const scope = `${dateStamp}/${this.config.region}/s3/aws4_request`;
    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');

    const hmac = (k: Buffer | string, d: string) =>
      createHmac('sha256', k).update(d).digest();
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${this.config.secretAccessKey}`, dateStamp), this.config.region), 's3'),
      'aws4_request',
    );
    const signature = createHmac('sha256', signingKey).update(stringToSign).digest('hex');

    return {
      ...extraHeaders,
      'x-amz-content-sha256': payloadHash,
      'x-amz-date': amzDate,
      Authorization: `AWS4-HMAC-SHA256 Credential=${this.config.accessKeyId}/${scope}, SignedHeaders=${signedHeaders.join(';')}, Signature=${signature}`,
    };
  }

  /**
   * Creates the bucket if it is not already there.
   *
   * Infrastructure usually owns this, and in a managed deployment it should:
   * a bucket carries retention rules, encryption settings and access policy
   * that belong in whatever provisions the account. It is here because the
   * alternative was a second, hand-rolled copy of request signing living in a
   * test file — and signing code that exists twice is signing code that
   * disagrees with itself eventually.
   *
   * Idempotent: an existing bucket is success, not an error.
   */
  async ensureBucket(): Promise<void> {
    const payloadHash = sha256Hex(Buffer.alloc(0));
    // Signed and fetched through the same function, so the canonical path the
    // signature covers is byte-for-byte the path the request uses. Building the
    // URL separately here differed by one trailing slash, which is enough for
    // SignatureDoesNotMatch and tells you nothing about why.
    const headers = this.sign('PUT', '', payloadHash);
    const response = await fetch(this.urlFor(''), { method: 'PUT', headers });

    // Both mean "it is there now", which is all the caller asked for.
    if (response.ok || response.status === 409) return;
    const body = await response.text();
    if (/BucketAlreadyOwnedByYou|BucketAlreadyExists/.test(body)) return;
    throw new Error(`Could not create bucket ${this.config.bucket}: ${response.status} ${body}`);
  }

  async put(key: string, bytes: Buffer, contentType: string) {
    const payloadHash = sha256Hex(bytes);
    const headers = this.sign('PUT', key, payloadHash, {
      'content-type': contentType,
      'content-length': String(bytes.length),
    });
    const res = await fetch(this.urlFor(key), {
      method: 'PUT',
      headers,
      body: new Uint8Array(bytes),
    });
    if (!res.ok) {
      throw new Error(`S3 PUT ${key} failed: ${res.status} ${await res.text()}`);
    }
    return { key, bytes: bytes.length, sha256: payloadHash };
  }

  async get(key: string) {
    const headers = this.sign('GET', key, 'UNSIGNED-PAYLOAD');
    const res = await fetch(this.urlFor(key), { headers });
    if (!res.ok) throw new Error(`S3 GET ${key} failed: ${res.status}`);
    return {
      bytes: Buffer.from(await res.arrayBuffer()),
      contentType: res.headers.get('content-type') ?? guessContentType(key),
    };
  }

  /**
   * Query-string SigV4 presign. Deliberately capped: an image URL that lives for
   * hours is an image URL that leaks in a browser history or a shared screenshot.
   */
  async presignGet(key: string, ttlSeconds: number): Promise<string> {
    const expiry = Math.min(ttlSeconds, 3600);
    const now = new Date();
    const amzDate = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
    const dateStamp = amzDate.slice(0, 8);
    const url = new URL(this.urlFor(key));
    const scope = `${dateStamp}/${this.config.region}/s3/aws4_request`;

    const params = new URLSearchParams({
      'X-Amz-Algorithm': 'AWS4-HMAC-SHA256',
      'X-Amz-Credential': `${this.config.accessKeyId}/${scope}`,
      'X-Amz-Date': amzDate,
      'X-Amz-Expires': String(expiry),
      'X-Amz-SignedHeaders': 'host',
    });

    const canonicalRequest = [
      'GET',
      url.pathname,
      params.toString(),
      `host:${url.host}\n`,
      'host',
      'UNSIGNED-PAYLOAD',
    ].join('\n');

    const stringToSign = [
      'AWS4-HMAC-SHA256',
      amzDate,
      scope,
      createHash('sha256').update(canonicalRequest).digest('hex'),
    ].join('\n');

    const hmac = (k: Buffer | string, d: string) =>
      createHmac('sha256', k).update(d).digest();
    const signingKey = hmac(
      hmac(hmac(hmac(`AWS4${this.config.secretAccessKey}`, dateStamp), this.config.region), 's3'),
      'aws4_request',
    );
    params.set(
      'X-Amz-Signature',
      createHmac('sha256', signingKey).update(stringToSign).digest('hex'),
    );

    return `${url.origin}${url.pathname}?${params.toString()}`;
  }

  async delete(key: string): Promise<void> {
    const headers = this.sign('DELETE', key, 'UNSIGNED-PAYLOAD');
    const res = await fetch(this.urlFor(key), { method: 'DELETE', headers });
    if (!res.ok && res.status !== 404) {
      throw new Error(`S3 DELETE ${key} failed: ${res.status}`);
    }
  }

  async exists(key: string): Promise<boolean> {
    const headers = this.sign('HEAD', key, 'UNSIGNED-PAYLOAD');
    const res = await fetch(this.urlFor(key), { method: 'HEAD', headers });
    return res.ok;
  }
}

function encodeKey(key: string): string {
  return key.split('/').map(encodeURIComponent).join('/');
}

function guessContentType(key: string): string {
  const ext = key.split('.').pop()?.toLowerCase();
  switch (ext) {
    case 'jpg':
    case 'jpeg':
      return 'image/jpeg';
    case 'png':
      return 'image/png';
    case 'webp':
      return 'image/webp';
    case 'pdf':
      return 'application/pdf';
    case 'mp4':
      return 'video/mp4';
    case 'webm':
      return 'video/webm';
    case 'json':
      return 'application/json';
    default:
      return 'application/octet-stream';
  }
}

/**
 * Builds the storage key for a document image. Tenant-first so a tenant's
 * objects can be lifecycled, exported, or deleted as one prefix — which is what
 * an erasure request or an offboarding actually requires.
 */
export function documentStorageKey(args: {
  tenantId: string;
  applicantId: string;
  documentId: string;
  side: string;
  extension: string;
}): string {
  return `tenants/${args.tenantId}/applicants/${args.applicantId}/documents/${args.documentId}/${args.side.toLowerCase()}.${args.extension}`;
}
