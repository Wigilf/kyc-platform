/**
 * Loads .env before any test module is evaluated.
 *
 * @kyc/db constructs its Prisma client at module scope, and ESM evaluates
 * imports depth-first in declaration order — so a test that imports @kyc/db
 * above its own helpers gets a client built before any `dotenv/config` in those
 * helpers has run. Doing it here removes the ordering hazard entirely.
 */
import 'dotenv/config';

/**
 * Quiet the API's request log during tests.
 *
 * Several suites build a real Fastify instance, which logs a line per request
 * at info level. A failing run then buries its own diagnosis under thousands
 * of JSON log lines — twice I could not tell which test had failed, and once
 * the deploy script's captured output was nothing but request logs.
 *
 * Only when nothing has asked otherwise, so `LOG_LEVEL=debug npx vitest` still
 * works when the logs are what you want.
 */
process.env.LOG_LEVEL ??= 'silent';
