import { nameTokens } from '@kyc/core';
import { prisma } from '@kyc/db';
import { WATCHLIST_SOURCES, type ParsedEntry, type WatchlistSourceSpec } from './sources.js';

/**
 * Refreshing the watchlist corpus from the published lists.
 *
 * Two properties matter more than speed.
 *
 * **Idempotent.** Rows are keyed on (listName, sourceRef), so a re-run updates
 * in place. Re-running must never duplicate a designated person, because a
 * duplicate becomes two hits an analyst has to clear separately.
 *
 * **Delisting is a real event.** Someone removed from a list must stop matching,
 * but their history has to survive — an AmlHit points at the entry that caused
 * it, and a decision made last year has to remain explainable. So entries that
 * vanish from a source are marked inactive and dated, never deleted.
 */

export interface IngestReport {
  source: string;
  fetched: number;
  created: number;
  updated: number;
  delisted: number;
  errors: string[];
  ms: number;
}

/** Tokens the candidate pre-filter searches on: whole tokens plus 4-char prefixes. */
function tokensFor(entry: ParsedEntry): string[] {
  return [
    ...new Set(
      [entry.fullName, ...entry.aliases]
        .flatMap((n) => nameTokens(n))
        .flatMap((t) => [t, t.slice(0, 4)])
        .filter((t) => t.length >= 2),
    ),
  ];
}

async function fetchXml(url: string, timeoutMs: number): Promise<string> {
  const abort = AbortSignal.timeout(timeoutMs);
  const response = await fetch(url, {
    signal: abort,
    headers: { accept: 'application/xml,text/xml,*/*' },
  });
  if (!response.ok) {
    throw new Error(`${response.status} ${response.statusText}`);
  }
  return response.text();
}

export async function ingestSource(
  source: WatchlistSourceSpec,
  opts: { timeoutMs?: number; batchSize?: number } = {},
): Promise<IngestReport> {
  const started = Date.now();
  const report: IngestReport = {
    source: source.listName,
    fetched: 0,
    created: 0,
    updated: 0,
    delisted: 0,
    errors: [],
    ms: 0,
  };

  let entries: ParsedEntry[];
  try {
    const xml = await fetchXml(source.url, opts.timeoutMs ?? 120_000);
    entries = source.parse(xml);
  } catch (error) {
    report.errors.push(error instanceof Error ? error.message : String(error));
    report.ms = Date.now() - started;
    return report;
  }

  report.fetched = entries.length;
  // A source that suddenly returns almost nothing is far more likely to be a
  // fetch or parse failure than a mass delisting, and acting on it would blind
  // screening. Refuse rather than wipe the list.
  if (entries.length < 50) {
    report.errors.push(
      `only ${entries.length} entries parsed — refusing to apply, this looks like a broken feed`,
    );
    report.ms = Date.now() - started;
    return report;
  }

  const existing = new Map(
    (
      await prisma.watchlistEntry.findMany({
        where: { listName: source.listName, tenantId: null },
        select: { id: true, sourceRef: true, isActive: true },
      })
    )
      .filter((r): r is typeof r & { sourceRef: string } => r.sourceRef !== null)
      .map((r) => [r.sourceRef, r]),
  );

  const seen = new Set<string>();
  const batchSize = opts.batchSize ?? 500;

  for (let i = 0; i < entries.length; i += batchSize) {
    const batch = entries.slice(i, i + batchSize);
    await prisma.$transaction(
      batch.map((entry) => {
        seen.add(entry.sourceRef);
        const data = {
          tenantId: null,
          listType: entry.listType as never,
          listName: entry.listName,
          sourceRef: entry.sourceRef,
          entityType: entry.entityType as never,
          fullName: entry.fullName,
          aliases: entry.aliases,
          dob: entry.dob ? new Date(entry.dob) : null,
          yobOnly: entry.yobOnly,
          countries: entry.countries,
          nameTokens: tokensFor(entry),
          program: entry.program,
          remarks: entry.remarks,
          isActive: true,
          delistedAt: null,
          raw: { source: source.key } as never,
        };
        return prisma.watchlistEntry.upsert({
          where: { listName_sourceRef: { listName: entry.listName, sourceRef: entry.sourceRef } },
          create: data,
          update: data,
        });
      }),
    );

    for (const entry of batch) {
      if (existing.has(entry.sourceRef)) report.updated++;
      else report.created++;
    }
  }

  // Gone from the source: deactivate, keep the row.
  const vanished = [...existing.values()].filter((r) => !seen.has(r.sourceRef) && r.isActive);
  if (vanished.length) {
    const result = await prisma.watchlistEntry.updateMany({
      where: { id: { in: vanished.map((r) => r.id) } },
      data: { isActive: false, delistedAt: new Date() },
    });
    report.delisted = result.count;
  }

  report.ms = Date.now() - started;
  return report;
}

export async function ingestAllSources(
  opts: { only?: string[]; timeoutMs?: number } = {},
): Promise<IngestReport[]> {
  const sources = opts.only?.length
    ? WATCHLIST_SOURCES.filter((s) => opts.only!.includes(s.key))
    : WATCHLIST_SOURCES;

  const reports: IngestReport[] = [];
  // Sequential on purpose: these are tens of megabytes of XML each, and parsing
  // three at once is how a 512MB container dies.
  for (const source of sources) {
    reports.push(await ingestSource(source, { timeoutMs: opts.timeoutMs }));
  }
  return reports;
}
