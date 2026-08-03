import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { KycError } from '@kyc/core';
import { prisma } from '@kyc/db';
import { LocalStorageAdapter, createStorage } from '@kyc/adapters';
import { authPlugin, replyError } from './auth.js';
import applicantsRoutes from './routes/applicants.js';
import decisionRoutes from './routes/decisions.js';
import configRoutes from './routes/config.js';
import kybRoutes from './routes/kyb.js';
import supportRoutes from './routes/support.js';
import transactionRoutes from './routes/transactions.js';

/**
 * API server.
 *
 * Note the raw-body capture: HMAC request signing has to hash the exact bytes
 * received, and by the time Fastify has parsed and re-serialised JSON the bytes
 * have changed (key order, whitespace), which would fail every signature.
 */

export async function buildServer() {
  const app = Fastify({
    logger: {
      level: process.env.LOG_LEVEL ?? 'info',
      redact: {
        // Never log credentials or PII, even at debug level. A log aggregator is
        // a much wider audience than the database.
        paths: [
          'req.headers.authorization',
          'req.headers["x-kyc-app-secret"]',
          'req.headers["x-kyc-signature"]',
          'req.body.password',
          'req.body.info',
          'req.body.message',
        ],
        censor: '[redacted]',
      },
    },
    bodyLimit: 30 * 1024 * 1024,
    trustProxy: true,
    // Request ids appear in the audit log, so they must be genuinely unique.
    genReqId: () => `req_${Math.random().toString(36).slice(2)}${Date.now().toString(36)}`,
  });

  // Capture the raw body before parsing so signatures verify against the bytes
  // actually sent.
  app.addContentTypeParser(
    'application/json',
    { parseAs: 'string' },
    (request, body, done) => {
      (request as { rawBody?: string }).rawBody = body as string;
      try {
        done(null, body === '' ? {} : JSON.parse(body as string));
      } catch (error) {
        done(error as Error, undefined);
      }
    },
  );

  await app.register(cors, {
    origin: (origin, cb) => {
      const allowed = (process.env.CORS_ORIGINS ?? '').split(',').filter(Boolean);
      // No configured list means development: allow anything, including the
      // no-origin case (curl, server-to-server).
      if (allowed.length === 0 || !origin || allowed.includes(origin)) return cb(null, true);
      cb(new Error('Origin not allowed'), false);
    },
    credentials: true,
    exposedHeaders: ['x-request-id'],
  });

  await app.register(multipart, {
    limits: { fileSize: 25 * 1024 * 1024, files: 4 },
  });

  await app.register(rateLimit, {
    global: true,
    max: Number(process.env.RATE_LIMIT_MAX ?? 300),
    timeWindow: '1 minute',
    // Per credential rather than per IP: one tenant behind a NAT must not be able
    // to exhaust another tenant's budget.
    keyGenerator: (request) => {
      const caller = request.caller;
      if (caller?.kind === 'api-key') return `key:${caller.keyId}`;
      if (caller?.kind === 'applicant') return `app:${caller.applicantId}`;
      if (caller?.kind === 'user') return `user:${caller.userId}`;
      return `ip:${request.ip}`;
    },
  });

  await app.register(authPlugin);

  // --- Health ---
  app.get('/health', async () => ({ status: 'ok', uptime: process.uptime() }));

  app.get('/ready', async (_request, reply) => {
    // Readiness means "can actually serve traffic", which means the database is
    // reachable — not merely that the process started.
    try {
      await prisma.$queryRaw`SELECT 1`;
      return { status: 'ready', database: 'ok' };
    } catch (error) {
      return reply.status(503).send({
        status: 'not-ready',
        database: 'unreachable',
        error: error instanceof Error ? error.message : 'unknown',
      });
    }
  });

  // --- Signed document access ---
  app.get<{ Params: { key: string }; Querystring: { expires?: string; signature?: string } }>(
    '/v1/files/:key',
    async (request, reply) => {
      const storage = createStorage({
        driver: (process.env.STORAGE_DRIVER ?? 'local') as 'local' | 's3',
        localDir: process.env.STORAGE_LOCAL_DIR ?? './.data/uploads',
        signingSecret: process.env.APP_SECRET ?? 'dev-secret',
      });

      const key = decodeURIComponent(request.params.key);

      // Document images are the most sensitive objects in the system, so access is
      // by time-limited signature only — never by knowing the key.
      if (storage instanceof LocalStorageAdapter) {
        const valid = storage.verifyPresigned(
          key,
          Number(request.query.expires),
          request.query.signature ?? '',
        );
        if (!valid) {
          return reply
            .status(403)
            .send({ error: { code: 'FORBIDDEN', message: 'Invalid or expired file signature' } });
        }
      } else if (!request.caller) {
        return reply.status(401).send({ error: { code: 'UNAUTHORIZED', message: 'Not authenticated' } });
      }

      try {
        const file = await storage.get(key);
        return reply
          .header('content-type', file.contentType)
          .header('cache-control', 'private, max-age=60')
          .send(file.bytes);
      } catch {
        return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'File not found' } });
      }
    },
  );

  /** Presign a document image for viewing in the dashboard. */
  app.post<{ Body: { storageKey: string; ttlSeconds?: number } }>(
    '/v1/files/presign',
    async (request) => {
      const { requireBackend, writeAudit } = await import('./auth.js');
      const caller = requireBackend(request);
      const storageKey = request.body.storageKey;

      // The key is tenant-prefixed, so this check is what stops one tenant
      // presigning another tenant's documents.
      if (!storageKey.startsWith(`tenants/${caller.tenantId}/`)) {
        throw new KycError('FORBIDDEN', 'Storage key does not belong to this tenant');
      }

      const storage = createStorage({
        driver: (process.env.STORAGE_DRIVER ?? 'local') as 'local' | 's3',
        localDir: process.env.STORAGE_LOCAL_DIR ?? './.data/uploads',
        signingSecret: process.env.APP_SECRET ?? 'dev-secret',
      });

      await writeAudit(request, {
        action: 'document.image.presigned',
        resourceType: 'DocumentImage',
        resourceId: storageKey,
      });

      return {
        url: await storage.presignGet(storageKey, Math.min(request.body.ttlSeconds ?? 300, 900)),
        expiresInSeconds: Math.min(request.body.ttlSeconds ?? 300, 900),
      };
    },
  );

  // --- Error handling ---
  //
  // Registered before the routes on purpose. Fastify copies the error handler
  // into each encapsulation context as that context is created, so a handler
  // set after `register()` never reaches those routes: Zod failures surfaced
  // as 500s instead of 400s, and thrown errors came back in Fastify's default
  // envelope rather than this API's.
  app.setErrorHandler((rawError, request, reply) => {
    // Fastify types the handler's first argument loosely; narrow once here rather
    // than casting at each branch.
    const error = rawError as Error & {
      statusCode?: number;
      code?: string;
      validation?: unknown;
      issues?: unknown[];
    };

    if (error instanceof KycError) {
      // Client errors are expected traffic, not incidents; only log the 5xx ones.
      if (error.statusCode >= 500) request.log.error({ err: error }, 'domain error');
      return reply.status(error.statusCode).send(error.toJSON());
    }

    if (error.validation) {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: error.message,
          details: error.validation,
        },
      });
    }

    // Zod
    if (error.name === 'ZodError') {
      return reply.status(400).send({
        error: {
          code: 'VALIDATION_FAILED',
          message: 'Request body failed validation',
          details: error.issues,
        },
      });
    }

    if (error.statusCode === 429) {
      return reply
        .status(429)
        .send({ error: { code: 'RATE_LIMITED', message: 'Too many requests' } });
    }

    // Prisma unique-constraint violation.
    if (error.code === 'P2002') {
      return reply
        .status(409)
        .send({ error: { code: 'CONFLICT', message: 'Resource already exists' } });
    }
    if (error.code === 'P2025') {
      return reply.status(404).send({ error: { code: 'NOT_FOUND', message: 'Not found' } });
    }

    request.log.error({ err: error }, 'unhandled error');
    return replyError(reply, error);
  });

  // --- Routes ---
  await app.register(applicantsRoutes);
  await app.register(decisionRoutes);
  await app.register(configRoutes);
  await app.register(kybRoutes);
  await app.register(supportRoutes);
  await app.register(transactionRoutes);

  // --- Machine-readable API description ---
  app.get('/openapi.json', async () => {
    const routes: Array<{ method: string; url: string }> = [];
    for (const line of app.printRoutes({ commonPrefix: false }).split('\n')) {
      const match = /^[│├└─\s]*([a-z0-9/:._{}-]+)\s+\((.+)\)/i.exec(line);
      if (match) {
        for (const method of match[2]!.split(', ')) {
          routes.push({ method, url: match[1]! });
        }
      }
    }
    return {
      openapi: '3.1.0',
      info: {
        title: 'KYC Platform API',
        version: '2026-07-01',
        description:
          'Identity verification, AML screening, KYB, transaction monitoring, and agentic support.',
      },
      servers: [{ url: `http://localhost:${process.env.API_PORT ?? 4000}` }],
      // A route inventory rather than a hand-maintained spec: an inaccurate spec
      // is worse than an honest list.
      'x-routes': routes,
      components: {
        securitySchemes: {
          apiKey: {
            type: 'apiKey',
            in: 'header',
            name: 'X-Kyc-App-Token',
            description:
              'Server-to-server. Send with X-Kyc-App-Secret, X-Kyc-Timestamp, and X-Kyc-Signature (HMAC-SHA256 over `${ts}\\n${METHOD}\\n${path}\\n${sha256(body)}`).',
          },
          bearer: {
            type: 'http',
            scheme: 'bearer',
            description: 'Applicant SDK token or dashboard session token.',
          },
        },
      },
    };
  });

  app.setNotFoundHandler((request, reply) =>
    reply.status(404).send({
      error: { code: 'NOT_FOUND', message: `No route for ${request.method} ${request.url}` },
    }),
  );

  return app;
}

async function main() {
  const app = await buildServer();
  const port = Number(process.env.API_PORT ?? 4000);
  const host = process.env.API_HOST ?? '0.0.0.0';

  const shutdown = async (signal: string) => {
    app.log.info(`${signal} received, closing`);
    await app.close();
    await prisma.$disconnect();
    process.exit(0);
  };
  process.on('SIGTERM', () => void shutdown('SIGTERM'));
  process.on('SIGINT', () => void shutdown('SIGINT'));

  await app.listen({ port, host });
  app.log.info(`API listening on http://${host}:${port} (docs: /openapi.json)`);
}

const isEntrypoint =
  process.argv[1] !== undefined &&
  (process.argv[1].endsWith('api/src/server.ts') || process.argv[1].endsWith('api/dist/server.js'));

if (isEntrypoint) {
  main().catch((error) => {
    console.error('[api] fatal', error);
    process.exit(1);
  });
}
