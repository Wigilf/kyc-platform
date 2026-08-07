import 'dotenv/config';
import Fastify from 'fastify';
import cors from '@fastify/cors';
import multipart from '@fastify/multipart';
import rateLimit from '@fastify/rate-limit';
import { KycError } from '@kyc/core';
import { prisma } from '@kyc/db';
import { signsItsOwnUrls, storageForProcess } from './storage.js';
import { authPlugin, replyError } from './auth.js';
import applicantsRoutes from './routes/applicants.js';
import decisionRoutes from './routes/decisions.js';
import configRoutes from './routes/config.js';
import twoFactorRoutes from './routes/twofactor.js';
import demoRoutes from './routes/demo.js';
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
    // Document storage keys are path parameters and run to roughly 130
    // characters once URL-encoded — tenant id, applicant id, document id and a
    // filename. Fastify's default cap is 100, so every request for a document
    // image was answered with 414 before reaching the route. The image endpoint
    // had therefore never worked, which is why nothing in the console used it.
    maxParamLength: 512,
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
      // Entries may be full origins or bare hostnames: Render supplies the
      // dashboard's host without a scheme, while the browser always sends a
      // full origin, so compare on hostname to stop the two missing each other.
      const allowed = (process.env.CORS_ORIGINS ?? '')
        .split(',')
        .map((entry) => entry.trim().replace(/\/$/, ''))
        .filter(Boolean)
        .map((entry) => (/^https?:\/\//.test(entry) ? entry : `https://${entry}`));

      // No configured list means development: allow anything, including the
      // no-origin case (curl, server-to-server).
      if (allowed.length === 0 || !origin) return cb(null, true);

      const hostOf = (value: string) => {
        try {
          return new URL(value).host;
        } catch {
          return value;
        }
      };
      const requested = hostOf(origin);
      if (allowed.some((entry) => hostOf(entry) === requested)) return cb(null, true);

      // Refuse by withholding the header, not by throwing. CORS is enforced by
      // the browser, so omitting Access-Control-Allow-Origin is what actually
      // blocks the caller; throwing here surfaced as a 500 INTERNAL, which reads
      // as a server fault and buries the real reason.
      cb(null, false);
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
      const storage = storageForProcess();
      const key = decodeURIComponent(request.params.key);

      // Document images are the most sensitive objects in the system, so access
      // is by time-limited signature only — never by knowing the key, and never
      // merely by being logged in.
      //
      // This used to demand a signature from the local driver and fall back to
      // "is there any caller at all" for every other one. Under that rule an
      // applicant's own short-lived token — issued to let them upload their own
      // passport — would fetch any object in any tenant, given its key. The
      // driver a deployment happens to use is not an access control decision.
      if (!signsItsOwnUrls(storage)) {
        // A driver that presigns elsewhere should never see a request here; if
        // one does, something is generating links this route cannot vouch for.
        return reply.status(404).send({
          error: { code: 'NOT_FOUND', message: 'File not found' },
        });
      }

      if (!storage.verifyPresigned(key, Number(request.query.expires), request.query.signature ?? '')) {
        return reply
          .status(403)
          .send({ error: { code: 'FORBIDDEN', message: 'Invalid or expired file signature' } });
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

      const storage = storageForProcess();

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
  await app.register(twoFactorRoutes);
  await app.register(kybRoutes);
  await app.register(supportRoutes);
  await app.register(transactionRoutes);
  await app.register(demoRoutes);

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
      servers: [{ url: process.env.PUBLIC_API_URL ?? `http://localhost:${process.env.PORT ?? process.env.API_PORT ?? 4000}` }],
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

/**
 * Refuses to start in production with the development placeholders in place.
 *
 * These are real secrets: APP_SECRET signs the tokens that authorise access to
 * an applicant's record, and PII_ENCRYPTION_KEY is the only thing standing
 * between a database dump and every stored address. Shipping the committed
 * defaults would make both decorative, and it is the kind of mistake that is
 * invisible until it matters — so it fails loudly at boot instead.
 */
export function assertProductionSecrets(env = process.env): void {
  if ((env.NODE_ENV ?? 'development') !== 'production') return;

  const problems: string[] = [];
  const check = (name: string, value: string | undefined, weak: (v: string) => boolean) => {
    if (!value) problems.push(`${name} is not set`);
    else if (weak(value)) problems.push(`${name} is still a development placeholder`);
  };

  check('APP_SECRET', env.APP_SECRET, (v) => v.includes('change-me') || v.length < 32);
  check('WEBHOOK_SIGNING_SECRET', env.WEBHOOK_SIGNING_SECRET, (v) => v.includes('change-me') || v.length < 16);
  check('PII_ENCRYPTION_KEY', env.PII_ENCRYPTION_KEY, (v) => /^0+$/.test(v) || v.length !== 64);
  check('DATABASE_URL', env.DATABASE_URL, () => false);

  if (problems.length) {
    throw new Error(
      `Refusing to start in production:\n  - ${problems.join('\n  - ')}\n\n` +
        'Generate strong values, e.g.\n' +
        '  APP_SECRET=$(openssl rand -base64 48)\n' +
        '  WEBHOOK_SIGNING_SECRET=$(openssl rand -base64 32)\n' +
        '  PII_ENCRYPTION_KEY=$(openssl rand -hex 32)\n\n' +
        'Note that changing PII_ENCRYPTION_KEY makes existing encrypted data unreadable.',
    );
  }
}

async function main() {
  assertProductionSecrets();

  const app = await buildServer();
  // PORT is what most hosts inject; API_PORT stays as the local convention.
  const port = Number(process.env.PORT ?? process.env.API_PORT ?? 4000);
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

  // One process hosting both. See startWorkers() for why this exists and what
  // it costs; a deployment that can afford a separate worker should leave this
  // unset and run `@kyc/worker` on its own.
  if (process.env.RUN_WORKER_IN_PROCESS === 'true') {
    const { startWorkers } = await import('@kyc/worker');
    await startWorkers();
    app.log.info('queue workers started in-process (RUN_WORKER_IN_PROCESS=true)');
  }
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
