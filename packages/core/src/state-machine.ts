import { KycError } from './errors.js';

/**
 * Applicant review lifecycle.
 *
 * The whole point of encoding this as an explicit machine is that "approved"
 * and "finally rejected" are consequential states with legal weight. A stray
 * write that flips a REJECTED_FINAL applicant back to PENDING is a compliance
 * incident, so transitions are enumerated and anything else throws.
 */

export type ReviewStatus =
  | 'NOT_STARTED'
  | 'PENDING'
  | 'QUEUED'
  | 'ON_HOLD'
  | 'APPROVED'
  | 'REJECTED_RETRY'
  | 'REJECTED_FINAL';

export type ApplicantStatus =
  | 'INIT'
  | 'PENDING'
  | 'AWAITING_USER'
  | 'QUEUED'
  | 'PROCESSING'
  | 'ON_HOLD'
  | 'COMPLETED';

export type TransitionTrigger =
  | 'APPLICANT_SUBMITTED'
  | 'CHECKS_STARTED'
  | 'CHECKS_COMPLETED'
  | 'AUTO_APPROVED'
  | 'AUTO_REJECTED'
  | 'ROUTED_TO_QUEUE'
  | 'REVIEWER_APPROVED'
  | 'REVIEWER_REJECTED_RETRY'
  | 'REVIEWER_REJECTED_FINAL'
  | 'PUT_ON_HOLD'
  | 'HOLD_RELEASED'
  | 'APPLICANT_RESUBMITTED'
  | 'MONITORING_HIT'
  | 'PERIODIC_REVIEW_DUE'
  | 'DECISION_OVERTURNED_ON_APPEAL'
  | 'RESET_BY_ADMIN';

interface Transition {
  from: ReviewStatus[];
  to: ReviewStatus;
  /**
   * Some transitions may only be performed by a human with authority. Automated
   * pipeline code must not be able to reach them.
   */
  requiresHuman?: boolean;
  /** Overturning a final rejection is a privileged, logged act. */
  privileged?: boolean;
}

const TRANSITIONS: Record<TransitionTrigger, Transition> = {
  APPLICANT_SUBMITTED: {
    from: ['NOT_STARTED', 'PENDING', 'REJECTED_RETRY'],
    to: 'PENDING',
  },
  CHECKS_STARTED: { from: ['PENDING', 'QUEUED'], to: 'PENDING' },
  CHECKS_COMPLETED: { from: ['PENDING'], to: 'PENDING' },
  AUTO_APPROVED: { from: ['PENDING'], to: 'APPROVED' },
  AUTO_REJECTED: { from: ['PENDING'], to: 'REJECTED_RETRY' },
  ROUTED_TO_QUEUE: { from: ['PENDING', 'ON_HOLD'], to: 'QUEUED' },
  REVIEWER_APPROVED: {
    from: ['QUEUED', 'ON_HOLD', 'PENDING'],
    to: 'APPROVED',
    requiresHuman: true,
  },
  REVIEWER_REJECTED_RETRY: {
    from: ['QUEUED', 'ON_HOLD', 'PENDING'],
    to: 'REJECTED_RETRY',
    requiresHuman: true,
  },
  REVIEWER_REJECTED_FINAL: {
    from: ['QUEUED', 'ON_HOLD', 'PENDING', 'APPROVED'],
    to: 'REJECTED_FINAL',
    requiresHuman: true,
  },
  PUT_ON_HOLD: { from: ['PENDING', 'QUEUED', 'APPROVED'], to: 'ON_HOLD' },
  HOLD_RELEASED: { from: ['ON_HOLD'], to: 'QUEUED' },
  // A retry-rejected applicant sending new documents re-enters the pipeline.
  APPLICANT_RESUBMITTED: { from: ['REJECTED_RETRY', 'ON_HOLD'], to: 'PENDING' },
  // An approved customer matching a newly-added sanctions entry must be frozen,
  // not silently left approved.
  MONITORING_HIT: { from: ['APPROVED'], to: 'ON_HOLD' },
  PERIODIC_REVIEW_DUE: { from: ['APPROVED'], to: 'QUEUED' },
  DECISION_OVERTURNED_ON_APPEAL: {
    from: ['REJECTED_FINAL', 'REJECTED_RETRY'],
    to: 'QUEUED',
    requiresHuman: true,
    privileged: true,
  },
  RESET_BY_ADMIN: {
    from: [
      'NOT_STARTED', 'PENDING', 'QUEUED', 'ON_HOLD',
      'APPROVED', 'REJECTED_RETRY', 'REJECTED_FINAL',
    ],
    to: 'NOT_STARTED',
    requiresHuman: true,
    privileged: true,
  },
};

export interface TransitionContext {
  /** Set when a human user is driving the change. */
  actorType: 'SYSTEM' | 'USER' | 'APPLICANT' | 'AI_AGENT' | 'API' | 'SCHEDULER';
  /** Privileged transitions additionally require an authorised role. */
  actorRole?: string;
}

const PRIVILEGED_ROLES = new Set(['OWNER', 'ADMIN', 'COMPLIANCE_OFFICER', 'MLRO']);

export interface TransitionResult {
  from: ReviewStatus;
  to: ReviewStatus;
  trigger: TransitionTrigger;
  applicantStatus: ApplicantStatus;
  terminal: boolean;
}

export function canTransition(
  from: ReviewStatus,
  trigger: TransitionTrigger,
  ctx: TransitionContext = { actorType: 'SYSTEM' },
): { ok: true } | { ok: false; reason: string } {
  const t = TRANSITIONS[trigger];
  if (!t) return { ok: false, reason: `unknown trigger ${trigger}` };
  if (!t.from.includes(from)) {
    return {
      ok: false,
      reason: `cannot ${trigger} from ${from}; allowed from ${t.from.join(', ')}`,
    };
  }
  // The AI support agent is explicitly not a human for this purpose. It can
  // recommend, and a human confirms.
  if (t.requiresHuman && ctx.actorType !== 'USER') {
    return {
      ok: false,
      reason: `${trigger} requires a human reviewer, got actorType=${ctx.actorType}`,
    };
  }
  if (t.privileged && !PRIVILEGED_ROLES.has(ctx.actorRole ?? '')) {
    return {
      ok: false,
      reason: `${trigger} requires one of: ${[...PRIVILEGED_ROLES].join(', ')}`,
    };
  }
  return { ok: true };
}

export function transition(
  from: ReviewStatus,
  trigger: TransitionTrigger,
  ctx: TransitionContext = { actorType: 'SYSTEM' },
): TransitionResult {
  const check = canTransition(from, trigger, ctx);
  if (!check.ok) {
    throw new KycError('ILLEGAL_TRANSITION', check.reason, {
      details: { from, trigger, actorType: ctx.actorType },
    });
  }
  const to = TRANSITIONS[trigger].to;
  return {
    from,
    to,
    trigger,
    applicantStatus: applicantStatusFor(to, trigger),
    terminal: isTerminal(to),
  };
}

/**
 * The coarse applicant-facing status derived from the review status. Applicants
 * do not need to see queue mechanics; they need to know whether it is on them
 * or on us.
 */
export function applicantStatusFor(
  status: ReviewStatus,
  trigger?: TransitionTrigger,
): ApplicantStatus {
  switch (status) {
    case 'NOT_STARTED':
      return 'INIT';
    case 'PENDING':
      return trigger === 'CHECKS_STARTED' ? 'PROCESSING' : 'PENDING';
    case 'QUEUED':
      return 'QUEUED';
    case 'ON_HOLD':
      return 'ON_HOLD';
    case 'APPROVED':
    case 'REJECTED_FINAL':
      return 'COMPLETED';
    case 'REJECTED_RETRY':
      // The applicant can act, so this is "awaiting user", not "completed".
      return 'AWAITING_USER';
  }
}

export function isTerminal(status: ReviewStatus): boolean {
  return status === 'APPROVED' || status === 'REJECTED_FINAL';
}

/** Whether the applicant may upload new documents in this state. */
export function acceptsSubmissions(status: ReviewStatus): boolean {
  return (
    status === 'NOT_STARTED' || status === 'PENDING' || status === 'REJECTED_RETRY'
  );
}

/** Applicant-facing copy for each state. Used by the SDK and the support agent. */
export const STATUS_COPY: Record<ReviewStatus, { title: string; detail: string }> = {
  NOT_STARTED: {
    title: 'Not started',
    detail: 'You have not begun verification yet.',
  },
  PENDING: {
    title: 'In progress',
    detail: 'We are reviewing what you submitted. This usually takes a few minutes.',
  },
  QUEUED: {
    title: 'Under review',
    detail: 'A member of our team is reviewing your application.',
  },
  ON_HOLD: {
    title: 'On hold',
    detail: 'Your verification is paused while we complete some additional checks.',
  },
  APPROVED: {
    title: 'Verified',
    detail: 'Your identity has been verified. Nothing further is needed.',
  },
  REJECTED_RETRY: {
    title: 'Action needed',
    detail: 'We need you to resubmit. See the reasons listed and try again.',
  },
  REJECTED_FINAL: {
    title: 'Not verified',
    detail: 'We were unable to verify your identity and cannot accept a resubmission.',
  },
};

export const TRIGGERS = Object.keys(TRANSITIONS) as TransitionTrigger[];

/** Every legal (from, trigger) pair. Used by tests and the docs generator. */
export function transitionTable(): Array<{
  from: ReviewStatus;
  trigger: TransitionTrigger;
  to: ReviewStatus;
  requiresHuman: boolean;
}> {
  const rows: Array<{
    from: ReviewStatus;
    trigger: TransitionTrigger;
    to: ReviewStatus;
    requiresHuman: boolean;
  }> = [];
  for (const [trigger, t] of Object.entries(TRANSITIONS)) {
    for (const from of t.from) {
      rows.push({
        from,
        trigger: trigger as TransitionTrigger,
        to: t.to,
        requiresHuman: t.requiresHuman ?? false,
      });
    }
  }
  return rows;
}
