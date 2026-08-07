/**
 * API client.
 *
 * One place that knows about the session token and about how the API reports
 * errors, so no component has to. A 401 clears the session and reloads rather
 * than leaving the operator clicking a dead console.
 */

const TOKEN_KEY = 'kyc.session';

/**
 * Where the API lives.
 *
 * Empty in development, where Vite proxies /v1 to the API on the same origin.
 * In production the dashboard is a static site on its own domain, so the origin
 * has to be baked in at build time.
 */
function normaliseBase(raw: string | undefined): string {
  const value = (raw ?? '').trim().replace(/\/$/, '');
  if (!value) return '';
  // Render's `fromService … property: host` yields a bare hostname. Left as-is
  // that produces a relative URL and every request silently hits the dashboard
  // instead of the API.
  return /^https?:\/\//.test(value) ? value : `https://${value}`;
}

const API_BASE = normaliseBase(import.meta.env.VITE_API_BASE_URL);

export interface Session {
  token: string;
  user: { id: string; name: string | null; email: string; role: string };
  tenant: { id: string; name: string; slug: string };
}

export function loadSession(): Session | null {
  const raw = localStorage.getItem(TOKEN_KEY);
  if (!raw) return null;
  try {
    return JSON.parse(raw) as Session;
  } catch {
    localStorage.removeItem(TOKEN_KEY);
    return null;
  }
}

export function saveSession(session: Session): void {
  localStorage.setItem(TOKEN_KEY, JSON.stringify(session));
}

export function clearSession(): void {
  localStorage.removeItem(TOKEN_KEY);
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message);
  }
}

async function request<T>(
  path: string,
  init: Omit<RequestInit, 'body'> & { body?: unknown } = {},
): Promise<T> {
  const session = loadSession();
  const { body, ...rest } = init;

  const response = await fetch(`${API_BASE}${path}`, {
    ...rest,
    headers: {
      ...(body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(session ? { authorization: `Bearer ${session.token}` } : {}),
      ...rest.headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });

  if (response.status === 401) {
    clearSession();
    window.location.href = '/login';
    throw new ApiError(401, 'UNAUTHORIZED', 'Session expired');
  }

  const text = await response.text();
  const payload = text ? JSON.parse(text) : {};

  if (!response.ok) {
    throw new ApiError(
      response.status,
      payload.code ?? payload.error ?? 'ERROR',
      payload.message ?? `Request failed (${response.status})`,
    );
  }
  return payload as T;
}

export const api = {
  get: <T>(path: string) => request<T>(path),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: 'POST', body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: 'PATCH', body }),

  /**
   * Step one. Returns either a session or a challenge to answer with a code.
   *
   * The two outcomes are deliberately different shapes rather than a session
   * with a flag on it: nothing should be able to treat a half-finished sign-in
   * as a finished one by ignoring a boolean.
   */
  async login(
    email: string,
    password: string,
  ): Promise<{ done: true; session: Session } | { done: false; challenge: string; enrolmentRequired: boolean }> {
    const result = await request<
      Session & { mfaRequired?: boolean; challenge?: string; mfaEnrolmentRequired?: boolean }
    >('/v1/auth/login', { method: 'POST', body: { email, password } });

    if (result.mfaRequired && result.challenge) {
      return {
        done: false,
        challenge: result.challenge,
        enrolmentRequired: Boolean(result.mfaEnrolmentRequired),
      };
    }

    saveSession(result);
    return { done: true, session: result };
  },

  /** Step two. */
  async loginWithCode(challenge: string, code: string): Promise<Session> {
    const session = await request<Session>('/v1/auth/login/2fa', {
      method: 'POST',
      body: { challenge, code },
    });
    saveSession(session);
    return session;
  },
};

// --- Shapes the dashboard reads. Partial by intent: the API returns more than
// any one screen needs, and mirroring all of it here would be a second schema
// to keep in step. ---

export interface ApplicantRow {
  id: string;
  externalUserId: string;
  status: string;
  reviewStatus: string;
  riskScore: number;
  riskLevel: string;
  ddLevel: string;
  firstName: string | null;
  lastName: string | null;
  country: string | null;
  email: string | null;
  tags: string[];
  createdAt: string;
  submittedAt: string | null;
  reviewedAt: string | null;
  levelName: string;
  levelDisplayName: string;
}

export interface Finding {
  code: string;
  severity: string;
  message: string;
  detail?: unknown;
}

export interface Check {
  id: string;
  type: string;
  status: string;
  result: string | null;
  score: number | null;
  rejectLabels: string[];
  findings: Finding[];
  provider: string | null;
  completedAt: string | null;
}

export interface ScreeningHit {
  id: string;
  runId?: string;
  listType: string;
  listName: string;
  matchedName: string;
  matchScore: number;
  matchedFields: string[];
  status: string;
  resolution: string | null;
  note?: string | null;
  snapshot?: Record<string, unknown>;
  /** Present on the hit-queue endpoint; the applicant hangs off the run, not the hit. */
  run?: {
    id: string;
    trigger: string;
    applicant: {
      id: string;
      externalUserId: string;
      firstName: string | null;
      lastName: string | null;
      dob: string | null;
      country: string | null;
    } | null;
  };
}

export interface DocumentImageRef {
  id: string;
  storageKey: string;
  side: string;
  contentType: string;
}

export interface ApplicantDetail extends ApplicantRow {
  documents: Array<{
    id: string;
    type: string;
    subType: string | null;
    status: string;
    country: string | null;
    expiryDate: string | null;
    rejectLabels: string[];
    createdAt: string;
    images: DocumentImageRef[];
    /** Whatever the reader extracted. Shape varies by document type. */
    extracted: Record<string, unknown> | null;
  }>;
  checks: Check[];
  reviews: Array<{
    id: string;
    decision: string | null;
    reviewStatus: string;
    rejectLabels: string[];
    clientComment: string | null;
    moderationComment: string | null;
    reviewSource: string;
    createdAt: string;
  }>;
  screening: Array<{ id: string; trigger: string; hits: ScreeningHit[] }>;
}

export interface CaseRow {
  id: string;
  reference: string;
  type: string;
  status: string;
  priority: string;
  title: string;
  summary: string | null;
  queue: string | null;
  assignee: { id: string; name: string | null; email: string } | null;
  applicant: {
    id: string;
    externalUserId: string;
    firstName: string | null;
    lastName: string | null;
    riskScore?: number;
  } | null;
  createdAt: string;
}

export interface Funnel {
  windowDays: number;
  total: number;
  byStatus: Record<string, number>;
  completionRate: number;
  approvalRateOfDecided: number;
  abandonedInFlow: number;
  automationRate: number;
  topRejectReasons: Array<{ label: string; count: number }>;
}

export interface QueueRow {
  id: string;
  name: string;
  description: string | null;
  isDefault: boolean;
  slaFirstResponseMinutes: number;
  slaResolutionMinutes: number;
  totalCases: number;
  openCases: number;
}
