import {
  classifyIntentHeuristic,
  estimateSentiment,
  mentionsRegulator,
  newSecret,
  redactPii,
  type SupportIntent,
} from '@kyc/core';
import { prisma } from '@kyc/db';
import { POLICY_VERSION, buildSystemPrompt } from './prompt.js';
import { ClaudeAgentRuntime } from './runtime-claude.js';
import { StubAgentRuntime } from './runtime-stub.js';
import { loadAgentConfig, type AgentConfig, type AgentContext, type AgentRuntime } from './types.js';

/**
 * Orchestrates a support conversation: persistence, intent classification,
 * running the agent, and recording everything that happened.
 *
 * The persistence order matters. The applicant's message and the AgentRun row
 * are written *before* the model is called, so a crash mid-run leaves a visible
 * RUNNING row rather than a silent gap — an unexplained absence of records is the
 * worst possible state for an audit.
 */
export class SupportService {
  private readonly runtime: AgentRuntime;

  constructor(private readonly config: AgentConfig = loadAgentConfig()) {
    this.runtime =
      config.runtime === 'claude'
        ? new ClaudeAgentRuntime(config)
        : new StubAgentRuntime();
  }

  get runtimeName(): 'claude' | 'stub' {
    return this.runtime.name;
  }

  /**
   * Opens a ticket and its first conversation.
   *
   * The return type is written out rather than inferred because Prisma's inferred
   * payload types reach into generated runtime internals, which does not survive
   * being re-exported across package boundaries.
   */
  async createTicket(args: {
    tenantId: string;
    applicantId?: string;
    applicantExternalUserId?: string;
    channel: string;
    subject: string;
    message: string;
    language?: string;
    intent?: SupportIntent;
    metadata?: Record<string, unknown>;
  }): Promise<{
    ticket: {
      id: string;
      reference: string;
      applicantId: string | null;
      conversationId: string;
      sessionKey: string;
    };
    priorTickets: number;
    intent: SupportIntent;
  }> {
    let applicantId = args.applicantId;
    if (!applicantId && args.applicantExternalUserId) {
      const applicant = await prisma.applicant.findUnique({
        where: {
          tenantId_externalUserId: {
            tenantId: args.tenantId,
            externalUserId: args.applicantExternalUserId,
          },
        },
        select: { id: true },
      });
      applicantId = applicant?.id;
    }

    // Classify up front: the intent decides the tool set, so it has to be
    // resolved before the agent gets a chance to act.
    const classified = args.intent
      ? { intent: args.intent, confidence: 1 }
      : classifyIntentHeuristic(`${args.subject}\n${args.message}`);

    const priorTickets = applicantId
      ? await prisma.supportTicket.count({
          where: {
            applicantId,
            intent: classified.intent as never,
            status: { notIn: ['OPEN'] },
          },
        })
      : 0;

    const count = await prisma.supportTicket.count({ where: { tenantId: args.tenantId } });

    const ticket = await prisma.supportTicket.create({
      data: {
        tenantId: args.tenantId,
        reference: `TKT-${1000 + count + 1}`,
        applicantId,
        channel: args.channel as never,
        intent: classified.intent as never,
        subject: args.subject.slice(0, 300),
        language: args.language ?? 'en',
        priority: mentionsRegulator(args.message) ? 'HIGH' : 'MEDIUM',
        conversations: {
          create: {
            sessionKey: newSecret(24),
            agentName: 'kyc-support-agent',
            model: this.config.model,
            policyVersion: POLICY_VERSION,
            messages: {
              create: {
                role: 'APPLICANT',
                content: args.message,
                redactedContent: redactPii(args.message).redacted,
              },
            },
          },
        },
      },
      include: { conversations: { select: { id: true, sessionKey: true } } },
    });

    const conversation = ticket.conversations[0];
    if (!conversation) throw new Error('Ticket was created without a conversation');

    return {
      ticket: {
        id: ticket.id,
        reference: ticket.reference,
        applicantId: ticket.applicantId,
        conversationId: conversation.id,
        sessionKey: conversation.sessionKey,
      },
      priorTickets,
      intent: classified.intent as SupportIntent,
    };
  }

  /**
   * Handles one applicant turn end to end: persists the message, runs the agent,
   * persists the reply, and reconciles ticket state.
   */
  async handleApplicantMessage(args: {
    tenantId: string;
    ticketId: string;
    message?: string;
    /** Skip persisting the message when it was written at ticket creation. */
    messageAlreadyPersisted?: boolean;
  }) {
    const ticket = await prisma.supportTicket.findFirstOrThrow({
      where: { id: args.ticketId, tenantId: args.tenantId },
      include: {
        tenant: { select: { name: true } },
        applicant: { select: { id: true, firstName: true } },
        conversations: {
          where: { isActive: true },
          orderBy: { createdAt: 'desc' },
          take: 1,
          include: { messages: { orderBy: { createdAt: 'asc' } } },
        },
      },
    });

    const conversation = ticket.conversations[0];
    if (!conversation) throw new Error('Ticket has no active conversation');

    // A ticket a human has taken over must not be answered by the agent behind
    // their back — the applicant would get two different answers.
    if (ticket.status === 'ESCALATED' || ticket.status === 'PENDING_HUMAN') {
      return {
        handled: false,
        reason: 'Ticket is with a human agent; the assistant does not reply.',
        reply: null,
      };
    }

    if (args.message && !args.messageAlreadyPersisted) {
      await prisma.supportMessage.create({
        data: {
          conversationId: conversation.id,
          role: 'APPLICANT',
          content: args.message,
          redactedContent: redactPii(args.message).redacted,
        },
      });
    }

    const history = [
      ...conversation.messages
        .filter((m) => m.role === 'APPLICANT' || m.role === 'ASSISTANT' || m.role === 'HUMAN_AGENT')
        .map((m) => ({
          role: (m.role === 'APPLICANT' ? 'applicant' : 'assistant') as 'applicant' | 'assistant',
          content: m.content,
        })),
      ...(args.message && !args.messageAlreadyPersisted
        ? [{ role: 'applicant' as const, content: args.message }]
        : []),
    ];

    const intent = (ticket.intent ?? 'UNKNOWN') as SupportIntent;
    const priorTickets = ticket.applicantId
      ? await prisma.supportTicket.count({
          where: {
            applicantId: ticket.applicantId,
            intent: intent as never,
            id: { not: ticket.id },
          },
        })
      : 0;

    // Written before the model runs: a crash leaves a RUNNING row, not silence.
    const run = await prisma.agentRun.create({
      data: {
        conversationId: conversation.id,
        runtime: this.runtime.name,
        model: this.config.model,
        maxTurns: this.config.maxTurns,
        status: 'RUNNING',
      },
    });

    const context: AgentContext = {
      tenantId: ticket.tenantId,
      ticketId: ticket.id,
      conversationId: conversation.id,
      runId: run.id,
      applicantId: ticket.applicantId ?? undefined,
      intent,
      language: ticket.language,
      policyVersion: POLICY_VERSION,
    };

    const systemPrompt = buildSystemPrompt({
      tenantName: ticket.tenant.name,
      intent,
      language: ticket.language,
      applicantFirstName: ticket.applicant?.firstName ?? null,
      hasApplicant: Boolean(ticket.applicantId),
      priorTicketsSameIntent: priorTickets,
    });

    let result;
    try {
      result = await this.runtime.run({
        context,
        systemPrompt,
        history,
        maxTurns: this.config.maxTurns,
      });
    } catch (error) {
      await prisma.agentRun.update({
        where: { id: run.id },
        data: {
          status: 'FAILED',
          finishedAt: new Date(),
          errorMessage: error instanceof Error ? error.message : 'unknown failure',
        },
      });
      throw error;
    }

    const lastApplicant = [...history].reverse().find((m) => m.role === 'applicant');

    const message = await prisma.supportMessage.create({
      data: {
        conversationId: conversation.id,
        role: 'ASSISTANT',
        content: result.reply,
        redactedContent: redactPii(result.reply).redacted,
        toolCalls: result.toolCalls as never,
        inputTokens: result.usage.inputTokens,
        outputTokens: result.usage.outputTokens,
        guardrail: {
          confidence: result.confidence,
          escalated: result.escalated,
          refused: result.refused ?? false,
          sentiment: lastApplicant ? estimateSentiment(lastApplicant.content) : null,
          policyVersion: POLICY_VERSION,
        },
      },
    });

    await prisma.$transaction([
      prisma.agentRun.update({
        where: { id: run.id },
        data: {
          status: result.escalated
            ? 'ESCALATED'
            : result.stopReason === 'max_iterations'
              ? 'MAX_TURNS'
              : result.refused
                ? 'BLOCKED_BY_POLICY'
                : 'COMPLETED',
          turns: result.turns,
          stopReason: result.stopReason,
          inputTokens: result.usage.inputTokens,
          outputTokens: result.usage.outputTokens,
          finishedAt: new Date(),
        },
      }),
      prisma.supportConversation.update({
        where: { id: conversation.id },
        data: { turnCount: { increment: 1 } },
      }),
      prisma.supportTicket.update({
        where: { id: ticket.id },
        data: {
          status: result.escalated ? 'ESCALATED' : 'AWAITING_APPLICANT',
          handledBy: result.escalated ? 'HYBRID' : 'AI_AGENT',
          firstResponseAt: ticket.firstResponseAt ?? new Date(),
          ...(result.escalated ? {} : { autoResolved: false }),
        },
      }),
    ]);

    return {
      handled: true,
      reply: result.reply,
      messageId: message.id,
      escalated: result.escalated,
      escalationReason: result.escalationReason,
      confidence: result.confidence,
      toolCalls: result.toolCalls,
      runtime: result.usage.runtime,
      model: result.usage.model,
    };
  }

  /** A human agent replies; the assistant stands down for this ticket. */
  async postHumanReply(args: {
    tenantId: string;
    ticketId: string;
    userId: string;
    message: string;
  }) {
    const ticket = await prisma.supportTicket.findFirstOrThrow({
      where: { id: args.ticketId, tenantId: args.tenantId },
      include: {
        conversations: { where: { isActive: true }, orderBy: { createdAt: 'desc' }, take: 1 },
      },
    });
    const conversation = ticket.conversations[0];
    if (!conversation) throw new Error('Ticket has no active conversation');

    const message = await prisma.supportMessage.create({
      data: {
        conversationId: conversation.id,
        role: 'HUMAN_AGENT',
        content: args.message,
        redactedContent: redactPii(args.message).redacted,
        authorUserId: args.userId,
      },
    });

    await prisma.supportTicket.update({
      where: { id: ticket.id },
      data: { status: 'AWAITING_APPLICANT', handledBy: 'HUMAN' },
    });

    return { messageId: message.id };
  }

  /**
   * Resolves an escalation. `returnToAgent` hands the conversation back to the
   * assistant, which is how the agent learns: the human's resolution is recorded
   * against the escalation and becomes a training signal.
   */
  async resolveEscalation(args: {
    tenantId: string;
    escalationId: string;
    userId: string;
    humanResolution: string;
    returnToAgent: boolean;
  }) {
    const escalation = await prisma.escalation.findFirstOrThrow({
      where: { id: args.escalationId, ticket: { tenantId: args.tenantId } },
      include: { ticket: true },
    });

    await prisma.$transaction([
      prisma.escalation.update({
        where: { id: escalation.id },
        data: {
          status: args.returnToAgent ? 'RETURNED_TO_AGENT' : 'RESOLVED',
          assigneeId: args.userId,
          humanResolution: args.humanResolution,
          resolvedAt: new Date(),
        },
      }),
      prisma.supportTicket.update({
        where: { id: escalation.ticketId },
        data: {
          status: args.returnToAgent ? 'AGENT_HANDLING' : 'RESOLVED',
          handledBy: args.returnToAgent ? 'AI_AGENT' : 'HUMAN',
          resolvedAt: args.returnToAgent ? null : new Date(),
        },
      }),
    ]);

    return { resolved: true, returnedToAgent: args.returnToAgent };
  }

  /** Operational metrics for the dashboard's agent-performance view. */
  async metrics(tenantId: string, since: Date) {
    const [tickets, autoResolved, escalations, runs] = await Promise.all([
      prisma.supportTicket.count({ where: { tenantId, createdAt: { gte: since } } }),
      prisma.supportTicket.count({
        where: { tenantId, createdAt: { gte: since }, autoResolved: true },
      }),
      prisma.escalation.count({
        where: { ticket: { tenantId }, createdAt: { gte: since } },
      }),
      prisma.agentRun.aggregate({
        where: { conversation: { ticket: { tenantId } }, startedAt: { gte: since } },
        _sum: { inputTokens: true, outputTokens: true, turns: true },
        _count: true,
      }),
    ]);

    const byReason = await prisma.escalation.groupBy({
      by: ['reason'],
      where: { ticket: { tenantId }, createdAt: { gte: since } },
      _count: true,
    });

    return {
      tickets,
      autoResolved,
      escalations,
      // Containment: the share of tickets the agent finished without a human.
      containmentRate: tickets > 0 ? Math.round(((tickets - escalations) / tickets) * 100) : 0,
      runs: runs._count,
      avgTurnsPerRun: runs._count > 0 ? (runs._sum.turns ?? 0) / runs._count : 0,
      inputTokens: runs._sum.inputTokens ?? 0,
      outputTokens: runs._sum.outputTokens ?? 0,
      escalationsByReason: Object.fromEntries(byReason.map((r) => [r.reason, r._count])),
    };
  }
}
