import type { FastifyPluginAsync } from 'fastify';
import {
  CreateSupportTicketSchema,
  INTENT_POLICY,
  PostSupportMessageSchema,
  ResolveEscalationSchema,
  SUPPORT_INTENTS,
  redactPii,
} from '@kyc/core';
import { SupportService, TOOL_DEFINITIONS } from '@kyc/agent';
import { prisma } from '@kyc/db';
import { emitEvent } from '@kyc/worker';
import {
  assertOwnRecord,
  requireBackend,
  requireCaller,
  requireRole,
  writeAudit,
} from '../auth.js';

/**
 * Agentic customer service endpoints.
 *
 * Applicants talk to the agent through `/v1/support/tickets` and
 * `/v1/support/tickets/:id/messages`; operators use the same records through the
 * escalation and metrics endpoints. Transcript reads are entitlement-checked and
 * redacted for anyone without PII access, because a transcript is the one place
 * where an applicant may have pasted their own document number.
 */

const supportRoutes: FastifyPluginAsync = async (app) => {
  const service = new SupportService();

  // --- Open a ticket (applicant or backend) ---
  app.post('/v1/support/tickets', async (request, reply) => {
    const caller = requireCaller(request);
    const body = CreateSupportTicketSchema.parse(request.body);

    // An applicant token may only ever open a ticket about itself, whatever the
    // body claims.
    const applicantId =
      caller.kind === 'applicant' ? caller.applicantId : body.applicantId;
    if (body.applicantId) assertOwnRecord(caller, body.applicantId);

    const created = await service.createTicket({
      tenantId: caller.tenantId,
      applicantId,
      applicantExternalUserId: body.applicantExternalUserId,
      channel: caller.kind === 'applicant' ? 'WEB_SDK' : body.channel,
      subject: body.subject,
      message: body.message,
      language: body.language,
      intent: body.intent,
      metadata: body.metadata,
    });

    // The agent answers the opening message immediately; the message is already
    // persisted, hence messageAlreadyPersisted.
    const result = await service.handleApplicantMessage({
      tenantId: caller.tenantId,
      ticketId: created.ticket.id,
      messageAlreadyPersisted: true,
    });

    await emitEvent(
      caller.tenantId,
      'support.ticketCreated',
      {
        ticketId: created.ticket.id,
        reference: created.ticket.reference,
        applicantId: created.ticket.applicantId,
        intent: created.intent,
        escalated: result.escalated ?? false,
      },
      created.ticket.applicantId ?? undefined,
    );

    if (result.escalated) {
      await emitEvent(
        caller.tenantId,
        'support.escalated',
        {
          ticketId: created.ticket.id,
          reference: created.ticket.reference,
          applicantId: created.ticket.applicantId,
          intent: created.intent,
          reason: result.escalationReason ?? 'UNKNOWN',
          agentConfidence: result.confidence,
          summary: body.message.slice(0, 500),
        },
        created.ticket.applicantId ?? undefined,
      );
    }

    return reply.status(201).send({
      ticket: {
        id: created.ticket.id,
        reference: created.ticket.reference,
        intent: created.intent,
        sessionKey: created.ticket.sessionKey,
      },
      reply: result.reply,
      escalated: result.escalated,
      escalationReason: result.escalationReason,
      // Surfaced so a client can show "a specialist is reviewing this" honestly.
      handledBy: result.escalated ? 'human-pending' : 'ai-agent',
      runtime: result.runtime,
    });
  });

  // --- Continue the conversation ---
  app.post<{ Params: { id: string } }>(
    '/v1/support/tickets/:id/messages',
    async (request) => {
      const caller = requireCaller(request);
      const body = PostSupportMessageSchema.parse(request.body);

      const ticket = await prisma.supportTicket.findFirstOrThrow({
        where: { id: request.params.id, tenantId: caller.tenantId },
        select: { id: true, applicantId: true, reference: true, intent: true },
      });
      if (ticket.applicantId) assertOwnRecord(caller, ticket.applicantId);

      // A human agent replying is a different act from an applicant replying: it
      // stands the assistant down rather than triggering another agent turn.
      if (body.asHumanAgent) {
        const user = requireRole(request, 'AGENT');
        const posted = await service.postHumanReply({
          tenantId: caller.tenantId,
          ticketId: ticket.id,
          userId: user.userId,
          message: body.message,
        });
        await writeAudit(request, {
          action: 'support.human.replied',
          resourceType: 'SupportTicket',
          resourceId: ticket.id,
        });
        return { messageId: posted.messageId, handledBy: 'human' };
      }

      const result = await service.handleApplicantMessage({
        tenantId: caller.tenantId,
        ticketId: ticket.id,
        message: body.message,
      });

      if (!result.handled) {
        return {
          handled: false,
          reason: result.reason,
          handledBy: 'human',
        };
      }

      if (result.escalated) {
        await emitEvent(
          caller.tenantId,
          'support.escalated',
          {
            ticketId: ticket.id,
            reference: ticket.reference,
            applicantId: ticket.applicantId,
            intent: ticket.intent ?? 'UNKNOWN',
            reason: result.escalationReason ?? 'UNKNOWN',
            agentConfidence: result.confidence,
            summary: body.message.slice(0, 500),
          },
          ticket.applicantId ?? undefined,
        );
      }

      return {
        handled: true,
        reply: result.reply,
        escalated: result.escalated,
        escalationReason: result.escalationReason,
        confidence: result.confidence,
        toolCalls: result.toolCalls?.map((t) => t.name),
        handledBy: result.escalated ? 'human-pending' : 'ai-agent',
      };
    },
  );

  // --- Read a transcript ---
  app.get<{ Params: { id: string } }>('/v1/support/tickets/:id', async (request) => {
    const caller = requireCaller(request);
    const ticket = await prisma.supportTicket.findFirstOrThrow({
      where: { id: request.params.id, tenantId: caller.tenantId },
      include: {
        conversations: {
          orderBy: { createdAt: 'asc' },
          include: {
            messages: { orderBy: { createdAt: 'asc' } },
            runs: {
              orderBy: { startedAt: 'asc' },
              include: { invocations: { orderBy: { createdAt: 'asc' } } },
            },
          },
        },
        escalations: { orderBy: { createdAt: 'desc' } },
        case: { select: { id: true, reference: true, status: true } },
        applicant: { select: { id: true, externalUserId: true } },
      },
    });
    if (ticket.applicantId) assertOwnRecord(caller, ticket.applicantId);

    // Entitlement gate on raw content. AUDITOR and AI_AGENT identities read the
    // redacted copy; the applicant sees their own words unredacted.
    const seesRawContent =
      caller.kind === 'applicant' ||
      (caller.kind === 'user' &&
        ['OWNER', 'ADMIN', 'COMPLIANCE_OFFICER', 'MLRO', 'AGENT'].includes(caller.role));

    const conversations = ticket.conversations.map((c) => ({
      id: c.id,
      agentName: c.agentName,
      model: c.model,
      policyVersion: c.policyVersion,
      turnCount: c.turnCount,
      messages: c.messages.map((m) => ({
        id: m.id,
        role: m.role,
        content: seesRawContent ? m.content : (m.redactedContent ?? redactPii(m.content).redacted),
        createdAt: m.createdAt,
        // Operators see the agent's reasoning trail; applicants do not.
        ...(caller.kind === 'applicant'
          ? {}
          : {
              toolCalls: m.toolCalls,
              guardrail: m.guardrail,
              inputTokens: m.inputTokens,
              outputTokens: m.outputTokens,
            }),
      })),
      // The audit trail of what the agent actually touched.
      ...(caller.kind === 'applicant'
        ? {}
        : {
            runs: c.runs.map((r) => ({
              id: r.id,
              runtime: r.runtime,
              model: r.model,
              status: r.status,
              turns: r.turns,
              stopReason: r.stopReason,
              inputTokens: r.inputTokens,
              outputTokens: r.outputTokens,
              startedAt: r.startedAt,
              finishedAt: r.finishedAt,
              toolInvocations: r.invocations.map((i) => ({
                toolName: i.toolName,
                effect: i.effect,
                status: i.status,
                latencyMs: i.latencyMs,
                input: i.input,
                errorMessage: i.errorMessage,
              })),
            })),
          }),
    }));

    return {
      ticket: {
        id: ticket.id,
        reference: ticket.reference,
        subject: ticket.subject,
        intent: ticket.intent,
        status: ticket.status,
        priority: ticket.priority,
        handledBy: ticket.handledBy,
        autoResolved: ticket.autoResolved,
        language: ticket.language,
        applicant: ticket.applicant,
        case: ticket.case,
        createdAt: ticket.createdAt,
        firstResponseAt: ticket.firstResponseAt,
        resolvedAt: ticket.resolvedAt,
      },
      conversations,
      escalations: ticket.escalations,
    };
  });

  // --- Escalation inbox ---
  app.get<{ Querystring: { status?: string; mine?: string } }>(
    '/v1/support/escalations',
    async (request) => {
      const caller = requireBackend(request);
      const escalations = await prisma.escalation.findMany({
        where: {
          ticket: { tenantId: caller.tenantId },
          status: (request.query.status as never) ?? { in: ['PENDING', 'ACCEPTED'] },
          ...(request.query.mine === 'true' && caller.kind === 'user'
            ? { assigneeId: caller.userId }
            : {}),
        },
        // Due-soonest first: these carry an SLA the firm has already promised.
        orderBy: [{ dueAt: 'asc' }],
        take: 100,
        include: {
          ticket: {
            select: {
              id: true,
              reference: true,
              subject: true,
              intent: true,
              language: true,
              applicant: {
                select: { id: true, externalUserId: true, reviewStatus: true, riskLevel: true },
              },
            },
          },
          assignee: { select: { id: true, name: true } },
        },
      });

      return {
        escalations: escalations.map((e) => ({
          id: e.id,
          reason: e.reason,
          detail: e.detail,
          agentConfidence: e.agentConfidence,
          status: e.status,
          dueAt: e.dueAt,
          overdue: e.dueAt ? e.dueAt < new Date() : false,
          createdAt: e.createdAt,
          assignee: e.assignee,
          ticket: e.ticket,
        })),
      };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/support/escalations/:id/accept',
    async (request) => {
      const user = requireRole(request, 'AGENT');
      const escalation = await prisma.escalation.update({
        where: { id: request.params.id },
        data: { status: 'ACCEPTED', assigneeId: user.userId, acceptedAt: new Date() },
      });
      await prisma.supportTicket.update({
        where: { id: escalation.ticketId },
        data: { status: 'PENDING_HUMAN', handledBy: 'HUMAN' },
      });
      return { accepted: true };
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/support/escalations/:id/resolve',
    async (request) => {
      const user = requireRole(request, 'AGENT');
      const body = ResolveEscalationSchema.parse(request.body);

      const result = await service.resolveEscalation({
        tenantId: user.tenantId,
        escalationId: request.params.id,
        userId: user.userId,
        humanResolution: body.humanResolution,
        returnToAgent: body.returnToAgent,
      });

      await writeAudit(request, {
        action: 'support.escalation.resolved',
        resourceType: 'Escalation',
        resourceId: request.params.id,
        after: { returnedToAgent: body.returnToAgent },
      });

      return result;
    },
  );

  // --- CSAT ---
  app.post<{ Params: { id: string }; Body: { score: number; comment?: string } }>(
    '/v1/support/tickets/:id/csat',
    async (request) => {
      const caller = requireCaller(request);
      const ticket = await prisma.supportTicket.findFirstOrThrow({
        where: { id: request.params.id, tenantId: caller.tenantId },
        select: { id: true, applicantId: true },
      });
      if (ticket.applicantId) assertOwnRecord(caller, ticket.applicantId);

      await prisma.supportTicket.update({
        where: { id: ticket.id },
        data: {
          csatScore: Math.max(1, Math.min(5, Math.round(request.body.score))),
          csatComment: request.body.comment?.slice(0, 2000),
          status: 'RESOLVED',
          resolvedAt: new Date(),
        },
      });
      return { recorded: true };
    },
  );

  // --- Agent performance ---
  app.get<{ Querystring: { days?: string } }>(
    '/v1/support/metrics',
    async (request) => {
      const caller = requireBackend(request);
      const days = Math.min(Number(request.query.days ?? 30), 365);
      const since = new Date(Date.now() - days * 86_400_000);

      const metrics = await service.metrics(caller.tenantId, since);
      const csat = await prisma.supportTicket.aggregate({
        where: { tenantId: caller.tenantId, createdAt: { gte: since }, csatScore: { not: null } },
        _avg: { csatScore: true },
        _count: true,
      });

      return {
        windowDays: days,
        runtime: service.runtimeName,
        ...metrics,
        csat: { average: csat._avg.csatScore, responses: csat._count },
      };
    },
  );

  // --- Introspection: the agent's own tool surface and policy ---
  app.get('/v1/support/agent-config', async (request) => {
    requireBackend(request);
    return {
      runtime: service.runtimeName,
      // The authorisation matrix, exposed so an auditor can see what the agent is
      // permitted to do per intent without reading the source.
      policy: Object.fromEntries(
        SUPPORT_INTENTS.map((intent) => [
          intent,
          {
            requiresHuman: INTENT_POLICY[intent].requiresHuman,
            minConfidence: INTENT_POLICY[intent].minConfidence,
            slaMinutes: INTENT_POLICY[intent].slaMinutes,
            allowedTools: INTENT_POLICY[intent].allowedTools,
          },
        ]),
      ),
      tools: TOOL_DEFINITIONS.map((t) => ({
        name: t.spec.name,
        description: t.spec.description,
        effect: t.spec.effect,
        requiresApproval: t.spec.requiresApproval ?? false,
      })),
    };
  });
};

export default supportRoutes;
