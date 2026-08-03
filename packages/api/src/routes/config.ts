import type { FastifyPluginAsync } from 'fastify';
import {
  CreateLevelSchema,
  CreateRuleSchema,
  CreateWebhookSchema,
  LEVEL_TEMPLATES,
  UpdateLevelStepsSchema,
  evaluateRules,
  generateApiKey,
  invalid,
  newSecret,
  validateRule,
} from '@kyc/core';
import { prisma } from '@kyc/db';
import { requireBackend, requireRole, signToken, writeAudit } from '../auth.js';

/**
 * Tenant configuration: levels, rules, webhooks, API keys, queues.
 *
 * Everything here is versioned or append-only. Compliance configuration that can
 * be changed without a trace is compliance configuration you cannot defend, so a
 * rule edit writes a new RuleVersion and a level edit bumps the level version
 * rather than mutating the one that past decisions were made under.
 */

const configRoutes: FastifyPluginAsync = async (app) => {
  // --- Login (dev-grade; a real deployment puts SSO in front) ---
  app.post<{ Body: { email: string; password: string } }>(
    '/v1/auth/login',
    async (request) => {
      const { email, password } = request.body ?? {};
      if (!email || !password) throw invalid('email and password are required');

      const user = await prisma.user.findFirst({
        where: { email: email.toLowerCase(), isActive: true },
        include: { tenant: { select: { id: true, name: true, slug: true } } },
      });

      const { sha256, safeEqual } = await import('@kyc/core');
      // Uniform failure: distinguishing "no such user" from "wrong password" is a
      // user-enumeration oracle.
      if (!user?.passwordHash || !safeEqual(sha256(password), user.passwordHash)) {
        throw invalid('Invalid credentials');
      }

      await prisma.user.update({
        where: { id: user.id },
        data: { lastLoginAt: new Date() },
      });

      return {
        token: signToken(
          { sub: user.id, kind: 'user', tenantId: user.tenantId, role: user.role, email: user.email },
          8 * 3600,
        ),
        user: { id: user.id, name: user.name, email: user.email, role: user.role },
        tenant: user.tenant,
      };
    },
  );

  app.get('/v1/me', async (request) => {
    const caller = requireBackend(request);
    const tenant = await prisma.tenant.findUniqueOrThrow({
      where: { id: caller.tenantId },
      select: { id: true, name: true, slug: true, industry: true, homeCountry: true },
    });
    return { caller, tenant };
  });

  // --- Levels ---
  app.get('/v1/levels', async (request) => {
    const caller = requireBackend(request);
    const levels = await prisma.verificationLevel.findMany({
      where: { tenantId: caller.tenantId },
      orderBy: [{ name: 'asc' }, { version: 'desc' }],
    });
    return {
      levels,
      // The built-in templates a tenant can clone, exposed so the designer UI does
      // not have to hard-code them.
      templates: Object.values(LEVEL_TEMPLATES).map((t) => ({
        name: t.name,
        displayName: t.displayName,
        description: t.description,
        subjectType: t.subjectType,
        stepCount: t.steps.length,
      })),
    };
  });

  app.post('/v1/levels', async (request, reply) => {
    const user = requireRole(request, 'COMPLIANCE_OFFICER');
    const body = CreateLevelSchema.parse(request.body);

    const latest = await prisma.verificationLevel.findFirst({
      where: { tenantId: user.tenantId, name: body.name },
      orderBy: { version: 'desc' },
    });

    const level = await prisma.verificationLevel.create({
      data: {
        tenantId: user.tenantId,
        name: body.name,
        displayName: body.displayName,
        description: body.description,
        subjectType: body.subjectType as never,
        // New version rather than an in-place edit: applicants already decided
        // under version N must remain explainable against version N.
        version: (latest?.version ?? 0) + 1,
        steps: body.steps as never,
        allowedCountries: body.allowedCountries,
        blockedCountries: body.blockedCountries,
        autoApprove: body.autoApprove,
        autoReject: body.autoReject,
        manualReviewScore: body.manualReviewScore,
        autoRejectScore: body.autoRejectScore,
        reverifyAfterDays: body.reverifyAfterDays,
        screeningConfig: body.screeningConfig as never,
      },
    });

    await writeAudit(request, {
      action: 'level.created',
      resourceType: 'VerificationLevel',
      resourceId: level.id,
      after: { name: level.name, version: level.version },
    });

    return reply.status(201).send({ level });
  });

  app.post<{ Params: { name: string } }>(
    '/v1/levels/:name/clone-template',
    async (request, reply) => {
      const user = requireRole(request, 'COMPLIANCE_OFFICER');
      const template = LEVEL_TEMPLATES[request.params.name];
      if (!template) throw invalid(`Unknown template: ${request.params.name}`);

      const existing = await prisma.verificationLevel.findFirst({
        where: { tenantId: user.tenantId, name: template.name },
        orderBy: { version: 'desc' },
      });

      const level = await prisma.verificationLevel.create({
        data: {
          tenantId: user.tenantId,
          name: template.name,
          displayName: template.displayName,
          description: template.description,
          subjectType: template.subjectType as never,
          version: (existing?.version ?? 0) + 1,
          steps: template.steps as never,
          allowedCountries: template.allowedCountries,
          blockedCountries: template.blockedCountries,
          autoApprove: template.autoApprove,
          autoReject: template.autoReject,
          manualReviewScore: template.manualReviewScore,
          autoRejectScore: template.autoRejectScore,
          reverifyAfterDays: template.reverifyAfterDays,
          screeningConfig: template.screeningConfig as never,
        },
      });

      return reply.status(201).send({ level });
    },
  );

  app.patch<{ Params: { id: string } }>('/v1/levels/:id/steps', async (request) => {
    const user = requireRole(request, 'COMPLIANCE_OFFICER');
    const body = UpdateLevelStepsSchema.parse(request.body);

    const current = await prisma.verificationLevel.findFirstOrThrow({
      where: { id: request.params.id, tenantId: user.tenantId },
    });

    const level = await prisma.verificationLevel.create({
      data: {
        tenantId: user.tenantId,
        name: current.name,
        displayName: current.displayName,
        description: body.changeNote ?? current.description,
        subjectType: current.subjectType,
        version: current.version + 1,
        steps: body.steps as never,
        allowedCountries: current.allowedCountries,
        blockedCountries: current.blockedCountries,
        autoApprove: current.autoApprove,
        autoReject: current.autoReject,
        manualReviewScore: current.manualReviewScore,
        autoRejectScore: current.autoRejectScore,
        reverifyAfterDays: current.reverifyAfterDays,
        screeningConfig: current.screeningConfig as never,
      },
    });

    // Old versions stay readable but stop being offered to new applicants.
    await prisma.verificationLevel.update({
      where: { id: current.id },
      data: { isActive: false },
    });

    await writeAudit(request, {
      action: 'level.steps.updated',
      resourceType: 'VerificationLevel',
      resourceId: level.id,
      before: { version: current.version },
      after: { version: level.version, changeNote: body.changeNote },
    });

    return { level };
  });

  // --- Rules ---
  app.get('/v1/rules', async (request) => {
    const caller = requireBackend(request);
    const rules = await prisma.rule.findMany({
      where: { tenantId: caller.tenantId },
      orderBy: [{ scope: 'asc' }, { priority: 'asc' }],
      include: { _count: { select: { versions: true } } },
    });
    return { rules };
  });

  app.post('/v1/rules', async (request, reply) => {
    const user = requireRole(request, 'COMPLIANCE_OFFICER');
    const body = CreateRuleSchema.parse(request.body);

    // Validate the AST before persisting: a malformed rule that only fails at
    // evaluation time is a rule that silently stops protecting anyone.
    const validation = validateRule({
      name: body.name,
      scope: body.scope,
      priority: body.priority,
      isActive: body.isActive,
      isShadow: body.isShadow,
      conditions: body.conditions,
      actions: body.actions,
    });
    if (!validation.valid) {
      throw invalid('Rule definition is not valid', validation.errors);
    }

    const rule = await prisma.rule.upsert({
      where: { tenantId_name: { tenantId: user.tenantId, name: body.name } },
      create: {
        tenantId: user.tenantId,
        name: body.name,
        description: body.description,
        scope: body.scope as never,
        priority: body.priority,
        isActive: body.isActive,
        isShadow: body.isShadow,
        conditions: body.conditions as never,
        actions: body.actions as never,
        versions: {
          create: {
            version: 1,
            conditions: body.conditions as never,
            actions: body.actions as never,
            changeNote: body.changeNote ?? 'Initial version',
            authorId: user.userId,
          },
        },
      },
      update: {
        description: body.description,
        priority: body.priority,
        isActive: body.isActive,
        isShadow: body.isShadow,
        conditions: body.conditions as never,
        actions: body.actions as never,
        currentVersion: { increment: 1 },
      },
    });

    // Every edit is a new version with an author. This is the trail a regulator
    // asks for when they ask "who changed the threshold, and when".
    const existingVersions = await prisma.ruleVersion.count({ where: { ruleId: rule.id } });
    if (existingVersions > 0 && existingVersions < rule.currentVersion) {
      await prisma.ruleVersion.create({
        data: {
          ruleId: rule.id,
          version: rule.currentVersion,
          conditions: body.conditions as never,
          actions: body.actions as never,
          changeNote: body.changeNote ?? 'Updated',
          authorId: user.userId,
        },
      });
    }

    await writeAudit(request, {
      action: 'rule.saved',
      resourceType: 'Rule',
      resourceId: rule.id,
      after: { name: rule.name, version: rule.currentVersion, isShadow: rule.isShadow },
    });

    return reply.status(201).send({ rule });
  });

  /**
   * Dry-run a rule against supplied facts.
   *
   * This is what makes the rules engine usable by a non-engineer: they can see
   * exactly which conditions matched and why, before the rule touches a customer.
   */
  app.post<{ Body: { rule: unknown; facts: Record<string, unknown> } }>(
    '/v1/rules/test',
    async (request) => {
      requireRole(request, 'COMPLIANCE_OFFICER');
      const validation = validateRule(request.body.rule);
      if (!validation.valid) return { valid: false, errors: validation.errors };

      const result = evaluateRules([validation.rule], request.body.facts ?? {});
      return {
        valid: true,
        fired: result.fired.length > 0,
        // Per-condition trace, not just a boolean: "why didn't my rule fire" is
        // the question this endpoint exists to answer.
        trace: result.fired[0]?.trace ?? [],
        actions: result.actions,
        riskDelta: result.riskDelta,
        skipped: result.skipped,
      };
    },
  );

  // --- Webhooks ---
  app.get('/v1/webhooks', async (request) => {
    const caller = requireBackend(request);
    const endpoints = await prisma.webhookEndpoint.findMany({
      where: { tenantId: caller.tenantId },
      select: {
        id: true,
        url: true,
        description: true,
        eventTypes: true,
        isActive: true,
        environment: true,
        consecutiveFailures: true,
        disabledAt: true,
        createdAt: true,
        _count: { select: { deliveries: true } },
      },
    });
    return { endpoints };
  });

  app.post('/v1/webhooks', async (request, reply) => {
    const user = requireRole(request, 'ADMIN');
    const body = CreateWebhookSchema.parse(request.body);
    const secret = newSecret(32);

    const endpoint = await prisma.webhookEndpoint.create({
      data: {
        tenantId: user.tenantId,
        url: body.url,
        description: body.description,
        eventTypes: body.eventTypes,
        environment: body.environment as never,
        secret,
      },
    });

    await writeAudit(request, {
      action: 'webhook.created',
      resourceType: 'WebhookEndpoint',
      resourceId: endpoint.id,
      after: { url: endpoint.url },
    });

    return reply.status(201).send({
      endpoint: { id: endpoint.id, url: endpoint.url, eventTypes: endpoint.eventTypes },
      // Shown once. It is never readable again, which is the point.
      secret,
    });
  });

  app.get<{ Querystring: { endpointId?: string; status?: string } }>(
    '/v1/webhooks/deliveries',
    async (request) => {
      const caller = requireBackend(request);
      const deliveries = await prisma.webhookDelivery.findMany({
        where: {
          endpoint: { tenantId: caller.tenantId },
          ...(request.query.endpointId ? { endpointId: request.query.endpointId } : {}),
          ...(request.query.status ? { status: request.query.status as never } : {}),
        },
        orderBy: { createdAt: 'desc' },
        take: 100,
        select: {
          id: true,
          eventType: true,
          eventId: true,
          status: true,
          attempt: true,
          responseStatus: true,
          errorMessage: true,
          nextAttemptAt: true,
          deliveredAt: true,
          createdAt: true,
        },
      });
      return { deliveries };
    },
  );

  app.post<{ Params: { id: string } }>('/v1/webhooks/:id/reactivate', async (request) => {
    const user = requireRole(request, 'ADMIN');
    const endpoint = await prisma.webhookEndpoint.update({
      where: { id: request.params.id },
      data: { isActive: true, disabledAt: null, consecutiveFailures: 0 },
    });
    await writeAudit(request, {
      action: 'webhook.reactivated',
      resourceType: 'WebhookEndpoint',
      resourceId: endpoint.id,
    });
    return { reactivated: true };
  });

  // --- API keys ---
  app.post<{ Body: { name: string; environment?: 'SANDBOX' | 'PRODUCTION'; scopes?: string[] } }>(
    '/v1/api-keys',
    async (request, reply) => {
      const user = requireRole(request, 'ADMIN');
      const generated = generateApiKey();

      const key = await prisma.apiKey.create({
        data: {
          tenantId: user.tenantId,
          name: request.body.name,
          keyId: generated.keyId,
          secretHash: generated.secretHash,
          scopes: request.body.scopes ?? [],
          environment: (request.body.environment ?? 'SANDBOX') as never,
        },
      });

      await writeAudit(request, {
        action: 'apikey.created',
        resourceType: 'ApiKey',
        resourceId: key.id,
        after: { name: key.name, keyId: key.keyId, environment: key.environment },
      });

      return reply.status(201).send({
        keyId: generated.keyId,
        // Returned exactly once; only the hash is retained.
        secret: generated.secret,
        environment: key.environment,
        note: 'Store the secret now — it cannot be retrieved again.',
      });
    },
  );

  app.delete<{ Params: { id: string } }>('/v1/api-keys/:id', async (request) => {
    const user = requireRole(request, 'ADMIN');
    await prisma.apiKey.update({
      where: { id: request.params.id },
      data: { revokedAt: new Date() },
    });
    await writeAudit(request, {
      action: 'apikey.revoked',
      resourceType: 'ApiKey',
      resourceId: request.params.id,
    });
    return { revoked: true };
  });

  // --- Queues ---
  app.get('/v1/queues', async (request) => {
    const caller = requireBackend(request);
    const queues = await prisma.queue.findMany({
      where: { tenantId: caller.tenantId },
      include: {
        _count: {
          select: { cases: true },
        },
      },
    });

    const depths = await prisma.case.groupBy({
      by: ['queueId'],
      where: {
        tenantId: caller.tenantId,
        status: { in: ['OPEN', 'ASSIGNED', 'IN_PROGRESS'] },
      },
      _count: true,
    });
    const depthByQueue = new Map(depths.map((d) => [d.queueId, d._count]));

    return {
      queues: queues.map((q) => ({
        id: q.id,
        name: q.name,
        description: q.description,
        isDefault: q.isDefault,
        slaFirstResponseMinutes: q.slaFirstResponseMinutes,
        slaResolutionMinutes: q.slaResolutionMinutes,
        totalCases: q._count.cases,
        openCases: depthByQueue.get(q.id) ?? 0,
      })),
    };
  });
};

export default configRoutes;
