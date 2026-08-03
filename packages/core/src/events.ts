/**
 * Webhook event catalogue.
 *
 * Events are the integration contract: once a client filters on
 * `applicantReviewed`, that name and payload shape are frozen. New information
 * goes in additive fields, never by renaming or repurposing.
 */

export const EVENT_TYPES = [
  'applicant.created',
  'applicant.pending', // submitted, checks running
  'applicant.onHold',
  'applicant.reviewed', // terminal decision reached
  'applicant.actionRequired', // retry-rejected; applicant must resubmit
  'applicant.levelChanged',
  'applicant.riskChanged',
  'applicant.deleted',
  'applicant.personalInfoChanged',
  'document.uploaded',
  'document.verified',
  'document.rejected',
  'check.completed',
  'screening.hitFound',
  'screening.hitResolved',
  'monitoring.listUpdateMatch',
  'company.verified',
  'company.uboResolved',
  'transaction.flagged',
  'transaction.blocked',
  'alert.created',
  'case.created',
  'case.assigned',
  'case.resolved',
  'travelRule.received',
  'travelRule.responded',
  'support.ticketCreated',
  'support.ticketResolved',
  'support.escalated',
  'reusableKyc.shareRequested',
  'reusableKyc.shareConsented',
] as const;

export type EventType = (typeof EVENT_TYPES)[number];

export interface WebhookEnvelope<T = unknown> {
  /** Unique per delivery attempt series; receivers use it for idempotency. */
  eventId: string;
  eventType: EventType;
  /** ISO 8601, UTC. */
  createdAt: string;
  /** Sandbox vs production, so a client cannot confuse the two. */
  environment: 'SANDBOX' | 'PRODUCTION';
  apiVersion: string;
  data: T;
}

export const API_VERSION = '2026-07-01';

export interface ApplicantReviewedPayload {
  applicantId: string;
  externalUserId: string;
  levelName: string;
  reviewStatus: 'APPROVED' | 'REJECTED_RETRY' | 'REJECTED_FINAL';
  reviewedAt: string;
  riskScore: number;
  riskLevel: string;
  /** Machine-readable reasons. Empty on approval. */
  rejectLabels: string[];
  /** Safe to show the applicant verbatim. */
  clientComment?: string;
  /** Whether the applicant may submit again. */
  canResubmit: boolean;
  reviewSource: 'AUTOMATED' | 'MANUAL' | 'AI_ASSISTED' | 'API';
}

export interface CheckCompletedPayload {
  applicantId: string;
  externalUserId: string;
  checkId: string;
  checkType: string;
  result: 'PASS' | 'FAIL' | 'WARNING' | 'INCONCLUSIVE';
  score?: number;
  findings: unknown[];
}

export interface ScreeningHitPayload {
  applicantId: string;
  externalUserId: string;
  runId: string;
  trigger: string;
  hits: Array<{
    hitId: string;
    listType: string;
    listName: string;
    matchedName: string;
    matchScore: number;
    matchedFields: string[];
  }>;
}

export interface TransactionFlaggedPayload {
  transactionId: string;
  externalId: string;
  applicantId?: string;
  action: 'FLAGGED' | 'BLOCKED' | 'HELD';
  riskScore: number;
  firedRules: Array<{ ruleId: string; ruleName: string }>;
  alerts: Array<{ alertId: string; title: string; severity: string }>;
}

export interface SupportEscalatedPayload {
  ticketId: string;
  reference: string;
  applicantId?: string;
  intent: string;
  reason: string;
  agentConfidence?: number;
  /** Transcript summary the human picks up from. */
  summary: string;
  dueAt?: string;
}

export function buildEnvelope<T>(
  eventType: EventType,
  data: T,
  options: {
    eventId: string;
    environment?: 'SANDBOX' | 'PRODUCTION';
    createdAt?: Date;
  },
): WebhookEnvelope<T> {
  return {
    eventId: options.eventId,
    eventType,
    createdAt: (options.createdAt ?? new Date()).toISOString(),
    environment: options.environment ?? 'SANDBOX',
    apiVersion: API_VERSION,
    data,
  };
}

export function isEventType(value: string): value is EventType {
  return (EVENT_TYPES as readonly string[]).includes(value);
}

/**
 * Retry schedule for failed deliveries: exponential with jitter, spanning about
 * 24 hours across 8 attempts. Long enough to ride out a client deploy, short
 * enough that a dead endpoint is noticed the same day.
 */
export function nextRetryDelayMs(attempt: number): number {
  const base = Math.min(6 * 60 * 60 * 1000, 30_000 * 2 ** Math.max(0, attempt - 1));
  // Jitter prevents a thundering herd when a client's endpoint comes back up
  // and thousands of queued deliveries retry in lockstep.
  const jitter = base * 0.2 * Math.random();
  return Math.round(base + jitter);
}
