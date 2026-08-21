/**
 * Brings a tenant's verification levels up to the current templates.
 *
 * Provisioning deliberately skips a level that already exists, and that is
 * right: a level is the rulebook a decision was made under, and rewriting it
 * would rewrite the basis of every past approval. But it left no way at all
 * for a change to reach a tenant already running — the chip step was added to
 * the template and could never appear anywhere.
 *
 * So: a new version, side by side with the old. The previous version stays
 * exactly as it was, still attached to the applicants decided under it; new
 * applicants get the new one. Nothing is edited and nothing is lost.
 *
 *   npm run levels:sync -- --tenant acme-fintech --dry-run
 *   npm run levels:sync -- --tenant acme-fintech
 *   npm run levels:sync -- --tenant acme-fintech --level standard-kyc-aml
 */

import { LEVEL_TEMPLATES } from '@kyc/core';
import { prisma } from '@kyc/db';

const argv = process.argv.slice(2);
const flag = (name: string) => {
  const i = argv.indexOf(name);
  return i === -1 ? undefined : argv[i + 1];
};
const dryRun = argv.includes('--dry-run');
const slug = flag('--tenant');
const only = flag('--level');

async function main() {
  if (!slug) throw new Error('Pass --tenant <slug>');

  const tenant = await prisma.tenant.findUnique({ where: { slug }, select: { id: true, name: true } });
  if (!tenant) throw new Error(`No tenant with slug "${slug}"`);
  console.log(`${tenant.name}${dryRun ? '  (dry run)' : ''}`);

  let changed = 0;
  for (const template of Object.values(LEVEL_TEMPLATES)) {
    if (only && template.name !== only) continue;

    const current = await prisma.verificationLevel.findFirst({
      where: { tenantId: tenant.id, name: template.name, isActive: true },
      orderBy: { version: 'desc' },
    });
    if (!current) {
      console.log(`  ${template.name}: absent — run the seed rather than this`);
      continue;
    }

    // Compared by the steps alone, with keys in a fixed order. Display names
    // and descriptions drift for cosmetic reasons and are not worth a version
    // that past decisions get compared against — and Postgres reorders the keys
    // of a JSONB column, so a plain stringify reports every level as changed
    // and would churn a new version of the entire rulebook for nothing.
    const before = canonical(current.steps);
    const after = canonical(template.steps);
    if (before === after) {
      console.log(`  ${template.name}: already current (v${current.version})`);
      continue;
    }

    const added = stepIds(template.steps).filter((id) => !stepIds(current.steps).includes(id));
    const removed = stepIds(current.steps).filter((id) => !stepIds(template.steps).includes(id));
    console.log(
      `  ${template.name}: v${current.version} → v${current.version + 1}` +
        (added.length ? `  +${added.join(', ')}` : '') +
        (removed.length ? `  −${removed.join(', ')}` : ''),
    );
    changed++;
    if (dryRun) continue;

    await prisma.$transaction([
      // The old version stops taking new applicants and keeps the ones it has.
      prisma.verificationLevel.update({
        where: { id: current.id },
        data: { isActive: false },
      }),
      prisma.verificationLevel.create({
        data: {
          tenantId: tenant.id,
          name: template.name,
          displayName: template.displayName,
          description: template.description,
          subjectType: template.subjectType,
          version: current.version + 1,
          steps: template.steps as never,
          allowedCountries: template.allowedCountries,
          blockedCountries: template.blockedCountries,
          autoApprove: template.autoApprove,
          autoReject: template.autoReject,
          autoApproveScore: current.autoApproveScore,
          autoRejectScore: current.autoRejectScore,
          manualReviewScore: current.manualReviewScore,
          screeningConfig: current.screeningConfig as never,
          isActive: true,
        },
      }),
    ]);
  }

  console.log(
    changed === 0
      ? '\nNothing to do.'
      : `\n${dryRun ? 'Would create' : 'Created'} ${changed} new level version(s). ` +
          `Applicants already decided keep the version they were decided under.`,
  );
}

/** JSON with object keys sorted, so ordering is not mistaken for a change. */
function canonical(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonical).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${JSON.stringify(k)}:${canonical(v)}`)
      .join(',')}}`;
  }
  return JSON.stringify(value ?? null);
}

function stepIds(steps: unknown): string[] {
  return Array.isArray(steps) ? steps.map((s) => String((s as { id?: string }).id ?? '?')) : [];
}

try {
  await main();
} catch (error) {
  console.error(`✗ ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
} finally {
  await prisma.$disconnect();
}
