import {
  createCipheriv,
  createDecipheriv,
  createHash,
  createHmac,
  randomBytes,
  randomUUID,
  scryptSync,
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

/**
 * The same envelope, over arbitrary bytes.
 *
 * Separate from `encryptPii` because base64-ing a passport photograph into a
 * JSON string to encrypt it, then base64-ing the ciphertext again, inflates it
 * by roughly four thirds twice over for no benefit. This keeps the same
 * algorithm, key and authentication tag, and returns bytes.
 *
 * Layout: version (1 byte) ‖ iv (12) ‖ tag (16) ‖ ciphertext. Self-describing,
 * so a stored object can be decrypted without a sidecar record telling you how.
 */
export function encryptBytes(plaintext: Buffer, keyHex: string, version = 1): Buffer {
  const iv = randomBytes(12);
  const cipher = createCipheriv(ALGO, keyFromHex(keyHex), iv);
  const ct = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([Buffer.from([version]), iv, cipher.getAuthTag(), ct]);
}

export function decryptBytes(sealed: Buffer, keyHex: string): Buffer {
  if (sealed.length < 29) throw new Error('Sealed object is too short to be valid');
  const version = sealed[0];
  if (version !== 1) throw new Error(`Unsupported sealed object version: ${version}`);
  const decipher = createDecipheriv(ALGO, keyFromHex(keyHex), sealed.subarray(1, 13));
  decipher.setAuthTag(sealed.subarray(13, 29));
  return Buffer.concat([decipher.update(sealed.subarray(29)), decipher.final()]);
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

// ---------------------------------------------------------------------------
// Operator passwords
// ---------------------------------------------------------------------------

/**
 * Password hashing.
 *
 * A bare SHA-256 of the password — which is what this used to be — is
 * unsalted and fast, so identical passwords collide visibly and an attacker
 * with the table can test billions of candidates a second. scrypt is
 * deliberately slow and memory-hard, and every hash carries its own salt.
 *
 * Node's own crypto is enough here; a dependency for this would be a liability
 * of its own.
 *
 * Format: `scrypt$N$r$p$salt$hash`, all base64. Parameters travel with the hash
 * so they can be raised later without invalidating existing passwords.
 */
const SCRYPT_N = 16384; // ~16MB, roughly 50-100ms per hash
const SCRYPT_r = 8;
const SCRYPT_p = 1;
const SCRYPT_KEYLEN = 32;

export function hashPassword(plain: string): string {
  const salt = randomBytes(16);
  const derived = scryptSync(plain.normalize('NFKC'), salt, SCRYPT_KEYLEN, {
    N: SCRYPT_N,
    r: SCRYPT_r,
    p: SCRYPT_p,
    // scrypt needs headroom above N*r*128 or Node refuses to run.
    maxmem: 64 * 1024 * 1024,
  });
  return [
    'scrypt',
    SCRYPT_N,
    SCRYPT_r,
    SCRYPT_p,
    salt.toString('base64'),
    derived.toString('base64'),
  ].join('$');
}

export interface PasswordCheck {
  ok: boolean;
  /** True when the stored hash uses a superseded scheme and should be replaced. */
  needsRehash: boolean;
}

export function verifyPassword(plain: string, stored: string | null): PasswordCheck {
  if (!stored) return { ok: false, needsRehash: false };

  if (stored.startsWith('scrypt$')) {
    const [, n, r, p, salt, hash] = stored.split('$');
    if (!n || !r || !p || !salt || !hash) return { ok: false, needsRehash: false };
    const expected = Buffer.from(hash, 'base64');
    const derived = scryptSync(plain.normalize('NFKC'), Buffer.from(salt, 'base64'), expected.length, {
      N: Number(n),
      r: Number(r),
      p: Number(p),
      maxmem: 64 * 1024 * 1024,
    });
    const ok = derived.length === expected.length && timingSafeEqual(derived, expected);
    // Re-hash if the stored cost is below what we now use.
    return { ok, needsRehash: ok && Number(n) < SCRYPT_N };
  }

  // Legacy unsalted SHA-256. Accepted so existing accounts keep working, and
  // upgraded in place on the next successful sign-in.
  const ok = safeEqual(sha256(plain), stored);
  return { ok, needsRehash: ok };
}
