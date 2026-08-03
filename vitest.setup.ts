/**
 * Loads .env before any test module is evaluated.
 *
 * @kyc/db constructs its Prisma client at module scope, and ESM evaluates
 * imports depth-first in declaration order — so a test that imports @kyc/db
 * above its own helpers gets a client built before any `dotenv/config` in those
 * helpers has run. Doing it here removes the ordering hazard entirely.
 */
import 'dotenv/config';
