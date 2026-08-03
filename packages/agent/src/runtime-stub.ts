import {
  INTENT_POLICY,
  STATUS_COPY,
  classifyIntentHeuristic,
  estimateSentiment,
  mentionsRegulator,
  shouldEscalate,
} from '@kyc/core';
import { invokeTool } from './tools.js';
import type { AgentRuntime, AgentTurnResult } from './types.js';

/**
 * Deterministic offline agent.
 *
 * Exists for three reasons, in order of importance:
 *
 *  1. It proves the tool contracts. The stub calls the same tools through the
 *     same policy wrapper as the model does, so a broken tool surface fails in
 *     CI rather than in front of an applicant.
 *  2. It makes the whole platform runnable and testable with no API key and no
 *     network — the tests assert on its output because it is deterministic.
 *  3. It is a working degraded mode. If the model is unavailable, applicants get
 *     a correct (if plainer) answer built from real record data, and anything it
 *     cannot answer is escalated rather than guessed at.
 *
 * It is deliberately conservative: it answers the handful of questions that can
 * be answered mechanically from record data, and escalates everything else.
 */
export class StubAgentRuntime implements AgentRuntime {
  readonly name = 'stub' as const;

  async run(args: Parameters<AgentRuntime['run']>[0]): Promise<AgentTurnResult> {
    const { context, history, maxTurns } = args;
    const calls: AgentTurnResult['toolCalls'] = [];
    let toolFailures = 0;

    const lastMessage =
      [...history].reverse().find((m) => m.role === 'applicant')?.content ?? '';
    const sentiment = estimateSentiment(lastMessage);
    const askedForHuman = /\b(human|person|agent|someone|speak to|talk to)\b/i.test(lastMessage);

    const call = async (name: string, input: unknown = {}) => {
      const outcome = await invokeTool(name, input, context);
      calls.push({ name, input, status: outcome.status, latencyMs: outcome.latencyMs });
      if (outcome.status === 'FAILED') toolFailures++;
      return outcome;
    };

    const policy = INTENT_POLICY[context.intent];

    // Confidence is derived from the classifier and then reduced by anything
    // that suggests this is not a routine question.
    const classification = classifyIntentHeuristic(lastMessage);
    let confidence =
      classification.intent === context.intent ? classification.confidence : 0.4;
    if (!context.applicantId) confidence = Math.min(confidence, 0.35);

    const gate = shouldEscalate({
      intent: context.intent,
      confidence,
      turnCount: calls.length,
      maxTurns,
      sentiment,
      applicantAskedForHuman: askedForHuman,
      mentionsRegulator: mentionsRegulator(lastMessage),
      toolFailures,
    });

    if (gate.escalate) {
      return this.escalate(context, calls, gate.reason ?? 'LOW_CONFIDENCE', gate.detail ?? '', confidence, call);
    }

    // Routine path: read the record and answer from it.
    const status = await call('get_applicant_status');
    if (status.status !== 'OK') {
      return this.escalate(
        context,
        calls,
        'TOOL_FAILURE',
        'Could not read the verification record.',
        0.1,
        call,
      );
    }

    const record = status.output as {
      reviewStatus: keyof typeof STATUS_COPY;
      statusExplanation?: string;
      canResubmit: boolean;
      awaitingAnalystReview: boolean;
    };

    const parts: string[] = [];
    parts.push(record.statusExplanation ?? STATUS_COPY[record.reviewStatus].detail);

    if (context.intent === 'DOCUMENT_REJECTED' || record.reviewStatus === 'REJECTED_RETRY') {
      const reasons = await call('get_rejection_reasons');
      const payload = reasons.output as {
        reasons?: string[];
        isFinal?: boolean;
        canResubmit?: boolean;
      };
      if (payload?.isFinal) {
        return this.escalate(
          context,
          calls,
          'POLICY_REQUIRES_HUMAN',
          'Final rejection: the applicant must be handled by a human reviewer.',
          confidence,
          call,
        );
      }
      if (payload?.reasons?.length) {
        parts.push('', 'What needs fixing:');
        for (const reason of payload.reasons) parts.push(`  • ${reason}`);
      }
    }

    if (record.canResubmit || context.intent === 'VERIFICATION_STATUS') {
      const outstanding = await call('get_outstanding_requirements');
      const payload = outstanding.output as {
        allDone?: boolean;
        outstanding?: Array<{ label: string; acceptedDocumentTypes: string[] }>;
      };
      if (payload?.outstanding?.length) {
        parts.push('', 'Still needed from you:');
        for (const step of payload.outstanding) {
          const accepted = step.acceptedDocumentTypes.length
            ? ` (${step.acceptedDocumentTypes.join(', ').toLowerCase().replace(/_/g, ' ')})`
            : '';
          parts.push(`  • ${step.label}${accepted}`);
        }
      }
    }

    if (
      context.intent === 'TIMELINE_QUESTION' ||
      record.reviewStatus === 'QUEUED' ||
      record.awaitingAnalystReview
    ) {
      const eta = await call('estimate_completion_time');
      const payload = eta.output as { humanReadable?: string; note?: string };
      if (payload?.humanReadable) {
        parts.push('', `Timing: ${payload.humanReadable}. ${payload.note ?? ''}`.trim());
      }
    }

    if (policy.allowedTools.includes('search_knowledge_base')) {
      const kb = await call('search_knowledge_base', { query: lastMessage.slice(0, 120), limit: 1 });
      const payload = kb.output as { results?: Array<{ title: string; excerpt: string }> };
      const article = payload?.results?.[0];
      if (article) {
        parts.push('', `This may help — ${article.title}: ${article.excerpt.slice(0, 240)}`);
      }
    }

    return {
      reply: parts.filter(Boolean).join('\n').trim(),
      toolCalls: calls,
      turns: calls.length,
      stopReason: 'end_turn',
      escalated: false,
      confidence,
      usage: { inputTokens: 0, outputTokens: 0, model: 'stub', runtime: 'stub' },
    };
  }

  private async escalate(
    context: Parameters<AgentRuntime['run']>[0]['context'],
    calls: AgentTurnResult['toolCalls'],
    reason: string,
    detail: string,
    confidence: number,
    call: (name: string, input?: unknown) => Promise<{ status: string; output: unknown }>,
  ): Promise<AgentTurnResult> {
    await call('add_case_note', {
      body: `Automated assistant could not resolve this (${reason}). ${detail}`.slice(0, 3900),
    });
    const escalation = await call('escalate_to_human', {
      reason,
      detail: detail || 'The automated assistant was not confident enough to answer.',
      confidence,
    });

    const hours =
      (escalation.output as { responseWithinHours?: number })?.responseWithinHours ?? 4;

    return {
      reply: [
        'I have passed this to a member of our team so a person can look at it properly.',
        `They will get back to you within ${hours} hour${hours === 1 ? '' : 's'}.`,
      ].join(' '),
      toolCalls: calls,
      turns: calls.length,
      stopReason: 'escalated',
      escalated: true,
      escalationReason: reason,
      confidence,
      usage: { inputTokens: 0, outputTokens: 0, model: 'stub', runtime: 'stub' },
    };
  }
}
