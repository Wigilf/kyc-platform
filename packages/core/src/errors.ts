/**
 * Domain errors. Every error carries a stable machine code because clients
 * integrate against codes, not messages, and messages get reworded.
 */

export type ErrorCode =
  | 'VALIDATION_FAILED'
  | 'NOT_FOUND'
  | 'CONFLICT'
  | 'UNAUTHORIZED'
  | 'FORBIDDEN'
  | 'RATE_LIMITED'
  | 'IDEMPOTENCY_MISMATCH'
  | 'ILLEGAL_TRANSITION'
  | 'LEVEL_MISCONFIGURED'
  | 'COUNTRY_NOT_SUPPORTED'
  | 'DOCUMENT_REQUIRED'
  | 'PROVIDER_ERROR'
  | 'POLICY_VIOLATION'
  | 'DECISION_LOCKED'
  | 'INTERNAL';

const STATUS: Record<ErrorCode, number> = {
  VALIDATION_FAILED: 400,
  NOT_FOUND: 404,
  CONFLICT: 409,
  UNAUTHORIZED: 401,
  FORBIDDEN: 403,
  RATE_LIMITED: 429,
  IDEMPOTENCY_MISMATCH: 409,
  ILLEGAL_TRANSITION: 409,
  LEVEL_MISCONFIGURED: 500,
  COUNTRY_NOT_SUPPORTED: 422,
  DOCUMENT_REQUIRED: 422,
  PROVIDER_ERROR: 502,
  POLICY_VIOLATION: 403,
  DECISION_LOCKED: 409,
  INTERNAL: 500,
};

export class KycError extends Error {
  readonly code: ErrorCode;
  readonly statusCode: number;
  readonly details?: unknown;
  /** Whether a caller (or queue) should retry the same operation. */
  readonly retryable: boolean;

  constructor(
    code: ErrorCode,
    message: string,
    options: { details?: unknown; retryable?: boolean } = {},
  ) {
    super(message);
    this.name = 'KycError';
    this.code = code;
    this.statusCode = STATUS[code];
    this.details = options.details;
    this.retryable = options.retryable ?? code === 'PROVIDER_ERROR';
  }

  toJSON() {
    return {
      error: {
        code: this.code,
        message: this.message,
        ...(this.details === undefined ? {} : { details: this.details }),
      },
    };
  }
}

export const notFound = (what: string, id?: string) =>
  new KycError('NOT_FOUND', id ? `${what} ${id} not found` : `${what} not found`);

export const invalid = (message: string, details?: unknown) =>
  new KycError('VALIDATION_FAILED', message, { details });

export const forbidden = (message: string) => new KycError('FORBIDDEN', message);

export const conflict = (message: string, details?: unknown) =>
  new KycError('CONFLICT', message, { details });

export function isKycError(e: unknown): e is KycError {
  return e instanceof KycError;
}
