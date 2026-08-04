import type { FastifyPluginAsync } from 'fastify';
import { invalid, newSecret, notFound } from '@kyc/core';
import { prisma } from '@kyc/db';
import { signToken } from '../auth.js';

/**
 * The hosted verification demo.
 *
 * Sumsub-style products expose three surfaces: a link you send someone, an SDK
 * you embed, and the reviewer console. This is the first — a way to start a
 * verification with no account and no credentials, so the applicant experience
 * can actually be shown to somebody.
 *
 * That means one unauthenticated endpoint that creates an applicant, which is
 * exactly the kind of thing that should not exist in a real deployment. Three
 * constraints keep it honest:
 *
 *  - It only mounts when DEMO_MODE is true, and the auth allowlist names the
 *    path explicitly rather than matching a prefix.
 *  - Every session gets its own throwaway applicant, so nobody can reach anyone
 *    else's record: the token it returns is scoped to that applicant alone.
 *  - It is rate limited well below the global budget, because an open
 *    applicant-creating endpoint is otherwise free storage for a stranger.
 */

const demoRoutes: FastifyPluginAsync = async (app) => {
  if (process.env.DEMO_MODE !== 'true') return;

  app.post(
    '/v1/demo/sessions',
    {
      config: {
        rateLimit: {
          max: Number(process.env.DEMO_RATE_LIMIT ?? 10),
          timeWindow: '1 minute',
          // Per IP: there is no credential to key on.
          keyGenerator: (request) => `demo:${request.ip}`,
        },
      },
    },
    async (request, reply) => {
      const slug = process.env.DEMO_TENANT_SLUG ?? 'acme-fintech';
      const levelName = process.env.DEMO_LEVEL_NAME ?? 'standard-kyc-aml';

      const tenant = await prisma.tenant.findFirst({ where: { slug } });
      if (!tenant) throw notFound('Demo tenant', slug);

      const level = await prisma.verificationLevel.findFirst({
        where: { tenantId: tenant.id, name: levelName, isActive: true },
        orderBy: { version: 'desc' },
      });
      if (!level) throw notFound('Verification level', levelName);

      const externalUserId = `demo-session-${newSecret(8)}`;
      const applicant = await prisma.applicant.create({
        data: {
          tenantId: tenant.id,
          externalUserId,
          levelId: level.id,
          // Tagged so demo traffic is distinguishable from seeded scenarios and
          // can be cleared without touching either.
          tags: ['hosted-demo'],
          ipAddress: request.ip,
          userAgent: String(request.headers['user-agent'] ?? ''),
        },
      });

      const ttlSeconds = Math.min(Number(process.env.DEMO_TOKEN_TTL ?? 3600), 7200);

      return reply.status(201).send({
        token: signToken(
          {
            sub: applicant.id,
            kind: 'applicant',
            tenantId: tenant.id,
            externalUserId,
          },
          ttlSeconds,
        ),
        applicantId: applicant.id,
        externalUserId,
        levelName: level.name,
        levelDisplayName: level.displayName,
        expiresInSeconds: ttlSeconds,
        simulated: (process.env.ADAPTER_MODE ?? 'mock') !== 'live',
      });
    },
  );

  /**
   * What the reviewer would see, for the same applicant.
   *
   * The point of the demo is the whole loop, and an applicant who submits and
   * is told "we'll be in touch" has seen half of it. This exposes the decision
   * and the checks behind it — for this applicant only, on their own token.
   */
  app.get<{ Params: { id: string } }>('/v1/demo/outcome/:id', async (request) => {
    const caller = request.caller;
    if (!caller || caller.kind !== 'applicant' || caller.applicantId !== request.params.id) {
      throw invalid('This endpoint only serves the applicant it was issued for.');
    }

    const applicant = await prisma.applicant.findFirstOrThrow({
      where: { id: request.params.id, tenantId: caller.tenantId },
      include: {
        checks: { orderBy: { createdAt: 'desc' } },
        screeningRuns: {
          orderBy: { startedAt: 'desc' },
          take: 1,
          include: { hits: { orderBy: { matchScore: 'desc' }, take: 5 } },
        },
        reviews: { orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });

    // Latest check per type: the applicant should see the current state, not
    // every superseded attempt.
    const latest = new Map<string, (typeof applicant.checks)[number]>();
    for (const c of applicant.checks) if (!latest.has(c.type)) latest.set(c.type, c);

    return {
      reviewStatus: applicant.reviewStatus,
      riskScore: applicant.riskScore,
      riskLevel: applicant.riskLevel,
      decidedAt: applicant.reviewedAt,
      automated: applicant.reviews[0]?.source === 'AUTOMATED',
      checks: [...latest.values()].map((c) => ({
        type: c.type,
        status: c.status,
        result: c.result,
        provider: c.provider,
        rejectLabels: c.rejectLabels,
        findings: c.findings,
      })),
      screening: {
        searched: applicant.screeningRuns[0]?.hitCount ?? 0,
        hits: (applicant.screeningRuns[0]?.hits ?? []).map((h) => ({
          listName: h.listName,
          matchedName: h.matchedName,
          matchScore: h.matchScore,
          matchedFields: h.matchedFields,
        })),
      },
    };
  });
};

export default demoRoutes;
