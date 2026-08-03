import { ALL_DEFAULT_RULES, LEVEL_TEMPLATES } from '@kyc/core';
import { prisma } from './index.js';

/**
 * Everything a tenant needs before it can verify anybody.
 *
 * The verification levels and the rule set are the built-in templates from
 * @kyc/core, so this is not a copy of the seed — it is the part of the seed that
 * was never specific to the demo, factored out so tests can stand up a tenant of
 * their own instead of borrowing the demo one.
 *
 * Idempotent: safe to call against a tenant that already has some of this.
 */

const DEFAULT_QUEUES = [
  { name: 'manual-review', description: 'General verification review', isDefault: true, sla: 1440 },
  { name: 'aml-hits', description: 'Sanctions, PEP, and adverse media hits', isDefault: false, sla: 480 },
  { name: 'fraud-review', description: 'Suspected fraud and duplicate accounts', isDefault: false, sla: 720 },
  { name: 'edd-review', description: 'Enhanced due diligence', isDefault: false, sla: 2880 },
  { name: 'kyb-review', description: 'Business verification and UBO resolution', isDefault: false, sla: 2880 },
  { name: 'transaction-alerts', description: 'Transaction monitoring alerts', isDefault: false, sla: 240 },
  { name: 'complaints', description: 'Complaints and appeals', isDefault: false, sla: 480 },
];

export interface ProvisionTenantInput {
  slug: string;
  name: string;
  homeCountry?: string;
  industry?: string;
  dataResidency?: string;
}

/** Creates the tenant if absent, then its levels, queues, and rules. */
export async function provisionTenant(input: ProvisionTenantInput) {
  const tenant = await prisma.tenant.upsert({
    where: { slug: input.slug },
    create: {
      name: input.name,
      slug: input.slug,
      homeCountry: input.homeCountry ?? 'GBR',
      industry: (input.industry ?? 'FINTECH') as never,
      dataResidency: input.dataResidency ?? 'eu',
    },
    update: {},
  });

  await provisionLevels(tenant.id);
  await provisionQueues(tenant.id);
  await provisionRules(tenant.id);

  return tenant;
}

export async function provisionLevels(tenantId: string): Promise<number> {
  let created = 0;
  for (const template of Object.values(LEVEL_TEMPLATES)) {
    const existing = await prisma.verificationLevel.findFirst({
      where: { tenantId, name: template.name },
    });
    if (existing) continue;
    await prisma.verificationLevel.create({
      data: {
        tenantId,
        name: template.name,
        displayName: template.displayName,
        description: template.description,
        subjectType: template.subjectType,
        version: 1,
        steps: template.steps as never,
        allowedCountries: template.allowedCountries,
        blockedCountries: template.blockedCountries,
        autoApprove: template.autoApprove,
        autoReject: template.autoReject,
        manualReviewScore: template.manualReviewScore,
        autoRejectScore: template.autoRejectScore,
        reverifyAfterDays: template.reverifyAfterDays,
        screeningConfig: template.screeningConfig as never,
      },
    });
    created++;
  }
  return created;
}

export async function provisionQueues(tenantId: string): Promise<number> {
  for (const queue of DEFAULT_QUEUES) {
    await prisma.queue.upsert({
      where: { tenantId_name: { tenantId, name: queue.name } },
      create: {
        tenantId,
        name: queue.name,
        description: queue.description,
        isDefault: queue.isDefault,
        slaFirstResponseMinutes: Math.round(queue.sla / 4),
        slaResolutionMinutes: queue.sla,
      },
      update: {},
    });
  }
  return DEFAULT_QUEUES.length;
}

/**
 * The rule set is what makes a decision possible at all — auto-approval is
 * itself a rule — so a tenant without it can never approve anyone.
 */
export async function provisionRules(tenantId: string): Promise<number> {
  for (const rule of ALL_DEFAULT_RULES) {
    await prisma.rule.upsert({
      where: { tenantId_name: { tenantId, name: rule.name } },
      create: {
        tenantId,
        name: rule.name,
        description: rule.description,
        scope: rule.scope,
        priority: rule.priority,
        isActive: rule.isActive,
        isShadow: rule.isShadow,
        conditions: rule.conditions as never,
        actions: rule.actions as never,
        versions: {
          create: {
            version: 1,
            conditions: rule.conditions as never,
            actions: rule.actions as never,
            changeNote: 'Seeded default',
          },
        },
      },
      update: {
        conditions: rule.conditions as never,
        actions: rule.actions as never,
        priority: rule.priority,
      },
    });
  }
  return ALL_DEFAULT_RULES.length;
}
