import type { SupportIntent } from '@kyc/core';

/**
 * Contracts for the agentic support layer.
 *
 * The whole design rests on one rule: the agent is a *reader and a router*, not
 * a decision-maker. It can look at anything about an applicant that the
 * applicant themselves is entitled to see, it can ask them for a resubmission,
 * and it can hand over to a human. It cannot approve, reject, resolve a
 * sanctions hit, or alter a risk score — those need a named accountable person.
 */

export interface AgentContext {
  tenantId: string;
  ticketId: string;
  conversationId: string;
  runId: string;
  /** Resolved applicant, if the ticket is linked to one. */
  applicantId?: string;
  /** Classified intent; gates which tools are callable. */
  intent: SupportIntent;
  /** Locale for applicant-facing copy. */
  language: string;
  /** Identity the agent acts as, for the audit trail. */
  agentUserId?: string;
  /** Policy snapshot in force for this conversation. */
  policyVersion: string;
}

export interface ToolOutcome {
  status: 'OK' | 'DENIED_BY_POLICY' | 'NEEDS_APPROVAL' | 'FAILED' | 'TIMEOUT';
  /** Serialised payload returned to the model. */
  output: unknown;
  errorMessage?: string;
  latencyMs: number;
}

export type ToolEffect = 'READ' | 'WRITE' | 'EXTERNAL';

export interface AgentToolSpec {
  name: string;
  description: string;
  effect: ToolEffect;
  /**
   * Whether a human must sign off before the effect lands. The tool still runs
   * and returns a preview, but the side effect is staged rather than applied.
   */
  requiresApproval?: boolean;
}

export interface AgentTurnResult {
  /** Assistant text to show the applicant. */
  reply: string;
  /** Tools the agent used, in order. */
  toolCalls: Array<{
    name: string;
    input: unknown;
    status: ToolOutcome['status'];
    latencyMs: number;
  }>;
  turns: number;
  stopReason: string;
  escalated: boolean;
  escalationReason?: string;
  /** Agent's own confidence in its answer, 0-1. */
  confidence: number;
  usage: {
    inputTokens: number;
    outputTokens: number;
    model: string;
    runtime: 'claude' | 'stub';
  };
  /** Set when the safety classifiers declined the request. */
  refused?: boolean;
}

export interface AgentRuntime {
  readonly name: 'claude' | 'stub';
  run(args: {
    context: AgentContext;
    systemPrompt: string;
    /** Full conversation so far, oldest first. */
    history: Array<{ role: 'applicant' | 'assistant'; content: string }>;
    maxTurns: number;
  }): Promise<AgentTurnResult>;
}

export interface AgentConfig {
  runtime: 'claude' | 'stub';
  model: string;
  /** Model used to retry when the safety classifiers decline a request. */
  fallbackModel?: string;
  /** Thinking depth / token spend. */
  effort: 'low' | 'medium' | 'high' | 'xhigh' | 'max';
  maxTurns: number;
  maxOutputTokens: number;
  apiKey?: string;
  escalationSlaMinutes: number;
}

export function loadAgentConfig(env: NodeJS.ProcessEnv = process.env): AgentConfig {
  const requested = (env.AGENT_RUNTIME ?? 'claude') as 'claude' | 'stub';
  // Falling back to the stub without an API key is safe here in a way it is not
  // for verification adapters: the stub answers from the same tool data and
  // escalates whenever it is unsure, so the worst case is a human handling a
  // ticket that could have been automated.
  const runtime = requested === 'claude' && !env.ANTHROPIC_API_KEY ? 'stub' : requested;

  return {
    runtime,
    model: env.AGENT_MODEL ?? 'claude-opus-5',
    fallbackModel: env.AGENT_FALLBACK_MODEL ?? 'claude-opus-4-8',
    effort: (env.AGENT_EFFORT ?? 'medium') as AgentConfig['effort'],
    maxTurns: Number(env.AGENT_MAX_TURNS ?? 12),
    maxOutputTokens: Number(env.AGENT_MAX_OUTPUT_TOKENS ?? 4096),
    apiKey: env.ANTHROPIC_API_KEY,
    escalationSlaMinutes: Number(env.AGENT_ESCALATION_SLA_MINUTES ?? 30),
  };
}
