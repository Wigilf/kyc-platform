import 'dotenv/config';
import { readFileSync } from 'node:fs';
import { prisma } from '../packages/db/src/index.js';
import { runVerificationPipeline } from '../packages/worker/src/pipeline.js';
import { adaptersFor } from '../packages/worker/src/context.js';
import { documentStorageKey } from '../packages/adapters/src/index.js';
import { SupportService } from '../packages/agent/src/index.js';

/**
 * End-to-end demonstration, run against a real database with the mock adapters.
 *
 * Drives every seeded scenario through the full pipeline and prints the decision,
 * then opens a support conversation about one of the rejections so the agentic
 * layer is exercised on real record data.
 *
 * Runs the pipeline directly rather than through Redis so the script is a single
 * synchronous story rather than a race against a worker.
 */

// A 1x1 PNG. The mock adapters key off the applicant, not the pixels, so the
// bytes only need to be a valid image of a plausible size.
const PNG_1X1 = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFBQIAX8jx0gAAAABJRU5ErkJggg==',
  'base64',
);

async function attachDocuments(tenantId: string, applicantId: string) {
  const storage = adaptersFor(tenantId).storage;

  for (const spec of [
    { type: 'PASSPORT' as const, side: 'FRONT_SIDE' as const },
    { type: 'SELFIE' as const, side: 'FRONT_SIDE' as const },
    { type: 'UTILITY_BILL' as const, side: 'PAGE' as const },
  ]) {
    const existing = await prisma.document.findFirst({
      where: { applicantId, type: spec.type, status: { not: 'SUPERSEDED' } },
    });
    if (existing) continue;

    const document = await prisma.document.create({
      data: {
        applicantId,
        type: spec.type,
        subType: spec.side,
        status: 'UPLOADED',
        issuedDate: spec.type === 'UTILITY_BILL' ? new Date(Date.now() - 30 * 86_400_000) : null,
      },
    });

    const key = documentStorageKey({
      tenantId,
      applicantId,
      documentId: document.id,
      side: spec.side,
      extension: 'png',
    });
    const stored = await storage.put(key, PNG_1X1, 'image/png');

    await prisma.documentImage.create({
      data: {
        documentId: document.id,
        storageKey: stored.key,
        contentType: 'image/png',
        bytes: stored.bytes,
        sha256: stored.sha256,
        side: spec.side,
        capturedBy: 'WEB_SDK_CAMERA',
      },
    });
  }
}

async function main() {
  const tenant = await prisma.tenant.findFirstOrThrow({ where: { slug: 'acme-fintech' } });
  const applicants = await prisma.applicant.findMany({
    where: { tenantId: tenant.id, externalUserId: { startsWith: 'demo-' } },
    orderBy: { externalUserId: 'asc' },
  });

  console.log('\n=== Verification pipeline ===\n');
  const rows: Array<Record<string, unknown>> = [];

  for (const applicant of applicants) {
    await attachDocuments(tenant.id, applicant.id);

    await prisma.applicant.update({
      where: { id: applicant.id },
      data: { reviewStatus: 'PENDING', status: 'QUEUED', submittedAt: new Date() },
    });

    const result = await runVerificationPipeline({
      tenantId: tenant.id,
      applicantId: applicant.id,
      trigger: 'SUBMITTED',
    });

    const after = await prisma.applicant.findUniqueOrThrow({
      where: { id: applicant.id },
      include: {
        checks: { orderBy: { createdAt: 'desc' } },
        reviews: { orderBy: { createdAt: 'desc' }, take: 1 },
        screeningRuns: { orderBy: { startedAt: 'desc' }, take: 1, include: { hits: true } },
      },
    });

    const failed = after.checks.filter((c) => c.result === 'FAIL');
    rows.push({
      applicant: applicant.externalUserId,
      decision: result.reviewStatus,
      risk: result.riskScore,
      band: after.riskLevel,
      dd: after.ddLevel,
      checks: result.checksRun,
      failed: failed.map((c) => c.type).join(',') || '—',
      hits: after.screeningRuns[0]?.hits.length ?? 0,
      labels:
        [...new Set(failed.flatMap((c) => c.rejectLabels))].slice(0, 3).join(',') || '—',
    });
  }

  console.table(rows);

  // --- Screening quality: the namesake must be distinguishable from the target ---
  console.log('\n=== Screening: exact match vs namesake ===\n');
  for (const externalUserId of ['demo-sanctioned-004', 'demo-namesake-005']) {
    const applicant = await prisma.applicant.findFirstOrThrow({
      where: { tenantId: tenant.id, externalUserId },
      include: {
        screeningRuns: {
          orderBy: { startedAt: 'desc' },
          take: 1,
          include: { hits: { orderBy: { matchScore: 'desc' } } },
        },
      },
    });
    const run = applicant.screeningRuns[0];
    console.log(
      `${externalUserId} (${applicant.firstName} ${applicant.lastName}, dob ${applicant.dob?.toISOString().slice(0, 10)}):`,
    );
    for (const hit of run?.hits ?? []) {
      console.log(
        `   ${hit.matchScore.toFixed(3)}  ${hit.listType.padEnd(14)} ${hit.matchedName.padEnd(32)} fields=${hit.matchedFields.join('/')}`,
      );
    }
    if (!run?.hits.length) console.log('   no hits');
  }

  // --- Agentic support on a real rejection ---
  console.log('\n=== Agentic support ===\n');
  const service = new SupportService();
  console.log(`runtime: ${service.runtimeName}\n`);

  const rejected = await prisma.applicant.findFirstOrThrow({
    where: { tenantId: tenant.id, externalUserId: 'demo-blurry-002' },
  });

  const ticket = await service.createTicket({
    tenantId: tenant.id,
    applicantId: rejected.id,
    channel: 'WEB_SDK',
    subject: 'My passport keeps getting rejected',
    message:
      "I've uploaded my passport three times now and it keeps saying it was rejected. What am I doing wrong?",
  });
  console.log(`ticket ${ticket.ticket.reference} — intent ${ticket.intent}`);

  const first = await service.handleApplicantMessage({
    tenantId: tenant.id,
    ticketId: ticket.ticket.id,
    messageAlreadyPersisted: true,
  });
  console.log(`\nagent (confidence ${first.confidence}, escalated=${first.escalated}):`);
  console.log(indent(first.reply ?? ''));
  console.log(`\ntools used: ${first.toolCalls?.map((t) => `${t.name}[${t.status}]`).join(' → ')}`);

  // A final-rejection appeal must be refused by the agent and escalated: this is
  // the policy boundary the whole design is built around.
  const finalReject = await prisma.applicant.findFirstOrThrow({
    where: { tenantId: tenant.id, externalUserId: 'demo-forged-003' },
  });
  const appeal = await service.createTicket({
    tenantId: tenant.id,
    applicantId: finalReject.id,
    channel: 'EMAIL',
    subject: 'I want to appeal your decision',
    message:
      'You rejected my application and I want to appeal. This is unacceptable and I will contact the regulator.',
  });
  const appealTurn = await service.handleApplicantMessage({
    tenantId: tenant.id,
    ticketId: appeal.ticket.id,
    messageAlreadyPersisted: true,
  });
  console.log(`\n--- appeal ticket ${appeal.ticket.reference} (intent ${appeal.intent}) ---`);
  console.log(`escalated: ${appealTurn.escalated} (${appealTurn.escalationReason})`);
  console.log(indent(appealTurn.reply ?? ''));

  // --- Tool authorisation: prove a forbidden tool is actually blocked ---
  console.log('\n=== Tool authorisation ===\n');
  const { invokeTool } = await import('../packages/agent/src/tools.js');
  const run = await prisma.agentRun.findFirstOrThrow({ orderBy: { startedAt: 'desc' } });
  const conversation = await prisma.supportConversation.findFirstOrThrow({
    where: { id: run.conversationId },
  });

  for (const [tool, intent] of [
    ['approve_applicant', 'VERIFICATION_STATUS'],
    ['request_resubmission', 'VERIFICATION_STATUS'],
    ['get_applicant_status', 'VERIFICATION_STATUS'],
  ] as const) {
    const outcome = await invokeTool(
      tool,
      { documentTypes: ['PASSPORT'], reason: 'testing the guardrail' },
      {
        tenantId: tenant.id,
        ticketId: conversation.ticketId,
        conversationId: conversation.id,
        runId: run.id,
        applicantId: rejected.id,
        intent,
        language: 'en',
        policyVersion: 'v1',
      },
    );
    console.log(
      `${tool.padEnd(24)} intent=${intent.padEnd(20)} → ${outcome.status}${
        outcome.status !== 'OK'
          ? `: ${(outcome.output as { reason?: string; error?: string }).reason ?? (outcome.output as { error?: string }).error}`
          : ''
      }`,
    );
  }

  // --- Audit chain ---
  const audits = await prisma.auditLog.count({ where: { tenantId: tenant.id } });
  const invocations = await prisma.toolInvocation.count();
  const events = await prisma.applicantStatusEvent.count();
  console.log(
    `\n=== Records written ===\n  status events: ${events}\n  tool invocations: ${invocations}\n  audit entries: ${audits}`,
  );

  console.log('\nDone.\n');
}

function indent(text: string): string {
  return text
    .split('\n')
    .map((l) => `   ${l}`)
    .join('\n');
}

main()
  .catch((error) => {
    console.error('\nFAILED:', error);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
