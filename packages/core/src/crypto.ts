import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  timingSafeEqual,
} from 'node:crypto';

/**
 * PII protection primitives.
 *
 * Two distinct needs, deliberately separated:
 *  - Reversible: full addresses, ID numbers, IVMS payloads. AES-256-GCM with an
 *    envelope so a key rotation does not require rewriting every row at once.
 *  - Irreversible: dedup and search keys. SHA-256 over normalised input, so two
 *    submissions of the same identity collide without us storing the identity.
 */

const ALGO = 'aes-256-gcm';

export interface EncryptedBlob {
  v: number;
  iv: string;
  tag: string;
  ct: string;
}

function keyFromHex(hex: string): Buffer {
  const key = Buffer.from(hex, 'hex');
  if (key.length !== 32) {
    throw new Error(
      `PII encryption key must be 32 bytes (64 hex chars), got ${key.length}`,
    );
  }
  return key;
}

export function encryptPii(
  plaintext: string,
  keyHex: string,
  version = 1,
): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, keyFromHex(keyHex), iv);
  const ct = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const blob: EncryptedBlob = {
    v: version,
    iv: iv.toString('base64'),
    tag: cipher.getAuthTag().toString('base64'),
    ct: ct.toString('base64'),
  };
  return JSON.stringify(blob);
}

export function decryptPii(serialized: string, keyHex: string): string {
  const blob = JSON.parse(serialized) as EncryptedBlob;
  const decipher = createDecipheriv(
    ALGO,
    keyFromHex(keyHex),
    Buffer.from(blob.iv, 'base64'),
  );
  decipher.setAuthTag(Buffer.from(blob.tag, 'base64'));
  return Buffer.concat([
    decipher.update(Buffer.from(blob.ct, 'base64')),
    decipher.final(),
  ]).toString('utf8');
}

export function encryptJson(
  value: unknown,
  keyHex: string,
  version = 1,
): string {
  return encryptPii(JSON.stringify(value), keyHex, version);
}

export function decryptJson<T>(serialized: string, keyHex: string): T {
  return JSON.parse(decryptPii(serialized, keyHex)) as T;
}

export function sha256(input: string): string {
  return createHash('sha256').update(input, 'utf8').digest('hex');
}

export function hmacSha256(payload: string, secret: string): string {
  return createHmac('sha256', secret).update(payload, 'utf8').digest('hex');
}

/** Constant-time comparison that will not throw on length mismatch. */
export function safeEqual(a: string, b: string): boolean {
  const ab = Buffer.from(a, 'utf8');
  const bb = Buffer.from(b, 'utf8');
  if (ab.length !== bb.length) return false;
  return timingSafeEqual(ab, bb);
}

export function newId(prefix: string): string {
  return `${prefix}_${randomUUID().replace(/-/g, '')}`;
}

export function newSecret(bytes = 32): string {
  return randomBytes(bytes).toString('base64url');
}

/**
 * API key material. The secret is returned once; only its hash is persisted,
 * so a database leak does not yield usable credentials.
 */
export function generateApiKey(): {
  keyId: string;
  secret: string;
  secretHash: string;
} {
  const keyId = `kyc_${randomBytes(12).toString('hex')}`;
  const secret = newSecret(32);
  return { keyId, secret, secretHash: sha256(secret) };
}

export function verifyApiSecret(secret: string, secretHash: string): boolean {
  return safeEqual(sha256(secret), secretHash);
}

/**
 * Canonical request signature, mirrored by the WebSDK and server clients:
 *
 *   signature = HMAC-SHA256(secret, `${ts}\n${method}\n${path}\n${bodySha256}`)
 *
 * The timestamp is inside the signed string so a captured request cannot be
 * replayed outside the tolerance window.
 */
export function signRequest(args: {
  secret: string;
  timestamp: number;
  method: string;
  path: string;
  body?: string;
}): string {
  const bodyHash = sha256(args.body ?? '');
  const canonical = [
    String(args.timestamp),
    args.method.toUpperCase(),
    args.path,
    bodyHash,
  ].join('\n');
  return hmacSha256(canonical, args.secret);
}

export function verifyRequestSignature(args: {
  secret: string;
  signature: string;
  timestamp: number;
  method: string;
  path: string;
  body?: string;
  toleranceSeconds?: number;
  now?: number;
}): { valid: boolean; reason?: string } {
  const now = args.now ?? Math.floor(Date.now() / 1000);
  const tolerance = args.toleranceSeconds ?? 300;
  if (!Number.isFinite(args.timestamp)) {
    return { valid: false, reason: 'malformed timestamp' };
  }
  if (Math.abs(now - args.timestamp) > tolerance) {
    return { valid: false, reason: 'timestamp outside tolerance window' };
  }
  const expected = signRequest(args);
  if (!safeEqual(expected, args.signature)) {
    return { valid: false, reason: 'signature mismatch' };
  }
  return { valid: true };
}

/** Webhook signature: `t=<unix>,v1=<hex>` over `${t}.${rawBody}`. */
export function signWebhook(
  rawBody: string,
  secret: string,
  timestamp = Math.floor(Date.now() / 1000),
): string {
  const v1 = hmacSha256(`${timestamp}.${rawBody}`, secret);
  return `t=${timestamp},v1=${v1}`;
}

export function verifyWebhookSignature(
  rawBody: string,
  header: string,
  secret: string,
  toleranceSeconds = 300,
  now = Math.floor(Date.now() / 1000),
): boolean {
  const parts = new Map(
    header.split(',').map((kv) => {
      const idx = kv.indexOf('=');
      return [kv.slice(0, idx).trim(), kv.slice(idx + 1).trim()] as const;
    }),
  );
  const t = Number(parts.get('t'));
  const v1 = parts.get('v1');
  if (!v1 || !Number.isFinite(t)) return false;
  if (Math.abs(now - t) > toleranceSeconds) return false;
  return safeEqual(hmacSha256(`${t}.${rawBody}`, secret), v1);
}

/**
 * Tamper-evident audit chaining. Each entry commits to the previous hash, so
 * deleting or editing a row invalidates every hash after it.
 */
export function auditHash(
  prevHash: string | null,
  entry: Record<string, unknown>,
): string {
  const canonical = JSON.stringify(entry, Object.keys(entry).sort());
  return sha256(`${prevHash ?? 'genesis'}|${canonical}`);
}
