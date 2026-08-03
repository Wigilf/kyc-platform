import { z } from 'zod/v4';
import {
  REJECT_LABELS,
  STATUS_COPY,
  classifyIntentHeuristic,
  clientMessagesFor,
  estimateCompletionMinutes,
  isFinalRejection,
  isToolAllowed,
  newId,
  outstandingSteps,
  parseLevelSteps,
  redactPii,
  type SupportIntent,
} from '@kyc/core';
import { prisma } from '@kyc/db';
import type { AgentContext, AgentToolSpec, ToolOutcome } from './types.js';

/**
 * The agent's tool surface.
 *
 * Two invariants hold across every tool:
 *
 *  1. **Applicant-visible data only.** A tool never returns internal moderation
 *     comments, raw provider payloads, analyst notes, or another applicant's
 *     data. The agent's output is read by the applicant, so anything a tool
 *     returns is effectively disclosed to them — the filtering has to happen
 *     here, not in the prompt. Prompts are not a security boundary.
 *
 *  2. **Every call is authorised and audited.** The intent policy decides which
 *     tools are reachable; every invocation writes a ToolInvocation row with its
 *     input, output, and effect. "The AI did something" must always be
 *     answerable with "here is exactly what, and under what authority".
 */

export interface ToolDefinition<S extends z.ZodType = z.ZodType> {
  spec: AgentToolSpec;
  inputSchema: S;
  handler: (input: z.infer<S>, ctx: AgentContext) => Promise<unknown>;
}

function def<S extends z.ZodType>(d: ToolDefinition<S>): ToolDefinition<S> {
  return d;
}

/** Resolves the applicant this conversation is about, or throws. */
async function requireApplicant(ctx: AgentContext) {
  if (!ctx.applicantId) {
    throw new Error(
      'This ticket is not linked to a verification, so applicant data cannot be read.',
    );
  }
  const applicant = await prisma.applicant.findFirst({
    // Tenant scoping in the query itself, not as a post-hoc check: a missing
    // tenant filter is the classic cross-tenant data leak.
    where: { id: ctx.applicantId, tenantId: ctx.tenantId },
    include: { level: true },
  });
  if (!applicant) throw new Error('Applicant not found for this ticket.');
  return applicant;
}

// ---------------------------------------------------------------------------
// Read tools
// ---------------------------------------------------------------------------

const getApplicantStatus = def({
  spec: {
    name: 'get_applicant_status',
    description:
      "Get the applicant's current verification status, risk band, and what stage they are at. Start here for almost any question about progress.",
    effect: 'READ',
  },
  inputSchema: z.object({}),
  async handler(_input, ctx) {
    const applicant = await requireApplicant(ctx);
    const copy = STATUS_COPY[applicant.reviewStatus as keyof typeof STATUS_COPY];
    const openHits = await prisma.amlHit.count({
      where: {
        status: { in: ['OPEN', 'IN_REVIEW'] },
        run: { applicantId: applicant.id },
      },
    });

    return {
      reviewStatus: applicant.reviewStatus,
      statusTitle: copy?.title,
      statusExplanation: copy?.detail,
      levelName: applicant.level.name,
      levelDisplayName: applicant.level.displayName,
      submittedAt: applicant.submittedAt?.toISOString() ?? null,
      reviewedAt: applicant.reviewedAt?.toISOString() ?? null,
      canResubmit:
        applicant.reviewStatus === 'REJECTED_RETRY' ||
        applicant.reviewStatus === 'PENDING' ||
        applicant.reviewStatus === 'NOT_STARTED',
      // Deliberately coarse. The exact numeric risk score is an internal
      // control; telling an applicant "your risk score is 62" invites gaming
      // and tells them nothing actionable.
      underEnhancedReview: applicant.ddLevel === 'EDD',
      awaitingAnalystReview: openHits > 0,
      daysSinceSubmission: applicant.submittedAt
        ? Math.floor((Date.now() - applicant.submittedAt.getTime()) / 86_400_000)
        : null,
    };
  },
});

const getOutstandingRequirements = def({
  spec: {
    name: 'get_outstanding_requirements',
    description:
      'List what the applicant still has to do or upload before verification can complete. Use this to answer "what do you need from me?".',
    effect: 'READ',
  },
  inputSchema: z.object({}),
  async handler(_input, ctx) {
    const applicant = await requireApplicant(ctx);
    const steps = parseLevelSteps(applicant.level.steps);

    const documents = await prisma.document.findMany({
      where: { applicantId: applicant.id },
      select: { type: true, status: true, subType: true },
    });

    // A step counts as satisfied when a document of an accepted type has got
    // past extraction without being rejected.
    const usable = new Set(
      documents
        .filter((d) => d.status !== 'REJECTED' && d.status !== 'EXPIRED')
        .map((d) => d.type),
    );
    const completed = new Set(
      steps
        .filter((s) => {
          const accepted = s.config.acceptedDocumentTypes ?? [];
          if (accepted.length === 0) return false;
          return accepted.some((t) => usable.has(t as never));
        })
        .map((s) => s.id),
    );

    const outstanding = outstandingSteps(steps, completed);

    return {
      allDone: outstanding.length === 0,
      outstanding: outstanding.map((s) => ({
        id: s.id,
        type: s.type,
        label: s.label ?? s.type.toLowerCase().replace(/_/g, ' '),
        acceptedDocumentTypes: s.config.acceptedDocumentTypes ?? [],
        requireBothSides: s.config.requireBothSides ?? false,
        attemptsAllowed: s.maxAttempts,
      })),
      alreadyProvided: [...usable],
    };
  },
});

const getCheckResults = def({
  spec: {
    name: 'get_check_results',
    description:
      'Get the outcome of the automated checks (document reading, liveness, face match, screening). Use this to explain why something failed.',
    effect: 'READ',
  },
  inputSchema: z.object({
    checkType: z
      .string()
      .optional()
      .describe('Optional filter, e.g. LIVENESS or DOCUMENT_OCR.'),
  }),
  async handler(input, ctx) {
    const applicant = await requireApplicant(ctx);
    const checks = await prisma.check.findMany({
      where: {
        applicantId: applicant.id,
        ...(input.checkType ? { type: input.checkType as never } : {}),
      },
      orderBy: { createdAt: 'desc' },
      select: {
        type: true,
        status: true,
        result: true,
        rejectLabels: true,
        completedAt: true,
        attempt: true,
      },
    });

    return {
      checks: checks.map((c) => ({
        type: c.type,
        status: c.status,
        result: c.result,
        attempt: c.attempt,
        completedAt: c.completedAt?.toISOString() ?? null,
        // Applicant-facing wording only. The raw provider payload and the
        // internal finding detail stay in the case file.
        explanation: clientMessagesFor(c.rejectLabels),
        fixable: c.rejectLabels.every((l) => REJECT_LABELS[l]?.retryable !== false),
      })),
    };
  },
});

const getRejectionReasons = def({
  spec: {
    name: 'get_rejection_reasons',
    description:
      'Get the reasons for the most recent decision and whether the applicant may try again. Use this whenever they ask why they were declined.',
    effect: 'READ',
  },
  inputSchema: z.object({}),
  async handler(_input, ctx) {
    const applicant = await requireApplicant(ctx);
    const review = await prisma.review.findFirst({
      where: { applicantId: applicant.id },
      orderBy: { createdAt: 'desc' },
    });

    if (!review) {
      return { hasDecision: false, message: 'No decision has been made yet.' };
    }

    const final = isFinalRejection(review.rejectLabels);
    return {
      hasDecision: true,
      decision: review.decision,
      decidedAt: review.createdAt.toISOString(),
      canResubmit: review.decision === 'REJECTED_RETRY' && !final,
      // `clientComment` is written for the applicant; `moderationComment` is
      // internal and must never be surfaced here.
      applicantFacingComment: review.clientComment,
      reasons: clientMessagesFor(review.rejectLabels),
      // The label codes are useful for the agent's own reasoning about what to
      // suggest, but it is instructed not to read them out verbatim.
      reasonCodes: review.rejectLabels.filter(
        (l) => REJECT_LABELS[l]?.category !== 'FRAUD',
      ),
      isFinal: final,
    };
  },
});

const searchKnowledgeBase = def({
  spec: {
    name: 'search_knowledge_base',
    description:
      'Search help articles for guidance on document requirements, capture tips, and process questions. Use before answering a general "how do I…" question.',
    effect: 'READ',
  },
  inputSchema: z.object({
    query: z.string().min(2).describe('Search terms.'),
    limit: z.number().int().min(1).max(5).default(3),
  }),
  async handler(input, ctx) {
    const terms = input.query
      .toLowerCase()
      .split(/\W+/)
      .filter((t) => t.length > 2);

    const articles = await prisma.knowledgeArticle.findMany({
      where: {
        isPublished: true,
        // Tenant-specific articles override the global set; both are in scope.
        OR: [{ tenantId: ctx.tenantId }, { tenantId: null }],
        AND: [
          {
            OR: [
              { intents: { has: ctx.intent as never } },
              ...terms.map((t) => ({ keywords: { has: t } })),
              ...terms.map((t) => ({ title: { contains: t, mode: 'insensitive' as const } })),
            ],
          },
        ],
      },
      take: input.limit,
      orderBy: { updatedAt: 'desc' },
      select: { slug: true, title: true, body: true, locale: true },
    });

    return {
      results: articles.map((a) => ({
        slug: a.slug,
        title: a.title,
        // Trimmed: the model does not need a whole article to answer, and long
        // bodies crowd out the conversation.
        excerpt: a.body.slice(0, 900),
        locale: a.locale,
      })),
      matched: articles.length,
    };
  },
});

const estimateCompletion = def({
  spec: {
    name: 'estimate_completion_time',
    description:
      'Estimate how much longer verification will take, based on the real queue depth. Use for "how long will this take?" instead of guessing.',
    effect: 'READ',
  },
  inputSchema: z.object({}),
  async handler(_input, ctx) {
    const applicant = await requireApplicant(ctx);
    const [queueDepth, openHits] = await Promise.all([
      prisma.case.count({
        where: {
          tenantId: ctx.tenantId,
          status: { in: ['OPEN', 'ASSIGNED', 'IN_PROGRESS'] },
          type: 'MANUAL_REVIEW',
        },
      }),
      prisma.amlHit.count({
        where: {
          status: { in: ['OPEN', 'IN_REVIEW'] },
          run: { applicantId: applicant.id },
        },
      }),
    ]);

    const estimate = estimateCompletionMinutes({
      reviewStatus: applicant.reviewStatus,
      queueDepth,
      hasOpenAmlHits: openHits > 0,
      ddLevel: applicant.ddLevel,
    });

    return {
      ...estimate,
      // An honest range beats a precise fiction. If we cannot say, we say so.
      humanReadable:
        estimate.maxMinutes === 0
          ? estimate.note
          : estimate.maxMinutes <= 60
            ? `usually ${estimate.minMinutes}-${estimate.maxMinutes} minutes`
            : `usually ${Math.round(estimate.minMinutes / 60)}-${Math.round(estimate.maxMinutes / 60)} hours`,
    };
  },
});

const classifyIntent = def({
  spec: {
    name: 'classify_intent',
    description:
      'Re-classify what the applicant is asking about when the conversation turns out to be about something else. Changing intent changes which tools you may use.',
    effect: 'READ',
  },
  inputSchema: z.object({
    message: z.string().min(1),
  }),
  async handler(input) {
    const result = classifyIntentHeuristic(input.message);
    return {
      intent: result.intent,
      confidence: result.confidence,
      alsoMatched: result.matched,
      note:
        'This is a keyword heuristic. Use your own judgement; if the two disagree, prefer the more cautious classification.',
    };
  },
});

// ---------------------------------------------------------------------------
// Write tools
// ---------------------------------------------------------------------------

const requestResubmission = def({
  spec: {
    name: 'request_resubmission',
    description:
      'Reopen the flow so the applicant can upload a replacement document. Only for retryable problems such as a blurry photo or an expired document.',
    effect: 'WRITE',
  },
  inputSchema: z.object({
    documentTypes: z
      .array(z.string())
      .min(1)
      .describe('Document types to request again, e.g. ["PASSPORT"].'),
    reason: z.string().min(5).describe('What the applicant needs to fix, in their words.'),
  }),
  async handler(input, ctx) {
    const applicant = await requireApplicant(ctx);

    // Hard guard, independent of the prompt: a final rejection must never be
    // reopened by an automated actor. This is the single most important check in
    // the tool layer, so it lives in code rather than in instructions.
    if (applicant.reviewStatus === 'REJECTED_FINAL') {
      throw new Error(
        'This application was finally rejected. Resubmission is not permitted and the applicant must be escalated to a human reviewer.',
      );
    }
    if (applicant.reviewStatus === 'APPROVED') {
      throw new Error('This applicant is already verified; nothing needs resubmitting.');
    }

    const superseded = await prisma.document.updateMany({
      where: {
        applicantId: applicant.id,
        type: { in: input.documentTypes as never[] },
        status: { in: ['REJECTED', 'EXTRACTED', 'UPLOADED'] },
      },
      data: { status: 'SUPERSEDED' },
    });

    await prisma.$transaction([
      prisma.applicant.update({
        where: { id: applicant.id },
        data: { status: 'AWAITING_USER', reviewStatus: 'REJECTED_RETRY' },
      }),
      prisma.applicantStatusEvent.create({
        data: {
          applicantId: applicant.id,
          fromStatus: applicant.reviewStatus,
          toStatus: 'REJECTED_RETRY',
          reason: `Resubmission requested by support agent: ${input.reason}`,
          actorType: 'AI_AGENT',
          actorId: ctx.agentUserId ?? null,
          metadata: { ticketId: ctx.ticketId, documentTypes: input.documentTypes },
        },
      }),
    ]);

    return {
      reopened: true,
      documentTypes: input.documentTypes,
      supersededDocuments: superseded.count,
      nextStep: 'Tell the applicant what to upload and give them the upload link.',
    };
  },
});

const generateUploadLink = def({
  spec: {
    name: 'generate_upload_link',
    description:
      'Create a fresh, time-limited link the applicant can use to continue their verification.',
    effect: 'WRITE',
  },
  inputSchema: z.object({
    ttlMinutes: z.number().int().min(15).max(1440).default(120),
  }),
  async handler(input, ctx) {
    const applicant = await requireApplicant(ctx);

    // The token itself is minted by the API's SDK-token endpoint; the agent only
    // records the request and hands back a resume reference, so the signing key
    // never comes anywhere near the agent process.
    const reference = newId('resume');
    await prisma.applicantStatusEvent.create({
      data: {
        applicantId: applicant.id,
        toStatus: applicant.reviewStatus,
        reason: 'Support agent issued a resume link',
        actorType: 'AI_AGENT',
        actorId: ctx.agentUserId ?? null,
        metadata: {
          ticketId: ctx.ticketId,
          resumeReference: reference,
          expiresAt: new Date(Date.now() + input.ttlMinutes * 60_000).toISOString(),
        },
      },
    });

    return {
      resumeReference: reference,
      // The API turns this into a signed URL when it delivers the message; the
      // agent must not fabricate a URL of its own.
      linkPlaceholder: '{{RESUME_LINK}}',
      expiresInMinutes: input.ttlMinutes,
      instruction:
        'Include the literal token {{RESUME_LINK}} where the link should appear; it is substituted on delivery.',
    };
  },
});

const sendApplicantMessage = def({
  spec: {
    name: 'send_applicant_message',
    description:
      'Send the applicant an email or SMS. Use only when they need something outside this conversation, such as a resume link.',
    effect: 'EXTERNAL',
    // Anything that leaves the building on the firm's letterhead gets a human
    // in the loop by default.
    requiresApproval: true,
  },
  inputSchema: z.object({
    channel: z.enum(['email', 'sms']),
    subject: z.string().max(200).optional(),
    body: z.string().min(10).max(4000),
  }),
  async handler(input, ctx) {
    const applicant = await requireApplicant(ctx);
    const destination = input.channel === 'email' ? applicant.email : applicant.phone;
    if (!destination) {
      throw new Error(
        `No ${input.channel} address on file for this applicant, so the message cannot be sent.`,
      );
    }

    // Staged, not sent. The worker's outbound queue picks it up once a human has
    // approved, which is why this returns "queued" rather than "sent".
    const staged = await prisma.caseNote.create({
      data: {
        caseId: await ensureCaseId(ctx, 'SUPPORT_ESCALATION', 'Outbound message pending approval'),
        actorType: 'AI_AGENT',
        body: `[${input.channel.toUpperCase()} DRAFT]\n${input.subject ? `Subject: ${input.subject}\n` : ''}${input.body}`,
        isInternal: true,
        attachments: [
          { kind: 'outbound-draft', channel: input.channel, to: redactPii(destination).redacted },
        ],
      },
    });

    return {
      queued: true,
      draftId: staged.id,
      channel: input.channel,
      awaitingHumanApproval: true,
      note: 'The message is drafted and waiting for a human to approve before it goes out. Tell the applicant the information directly in this conversation too.',
    };
  },
});

const createCase = def({
  spec: {
    name: 'create_case',
    description:
      'Open a case so a human can work on something you cannot resolve yourself. Use for appeals, complaints, data requests, and suspected fraud.',
    effect: 'WRITE',
  },
  inputSchema: z.object({
    type: z.enum([
      'APPEAL',
      'DATA_SUBJECT_REQUEST',
      'FRAUD_INVESTIGATION',
      'DOCUMENT_ISSUE',
      'SUPPORT_ESCALATION',
      'AML_HIT_REVIEW',
    ]),
    title: z.string().min(5).max(200),
    summary: z.string().min(20).max(4000).describe('What the applicant wants and what you have already checked.'),
    priority: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).default('MEDIUM'),
  }),
  async handler(input, ctx) {
    const caseId = await ensureCaseId(ctx, input.type, input.title, {
      priority: input.priority,
      summary: input.summary,
    });
    const created = await prisma.case.findUniqueOrThrow({
      where: { id: caseId },
      select: { reference: true, type: true, priority: true },
    });
    return {
      caseReference: created.reference,
      type: created.type,
      priority: created.priority,
      note: 'Give the applicant this reference so they can quote it.',
    };
  },
});

const addCaseNote = def({
  spec: {
    name: 'add_case_note',
    description:
      'Add context to an existing case for the human who will pick it up. Use before escalating so they do not have to re-read the whole transcript.',
    effect: 'WRITE',
  },
  inputSchema: z.object({
    body: z.string().min(10).max(4000),
  }),
  async handler(input, ctx) {
    const caseId = await ensureCaseId(ctx, 'SUPPORT_ESCALATION', 'Support conversation');
    const note = await prisma.caseNote.create({
      data: {
        caseId,
        actorType: 'AI_AGENT',
        // Redacted on the way in: transcripts get exported, and a document
        // number pasted into a note travels with them.
        body: redactPii(input.body).redacted,
        isInternal: true,
      },
    });
    return { noteId: note.id, added: true };
  },
});

const escalateToHuman = def({
  spec: {
    name: 'escalate_to_human',
    description:
      'Hand the conversation to a human specialist. Use whenever policy requires it, the applicant asks for a person, or you are not confident enough to answer.',
    effect: 'WRITE',
  },
  inputSchema: z.object({
    reason: z.enum([
      'LOW_CONFIDENCE',
      'POLICY_REQUIRES_HUMAN',
      'APPLICANT_REQUESTED',
      'REGULATORY_DECISION',
      'SENTIMENT_NEGATIVE',
      'REPEAT_CONTACT',
      'TOOL_FAILURE',
      'SUSPECTED_FRAUD',
      'COMPLAINT',
      'DATA_SUBJECT_RIGHTS',
    ]),
    detail: z.string().min(10).max(2000).describe('What the human needs to know to pick this up cold.'),
    confidence: z.number().min(0).max(1).describe('How confident you were before giving up.'),
  }),
  async handler(input, ctx) {
    const { INTENT_POLICY, escalationDueAt } = await import('@kyc/core');
    const sla = INTENT_POLICY[ctx.intent].slaMinutes;

    const escalation = await prisma.escalation.create({
      data: {
        ticketId: ctx.ticketId,
        reason: input.reason as never,
        detail: input.detail,
        agentConfidence: input.confidence,
        dueAt: escalationDueAt(sla),
      },
    });

    await prisma.supportTicket.update({
      where: { id: ctx.ticketId },
      data: { status: 'ESCALATED', handledBy: 'HYBRID' },
    });

    return {
      escalated: true,
      escalationId: escalation.id,
      // Quote a real SLA rather than "soon", because the applicant will hold us
      // to whatever we say.
      responseWithinHours: Math.ceil(sla / 60),
      note: 'Tell the applicant a specialist will respond, and give them the timeframe.',
    };
  },
});

/** Finds or opens the case backing this ticket. */
async function ensureCaseId(
  ctx: AgentContext,
  type: string,
  title: string,
  extra: { priority?: string; summary?: string } = {},
): Promise<string> {
  const ticket = await prisma.supportTicket.findFirstOrThrow({
    where: { id: ctx.ticketId, tenantId: ctx.tenantId },
    select: { caseId: true, reference: true, applicantId: true },
  });
  if (ticket.caseId) return ticket.caseId;

  const count = await prisma.case.count({ where: { tenantId: ctx.tenantId } });
  const created = await prisma.case.create({
    data: {
      tenantId: ctx.tenantId,
      reference: `CASE-${1000 + count + 1}`,
      type: type as never,
      title,
      summary: extra.summary,
      priority: (extra.priority ?? 'MEDIUM') as never,
      applicantId: ticket.applicantId,
      context: {
        openedBy: 'ai-support-agent',
        ticketReference: ticket.reference,
        conversationId: ctx.conversationId,
        policyVersion: ctx.policyVersion,
      },
    },
  });

  await prisma.supportTicket.update({
    where: { id: ctx.ticketId },
    data: { caseId: created.id },
  });
  return created.id;
}

// ---------------------------------------------------------------------------
// Registry
// ---------------------------------------------------------------------------

export const TOOL_DEFINITIONS: ToolDefinition<z.ZodType>[] = [
  getApplicantStatus,
  getOutstandingRequirements,
  getCheckResults,
  getRejectionReasons,
  searchKnowledgeBase,
  estimateCompletion,
  classifyIntent,
  requestResubmission,
  generateUploadLink,
  sendApplicantMessage,
  createCase,
  addCaseNote,
  escalateToHuman,
] as ToolDefinition<z.ZodType>[];

export const TOOLS_BY_NAME = new Map(
  TOOL_DEFINITIONS.map((t) => [t.spec.name, t] as const),
);

/**
 * Executes a tool with the full policy and audit wrapper.
 *
 * A denial is returned to the model as a normal result, not thrown: telling the
 * model "you may not do that, here is why" lets it adapt (usually by
 * escalating), whereas an exception just ends the turn.
 */
export async function invokeTool(
  name: string,
  rawInput: unknown,
  ctx: AgentContext,
): Promise<ToolOutcome> {
  const started = Date.now();
  const tool = TOOLS_BY_NAME.get(name);

  if (!tool) {
    return record(ctx, name, rawInput, {
      status: 'FAILED',
      output: { error: `Unknown tool: ${name}` },
      errorMessage: `Unknown tool: ${name}`,
      latencyMs: Date.now() - started,
    }, 'READ');
  }

  const permission = isToolAllowed(ctx.intent as SupportIntent, name);
  if (!permission.allowed) {
    return record(ctx, name, rawInput, {
      status: 'DENIED_BY_POLICY',
      output: {
        denied: true,
        reason: permission.reason,
        guidance:
          'You are not permitted to do this for the current intent. Either re-classify the intent if you have misread the request, or escalate to a human.',
      },
      latencyMs: Date.now() - started,
    }, tool.spec.effect);
  }

  const parsed = tool.inputSchema.safeParse(rawInput ?? {});
  if (!parsed.success) {
    return record(ctx, name, rawInput, {
      status: 'FAILED',
      output: {
        error: 'Invalid arguments',
        issues: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
      },
      errorMessage: 'schema validation failed',
      latencyMs: Date.now() - started,
    }, tool.spec.effect);
  }

  try {
    const output = await tool.handler(parsed.data, ctx);
    return record(ctx, name, parsed.data, {
      status: tool.spec.requiresApproval ? 'NEEDS_APPROVAL' : 'OK',
      output,
      latencyMs: Date.now() - started,
    }, tool.spec.effect);
  } catch (error) {
    const message = error instanceof Error ? error.message : 'tool execution failed';
    return record(ctx, name, parsed.data, {
      status: 'FAILED',
      // The message is written to be actionable for the model, because the
      // model is the one that has to recover from it.
      output: { error: message },
      errorMessage: message,
      latencyMs: Date.now() - started,
    }, tool.spec.effect);
  }
}

async function record(
  ctx: AgentContext,
  toolName: string,
  input: unknown,
  outcome: ToolOutcome,
  effect: AgentToolSpec['effect'],
): Promise<ToolOutcome> {
  try {
    await prisma.toolInvocation.create({
      data: {
        runId: ctx.runId,
        toolName,
        input: (input ?? {}) as never,
        output: (outcome.output ?? {}) as never,
        effect: effect as never,
        status: outcome.status as never,
        errorMessage: outcome.errorMessage ?? null,
        latencyMs: outcome.latencyMs,
      },
    });
  } catch {
    // A failed audit write must not swallow the tool result the model is waiting
    // on, but it is a real problem — surfaced via the run's error field rather
    // than by aborting the conversation.
  }
  return outcome;
}

/** Tool specs the model is allowed to see for a given intent. */
export function toolsForIntent(intent: SupportIntent): ToolDefinition<z.ZodType>[] {
  return TOOL_DEFINITIONS.filter((t) => isToolAllowed(intent, t.spec.name).allowed);
}
