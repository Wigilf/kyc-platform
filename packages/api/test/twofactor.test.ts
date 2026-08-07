import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { hashPassword, totpCodeForStep, verifyTotp } from '@kyc/core';
import { decryptPii } from '@kyc/core';
import { prisma, provisionTenant } from '@kyc/db';
import { buildServer } from '../src/server.js';

/**
 * Two-factor authentication for the console.
 *
 * The cases worth writing are the ones where a second factor quietly stops
 * being one: a session handed out before the code is checked, a code that
 * works twice, unlimited guesses at six digits, and the ability to remove the
 * factor using only the thing it exists to backstop.
 */

const SLUG = 'kyc-2fa-test';
const PASSWORD = 'correct-horse-battery-staple';

let app: Awaited<ReturnType<typeof buildServer>>;
let tenantId: string;
let userId: string;

const login = (password = PASSWORD, email = 'reviewer@2fa-test.test') =>
  app.inject({ method: 'POST', url: '/v1/auth/login', payload: { email, password } });

const submitCode = (challenge: string, code: string) =>
  app.inject({ method: 'POST', url: '/v1/auth/login/2fa', payload: { challenge, code } });

/** The code an authenticator would be showing right now. */
async function currentCode(): Promise<string> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const secret = decryptPii(user.mfaSecret!, process.env.PII_ENCRYPTION_KEY!);
  return totpCodeForStep(secret, Math.floor(Date.now() / 1000 / 30));
}

/**
 * A code from a step that has not been spent yet.
 *
 * Confirming enrolment consumes the step it was proved with, so signing in
 * immediately afterwards has to wait for the clock — correct, and a real
 * papercut for anyone who enrols and signs straight back in.
 */
async function freshCode(): Promise<string> {
  const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
  const secret = decryptPii(user.mfaSecret!, process.env.PII_ENCRYPTION_KEY!);
  const step = Math.floor(Date.now() / 1000 / 30);
  // One step ahead is inside the drift window and cannot have been used.
  const next = user.mfaLastStep != null && user.mfaLastStep >= step ? step + 1 : step;
  return totpCodeForStep(secret, next);
}

beforeAll(async () => {
  const tenant = await provisionTenant({
    slug: SLUG,
    name: '2FA Test',
    homeCountry: 'GBR',
    industry: 'FINTECH',
  });
  tenantId = tenant.id;

  const user = await prisma.user.create({
    data: {
      tenantId,
      email: 'reviewer@2fa-test.test',
      name: 'Reviewer',
      role: 'COMPLIANCE_OFFICER',
      passwordHash: hashPassword(PASSWORD),
    },
  });
  userId = user.id;

  app = await buildServer();
  await app.ready();
}, 120_000);

afterAll(async () => {
  await app?.close();
  await prisma.tenant.deleteMany({ where: { slug: SLUG } });
});

describe('before anyone has enrolled', () => {
  it('signs in with a password alone', async () => {
    const response = await login();
    expect(response.statusCode).toBe(200);
    expect(response.json().mfaRequired).toBe(false);
    expect(response.json().token).toBeTruthy();
  }, 60_000);
});

describe('enrolling', () => {
  let session: string;
  let recoveryCodes: string[];

  it('does not switch on until a code proves the authenticator works', async () => {
    session = (await login()).json().token;

    const enrol = await app.inject({
      method: 'POST',
      url: '/v1/me/2fa/enrol',
      headers: { authorization: `Bearer ${session}` },
    });
    expect(enrol.statusCode).toBe(200);
    expect(enrol.json().uri).toContain('otpauth://totp/');
    recoveryCodes = enrol.json().recoveryCodes;
    expect(recoveryCodes).toHaveLength(10);

    // Enrolment started but not confirmed: a mistyped setup must not lock
    // someone out of their own account at the next sign-in.
    const status = await app.inject({
      method: 'GET',
      url: '/v1/me/2fa',
      headers: { authorization: `Bearer ${session}` },
    });
    expect(status.json().enabled).toBe(false);
    expect((await login()).json().mfaRequired).toBe(false);
  }, 60_000);

  it('rejects a wrong confirmation code', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/me/2fa/confirm',
      headers: { authorization: `Bearer ${session}` },
      payload: { code: '000000' },
    });
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  }, 60_000);

  it('switches on once a real code is presented', async () => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/me/2fa/confirm',
      headers: { authorization: `Bearer ${session}` },
      payload: { code: await currentCode() },
    });
    expect(response.statusCode).toBe(200);
    expect(response.json().enabled).toBe(true);
  }, 60_000);

  it('stores the shared secret encrypted, not in the clear', async () => {
    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    // One database read must not yield both factors.
    expect(user.mfaSecret).toBeTruthy();
    expect(user.mfaSecret).not.toMatch(/^[A-Z2-7]{32}$/);
    expect(() => decryptPii(user.mfaSecret!, process.env.PII_ENCRYPTION_KEY!)).not.toThrow();
  }, 60_000);
});

describe('signing in with a second factor', () => {
  it('gives no session until the code is presented', async () => {
    const response = await login();

    expect(response.json().mfaRequired).toBe(true);
    expect(response.json().challenge).toBeTruthy();
    // The point of the split: nothing usable exists yet.
    expect(response.json().token).toBeUndefined();
  }, 60_000);

  it('will not let the challenge itself act as a session', async () => {
    const challenge = (await login()).json().challenge as string;

    const response = await app.inject({
      method: 'GET',
      url: '/v1/applicants?limit=1',
      headers: { authorization: `Bearer ${challenge}` },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  }, 60_000);

  it('issues a session for a correct code', async () => {
    const challenge = (await login()).json().challenge as string;
    const response = await submitCode(challenge, await freshCode());

    expect(response.statusCode).toBe(200);
    expect(response.json().token).toBeTruthy();
  }, 60_000);

  it('refuses the same code a second time', async () => {
    const code = await currentCode();
    const first = await submitCode((await login()).json().challenge, code);
    // The first use may already have been spent by the test above; either way,
    // what matters is that a second attempt with the same code fails.
    const second = await submitCode((await login()).json().challenge, code);

    expect(second.statusCode).toBeGreaterThanOrEqual(400);
    expect([200, 400, 422]).toContain(first.statusCode);
  }, 60_000);
});

describe('guessing', () => {
  it('stops accepting attempts after a handful of wrong codes', async () => {
    await prisma.user.update({
      where: { id: userId },
      data: { mfaFailedAttempts: 0, mfaLockedUntil: null },
    });

    for (let i = 0; i < 5; i++) {
      const challenge = (await login()).json().challenge as string;
      await submitCode(challenge, '000000');
    }

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    // Six digits is a million combinations. Without a limit that is an
    // afternoon's work at a few requests a second.
    expect(user.mfaLockedUntil).not.toBeNull();
    expect(user.mfaLockedUntil!.getTime()).toBeGreaterThan(Date.now());

    // And a correct code is refused while the lock stands, so the lockout is
    // not merely advisory.
    const response = await submitCode((await login()).json().challenge, await freshCode());
    expect(response.statusCode).toBeGreaterThanOrEqual(400);
  }, 60_000);
});

describe('recovery codes', () => {
  it('lets a lost phone in exactly once per code', async () => {
    await prisma.user.update({
      where: { id: userId },
      data: { mfaFailedAttempts: 0, mfaLockedUntil: null, mfaLastStep: null },
    });

    const session = (await login()).json();
    // Re-enrol to obtain fresh codes we know the plaintext of.
    await prisma.user.update({
      where: { id: userId },
      data: { mfaSecret: null, mfaEnabledAt: null, mfaRecoveryHashes: [] },
    });
    const plain = (await login()).json().token as string;
    const enrol = await app.inject({
      method: 'POST',
      url: '/v1/me/2fa/enrol',
      headers: { authorization: `Bearer ${plain}` },
    });
    const codes = enrol.json().recoveryCodes as string[];
    await app.inject({
      method: 'POST',
      url: '/v1/me/2fa/confirm',
      headers: { authorization: `Bearer ${plain}` },
      payload: { code: await currentCode() },
    });

    expect(session).toBeTruthy();

    const first = await submitCode((await login()).json().challenge, codes[0]!);
    expect(first.statusCode).toBe(200);
    expect(first.json().token).toBeTruthy();

    // Single use: a recovery code left valid is a password that never expires.
    const again = await submitCode((await login()).json().challenge, codes[0]!);
    expect(again.statusCode).toBeGreaterThanOrEqual(400);

    // A different one still works.
    const other = await submitCode((await login()).json().challenge, codes[1]!);
    expect(other.statusCode).toBe(200);
  }, 60_000);
});

describe('turning it off', () => {
  it('needs the password as well as a code', async () => {
    const token = (await submitCode((await login()).json().challenge, await freshCode())).json()
      .token as string;

    const withoutPassword = await app.inject({
      method: 'POST',
      url: '/v1/me/2fa/disable',
      headers: { authorization: `Bearer ${token}` },
      payload: { password: 'wrong', code: await freshCode() },
    });
    // Otherwise anyone holding a stolen session simply removes the factor that
    // was there to stop them.
    expect(withoutPassword.statusCode).toBeGreaterThanOrEqual(400);

    const user = await prisma.user.findUniqueOrThrow({ where: { id: userId } });
    expect(user.mfaEnabledAt).not.toBeNull();
  }, 60_000);

  it('cannot be turned off at all when the organisation requires it', async () => {
    await prisma.tenant.update({ where: { id: tenantId }, data: { requireTwoFactor: true } });
    const token = (await submitCode((await login()).json().challenge, await freshCode())).json()
      .token as string;

    const response = await app.inject({
      method: 'POST',
      url: '/v1/me/2fa/disable',
      headers: { authorization: `Bearer ${token}` },
      payload: { password: PASSWORD, code: await freshCode() },
    });

    expect(response.statusCode).toBeGreaterThanOrEqual(400);
    await prisma.tenant.update({ where: { id: tenantId }, data: { requireTwoFactor: false } });
  }, 60_000);
});
