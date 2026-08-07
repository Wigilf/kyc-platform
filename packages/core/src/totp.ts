import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

/**
 * Time-based one-time passwords (RFC 6238), for the reviewer console.
 *
 * The console shows identity documents, dates of birth, addresses and sanctions
 * matches for every applicant a business has ever onboarded, and it was behind
 * a single password. A password is one credential and it leaks: reused,
 * phished, or sitting in somebody's browser on a shared machine.
 *
 * Implemented here rather than pulled in because it is sixty lines of HMAC and
 * a dependency in the authentication path is a dependency that can be
 * compromised into the authentication path. The three details that are easy to
 * get wrong are all handled explicitly below: constant-time comparison, a drift
 * window in both directions, and refusing to accept the same code twice.
 */

/** RFC 6238 defaults, and what every authenticator app assumes. */
const STEP_SECONDS = 30;
const DIGITS = 6;

/**
 * How far out of step a clock may be, in either direction.
 *
 * One step each way — thirty seconds — is the usual compromise. Wider is
 * friendlier to a phone whose clock has drifted and proportionally more
 * generous to someone guessing, since each extra step is another accepted code.
 */
const DRIFT_STEPS = 1;

const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** A new shared secret, base32 so an authenticator app can accept it typed. */
export function generateTotpSecret(bytes = 20): string {
  return base32Encode(randomBytes(bytes));
}

/**
 * The URI an authenticator app expects behind a QR code.
 *
 * `issuer` appears as the account's heading in the app, so it should name the
 * product rather than the tenant — someone with logins to three businesses
 * needs to tell the entries apart by the account label, not the heading.
 */
export function totpUri(args: { secret: string; account: string; issuer: string }): string {
  const label = encodeURIComponent(`${args.issuer}:${args.account}`);
  const params = new URLSearchParams({
    secret: args.secret,
    issuer: args.issuer,
    algorithm: 'SHA1',
    digits: String(DIGITS),
    period: String(STEP_SECONDS),
  });
  return `otpauth://totp/${label}?${params.toString()}`;
}

/** The code for one time step. Exported for tests and for nothing else. */
export function totpCodeForStep(secret: string, step: number): string {
  const key = base32Decode(secret);
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));

  const digest = createHmac('sha1', key).update(counter).digest();
  // Dynamic truncation, RFC 4226 §5.4: the low nibble of the last byte picks
  // where to read the four-byte window from.
  const offset = digest[digest.length - 1]! & 0x0f;
  const binary =
    ((digest[offset]! & 0x7f) << 24) |
    ((digest[offset + 1]! & 0xff) << 16) |
    ((digest[offset + 2]! & 0xff) << 8) |
    (digest[offset + 3]! & 0xff);

  return String(binary % 10 ** DIGITS).padStart(DIGITS, '0');
}

export interface TotpCheck {
  ok: boolean;
  /**
   * The step the accepted code belonged to.
   *
   * The caller must store this and refuse anything not strictly greater next
   * time. Without that a code stays usable for its whole window and for the
   * drift either side of it — long enough for someone reading over a shoulder,
   * or replaying a request they intercepted, to use it themselves.
   */
  step: number | null;
}

export function verifyTotp(
  secret: string,
  code: string,
  options: { now?: Date; lastUsedStep?: number | null } = {},
): TotpCheck {
  const cleaned = code.replace(/\s+/g, '');
  if (!/^\d{6}$/.test(cleaned)) return { ok: false, step: null };

  const current = Math.floor((options.now ?? new Date()).getTime() / 1000 / STEP_SECONDS);

  for (let drift = -DRIFT_STEPS; drift <= DRIFT_STEPS; drift++) {
    const step = current + drift;
    // Already used, or older than one that was: not acceptable again.
    if (options.lastUsedStep != null && step <= options.lastUsedStep) continue;
    if (equals(totpCodeForStep(secret, step), cleaned)) return { ok: true, step };
  }

  return { ok: false, step: null };
}

// ---------------------------------------------------------------------------
// Recovery codes
// ---------------------------------------------------------------------------

/**
 * Codes for the phone that fell in the sea.
 *
 * Shown once, stored only as hashes, and single-use. Without them, losing a
 * phone means an administrator turning off the second factor for someone who
 * cannot prove who they are over the telephone — which is the attack the second
 * factor was for.
 */
export function generateRecoveryCodes(count = 10): string[] {
  return Array.from({ length: count }, () => {
    const raw = base32Encode(randomBytes(10)).slice(0, 16).toLowerCase();
    return `${raw.slice(0, 4)}-${raw.slice(4, 8)}-${raw.slice(8, 12)}-${raw.slice(12, 16)}`;
  });
}

export function hashRecoveryCode(code: string): string {
  // A recovery code is high-entropy and randomly generated, so a plain digest
  // is enough — the slow hashing a password needs exists to survive being
  // guessable, and these are not.
  return createHmac('sha256', 'kyc-recovery-code').update(normaliseRecovery(code)).digest('hex');
}

export function normaliseRecovery(code: string): string {
  return code.trim().toLowerCase().replace(/[^a-z0-9]/g, '');
}

/** The matching hash, or null. Constant-time against every candidate. */
export function matchRecoveryCode(code: string, hashes: string[]): string | null {
  const candidate = hashRecoveryCode(code);
  let found: string | null = null;
  // Every hash is compared even after a match, so the time taken does not
  // reveal how far down the list the used code sat.
  for (const hash of hashes) {
    if (equals(hash, candidate)) found = hash;
  }
  return found;
}

// ---------------------------------------------------------------------------

function equals(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

function base32Encode(buffer: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of buffer) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

function base32Decode(input: string): Buffer {
  const cleaned = input.toUpperCase().replace(/=+$/, '').replace(/\s+/g, '');
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of cleaned) {
    const index = BASE32.indexOf(char);
    if (index === -1) throw new Error(`Invalid base32 character in secret: ${char}`);
    value = (value << 5) | index;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 0xff);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}
