import { describe, expect, it } from 'vitest';
import {
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  matchRecoveryCode,
  totpCodeForStep,
  totpUri,
  verifyTotp,
} from '../src/totp.js';

/**
 * One-time passwords.
 *
 * The interesting cases are not "does a correct code work" but the three ways
 * a second factor stops being one: a code that can be used twice, a window so
 * wide that guessing pays, and a comparison that leaks how close a guess was.
 */

// RFC 6238 publishes test vectors against the ASCII secret "12345678901234567890",
// which is this in base32. Matching them is what proves the implementation is
// the standard one rather than merely self-consistent.
const RFC_SECRET = 'GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ';

describe('against the published test vectors', () => {
  it('produces the codes RFC 6238 says it should', () => {
    // The published table gives eight-digit codes at particular times; these
    // are the low six digits, which is what a standard authenticator shows.
    //   T=59          → step 1        → 94287082
    //   T=1111111109  → step 37037036 → 07081804
    //   T=1111111111  → step 37037037 → 14050471
    //   T=1234567890  → step 41152263 → 89005924
    //   T=2000000000  → step 66666666 → 69279037
    expect(totpCodeForStep(RFC_SECRET, 1)).toBe('287082');
    expect(totpCodeForStep(RFC_SECRET, 37037036)).toBe('081804');
    expect(totpCodeForStep(RFC_SECRET, 37037037)).toBe('050471');
    expect(totpCodeForStep(RFC_SECRET, 41152263)).toBe('005924');
    expect(totpCodeForStep(RFC_SECRET, 66666666)).toBe('279037');
  });
});

describe('verifying a code', () => {
  const secret = generateTotpSecret();
  const at = (seconds: number) => new Date(seconds * 1000);

  it('accepts the current code', () => {
    const now = at(1_800_000_000);
    const step = Math.floor(1_800_000_000 / 30);
    expect(verifyTotp(secret, totpCodeForStep(secret, step), { now }).ok).toBe(true);
  });

  it('tolerates a clock thirty seconds out in either direction', () => {
    const now = at(1_800_000_000);
    const step = Math.floor(1_800_000_000 / 30);
    expect(verifyTotp(secret, totpCodeForStep(secret, step - 1), { now }).ok).toBe(true);
    expect(verifyTotp(secret, totpCodeForStep(secret, step + 1), { now }).ok).toBe(true);
  });

  it('does not tolerate a clock two steps out', () => {
    // Every extra step of tolerance is another code an attacker may guess.
    const now = at(1_800_000_000);
    const step = Math.floor(1_800_000_000 / 30);
    expect(verifyTotp(secret, totpCodeForStep(secret, step - 2), { now }).ok).toBe(false);
    expect(verifyTotp(secret, totpCodeForStep(secret, step + 2), { now }).ok).toBe(false);
  });

  it('refuses a code that has already been used', () => {
    const now = at(1_800_000_000);
    const step = Math.floor(1_800_000_000 / 30);
    const code = totpCodeForStep(secret, step);

    const first = verifyTotp(secret, code, { now });
    expect(first.ok).toBe(true);
    expect(first.step).toBe(step);

    // Someone reading over a shoulder, or replaying an intercepted request,
    // otherwise has the rest of the window to use it themselves.
    expect(verifyTotp(secret, code, { now, lastUsedStep: first.step }).ok).toBe(false);
  });

  it('refuses an older code once a newer one has been used', () => {
    const now = at(1_800_000_000);
    const step = Math.floor(1_800_000_000 / 30);
    expect(
      verifyTotp(secret, totpCodeForStep(secret, step - 1), { now, lastUsedStep: step }).ok,
    ).toBe(false);
  });

  it('rejects anything that is not six digits without consulting the secret', () => {
    const now = at(1_800_000_000);
    for (const bad of ['', '12345', '1234567', 'abcdef', '12 34 56 78']) {
      expect(verifyTotp(secret, bad, { now }).ok).toBe(false);
    }
    // Spacing as an authenticator app displays it is still fine.
    const step = Math.floor(1_800_000_000 / 30);
    const spaced = totpCodeForStep(secret, step).replace(/^(\d{3})(\d{3})$/, '$1 $2');
    expect(verifyTotp(secret, spaced, { now }).ok).toBe(true);
  });
});

describe('the enrolment URI', () => {
  it('carries what an authenticator app needs', () => {
    const uri = totpUri({ secret: 'ABCDEF', account: 'ada@example.test', issuer: 'KYC Console' });
    expect(uri.startsWith('otpauth://totp/')).toBe(true);
    expect(uri).toContain(encodeURIComponent('KYC Console:ada@example.test'));
    expect(uri).toContain('secret=ABCDEF');
    expect(uri).toContain('period=30');
    expect(uri).toContain('digits=6');
  });
});

describe('recovery codes', () => {
  it('generates distinct codes and stores only their hashes', () => {
    const codes = generateRecoveryCodes(10);
    expect(new Set(codes).size).toBe(10);

    const hashes = codes.map(hashRecoveryCode);
    // Nothing recognisable from the code itself may survive into storage.
    for (const [i, hash] of hashes.entries()) {
      expect(hash).not.toContain(codes[i]!.replace(/-/g, ''));
    }
  });

  it('matches regardless of how the user typed it', () => {
    const [code] = generateRecoveryCodes(1);
    const hashes = [hashRecoveryCode(code!)];

    for (const variant of [code!, code!.toUpperCase(), code!.replace(/-/g, ''), ` ${code!} `]) {
      expect(matchRecoveryCode(variant, hashes)).toBe(hashes[0]);
    }
  });

  it('returns nothing for a code that was never issued', () => {
    const hashes = generateRecoveryCodes(5).map(hashRecoveryCode);
    expect(matchRecoveryCode('zzzz-zzzz-zzzz-zzzz', hashes)).toBeNull();
  });
});
