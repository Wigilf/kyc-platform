import { createHmac, timingSafeEqual } from 'node:crypto';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import fp from 'fastify-plugin';
import {
  KycError,
  safeEqual,
  sha256,
  verifyRequestSignature,
} from '@kyc/core';
import { appendAuditEntry, prisma } from '@kyc/db';

/**
 * Authentication.
 *
 * Three distinct callers, three distinct credentials — conflating them is how a
 * browser-held token ends up able to approve applicants:
 *
 *  1. **Server-to-server** (`X-Kyc-App-Token` + `X-Kyc-Signature`). HMAC over the
 *     request, so a leaked log line cannot be replayed and a proxy cannot tamper
 *     with the body.
 *  2. **Applicant SDK** (`Authorization: Bearer <sdk token>`). Scoped to exactly
 *     one applicant, short-lived, and it can only ever read its own record and
 *     upload to it.
 *  3. **Dashboard operator** (`Authorization: Bearer <session token>`). Carries a
 *     role, which is what the decision endpoints check.
 */

export type Caller =
  | {
      kind: 'api-key';
      tenantId: string;
      keyId: string;
      environment: 'SANDBOX' | 'PRODUCTION';
      scopes: string[];
    }
  | {
      kind: 'applicant';
      tenantId: string;
      applicantId: string;
      externalUserId: string;
    }
  | {
      kind: 'user';
      tenantId: string;
      userId: string;
      role: string;
      email: string;
    };

declare module 'fastify' {
  interface FastifyRequest {
    caller?: Caller;
  }
}

function appSecret(): string {
  const secret = process.env.APP_SECRET;
  if (!secret || secret.length < 32) {
    throw new Error('APP_SECRET must be set to at least 32 characters');
  }
  return secret;
}

/** Compact signed token. Deliberately not a JWT: no alg field to confuse. */
export function signToken(payload: Record<string, unknown>, ttlSeconds: number): string {
  const body = {
    ...payload,
    iat: Math.floor(Date.now() / 1000),
    exp: Math.floor(Date.now() / 1000) + ttlSeconds,
  };
  const encoded = Buffer.from(JSON.stringify(body)).toString('base64url');
  const mac = createHmac('sha256', appSecret()).update(encoded).digest('base64url');
  return `${encoded}.${mac}`;
}

export function verifyToken<T extends Record<string, unknown>>(token: string): T {
  const [encoded, mac] = token.split('.');
  if (!encoded || !mac) throw new KycError('UNAUTHORIZED', 'Malformed token');

  const expected = createHmac('sha256', appSecret()).update(encoded).digest('base64url');
  // Constant-time compare on equal-length buffers; a length mismatch is itself a
  // rejection, so there is nothing to leak.
  if (
    expected.length !== mac.length ||
    !timingSafeEqual(Buffer.from(expected), Buffer.from(mac))
  ) {
    throw new KycError('UNAUTHORIZED', 'Invalid token signature');
  }

  const payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8')) as T & {
    exp: number;
  };
  if (payload.exp * 1000 < Date.now()) {
    throw new KycError('UNAUTHORIZED', 'Token has expired');
  }
  return payload;
}

async function authenticateApiKey(request: FastifyRequest): Promise<Caller | null> {
  const keyId = request.headers['x-kyc-app-token'];
  if (typeof keyId !== 'string') return null;

  const signature = request.headers['x-kyc-signature'];
  const timestamp = Number(request.headers['x-kyc-timestamp']);
  if (typeof signature !== 'string' || !Number.isFinite(timestamp)) {
    throw new KycError(
      'UNAUTHORIZED',
      'X-Kyc-Signature and X-Kyc-Timestamp are required alongside X-Kyc-App-Token',
    );
  }

  const apiKey = await prisma.apiKey.findUnique({ where: { keyId } });
  if (!apiKey || apiKey.revokedAt) throw new KycError('UNAUTHORIZED', 'Unknown or revoked API key');
  if (apiKey.expiresAt && apiKey.expiresAt < new Date()) {
    throw new KycError('UNAUTHORIZED', 'API key has expired');
  }

  // The secret is only ever stored hashed, so verification means re-deriving the
  // HMAC with the presented secret — which the caller proves it holds by signing.
  const secret = request.headers['x-kyc-app-secret'];
  if (typeof secret !== 'string' || !safeEqual(sha256(secret), apiKey.secretHash)) {
    throw new KycError('UNAUTHORIZED', 'Invalid API credentials');
  }

  const rawBody = (request as { rawBody?: string }).rawBody ?? '';
  const check = verifyRequestSignature({
    secret,
    signature,
    timestamp,
    method: request.method,
    path: request.url.split('?')[0] ?? request.url,
    body: rawBody,
  });
  if (!check.valid) {
    throw new KycError('UNAUTHORIZED', `Request signature rejected: ${check.reason}`);
  }

  // Fire-and-forget: last-used tracking must not add latency to every request.
  void prisma.apiKey
    .update({ where: { id: apiKey.id }, data: { lastUsedAt: new Date() } })
    .catch(() => undefined);

  return {
    kind: 'api-key',
    tenantId: apiKey.tenantId,
    keyId: apiKey.keyId,
    environment: apiKey.environment as 'SANDBOX' | 'PRODUCTION',
    scopes: apiKey.scopes,
  };
}

async function authenticateBearer(request: FastifyRequest): Promise<Caller | null> {
  const header = request.headers.authorization;
  if (typeof header !== 'string' || !header.startsWith('Bearer ')) return null;

  const payload = verifyToken<{
    sub: string;
    kind: 'applicant' | 'user';
    tenantId: string;
    externalUserId?: string;
    role?: string;
    email?: string;
  }>(header.slice(7));

  if (payload.kind === 'applicant') {
    return {
      kind: 'applicant',
      tenantId: payload.tenantId,
      applicantId: payload.sub,
      externalUserId: payload.externalUserId ?? '',
    };
  }

  // Only a session token is a session.
  //
  // This used to treat anything that was not an applicant token as a user
  // token and look the subject up — which meant the short-lived challenge
  // issued after a correct password, whose entire purpose is to be useless
  // until a second factor is presented, authenticated as the user it named.
  // The second factor was decorative for as long as that was true.
  if (payload.kind !== 'user') {
    throw new KycError(
      'UNAUTHORIZED',
      'This token is not a session token and cannot be used to authenticate requests',
    );
  }

  const user = await prisma.user.findFirst({
    where: { id: payload.sub, tenantId: payload.tenantId, isActive: true },
    select: { id: true, role: true, email: true, tenantId: true },
  });
  if (!user) throw new KycError('UNAUTHORIZED', 'User no longer active');

  return {
    kind: 'user',
    tenantId: user.tenantId,
    userId: user.id,
    // Read from the database, not the token: a role revoked five minutes ago must
    // not still be honoured because it is baked into a valid token.
    role: user.role,
    email: user.email,
  };
}

/** `GET /v1/files/<key>` and nothing else beneath `/v1/files/`. */
const FILE_DOWNLOAD = /^\/v1\/files\/(?!presign$)[^/]+$/;

export const authPlugin: FastifyPluginAsync = fp(async (app) => {
  app.decorateRequest('caller', undefined);

  app.addHook('onRequest', async (request) => {
    const path = request.url.split('?')[0] ?? '';
    // Unauthenticated surface, enumerated explicitly rather than by prefix match.
    if (
      path === '/health' ||
      path === '/ready' ||
      path === '/openapi.json' ||
      path.startsWith('/docs') ||
      path === '/v1/auth/login' ||
      // Step two of signing in. The challenge token issued by step one is the
      // credential, and it is verified inside the handler; a bearer session is
      // precisely what the caller does not have yet.
      path === '/v1/auth/login/2fa' ||
      // Public only when DEMO_MODE is on. Enumerated here rather than matched by
      // prefix so a future /v1/demo/* route cannot become public by accident.
      (path === '/v1/demo/sessions' && process.env.DEMO_MODE === 'true') ||
      // A signed document link carries its own authorisation in the signature —
      // a short-lived HMAC over the key and expiry, minted by an authenticated
      // reviewer. Demanding a bearer token as well would defeat the point: the
      // link exists so an <img> tag can load it, and an image request carries
      // no headers. The route itself serves nothing without a valid signature.
      //
      // Matched precisely, not by prefix. A prefix match here also exempts
      // `/v1/files/presign`, which is the endpoint that *mints* the links — so
      // the one route that must be authenticated would have become the one
      // route that was not.
      (request.method === 'GET' && FILE_DOWNLOAD.test(path))
    ) {
      return;
    }

    const caller =
      (await authenticateApiKey(request)) ?? (await authenticateBearer(request));
    if (!caller) {
      throw new KycError(
        'UNAUTHORIZED',
        'Provide either X-Kyc-App-Token with a signature, or a Bearer token',
      );
    }
    request.caller = caller;
  });
});

// ---------------------------------------------------------------------------
// Authorisation helpers
// ---------------------------------------------------------------------------

export function requireCaller(request: FastifyRequest): Caller {
  if (!request.caller) throw new KycError('UNAUTHORIZED', 'Not authenticated');
  return request.caller;
}

/** Server-to-server or dashboard operator; never an applicant. */
export function requireBackend(request: FastifyRequest): Caller {
  const caller = requireCaller(request);
  if (caller.kind === 'applicant') {
    throw new KycError('FORBIDDEN', 'Applicant tokens cannot access this endpoint');
  }
  return caller;
}

const ROLE_RANK: Record<string, number> = {
  AUDITOR: 0,
  AI_AGENT: 0,
  AGENT: 1,
  COMPLIANCE_OFFICER: 2,
  MLRO: 3,
  ADMIN: 4,
  OWNER: 5,
};

/**
 * Requires a human operator of at least the given role.
 *
 * API keys are deliberately *not* accepted for decision endpoints: a decision has
 * to be attributable to a person, and a shared server credential is not a person.
 */
export function requireRole(
  request: FastifyRequest,
  minimum: keyof typeof ROLE_RANK,
): Extract<Caller, { kind: 'user' }> {
  const caller = requireCaller(request);
  if (caller.kind !== 'user') {
    throw new KycError(
      'FORBIDDEN',
      'This action must be performed by a named user, not a service credential',
    );
  }
  if ((ROLE_RANK[caller.role] ?? -1) < ROLE_RANK[minimum]!) {
    throw new KycError('FORBIDDEN', `Requires role ${minimum} or higher; you have ${caller.role}`);
  }
  return caller;
}

/** An applicant may only ever act on their own record. */
export function assertOwnRecord(caller: Caller, applicantId: string): void {
  if (caller.kind === 'applicant' && caller.applicantId !== applicantId) {
    // 404 rather than 403: confirming that another applicant exists is itself a
    // disclosure.
    throw new KycError('NOT_FOUND', 'Applicant not found');
  }
}

export function tenantOf(request: FastifyRequest): string {
  return requireCaller(request).tenantId;
}

export async function writeAudit(
  request: FastifyRequest,
  entry: {
    action: string;
    resourceType: string;
    resourceId?: string;
    before?: unknown;
    after?: unknown;
  },
): Promise<void> {
  const caller = request.caller;
  if (!caller) return;

  // Chaining, ordering, and the read-append race are handled by the shared
  // writer, so an HTTP-originated entry and one written by the pipeline land in
  // the same chain under the same rules.
  await appendAuditEntry({
    tenantId: caller.tenantId,
    actorType:
      caller.kind === 'user' ? 'USER' : caller.kind === 'applicant' ? 'APPLICANT' : 'API',
    actorId: caller.kind === 'user' ? caller.userId : null,
    action: entry.action,
    resourceType: entry.resourceType,
    resourceId: entry.resourceId ?? null,
    before: entry.before,
    after: entry.after,
    ipAddress: request.ip,
    userAgent: String(request.headers['user-agent'] ?? ''),
    requestId: request.id,
  });
}

export function replyError(reply: FastifyReply, error: unknown): FastifyReply {
  if (error instanceof KycError) {
    return reply.status(error.statusCode).send(error.toJSON());
  }
  const message = error instanceof Error ? error.message : 'Unexpected error';
  // Prisma's not-found error, mapped rather than leaked as a 500.
  if (message.includes('No ') && message.includes('found')) {
    return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
  }
  return reply
    .status(500)
    .send({ error: { code: 'INTERNAL', message: 'Internal server error' } });
}
