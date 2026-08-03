import { z } from 'zod';

/**
 * Rules engine.
 *
 * Compliance policy changes on a compliance officer's timeline, not an
 * engineering release train, so rules are data: a JSON condition AST plus a list
 * of actions, versioned and attributable in the database.
 *
 * Three properties matter more than expressiveness:
 *  1. Determinism — the same facts and rules always produce the same outcome, in
 *     the same order. A decision has to be reproducible months later.
 *  2. Explainability — every fired rule reports which conditions matched and
 *     with what values, so a reviewer can see *why*, not just *what*.
 *  3. Total evaluation — a malformed rule is skipped and reported, never allowed
 *     to abort a run. One bad rule must not stop an applicant being decided.
 */

// ---------------------------------------------------------------------------
// Condition AST
// ---------------------------------------------------------------------------

export const ComparisonOp = z.enum([
  'eq', 'neq', 'gt', 'gte', 'lt', 'lte',
  'in', 'nin', // membership of a provided list
  'contains', 'notContains', // array/string containment
  'containsAny', 'containsAll', // array intersection
  'startsWith', 'endsWith', 'matches', // string / regex
  'exists', 'empty', // presence
  'between', // inclusive numeric range, value = [lo, hi]
  'olderThan', 'newerThan', // dates vs. a duration string, e.g. "90d"
]);
export type ComparisonOp = z.infer<typeof ComparisonOp>;

export interface PredicateNode {
  fact: string;
  op: ComparisonOp;
  value?: unknown;
  /** Case-insensitive string comparison. Defaults to true for name-ish facts. */
  ignoreCase?: boolean;
  /** Human-readable label used in explanations. */
  label?: string;
}

export interface AllNode { all: ConditionNode[] }
export interface AnyNode { any: ConditionNode[] }
export interface NotNode { not: ConditionNode }
/** At least `atLeast` of the children must match. Useful for scorecards. */
export interface AtLeastNode { atLeast: number; of: ConditionNode[] }
export interface AlwaysNode { always: true }

export type ConditionNode =
  | PredicateNode
  | AllNode
  | AnyNode
  | NotNode
  | AtLeastNode
  | AlwaysNode;

const ConditionNodeSchema: z.ZodType<ConditionNode> = z.lazy(() =>
  z.union([
    z.object({
      fact: z.string().min(1),
      op: ComparisonOp,
      value: z.unknown().optional(),
      ignoreCase: z.boolean().optional(),
      label: z.string().optional(),
    }),
    z.object({ all: z.array(ConditionNodeSchema) }),
    z.object({ any: z.array(ConditionNodeSchema) }),
    z.object({ not: ConditionNodeSchema }),
    z.object({ atLeast: z.number().int().min(1), of: z.array(ConditionNodeSchema) }),
    z.object({ always: z.literal(true) }),
  ]),
);

// ---------------------------------------------------------------------------
// Actions
// ---------------------------------------------------------------------------

export const ActionType = z.enum([
  'ADD_RISK', // additive risk contribution
  'SET_RISK_LEVEL',
  'REQUIRE_MANUAL_REVIEW',
  'REQUIRE_EDD',
  'AUTO_APPROVE',
  'AUTO_REJECT',
  'ADD_REJECT_LABEL',
  'REQUEST_DOCUMENT',
  'ADD_TAG',
  'ASSIGN_QUEUE',
  'CREATE_CASE',
  'CREATE_ALERT',
  'BLOCK_TRANSACTION',
  'FLAG_TRANSACTION',
  'HOLD_TRANSACTION',
  'ENABLE_ONGOING_MONITORING',
  'ESCALATE',
  'NOTIFY_APPLICANT',
  'NOTIFY_TEAM',
  'SUPPRESS_HIT',
  'ROUTE_TO_SUPPORT_AGENT',
  'REQUIRE_HUMAN_HANDOFF',
  'SET_FACT', // derived facts for later rules in the same run
]);
export type ActionType = z.infer<typeof ActionType>;

export interface RuleAction {
  type: ActionType;
  /** Interpretation depends on type: risk points, queue name, label code, ... */
  value?: unknown;
  params?: Record<string, unknown>;
  reason?: string;
}

const RuleActionSchema = z.object({
  type: ActionType,
  value: z.unknown().optional(),
  params: z.record(z.unknown()).optional(),
  reason: z.string().optional(),
});

export const RuleDefinitionSchema = z.object({
  id: z.string().optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  scope: z.enum([
    'APPLICANT_RISK', 'DOCUMENT', 'SCREENING', 'TRANSACTION',
    'ONGOING_MONITORING', 'COMPANY', 'SUPPORT_ROUTING',
  ]),
  priority: z.number().int().default(100),
  isActive: z.boolean().default(true),
  isShadow: z.boolean().default(false),
  conditions: ConditionNodeSchema,
  actions: z.array(RuleActionSchema).default([]),
});

export type RuleDefinition = z.infer<typeof RuleDefinitionSchema>;

// ---------------------------------------------------------------------------
// Fact resolution
// ---------------------------------------------------------------------------

export type Facts = Record<string, unknown>;

/**
 * Dot-path lookup with array support:
 *   "applicant.country"       -> scalar
 *   "checks.LIVENESS.score"   -> scalar via map key
 *   "checks[].result"         -> array of every check's result
 */
export function resolveFact(facts: Facts, path: string): unknown {
  if (path in facts) return facts[path];

  const segments = path.split('.');
  let current: unknown = facts;

  for (const rawSegment of segments) {
    if (current === null || current === undefined) return undefined;
    const spread = rawSegment.endsWith('[]');
    const segment = spread ? rawSegment.slice(0, -2) : rawSegment;

    if (Array.isArray(current)) {
      // Mapping a segment over an array collects that field from each element.
      current = current
        .map((item) => (item as Record<string, unknown> | null)?.[segment])
        .filter((v) => v !== undefined);
    } else if (typeof current === 'object') {
      current = (current as Record<string, unknown>)[segment];
    } else {
      return undefined;
    }

    if (spread && !Array.isArray(current)) {
      current = current === undefined ? [] : [current];
    }
  }
  return current;
}

const DURATION_UNITS: Record<string, number> = {
  s: 1_000,
  m: 60_000,
  h: 3_600_000,
  d: 86_400_000,
  w: 604_800_000,
  y: 31_536_000_000,
};

export function parseDuration(input: string): number | null {
  const m = /^(\d+(?:\.\d+)?)\s*(s|m|h|d|w|y)$/.exec(input.trim());
  if (!m) return null;
  return Number(m[1]) * (DURATION_UNITS[m[2]!] ?? 0);
}

function toComparable(v: unknown, ignoreCase: boolean): unknown {
  if (typeof v === 'string' && ignoreCase) return v.toLowerCase();
  if (v instanceof Date) return v.getTime();
  return v;
}

function asNumber(v: unknown): number | null {
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  if (typeof v === 'bigint') return Number(v);
  if (v instanceof Date) return v.getTime();
  if (typeof v === 'string' && v.trim() !== '') {
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  }
  return null;
}

function asArray(v: unknown): unknown[] {
  if (Array.isArray(v)) return v;
  if (v === undefined || v === null) return [];
  return [v];
}

// ---------------------------------------------------------------------------
// Evaluation
// ---------------------------------------------------------------------------

export interface PredicateTrace {
  fact: string;
  op: ComparisonOp;
  expected: unknown;
  actual: unknown;
  matched: boolean;
  label?: string;
}

export interface EvaluationTrace {
  matched: boolean;
  predicates: PredicateTrace[];
}

export function evaluatePredicate(
  node: PredicateNode,
  facts: Facts,
  now: number,
): PredicateTrace {
  const actualRaw = resolveFact(facts, node.fact);
  const ignoreCase = node.ignoreCase ?? true;
  const actual = toComparable(actualRaw, ignoreCase);
  const expected = toComparable(node.value, ignoreCase);

  let matched = false;

  switch (node.op) {
    case 'exists':
      matched = actualRaw !== undefined && actualRaw !== null;
      break;
    case 'empty':
      matched =
        actualRaw === undefined ||
        actualRaw === null ||
        actualRaw === '' ||
        (Array.isArray(actualRaw) && actualRaw.length === 0);
      break;
    case 'eq':
      matched = Array.isArray(actual) && Array.isArray(expected)
        ? JSON.stringify(actual) === JSON.stringify(expected)
        : actual === expected;
      break;
    case 'neq':
      matched = actual !== expected;
      break;
    case 'gt':
    case 'gte':
    case 'lt':
    case 'lte': {
      const a = asNumber(actual);
      const b = asNumber(expected);
      // Missing values never satisfy an inequality. Treating undefined as 0
      // would silently fire "amount < 100" rules on absent amounts.
      if (a === null || b === null) { matched = false; break; }
      matched =
        node.op === 'gt' ? a > b :
        node.op === 'gte' ? a >= b :
        node.op === 'lt' ? a < b : a <= b;
      break;
    }
    case 'between': {
      const range = asArray(expected).map(asNumber);
      const a = asNumber(actual);
      const lo = range[0];
      const hi = range[1];
      matched =
        a !== null && lo !== null && lo !== undefined && hi !== null && hi !== undefined &&
        a >= lo && a <= hi;
      break;
    }
    case 'in':
      matched = asArray(expected).map((v) => toComparable(v, ignoreCase)).includes(actual);
      break;
    case 'nin':
      matched = !asArray(expected).map((v) => toComparable(v, ignoreCase)).includes(actual);
      break;
    case 'contains':
      matched =
        typeof actual === 'string' && typeof expected === 'string'
          ? actual.includes(expected)
          : asArray(actual).map((v) => toComparable(v, ignoreCase)).includes(expected);
      break;
    case 'notContains':
      matched =
        typeof actual === 'string' && typeof expected === 'string'
          ? !actual.includes(expected)
          : !asArray(actual).map((v) => toComparable(v, ignoreCase)).includes(expected);
      break;
    case 'containsAny': {
      const haystack = asArray(actual).map((v) => toComparable(v, ignoreCase));
      matched = asArray(expected)
        .map((v) => toComparable(v, ignoreCase))
        .some((v) => haystack.includes(v));
      break;
    }
    case 'containsAll': {
      const haystack = asArray(actual).map((v) => toComparable(v, ignoreCase));
      const needles = asArray(expected).map((v) => toComparable(v, ignoreCase));
      matched = needles.length > 0 && needles.every((v) => haystack.includes(v));
      break;
    }
    case 'startsWith':
      matched =
        typeof actual === 'string' && typeof expected === 'string' &&
        actual.startsWith(expected);
      break;
    case 'endsWith':
      matched =
        typeof actual === 'string' && typeof expected === 'string' &&
        actual.endsWith(expected);
      break;
    case 'matches': {
      if (typeof actualRaw !== 'string' || typeof node.value !== 'string') {
        matched = false;
        break;
      }
      try {
        matched = new RegExp(node.value, ignoreCase ? 'i' : '').test(actualRaw);
      } catch {
        // An invalid pattern is a rule-authoring bug; fail the predicate rather
        // than the whole evaluation.
        matched = false;
      }
      break;
    }
    case 'olderThan':
    case 'newerThan': {
      const ms = typeof node.value === 'string' ? parseDuration(node.value) : null;
      const t = asNumber(actualRaw instanceof Date ? actualRaw : new Date(String(actualRaw)));
      if (ms === null || t === null || Number.isNaN(t)) { matched = false; break; }
      const age = now - t;
      matched = node.op === 'olderThan' ? age > ms : age < ms;
      break;
    }
  }

  return {
    fact: node.fact,
    op: node.op,
    expected: node.value,
    actual: actualRaw,
    matched,
    ...(node.label ? { label: node.label } : {}),
  };
}

export function evaluateCondition(
  node: ConditionNode,
  facts: Facts,
  trace: PredicateTrace[] = [],
  now = Date.now(),
): boolean {
  if ('always' in node) return true;

  if ('fact' in node) {
    const t = evaluatePredicate(node, facts, now);
    trace.push(t);
    return t.matched;
  }
  if ('all' in node) {
    // Evaluate every child even after a failure: the trace is for humans, and a
    // reviewer needs to see all the failing conditions, not just the first.
    let result = true;
    for (const child of node.all) {
      if (!evaluateCondition(child, facts, trace, now)) result = false;
    }
    return node.all.length === 0 ? true : result;
  }
  if ('any' in node) {
    let result = false;
    for (const child of node.any) {
      if (evaluateCondition(child, facts, trace, now)) result = true;
    }
    return result;
  }
  if ('atLeast' in node) {
    let count = 0;
    for (const child of node.of) {
      if (evaluateCondition(child, facts, trace, now)) count++;
    }
    return count >= node.atLeast;
  }
  if ('not' in node) {
    // Child traces are recorded in a side buffer so a negated match does not
    // read as a positive finding in the explanation.
    const inner: PredicateTrace[] = [];
    const result = !evaluateCondition(node.not, facts, inner, now);
    trace.push(
      ...inner.map((t) => ({ ...t, label: t.label ? `NOT ${t.label}` : undefined })),
    );
    return result;
  }
  return false;
}

export interface FiredRule {
  ruleId: string;
  ruleName: string;
  priority: number;
  isShadow: boolean;
  actions: RuleAction[];
  trace: PredicateTrace[];
}

export interface RuleEvaluationResult {
  fired: FiredRule[];
  /** Actions from non-shadow rules, in priority order. */
  actions: Array<RuleAction & { ruleId: string; ruleName: string }>;
  /** Sum of ADD_RISK contributions from non-shadow rules, clamped to 0-100. */
  riskDelta: number;
  /** Rules that could not be evaluated, with the reason. */
  skipped: Array<{ ruleName: string; reason: string }>;
  /** Facts derived by SET_FACT actions during the run. */
  derivedFacts: Facts;
  evaluatedCount: number;
  durationMs: number;
}

/**
 * Evaluates rules in (priority, name) order. Later rules see facts set by
 * earlier ones via SET_FACT, which is how a scorecard rule can key off an
 * aggregate computed by preceding rules.
 */
export function evaluateRules(
  rules: RuleDefinition[],
  facts: Facts,
  options: { now?: number; scope?: RuleDefinition['scope'] } = {},
): RuleEvaluationResult {
  const started = Date.now();
  const now = options.now ?? started;
  const skipped: RuleEvaluationResult['skipped'] = [];
  const fired: FiredRule[] = [];
  const derivedFacts: Facts = {};
  const workingFacts: Facts = { ...facts };

  const ordered = rules
    .filter((r) => r.isActive !== false)
    .filter((r) => (options.scope ? r.scope === options.scope : true))
    .sort((a, b) => a.priority - b.priority || a.name.localeCompare(b.name));

  for (const rule of ordered) {
    const parsed = RuleDefinitionSchema.safeParse(rule);
    if (!parsed.success) {
      skipped.push({
        ruleName: rule.name ?? '<unnamed>',
        reason: parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; '),
      });
      continue;
    }
    const def = parsed.data;
    const trace: PredicateTrace[] = [];
    let matched: boolean;
    try {
      matched = evaluateCondition(def.conditions, workingFacts, trace, now);
    } catch (error) {
      skipped.push({
        ruleName: def.name,
        reason: error instanceof Error ? error.message : 'evaluation threw',
      });
      continue;
    }
    if (!matched) continue;

    fired.push({
      ruleId: def.id ?? def.name,
      ruleName: def.name,
      priority: def.priority,
      isShadow: def.isShadow,
      actions: def.actions,
      trace,
    });

    // Shadow rules are observed, never applied — that is the point of shadow
    // mode, so a new policy can be measured against live traffic first.
    if (def.isShadow) continue;

    for (const action of def.actions) {
      if (action.type === 'SET_FACT' && action.params?.['name']) {
        const name = String(action.params['name']);
        derivedFacts[name] = action.value;
        workingFacts[name] = action.value;
      }
    }
  }

  const applied = fired.filter((f) => !f.isShadow);
  const actions = applied.flatMap((f) =>
    f.actions.map((a) => ({ ...a, ruleId: f.ruleId, ruleName: f.ruleName })),
  );
  const riskDelta = actions
    .filter((a) => a.type === 'ADD_RISK')
    .reduce((sum, a) => sum + (asNumber(a.value) ?? 0), 0);

  return {
    fired,
    actions,
    riskDelta: Math.max(0, Math.min(100, Math.round(riskDelta))),
    skipped,
    derivedFacts,
    evaluatedCount: ordered.length,
    durationMs: Date.now() - started,
  };
}

/** Collapses a result into the decision-relevant summary the pipeline needs. */
export interface DecisionHints {
  autoReject: boolean;
  autoApprove: boolean;
  requiresManualReview: boolean;
  requiresEdd: boolean;
  rejectLabels: string[];
  tags: string[];
  queue?: string;
  blockTransaction: boolean;
  flagTransaction: boolean;
  escalate: boolean;
  requestedDocuments: string[];
  alerts: Array<{ title: string; severity: string; detail?: unknown }>;
  enableMonitoring: boolean;
}

export function summarizeActions(
  actions: Array<RuleAction & { ruleName?: string }>,
): DecisionHints {
  const hints: DecisionHints = {
    autoReject: false,
    autoApprove: false,
    requiresManualReview: false,
    requiresEdd: false,
    rejectLabels: [],
    tags: [],
    blockTransaction: false,
    flagTransaction: false,
    escalate: false,
    requestedDocuments: [],
    alerts: [],
    enableMonitoring: false,
  };

  for (const a of actions) {
    switch (a.type) {
      case 'AUTO_REJECT':
        hints.autoReject = true;
        for (const label of asArray(a.value)) hints.rejectLabels.push(String(label));
        break;
      case 'ADD_REJECT_LABEL':
        for (const label of asArray(a.value)) hints.rejectLabels.push(String(label));
        break;
      case 'AUTO_APPROVE':
        hints.autoApprove = true;
        break;
      case 'REQUIRE_MANUAL_REVIEW':
        hints.requiresManualReview = true;
        break;
      case 'REQUIRE_EDD':
        hints.requiresEdd = true;
        // EDD implies a human decision; the two are not separable.
        hints.requiresManualReview = true;
        break;
      case 'ADD_TAG':
        for (const tag of asArray(a.value)) hints.tags.push(String(tag));
        break;
      case 'ASSIGN_QUEUE':
        hints.queue = String(a.value);
        break;
      case 'BLOCK_TRANSACTION':
      case 'HOLD_TRANSACTION':
        hints.blockTransaction = true;
        break;
      case 'FLAG_TRANSACTION':
        hints.flagTransaction = true;
        break;
      case 'ESCALATE':
      case 'REQUIRE_HUMAN_HANDOFF':
        hints.escalate = true;
        break;
      case 'REQUEST_DOCUMENT':
        for (const doc of asArray(a.value)) hints.requestedDocuments.push(String(doc));
        break;
      case 'CREATE_ALERT':
        hints.alerts.push({
          title: String(a.params?.['title'] ?? a.reason ?? a.ruleName ?? 'Rule alert'),
          severity: String(a.params?.['severity'] ?? 'MEDIUM'),
          detail: a.params?.['detail'],
        });
        break;
      case 'ENABLE_ONGOING_MONITORING':
        hints.enableMonitoring = true;
        break;
      default:
        break;
    }
  }

  // A reject and an approve cannot both stand. Rejection wins: the cost of
  // wrongly approving a sanctioned customer is not symmetric with the cost of
  // wrongly queueing a good one.
  if (hints.autoReject) hints.autoApprove = false;
  if (hints.requiresManualReview) hints.autoApprove = false;

  hints.rejectLabels = [...new Set(hints.rejectLabels)];
  hints.tags = [...new Set(hints.tags)];
  hints.requestedDocuments = [...new Set(hints.requestedDocuments)];
  return hints;
}

/** Renders a fired rule's trace as one line per condition, for the case file. */
export function explainFiredRule(fired: FiredRule): string[] {
  return fired.trace.map((t) => {
    const label = t.label ? `${t.label}: ` : '';
    const verdict = t.matched ? '✓' : '✗';
    return `${verdict} ${label}${t.fact} ${t.op} ${JSON.stringify(t.expected)} (actual: ${JSON.stringify(t.actual)})`;
  });
}

export function validateRule(input: unknown):
  | { valid: true; rule: RuleDefinition }
  | { valid: false; errors: string[] } {
  const parsed = RuleDefinitionSchema.safeParse(input);
  if (parsed.success) return { valid: true, rule: parsed.data };
  return {
    valid: false,
    errors: parsed.error.issues.map((i) => `${i.path.join('.') || '(root)'}: ${i.message}`),
  };
}
