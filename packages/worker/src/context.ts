import { createAdapters, type AdapterRegistry, type WatchlistCandidate, type WatchlistSource } from '@kyc/adapters';
import { nameTokens } from '@kyc/core';
import { prisma } from '@kyc/db';

/**
 * Shared runtime wiring.
 *
 * The watchlist source is the interesting piece: the screening adapter needs
 * candidate list entries, and rather than let @kyc/adapters depend on the
 * database, the query lives here and is injected. That keeps the adapter package
 * a pure boundary and means the same matching code serves mock mode, a cached
 * provider, and a test fixture.
 */

export class PrismaWatchlistSource implements WatchlistSource {
  constructor(private readonly tenantId: string) {}

  async load(req: {
    listTypes: string[];
    entityType: 'INDIVIDUAL' | 'COMPANY';
    nameTokens: string[];
  }): Promise<WatchlistCandidate[]> {
    // Pre-filter on a token prefix rather than an exact name: matching the whole
    // string in SQL would defeat the fuzzy scoring the adapter does. Four
    // characters is enough to cut the corpus down without excluding the typos and
    // transliterations we specifically want to catch.
    const prefixes = req.nameTokens
      .filter((t) => t.length >= 3)
      .map((t) => t.slice(0, 4));

    const entries = await prisma.watchlistEntry.findMany({
      where: {
        isActive: true,
        delistedAt: null,
        listType: { in: req.listTypes as never[] },
        entityType: req.entityType as never,
        // Global lists plus this tenant's own blocklists/allowlists.
        OR: [{ tenantId: null }, { tenantId: this.tenantId }],
        ...(prefixes.length
          ? { nameTokens: { hasSome: prefixes.flatMap((p) => [p, p.toLowerCase()]) } }
          : {}),
      },
      take: 500,
    });

    // If the prefix filter found nothing, fall back to a broader scan. A screening
    // run that silently searched an empty candidate set is worse than a slow one:
    // it reports "no hits" with no evidence behind it.
    const rows = entries.length
      ? entries
      : await prisma.watchlistEntry.findMany({
          where: {
            isActive: true,
            delistedAt: null,
            listType: { in: req.listTypes as never[] },
            entityType: req.entityType as never,
            OR: [{ tenantId: null }, { tenantId: this.tenantId }],
          },
          take: 500,
        });

    return rows.map(
      (e): WatchlistCandidate => ({
        id: e.id,
        listType: e.listType,
        listName: e.listName,
        entityType: e.entityType as 'INDIVIDUAL' | 'COMPANY',
        fullName: e.fullName,
        aliases: e.aliases,
        dob: e.dob ? e.dob.toISOString().slice(0, 10) : null,
        yobOnly: e.yobOnly,
        countries: e.countries,
        positions: e.positions,
        pepTier: e.pepTier,
        program: e.program,
        remarks: e.remarks,
        categories: Array.isArray((e.raw as { categories?: unknown })?.categories)
          ? ((e.raw as { categories: string[] }).categories)
          : [],
        listedAt: e.listedAt ? e.listedAt.toISOString() : null,
        raw: e.raw as Record<string, unknown>,
      }),
    );
  }
}

/** Adapter set for a tenant. Cached, because construction reads config. */
const registryCache = new Map<string, AdapterRegistry>();

export function adaptersFor(tenantId: string): AdapterRegistry {
  const cached = registryCache.get(tenantId);
  if (cached) return cached;

  const registry = createAdapters({
    mode: (process.env.ADAPTER_MODE ?? 'mock') as 'mock' | 'live',
    storage: {
      driver: (process.env.STORAGE_DRIVER ?? 'local') as 'local' | 's3',
      localDir: process.env.STORAGE_LOCAL_DIR ?? './.data/uploads',
      signingSecret: process.env.APP_SECRET ?? 'dev-secret',
      ...(process.env.STORAGE_DRIVER === 's3'
        ? {
            s3: {
              endpoint: process.env.S3_ENDPOINT!,
              region: process.env.S3_REGION ?? 'us-east-1',
              bucket: process.env.S3_BUCKET!,
              accessKeyId: process.env.S3_ACCESS_KEY_ID!,
              secretAccessKey: process.env.S3_SECRET_ACCESS_KEY!,
              forcePathStyle: process.env.S3_FORCE_PATH_STYLE === 'true',
            },
          }
        : {}),
    },
    watchlistSource: new PrismaWatchlistSource(tenantId),
    logger: (msg) => console.log(`[notify] ${msg}`),
  });

  registryCache.set(tenantId, registry);
  return registry;
}

/** Loads the tenant's active rules, newest version of each. */
export async function loadRules(tenantId: string, scopes: string[]) {
  const rules = await prisma.rule.findMany({
    where: { tenantId, isActive: true, scope: { in: scopes as never[] } },
    orderBy: [{ priority: 'asc' }, { name: 'asc' }],
  });
  return rules.map((r) => ({
    id: r.id,
    name: r.name,
    description: r.description ?? undefined,
    scope: r.scope as never,
    priority: r.priority,
    isActive: r.isActive,
    isShadow: r.isShadow,
    conditions: r.conditions as never,
    actions: (r.actions ?? []) as never[],
  }));
}

export { nameTokens };
