import { PrismaClient, Prisma } from '../generated/client/index.js';

export * from '../generated/client/index.js';
export { Prisma };

declare global {
  // Reused across hot reloads so `tsx watch` does not exhaust the connection pool.
  // eslint-disable-next-line no-var
  var __kycPrisma: PrismaClient | undefined;
}

function create(): PrismaClient {
  const client = new PrismaClient({
    log:
      process.env.PRISMA_LOG === 'query'
        ? ['query', 'warn', 'error']
        : ['warn', 'error'],
  });
  return client;
}

export const prisma: PrismaClient = globalThis.__kycPrisma ?? create();

if (process.env.NODE_ENV !== 'production') {
  globalThis.__kycPrisma = prisma;
}

export async function disconnect(): Promise<void> {
  await prisma.$disconnect();
}

/**
 * Runs `fn` inside a transaction with the retry semantics we want for
 * write-heavy pipeline steps: serialization failures and deadlocks are
 * transient in Postgres under concurrency, so retry them a few times before
 * surfacing the error.
 */
export async function withRetry<T>(
  fn: (tx: Prisma.TransactionClient) => Promise<T>,
  attempts = 3,
): Promise<T> {
  let lastError: unknown;
  for (let i = 0; i < attempts; i++) {
    try {
      return await prisma.$transaction(fn, { timeout: 20_000 });
    } catch (error) {
      lastError = error;
      const code =
        error instanceof Prisma.PrismaClientKnownRequestError ? error.code : '';
      // P2034 = write conflict / deadlock detected.
      if (code !== 'P2034') throw error;
      await new Promise((r) => setTimeout(r, 50 * 2 ** i));
    }
  }
  throw lastError;
}
