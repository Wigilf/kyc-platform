import 'dotenv/config';
import { prisma } from '../packages/db/src/index.js';
import { ingestAllSources } from '../packages/worker/src/watchlist/ingest.js';

/**
 * Refreshes the sanctions corpus from OFAC, the UN and the EU.
 *
 *   npm run watchlist:refresh                  # all sources
 *   npm run watchlist:refresh -- ofac-sdn      # one source
 *
 * Point DATABASE_URL at whichever database you mean. The published lists total
 * ~55MB of XML, so this wants more memory than a small container has — running
 * it from a workstation against the deployed database is the intended path on a
 * free-tier deployment.
 */

const only = process.argv.slice(2).filter((a) => !a.startsWith('-'));

const reports = await ingestAllSources({ only: only.length ? only : undefined });

let failed = false;
console.log('');
for (const r of reports) {
  if (r.errors.length) {
    failed = true;
    console.log(`✗ ${r.listName ?? r.source}`);
    for (const e of r.errors) console.log(`    ${e}`);
    continue;
  }
  console.log(
    `✓ ${r.source.padEnd(18)} ${String(r.fetched).padStart(6)} entries  ` +
      `+${r.created} new  ~${r.updated} updated  -${r.delisted} delisted  ` +
      `(${(r.ms / 1000).toFixed(1)}s)`,
  );
}

const active = await prisma.watchlistEntry.count({ where: { isActive: true, tenantId: null } });
console.log(`\nactive global watchlist entries: ${active}`);

await prisma.$disconnect();
process.exit(failed ? 1 : 0);
