/**
 * Shared support-domain logic for the agentic customer service layer.
 *
 * Lives in core rather than in @kyc/agent because three consumers need the same
 * definitions: the agent runtime (to decide what it may do), the API (to route
 * and authorise), and the dashboard (to show a human why the agent handed over).
 */

export const SUPPORT_INTENTS = [
  'UNKNOWN',
  'VERIFICATION_STATUS',
  'DOCUMENT_REJECTED',
  'UPLOAD_HELP',
  'LIVENESS_FAILURE',
  'APPEAL_DECISION',
  'DATA_CORRECTION',
  'DATA_DELETION',
  'SCREENING_DISPUTE',
  'ACCOUNT_ACCESS',
  'TIMELINE_QUESTION',
  'TECHNICAL_ISSUE',
  'COMPLAINT',
  'FRAUD_REPORT',
  'OTHER',
] as const;

export type SupportIntent = (typeof SUPPORT_INTENTS)[number];

export interface IntentDefinition {
  intent: SupportIntent;
  description: string;
  /**
   * Whether a human must own the outcome. The agent may still gather context and
   * draft, but it cannot resolve the ticket.
   */
  requiresHuman: boolean;
  /** Tools the agent may use while handling this intent. */
  allowedTools: string[];
  /** Below this self-reported confidence, escalate rather than answer. */
  minConfidence: number;
  /** Minutes to first human response once escalated. */
  slaMinutes: number;
}

/**
 * The authorisation matrix for the agent. Deny-by-default: a tool not listed for
 * an intent cannot be called, which is what keeps a "where's my verification?"
 * conversation from reaching a decision-writing tool.
 */
export const INTENT_POLICY: Record<SupportIntent, IntentDefinition> = {
  UNKNOWN: {
    intent: 'UNKNOWN',
    description: 'Not yet classified.',
    requiresHuman: false,
    allowedTools: ['get_applicant_status', 'search_knowledge_base', 'classify_intent'],
    minConfidence: 0.5,
    slaMinutes: 240,
  },
  VERIFICATION_STATUS: {
    intent: 'VERIFICATION_STATUS',
    description: 'Where is my verification, what is still outstanding.',
    requiresHuman: false,
    allowedTools: [
      'get_applicant_status',
      'get_outstanding_requirements',
      'get_check_results',
      'search_knowledge_base',
      'estimate_completion_time',
      'send_applicant_message',
    ],
    minConfidence: 0.6,
    slaMinutes: 240,
  },
  DOCUMENT_REJECTED: {
    intent: 'DOCUMENT_REJECTED',
    description: 'Why was my document rejected and what do I do now.',
    requiresHuman: false,
    allowedTools: [
      'get_applicant_status',
      'get_rejection_reasons',
      'get_check_results',
      'search_knowledge_base',
      'request_resubmission',
      'send_applicant_message',
      'generate_upload_link',
    ],
    minConfidence: 0.65,
    slaMinutes: 240,
  },
  UPLOAD_HELP: {
    intent: 'UPLOAD_HELP',
    description: 'Technical help capturing or uploading documents.',
    requiresHuman: false,
    allowedTools: [
      'get_applicant_status',
      'get_outstanding_requirements',
      'search_knowledge_base',
      'generate_upload_link',
      'send_applicant_message',
    ],
    minConfidence: 0.6,
    slaMinutes: 480,
  },
  LIVENESS_FAILURE: {
    intent: 'LIVENESS_FAILURE',
    description: 'Selfie or liveness check keeps failing.',
    requiresHuman: false,
    allowedTools: [
      'get_applicant_status',
      'get_check_results',
      'search_knowledge_base',
      'request_resubmission',
      'generate_upload_link',
      'send_applicant_message',
    ],
    minConfidence: 0.65,
    slaMinutes: 240,
  },
  APPEAL_DECISION: {
    intent: 'APPEAL_DECISION',
    description: 'Contesting a rejection.',
    // A rejection is a decision with legal and commercial consequences; only a
    // human may revisit it.
    requiresHuman: true,
    allowedTools: [
      'get_applicant_status',
      'get_rejection_reasons',
      'get_check_results',
      'create_case',
      'escalate_to_human',
      'send_applicant_message',
    ],
    minConfidence: 0.9,
    slaMinutes: 1440,
  },
  DATA_CORRECTION: {
    intent: 'DATA_CORRECTION',
    description: 'My name/date of birth/address is recorded wrongly.',
    // Rectification changes the identity record the whole decision rests on.
    requiresHuman: true,
    allowedTools: [
      'get_applicant_status',
      'create_case',
      'escalate_to_human',
      'send_applicant_message',
    ],
    minConfidence: 0.9,
    slaMinutes: 1440,
  },
  DATA_DELETION: {
    intent: 'DATA_DELETION',
    description: 'Erasure request under data protection law.',
    // Statutory deadlines and AML retention exemptions have to be balanced by a
    // person who can be accountable for the answer.
    requiresHuman: true,
    allowedTools: ['get_applicant_status', 'create_case', 'escalate_to_human'],
    minConfidence: 0.95,
    slaMinutes: 720,
  },
  SCREENING_DISPUTE: {
    intent: 'SCREENING_DISPUTE',
    description: '"I am not the sanctioned/PEP person you matched me to."',
    requiresHuman: true,
    allowedTools: ['get_applicant_status', 'create_case', 'escalate_to_human'],
    minConfidence: 0.95,
    slaMinutes: 480,
  },
  ACCOUNT_ACCESS: {
    intent: 'ACCOUNT_ACCESS',
    description: 'Cannot get back into the verification flow.',
    requiresHuman: false,
    allowedTools: [
      'get_applicant_status',
      'generate_upload_link',
      'search_knowledge_base',
      'send_applicant_message',
    ],
    minConfidence: 0.6,
    slaMinutes: 480,
  },
  TIMELINE_QUESTION: {
    intent: 'TIMELINE_QUESTION',
    description: 'How long will this take.',
    requiresHuman: false,
    allowedTools: [
      'get_applicant_status',
      'estimate_completion_time',
      'search_knowledge_base',
      'send_applicant_message',
    ],
    minConfidence: 0.55,
    slaMinutes: 480,
  },
  TECHNICAL_ISSUE: {
    intent: 'TECHNICAL_ISSUE',
    description: 'The SDK or app is broken.',
    requiresHuman: false,
    allowedTools: [
      'get_applicant_status',
      'search_knowledge_base',
      'generate_upload_link',
      'create_case',
      'send_applicant_message',
    ],
    minConfidence: 0.6,
    slaMinutes: 480,
  },
  COMPLAINT: {
    intent: 'COMPLAINT',
    description: 'Formal dissatisfaction with the process or outcome.',
    // Regulated firms owe complainants a logged, human-owned response.
    requiresHuman: true,
    allowedTools: [
      'get_applicant_status',
      'create_case',
      'escalate_to_human',
      'send_applicant_message',
    ],
    minConfidence: 0.9,
    slaMinutes: 480,
  },
  FRAUD_REPORT: {
    intent: 'FRAUD_REPORT',
    description: 'Someone used my identity / I did not make this application.',
    requiresHuman: true,
    allowedTools: ['get_applicant_status', 'create_case', 'escalate_to_human'],
    minConfidence: 0.95,
    slaMinutes: 120,
  },
  OTHER: {
    intent: 'OTHER',
    description: 'Anything not covered above.',
    requiresHuman: false,
    allowedTools: ['get_applicant_status', 'search_knowledge_base', 'escalate_to_human'],
    minConfidence: 0.7,
    slaMinutes: 480,
  },
};

/** Tools that mutate state or contact the applicant, wherever they appear. */
export const WRITE_TOOLS = new Set([
  'request_resubmission',
  'send_applicant_message',
  'create_case',
  'escalate_to_human',
  'generate_upload_link',
  'add_case_note',
]);

/** Tools the agent may never call, regardless of intent. */
export const FORBIDDEN_TOOLS = new Set([
  'approve_applicant',
  'reject_applicant',
  'resolve_aml_hit',
  'override_risk_score',
  'delete_applicant',
  'update_applicant_pii',
  'file_sar',
]);

export function isToolAllowed(
  intent: SupportIntent,
  toolName: string,
): { allowed: boolean; reason?: string } {
  if (FORBIDDEN_TOOLS.has(toolName)) {
    return {
      allowed: false,
      reason: `${toolName} is never available to the agent; it requires a human decision-maker`,
    };
  }
  const policy = INTENT_POLICY[intent];
  if (!policy.allowedTools.includes(toolName)) {
    return {
      allowed: false,
      reason: `${toolName} is not permitted for intent ${intent}`,
    };
  }
  return { allowed: true };
}

// ---------------------------------------------------------------------------
// Heuristic classification
// ---------------------------------------------------------------------------

const INTENT_PATTERNS: Array<{ intent: SupportIntent; weight: number; pattern: RegExp }> = [
  { intent: 'FRAUD_REPORT', weight: 1.0, pattern: /\b(identity theft|stolen identity|someone (else )?used my|i did ?n[o']?t (apply|sign ?up|make this)|not me|impersonat)/i },
  { intent: 'SCREENING_DISPUTE', weight: 1.0, pattern: /\b(sanction|pep|politically exposed|watchlist|not that person|wrong person|same name as)/i },
  { intent: 'DATA_DELETION', weight: 1.0, pattern: /\b(delete my (data|account|information)|erase|right to be forgotten|gdpr|remove my data)/i },
  { intent: 'DATA_CORRECTION', weight: 0.9, pattern: /\b(wrong (name|date of birth|dob|address|spelling)|misspell|typo in my|incorrect (name|details)|change my (name|address))/i },
  { intent: 'COMPLAINT', weight: 0.9, pattern: /\b(complain|unacceptable|ombudsman|regulator|fca|legal action|lawyer|sue|disgrace|appalling)/i },
  { intent: 'APPEAL_DECISION', weight: 0.9, pattern: /\b(appeal|reconsider|dispute (the|your) decision|why was i (rejected|declined|refused)|overturn)/i },
  { intent: 'LIVENESS_FAILURE', weight: 0.85, pattern: /\b(selfie|liveness|face (scan|check|match)|camera keeps|blink|move your head)/i },
  { intent: 'DOCUMENT_REJECTED', weight: 0.85, pattern: /\b(document (was )?(rejected|declined|not accepted)|passport (rejected|declined)|why.*(rejected|declined))/i },
  { intent: 'UPLOAD_HELP', weight: 0.8, pattern: /\b(upload|can'?t (take|submit)|photo (wo|does) ?n[o']?t|file too (large|big)|scan|blurry|which (side|document))/i },
  { intent: 'ACCOUNT_ACCESS', weight: 0.8, pattern: /\b(log ?in|sign ?in|link (expired|not working)|can'?t access|locked out|password)/i },
  { intent: 'TIMELINE_QUESTION', weight: 0.75, pattern: /\b(how long|when will|still waiting|taking (so )?long|eta|days now)/i },
  { intent: 'TECHNICAL_ISSUE', weight: 0.7, pattern: /\b(error|crash|bug|not working|broken|stuck|freez|blank screen|spinning)/i },
  { intent: 'VERIFICATION_STATUS', weight: 0.7, pattern: /\b(status|verified yet|approved|progress|pending|where (is|are) my|any update)/i },
];

/**
 * Cheap first-pass classification. Used to pick the tool set before the model
 * runs, to route when the model is unavailable, and as a cross-check on the
 * model's own classification. Not a replacement for it.
 */
export function classifyIntentHeuristic(text: string): {
  intent: SupportIntent;
  confidence: number;
  matched: SupportIntent[];
} {
  const scores = new Map<SupportIntent, number>();
  const matched: SupportIntent[] = [];

  for (const { intent, weight, pattern } of INTENT_PATTERNS) {
    if (pattern.test(text)) {
      scores.set(intent, Math.max(scores.get(intent) ?? 0, weight));
      matched.push(intent);
    }
  }
  if (scores.size === 0) {
    return { intent: 'UNKNOWN', confidence: 0.2, matched: [] };
  }

  const ranked = [...scores.entries()].sort((a, b) => b[1] - a[1]);
  const [topIntent, topScore] = ranked[0]!;
  const runnerUp = ranked[1]?.[1] ?? 0;

  // Ambiguity discount: when two intents score similarly, we are less confident
  // in either. Overstating confidence here is what causes wrong tool sets.
  const margin = topScore - runnerUp;
  const confidence = Math.min(0.95, topScore * (0.7 + 0.3 * Math.min(1, margin / 0.3)));

  return { intent: topIntent, confidence: Math.round(confidence * 100) / 100, matched };
}

const NEGATIVE_MARKERS =
  /\b(angry|furious|ridiculous|useless|terrible|awful|worst|scam|fraud(ster)?|disgust|unacceptable|outrage|fed up|sick of|never again|incompetent)\b/gi;
const POSITIVE_MARKERS =
  /\b(thank|thanks|great|helpful|appreciate|perfect|excellent|brilliant|cheers)\b/gi;

/**
 * Crude sentiment in [-1, 1]. Deliberately crude: it is used only as one input
 * to an escalation decision, never as a customer-visible judgement.
 */
export function estimateSentiment(text: string): number {
  const negatives = (text.match(NEGATIVE_MARKERS) ?? []).length;
  const positives = (text.match(POSITIVE_MARKERS) ?? []).length;
  const shouting = /[A-Z]{5,}/.test(text) ? 1 : 0;
  const exclamations = Math.min(2, (text.match(/!/g) ?? []).length / 2);
  const raw = positives - negatives - shouting - exclamations;
  return Math.max(-1, Math.min(1, raw / 3));
}

export function mentionsRegulator(text: string): boolean {
  return /\b(fca|finra|sec|bafin|amf|acpr|ombudsman|regulator|data protection authority|ico|cnil|dpa)\b/i.test(
    text,
  );
}

// ---------------------------------------------------------------------------
// PII redaction
// ---------------------------------------------------------------------------

const REDACTIONS: Array<[RegExp, string]> = [
  // Order matters: card and IBAN patterns are matched before the generic long
  // digit run, or they would be caught by it and mislabelled.
  [/\b(?:\d[ -]*?){13,19}\b/g, '[CARD_OR_ACCOUNT]'],
  [/\b[A-Z]{2}\d{2}[A-Z0-9]{10,30}\b/g, '[IBAN]'],
  [/\b[\w.+-]+@[\w-]+\.[\w.-]+\b/g, '[EMAIL]'],
  [/\+?\d[\d\s().-]{7,}\d/g, '[PHONE]'],
  // Passport-shaped and national-ID-shaped identifiers.
  [/\b[A-Z]{1,2}\d{6,9}\b/g, '[DOC_NUMBER]'],
  [/\b\d{3}-\d{2}-\d{4}\b/g, '[SSN]'],
];

/**
 * Masks obvious PII in free text. Used when a transcript is shown to a reviewer
 * without PII entitlement, and when text is written to logs.
 *
 * This is a defence-in-depth measure, not a guarantee — regex cannot recognise a
 * name typed in prose. Access control remains the primary control.
 */
export function redactPii(text: string): { redacted: string; hits: string[] } {
  let out = text;
  const hits: string[] = [];
  for (const [pattern, replacement] of REDACTIONS) {
    if (pattern.test(out)) {
      hits.push(replacement);
      out = out.replace(pattern, replacement);
    }
    pattern.lastIndex = 0;
  }
  return { redacted: out, hits: [...new Set(hits)] };
}

// ---------------------------------------------------------------------------
// Escalation
// ---------------------------------------------------------------------------

export type EscalationReason =
  | 'LOW_CONFIDENCE'
  | 'POLICY_REQUIRES_HUMAN'
  | 'APPLICANT_REQUESTED'
  | 'REGULATORY_DECISION'
  | 'SENTIMENT_NEGATIVE'
  | 'REPEAT_CONTACT'
  | 'TOOL_FAILURE'
  | 'MAX_TURNS_REACHED'
  | 'SUSPECTED_FRAUD'
  | 'COMPLAINT'
  | 'DATA_SUBJECT_RIGHTS';

export interface EscalationDecision {
  escalate: boolean;
  reason?: EscalationReason;
  detail?: string;
  slaMinutes: number;
}

/**
 * Decides whether the agent should hand over. Ordered by precedence: policy bars
 * beat everything, then explicit applicant requests, then quality signals.
 *
 * The bias is deliberately toward escalating. A needless handover costs a few
 * minutes of an agent's time; a wrongly-automated compliance answer costs a
 * remediation programme.
 */
export function shouldEscalate(args: {
  intent: SupportIntent;
  confidence: number;
  turnCount: number;
  maxTurns: number;
  sentiment?: number;
  priorTicketsSameIntent?: number;
  applicantAskedForHuman?: boolean;
  toolFailures?: number;
  mentionsRegulator?: boolean;
}): EscalationDecision {
  const policy = INTENT_POLICY[args.intent];
  const sla = policy.slaMinutes;

  if (policy.requiresHuman) {
    return {
      escalate: true,
      reason:
        args.intent === 'FRAUD_REPORT' ? 'SUSPECTED_FRAUD' :
        args.intent === 'COMPLAINT' ? 'COMPLAINT' :
        args.intent === 'DATA_DELETION' || args.intent === 'DATA_CORRECTION' ? 'DATA_SUBJECT_RIGHTS' :
        args.intent === 'SCREENING_DISPUTE' ? 'REGULATORY_DECISION' :
        'POLICY_REQUIRES_HUMAN',
      detail: `Intent ${args.intent} requires a human owner: ${policy.description}`,
      slaMinutes: sla,
    };
  }
  if (args.applicantAskedForHuman) {
    return {
      escalate: true,
      reason: 'APPLICANT_REQUESTED',
      detail: 'The applicant asked to speak to a person.',
      slaMinutes: sla,
    };
  }
  if (args.mentionsRegulator) {
    return {
      escalate: true,
      reason: 'COMPLAINT',
      detail: 'The applicant referenced a regulator or legal action.',
      slaMinutes: Math.min(sla, 240),
    };
  }
  if ((args.toolFailures ?? 0) >= 2) {
    return {
      escalate: true,
      reason: 'TOOL_FAILURE',
      detail: `${args.toolFailures} tool failures; the agent cannot see the data it needs.`,
      slaMinutes: sla,
    };
  }
  if ((args.priorTicketsSameIntent ?? 0) >= 2) {
    return {
      escalate: true,
      reason: 'REPEAT_CONTACT',
      detail: 'Third contact about the same issue.',
      slaMinutes: Math.min(sla, 240),
    };
  }
  if (args.confidence < policy.minConfidence) {
    return {
      escalate: true,
      reason: 'LOW_CONFIDENCE',
      detail: `Confidence ${args.confidence.toFixed(2)} below the ${policy.minConfidence} floor for ${args.intent}.`,
      slaMinutes: sla,
    };
  }
  if ((args.sentiment ?? 0) <= -0.6) {
    return {
      escalate: true,
      reason: 'SENTIMENT_NEGATIVE',
      detail: 'The applicant is clearly upset.',
      slaMinutes: Math.min(sla, 240),
    };
  }
  if (args.turnCount >= args.maxTurns) {
    return {
      escalate: true,
      reason: 'MAX_TURNS_REACHED',
      detail: `Hit the ${args.maxTurns}-turn ceiling without resolving.`,
      slaMinutes: sla,
    };
  }
  return { escalate: false, slaMinutes: sla };
}

export function escalationDueAt(slaMinutes: number, from = new Date()): Date {
  return new Date(from.getTime() + slaMinutes * 60_000);
}

/**
 * Expected time to a decision, by review status. Used to answer "how long?"
 * honestly instead of with a stock reassurance.
 */
export function estimateCompletionMinutes(args: {
  reviewStatus: string;
  queueDepth?: number;
  hasOpenAmlHits?: boolean;
  ddLevel?: string;
}): { minMinutes: number; maxMinutes: number; note: string } {
  if (args.reviewStatus === 'APPROVED' || args.reviewStatus === 'REJECTED_FINAL') {
    return { minMinutes: 0, maxMinutes: 0, note: 'A final decision has already been made.' };
  }
  if (args.reviewStatus === 'REJECTED_RETRY') {
    return {
      minMinutes: 0,
      maxMinutes: 0,
      note: 'Waiting on the applicant to resubmit; nothing is queued on our side.',
    };
  }
  if (args.hasOpenAmlHits) {
    return {
      minMinutes: 240,
      maxMinutes: 2880,
      note: 'An analyst has to review a watchlist match, which is manual work.',
    };
  }
  if (args.ddLevel === 'EDD') {
    return {
      minMinutes: 1440,
      maxMinutes: 5760,
      note: 'Enhanced due diligence involves document review and sign-off.',
    };
  }
  if (args.reviewStatus === 'QUEUED') {
    const depth = args.queueDepth ?? 0;
    // Roughly four minutes of reviewer time per case, one reviewer's worth of
    // throughput. Better to quote a wide honest range than a precise wrong one.
    const min = 30 + depth * 2;
    return {
      minMinutes: min,
      maxMinutes: Math.max(min * 3, 480),
      note: `In the manual review queue${depth ? ` behind about ${depth} other cases` : ''}.`,
    };
  }
  return {
    minMinutes: 1,
    maxMinutes: 15,
    note: 'Automated checks are running.',
  };
}
