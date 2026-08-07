import type { FastifyPluginAsync } from 'fastify';
import {
  decryptPii,
  encryptPii,
  generateRecoveryCodes,
  generateTotpSecret,
  hashRecoveryCode,
  invalid,
  matchRecoveryCode,
  totpUri,
  verifyPassword,
  verifyTotp,
} from '@kyc/core';
import { prisma } from '@kyc/db';
import { requireBackend, signToken, verifyToken, writeAudit } from '../auth.js';

/**
 * Second factor for the reviewer console.
 *
 * The console shows identity documents, dates of birth, addresses and sanctions
 * matches for every applicant a business has onboarded, and it was reachable
 * with a password alone.
 *
 * Login becomes two steps for anyone enrolled: the password buys a short-lived
 * *challenge* token that can do nothing except present a code, and only the
 * code yields a session. That split matters — issuing the session first and
 * checking the code afterwards means the session existed, and anything holding
 * it was already inside.
 */

/** Long enough to fetch a phone from another room, short enough to be useless later. */
const CHALLENGE_TTL_SECONDS = 300;

/** Wrong codes tolerated before the account stops accepting them. */
const MAX_FAILURES = 5;
const LOCKOUT_MINUTES = 15;

const twoFactorRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Step two of signing in.
   *
   * Accepts either a code from the authenticator or one of the recovery codes.
   */
  app.post<{ Body: { challenge: string; code: string } }>(
    '/v1/auth/login/2fa',
    async (request) => {
      const { challenge, code } = request.body ?? {};
      if (!challenge || !code) throw invalid('challenge and code are required');

      const payload = verifyToken<{ sub: string; kind: string; tenantId: string }>(challenge);
      if (payload.kind !== 'mfa-challenge') {
        throw invalid('That is not a sign-in challenge');
      }

      const user = await prisma.user.findFirst({
        where: { id: payload.sub, tenantId: payload.tenantId, isActive: true },
        include: { tenant: { select: { id: true, name: true, slug: true } } },
      });
      if (!user?.mfaSecret) throw invalid('Two-factor authentication is not set up');

      if (user.mfaLockedUntil && user.mfaLockedUntil > new Date()) {
        throw invalid(
          'Too many incorrect codes. Try again in a few minutes or use a recovery code.',
        );
      }

      const secret = decryptPii(user.mfaSecret, encryptionKey());
      const check = verifyTotp(secret, code, { lastUsedStep: user.mfaLastStep });

      let usedRecovery: string | null = null;
      if (!check.ok) {
        usedRecovery = matchRecoveryCode(code, user.mfaRecoveryHashes);
      }

      if (!check.ok && !usedRecovery) {
        const failures = user.mfaFailedAttempts + 1;
        await prisma.user.update({
          where: { id: user.id },
          data: {
            mfaFailedAttempts: failures,
            // Six digits is a million combinations; at a few requests a second
            // and no limit, that is an afternoon's work.
            ...(failures >= MAX_FAILURES
              ? { mfaLockedUntil: new Date(Date.now() + LOCKOUT_MINUTES * 60_000) }
              : {}),
          },
        });
        await writeAudit(request, {
          action: 'auth.2fa.failed',
          resourceType: 'User',
          resourceId: user.id,
          after: { attempt: failures, locked: failures >= MAX_FAILURES },
        });
        throw invalid('That code is not right');
      }

      await prisma.user.update({
        where: { id: user.id },
        data: {
          mfaFailedAttempts: 0,
          mfaLockedUntil: null,
          lastLoginAt: new Date(),
          // Spent, either way: the time step cannot be reused, and a recovery
          // code is struck off the list.
          ...(check.step != null ? { mfaLastStep: check.step } : {}),
          ...(usedRecovery
            ? { mfaRecoveryHashes: user.mfaRecoveryHashes.filter((h) => h !== usedRecovery) }
            : {}),
        },
      });

      await writeAudit(request, {
        action: usedRecovery ? 'auth.2fa.recovery_used' : 'auth.2fa.passed',
        resourceType: 'User',
        resourceId: user.id,
        after: usedRecovery
          ? { remainingRecoveryCodes: user.mfaRecoveryHashes.length - 1 }
          : undefined,
      });

      return {
        token: signToken(
          { sub: user.id, kind: 'user', tenantId: user.tenantId, role: user.role, email: user.email },
          8 * 3600,
        ),
        user: { id: user.id, name: user.name, email: user.email, role: user.role },
        tenant: user.tenant,
        ...(usedRecovery
          ? { recoveryCodesRemaining: user.mfaRecoveryHashes.length - 1 }
          : {}),
      };
    },
  );

  /**
   * Begin enrolment.
   *
   * Returns the secret and the recovery codes, once. Nothing is switched on
   * until a code proves the authenticator was actually configured — otherwise a
   * mistyped setup locks someone out of their own account at the next login.
   */
  app.post('/v1/me/2fa/enrol', async (request) => {
    const caller = requireBackend(request);
    if (caller.kind !== 'user') throw invalid('Only a signed-in user can enrol a second factor');

    const user = await prisma.user.findUniqueOrThrow({ where: { id: caller.userId } });
    if (user.mfaEnabledAt) {
      throw invalid(
        'Two-factor authentication is already on for this account. Turn it off first to re-enrol.',
      );
    }

    const secret = generateTotpSecret();
    const recovery = generateRecoveryCodes();

    await prisma.user.update({
      where: { id: user.id },
      data: {
        mfaSecret: encryptPii(secret, encryptionKey()),
        mfaRecoveryHashes: recovery.map(hashRecoveryCode),
        // Not enabled yet. Confirm does that.
        mfaEnabledAt: null,
        mfaLastStep: null,
        mfaFailedAttempts: 0,
        mfaLockedUntil: null,
      },
    });

    return {
      secret,
      uri: totpUri({ secret, account: user.email, issuer: 'KYC Console' }),
      // Shown once. They are not retrievable afterwards, only replaceable.
      recoveryCodes: recovery,
    };
  });

  /** Finish enrolment by proving the authenticator works. */
  app.post<{ Body: { code: string } }>('/v1/me/2fa/confirm', async (request) => {
    const caller = requireBackend(request);
    if (caller.kind !== 'user') throw invalid('Only a signed-in user can enrol a second factor');

    const user = await prisma.user.findUniqueOrThrow({ where: { id: caller.userId } });
    if (!user.mfaSecret) throw invalid('Start enrolment first');

    const check = verifyTotp(decryptPii(user.mfaSecret, encryptionKey()), request.body?.code ?? '');
    if (!check.ok) throw invalid('That code is not right. Check your authenticator and try again.');

    await prisma.user.update({
      where: { id: user.id },
      data: { mfaEnabledAt: new Date(), mfaLastStep: check.step },
    });

    await writeAudit(request, {
      action: 'auth.2fa.enabled',
      resourceType: 'User',
      resourceId: user.id,
    });

    return { enabled: true };
  });

  /**
   * Turn it off.
   *
   * Requires the password *and* a current code. Turning off a second factor
   * with only the thing the second factor exists to backstop would make it
   * decorative: anyone who had stolen the session could simply remove it.
   */
  app.post<{ Body: { password: string; code: string } }>('/v1/me/2fa/disable', async (request) => {
    const caller = requireBackend(request);
    if (caller.kind !== 'user') throw invalid('Only a signed-in user can change this');

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: caller.userId },
      include: { tenant: { select: { requireTwoFactor: true } } },
    });
    if (user.tenant.requireTwoFactor) {
      throw invalid(
        'This organisation requires two-factor authentication, so it cannot be turned off.',
      );
    }
    if (!user.mfaSecret || !user.mfaEnabledAt) throw invalid('It is not currently on');

    if (!verifyPassword(request.body?.password ?? '', user.passwordHash).ok) {
      throw invalid('Password is not right');
    }
    const check = verifyTotp(decryptPii(user.mfaSecret, encryptionKey()), request.body?.code ?? '', {
      lastUsedStep: user.mfaLastStep,
    });
    if (!check.ok) throw invalid('That code is not right');

    await prisma.user.update({
      where: { id: user.id },
      data: {
        mfaSecret: null,
        mfaEnabledAt: null,
        mfaLastStep: null,
        mfaRecoveryHashes: [],
        mfaFailedAttempts: 0,
        mfaLockedUntil: null,
      },
    });

    await writeAudit(request, {
      action: 'auth.2fa.disabled',
      resourceType: 'User',
      resourceId: user.id,
    });

    return { enabled: false };
  });

  /** What the settings screen needs to render. */
  app.get('/v1/me/2fa', async (request) => {
    const caller = requireBackend(request);
    if (caller.kind !== 'user') return { enabled: false, required: false, recoveryCodesLeft: 0 };

    const user = await prisma.user.findUniqueOrThrow({
      where: { id: caller.userId },
      include: { tenant: { select: { requireTwoFactor: true } } },
    });

    return {
      enabled: Boolean(user.mfaEnabledAt),
      required: user.tenant.requireTwoFactor,
      recoveryCodesLeft: user.mfaRecoveryHashes.length,
      enabledAt: user.mfaEnabledAt,
    };
  });
};

/**
 * The key the TOTP secret is sealed with.
 *
 * Required rather than optional: a shared secret stored in the clear next to
 * the password hash means one database read yields both factors, which is one
 * factor with extra steps.
 */
function encryptionKey(): string {
  const key = process.env.PII_ENCRYPTION_KEY;
  if (!key) {
    throw new Error(
      'PII_ENCRYPTION_KEY is required for two-factor authentication; the TOTP secret ' +
        'is not stored unencrypted.',
    );
  }
  return key;
}

export default twoFactorRoutes;
