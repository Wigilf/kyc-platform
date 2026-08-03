import Anthropic from '@anthropic-ai/sdk';
import { betaZodTool } from '@anthropic-ai/sdk/helpers/beta/zod';
import { estimateSentiment, shouldEscalate } from '@kyc/core';
import { invokeTool, toolsForIntent } from './tools.js';
import type { AgentConfig, AgentRuntime, AgentTurnResult } from './types.js';

/**
 * Claude-backed agent loop.
 *
 * Uses the SDK's tool runner rather than a hand-rolled while-loop: the runner
 * drives the request → execute → feed-back cycle, and every tool still passes
 * through `invokeTool`, so the policy check and the audit write happen on the
 * execution path regardless of what the model decides to call.
 *
 * Three API behaviours are handled deliberately because each is easy to get
 * wrong and each fails quietly:
 *
 *  - **Refusals are not errors.** A safety-classifier decline returns HTTP 200
 *    with `stop_reason: "refusal"` and empty or partial content. Reading
 *    `content[0]` without checking would throw on exactly the requests we most
 *    need to handle gracefully. Server-side `fallbacks: "default"` re-runs the
 *    request on Anthropic's recommended fallback in the same call, so a false
 *    positive on a benign support question recovers instead of failing a ticket.
 *  - **Thinking is on by default** on this model tier, and `max_tokens` caps
 *    thinking plus visible text together, so the budget is sized for both.
 *  - **Sampling parameters are rejected.** No `temperature` or `top_p` — tone is
 *    steered entirely through the system prompt.
 */
export class ClaudeAgentRuntime implements AgentRuntime {
  readonly name = 'claude' as const;
  private readonly client: Anthropic;

  constructor(private readonly config: AgentConfig) {
    this.client = new Anthropic({
      // Falls back to ANTHROPIC_API_KEY / an `ant auth login` profile when unset.
      ...(config.apiKey ? { apiKey: config.apiKey } : {}),
      maxRetries: 2,
    });
  }

  async run(args: Parameters<AgentRuntime['run']>[0]): Promise<AgentTurnResult> {
    const { context, systemPrompt, history, maxTurns } = args;

    const calls: AgentTurnResult['toolCalls'] = [];
    let toolFailures = 0;
    let escalated = false;
    let escalationReason: string | undefined;
    let reportedConfidence = 0.8;

    const tools = toolsForIntent(context.intent).map((definition) =>
      betaZodTool({
        name: definition.spec.name,
        description: definition.spec.description,
        inputSchema: definition.inputSchema as never,
        // Every call is funnelled through invokeTool: policy first, then audit,
        // then the handler. The model never reaches a handler directly.
        run: async (input: unknown) => {
          const outcome = await invokeTool(definition.spec.name, input, context);
          calls.push({
            name: definition.spec.name,
            input,
            status: outcome.status,
            latencyMs: outcome.latencyMs,
          });
          if (outcome.status === 'FAILED') toolFailures++;
          if (definition.spec.name === 'escalate_to_human' && outcome.status === 'OK') {
            escalated = true;
            const typed = input as { reason?: string; confidence?: number };
            escalationReason = typed?.reason;
            reportedConfidence = typed?.confidence ?? reportedConfidence;
          }
          return JSON.stringify(outcome.output);
        },
      }),
    );

    const messages: Anthropic.Beta.Messages.BetaMessageParam[] = history.map((m) => ({
      role: m.role === 'applicant' ? 'user' : 'assistant',
      content: m.content,
    }));

    let final: Anthropic.Beta.Messages.BetaMessage;
    try {
      final = await this.client.beta.messages
        .toolRunner({
          model: this.config.model,
          // Covers thinking + visible text together.
          max_tokens: this.config.maxOutputTokens,
          system: systemPrompt,
          messages,
          tools,
          max_iterations: maxTurns,
          // Adaptive is the default on this tier; stated explicitly so intent is
          // legible and behaviour does not drift under a model swap.
          thinking: { type: 'adaptive' },
          output_config: { effort: this.config.effort },
          // Routes a policy decline to Anthropic's recommended fallback rather
          // than returning the refusal to the applicant.
          betas: ['server-side-fallback-2026-07-01'],
          fallbacks: 'default',
        })
        .runUntilDone();
    } catch (error) {
      // An API failure is not the applicant's problem: hand to a human rather
      // than surfacing a stack trace or a vague apology.
      return {
        reply:
          'I am having trouble looking that up right now, so I have passed this to a member of our team. They will come back to you shortly.',
        toolCalls: calls,
        turns: calls.length,
        stopReason: 'runtime_error',
        escalated: true,
        escalationReason: 'TOOL_FAILURE',
        confidence: 0,
        usage: {
          inputTokens: 0,
          outputTokens: 0,
          model: this.config.model,
          runtime: 'claude',
        },
      };
    }

    // Check stop_reason before reading content: a refusal that survived the
    // fallback chain carries empty or partial content.
    const refused = final.stop_reason === 'refusal';

    const reply = refused
      ? 'I am not able to answer that here. I have passed it to a member of our team, who will follow up with you.'
      : final.content
          .filter((b): b is Anthropic.Beta.Messages.BetaTextBlock => b.type === 'text')
          .map((b) => b.text)
          .join('\n')
          .trim();

    // Post-hoc policy gate, independent of whether the model chose to escalate.
    // Policy is enforced on the way out, not merely suggested on the way in.
    const lastApplicantMessage = [...history].reverse().find((m) => m.role === 'applicant');
    const gate = shouldEscalate({
      intent: context.intent,
      confidence: reportedConfidence,
      turnCount: calls.length,
      maxTurns,
      sentiment: lastApplicantMessage ? estimateSentiment(lastApplicantMessage.content) : 0,
      toolFailures,
    });

    return {
      reply:
        reply ||
        'I could not put together an answer for that. I have passed it to a member of our team.',
      toolCalls: calls,
      turns: calls.length,
      stopReason: final.stop_reason ?? 'end_turn',
      escalated: escalated || refused || gate.escalate,
      escalationReason: escalationReason ?? (refused ? 'POLICY_REQUIRES_HUMAN' : gate.reason),
      confidence: refused ? 0 : reportedConfidence,
      refused,
      usage: {
        inputTokens: final.usage?.input_tokens ?? 0,
        outputTokens: final.usage?.output_tokens ?? 0,
        // `model` on the response names the model that actually produced the
        // message, which is the fallback when one served the turn.
        model: final.model ?? this.config.model,
        runtime: 'claude',
      },
    };
  }
}
