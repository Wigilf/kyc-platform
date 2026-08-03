import type { FastifyPluginAsync } from 'fastify';
import {
  CreateApplicantSchema,
  CreateSdkTokenSchema,
  ListApplicantsQuerySchema,
  STATUS_COPY,
  UpdateApplicantSchema,
  UploadDocumentMetaSchema,
  acceptsSubmissions,
  clientMessagesFor,
  encryptJson,
  identityFingerprint,
  invalid,
  notFound,
  outstandingSteps,
  parseLevelSteps,
  transition,
} from '@kyc/core';
import { documentStorageKey } from '@kyc/adapters';
import { prisma } from '@kyc/db';
import { adaptersFor, enqueueVerification } from '@kyc/worker';
import {
  assertOwnRecord,
  requireBackend,
  requireCaller,
  requireRole,
  signToken,
  tenantOf,
  writeAudit,
} from '../auth.js';

/**
 * Applicant lifecycle endpoints.
 *
 * The access model runs through every handler: an applicant token may read and
 * write only its own record and sees only applicant-safe fields; a backend caller
 * sees the operational view. Rather than one endpoint with conditional field
 * stripping, the applicant-facing shape is built by a separate function, so a new
 * field added to the operational view cannot silently leak.
 */

const applicantsRoutes: FastifyPluginAsync = async (app) => {
  // --- Create ---
  app.post('/v1/applicants', async (request, reply) => {
    const caller = requireBackend(request);
    const body = CreateApplicantSchema.parse(request.body);

    const level = await prisma.verificationLevel.findFirst({
      where: { tenantId: caller.tenantId, name: body.levelName, isActive: true },
      orderBy: { version: 'desc' },
    });
    if (!level) throw notFound('Verification level', body.levelName);

    const existing = await prisma.applicant.findUnique({
      where: {
        tenantId_externalUserId: {
          tenantId: caller.tenantId,
          externalUserId: body.externalUserId,
        },
      },
    });
    // Idempotent create: a retried signup must attach to the same applicant, not
    // fork a second identity for the same person.
    if (existing) {
      return reply.status(200).send({ applicant: operationalView(existing), created: false });
    }

    const info = body.info ?? {};
    const piiKey = process.env.PII_ENCRYPTION_KEY;

    const applicant = await prisma.applicant.create({
      data: {
        tenantId: caller.tenantId,
        externalUserId: body.externalUserId,
        levelId: level.id,
        subjectType: body.subjectType as never,
        firstName: info.firstName ?? null,
        lastName: info.lastName ?? null,
        dob: info.dob ? new Date(info.dob) : null,
        country: info.country ?? null,
        nationality: info.nationality ?? null,
        email: info.email ?? body.email ?? null,
        phone: info.phone ?? body.phone ?? null,
        lang: body.lang,
        sourceKey: body.sourceKey ?? null,
        tags: body.tags,
        metadata: body.metadata as never,
        ipAddress: body.ipAddress ?? request.ip,
        userAgent: body.userAgent ?? String(request.headers['user-agent'] ?? ''),
        identityFingerprint: identityFingerprint({
          firstName: info.firstName,
          lastName: info.lastName,
          dob: info.dob,
          country: info.country,
        }),
        // Address and national identifiers are encrypted at rest; only the fields
        // needed for indexed search stay in plaintext columns.
        piiCiphertext:
          piiKey && (info.address || info.taxId)
            ? encryptJson(
                {
                  address: info.address,
                  taxId: info.taxId,
                  placeOfBirth: info.placeOfBirth,
                  occupation: info.occupation,
                  employerName: info.employerName,
                  sourceOfFunds: info.sourceOfFunds,
                },
                piiKey,
              )
            : null,
      },
    });

    await writeAudit(request, {
      action: 'applicant.created',
      resourceType: 'Applicant',
      resourceId: applicant.id,
      after: { externalUserId: applicant.externalUserId, levelName: level.name },
    });

    return reply.status(201).send({ applicant: operationalView(applicant), created: true });
  });

  // --- List (backend only) ---
  app.get('/v1/applicants', async (request) => {
    const caller = requireBackend(request);
    const query = ListApplicantsQuerySchema.parse(request.query);

    const where = {
      tenantId: caller.tenantId,
      ...(query.reviewStatus ? { reviewStatus: query.reviewStatus as never } : {}),
      ...(query.riskLevel ? { riskLevel: query.riskLevel as never } : {}),
      ...(query.country ? { country: query.country } : {}),
      ...(query.tag ? { tags: { has: query.tag } } : {}),
      ...(query.levelName ? { level: { name: query.levelName } } : {}),
      ...(query.createdAfter || query.createdBefore
        ? {
            createdAt: {
              ...(query.createdAfter ? { gte: new Date(query.createdAfter) } : {}),
              ...(query.createdBefore ? { lte: new Date(query.createdBefore) } : {}),
            },
          }
        : {}),
      ...(query.search
        ? {
            OR: [
              { externalUserId: { contains: query.search, mode: 'insensitive' as const } },
              { firstName: { contains: query.search, mode: 'insensitive' as const } },
              { lastName: { contains: query.search, mode: 'insensitive' as const } },
              { email: { contains: query.search, mode: 'insensitive' as const } },
            ],
          }
        : {}),
      // Keyset pagination rather than offset: offsets drift under live inserts,
      // which in a review queue means reviewers see the same applicant twice.
      ...(query.cursor ? { id: { lt: query.cursor } } : {}),
    };

    const applicants = await prisma.applicant.findMany({
      where,
      orderBy: [{ [query.sort]: query.order }, { id: 'desc' }],
      take: query.limit + 1,
      include: { level: { select: { name: true, displayName: true } } },
    });

    const hasMore = applicants.length > query.limit;
    const page = hasMore ? applicants.slice(0, query.limit) : applicants;

    return {
      applicants: page.map((a) => ({
        ...operationalView(a),
        levelName: a.level.name,
        levelDisplayName: a.level.displayName,
      })),
      hasMore,
      nextCursor: hasMore ? page.at(-1)?.id : null,
    };
  });

  // --- Get one ---
  app.get<{ Params: { id: string } }>('/v1/applicants/:id', async (request) => {
    const caller = requireCaller(request);
    assertOwnRecord(caller, request.params.id);

    const applicant = await prisma.applicant.findFirst({
      where: { id: request.params.id, tenantId: caller.tenantId },
      include: {
        level: true,
        documents: {
          select: {
            id: true,
            type: true,
            subType: true,
            status: true,
            country: true,
            expiryDate: true,
            rejectLabels: true,
            createdAt: true,
          },
        },
        checks: {
          orderBy: { createdAt: 'desc' },
          select: {
            id: true,
            type: true,
            status: true,
            result: true,
            score: true,
            rejectLabels: true,
            findings: true,
            provider: true,
            completedAt: true,
          },
        },
        reviews: { orderBy: { createdAt: 'desc' }, take: 5 },
        screeningRuns: { orderBy: { startedAt: 'desc' }, take: 3, include: { hits: true } },
      },
    });
    if (!applicant) throw notFound('Applicant', request.params.id);

    if (caller.kind === 'applicant') {
      return { applicant: applicantView(applicant) };
    }

    await writeAudit(request, {
      action: 'pii.viewed',
      resourceType: 'Applicant',
      resourceId: applicant.id,
    });

    return {
      applicant: {
        ...operationalView(applicant),
        levelName: applicant.level.name,
        documents: applicant.documents,
        checks: applicant.checks,
        reviews: applicant.reviews,
        screening: applicant.screeningRuns.map((r) => ({
          id: r.id,
          trigger: r.trigger,
          status: r.status,
          hitCount: r.hitCount,
          openHitCount: r.openHitCount,
          startedAt: r.startedAt,
          hits: r.hits,
        })),
      },
    };
  });

  // --- Update profile ---
  app.patch<{ Params: { id: string } }>('/v1/applicants/:id', async (request) => {
    const caller = requireCaller(request);
    assertOwnRecord(caller, request.params.id);
    const body = UpdateApplicantSchema.parse(request.body);

    const applicant = await prisma.applicant.findFirstOrThrow({
      where: { id: request.params.id, tenantId: caller.tenantId },
    });

    // Once a decision is made, the identity it rests on is frozen. Corrections go
    // through a data-rectification case so there is a record of who changed what.
    if (!acceptsSubmissions(applicant.reviewStatus as never)) {
      throw invalid(
        `Cannot edit an applicant in state ${applicant.reviewStatus}. Raise a data correction case instead.`,
      );
    }

    const info = body.info ?? {};
    const updated = await prisma.applicant.update({
      where: { id: applicant.id },
      data: {
        ...(info.firstName !== undefined ? { firstName: info.firstName } : {}),
        ...(info.lastName !== undefined ? { lastName: info.lastName } : {}),
        ...(info.dob !== undefined ? { dob: new Date(info.dob) } : {}),
        ...(info.country !== undefined ? { country: info.country } : {}),
        ...(info.nationality !== undefined ? { nationality: info.nationality } : {}),
        ...(info.email !== undefined ? { email: info.email } : {}),
        ...(info.phone !== undefined ? { phone: info.phone } : {}),
        ...(body.tags ? { tags: body.tags } : {}),
        ...(body.metadata ? { metadata: body.metadata as never } : {}),
        identityFingerprint: identityFingerprint({
          firstName: info.firstName ?? applicant.firstName,
          lastName: info.lastName ?? applicant.lastName,
          dob: info.dob ?? applicant.dob,
          country: info.country ?? applicant.country,
        }),
      },
    });

    await writeAudit(request, {
      action: 'applicant.updated',
      resourceType: 'Applicant',
      resourceId: applicant.id,
      before: { firstName: applicant.firstName, lastName: applicant.lastName },
      after: { firstName: updated.firstName, lastName: updated.lastName },
    });

    return { applicant: operationalView(updated) };
  });

  // --- Upload a document ---
  app.post<{ Params: { id: string } }>(
    '/v1/applicants/:id/documents',
    async (request, reply) => {
      const caller = requireCaller(request);
      assertOwnRecord(caller, request.params.id);

      const applicant = await prisma.applicant.findFirstOrThrow({
        where: { id: request.params.id, tenantId: caller.tenantId },
      });
      if (!acceptsSubmissions(applicant.reviewStatus as never)) {
        throw invalid(
          `This applicant cannot accept uploads in state ${applicant.reviewStatus}.`,
        );
      }

      const parts = request.parts();
      let meta: Record<string, string> = {};
      const files: Array<{ buffer: Buffer; filename: string; mimetype: string }> = [];

      for await (const part of parts) {
        if (part.type === 'file') {
          const buffer = await part.toBuffer();
          if (buffer.length === 0) throw invalid('Uploaded file is empty');
          if (buffer.length > 25 * 1024 * 1024) throw invalid('File exceeds the 25MB limit');
          files.push({ buffer, filename: part.filename, mimetype: part.mimetype });
        } else {
          meta[part.fieldname] = String(part.value);
        }
      }

      if (files.length === 0) throw invalid('At least one file is required');
      const parsed = UploadDocumentMetaSchema.parse(meta);

      // A replacement replaces. Without this the previous attempt stays current,
      // and the checks attached to it keep counting against the applicant — so
      // someone who fixes a blurry passport is still judged on the blurry one.
      await prisma.document.updateMany({
        where: {
          applicantId: applicant.id,
          type: parsed.type as never,
          subType: parsed.subType as never,
          status: { not: 'SUPERSEDED' },
        },
        data: { status: 'SUPERSEDED' },
      });

      const document = await prisma.document.create({
        data: {
          applicantId: applicant.id,
          type: parsed.type as never,
          subType: parsed.subType as never,
          country: parsed.country ?? applicant.country,
          number: parsed.number ?? null,
          issuedDate: parsed.issuedDate ? new Date(parsed.issuedDate) : null,
          expiryDate: parsed.expiryDate ? new Date(parsed.expiryDate) : null,
          status: 'UPLOADED',
        },
      });

      const storage = adaptersFor(caller.tenantId).storage;
      for (const [index, file] of files.entries()) {
        const extension = file.filename.split('.').pop()?.toLowerCase() ?? 'jpg';
        const key = documentStorageKey({
          tenantId: caller.tenantId,
          applicantId: applicant.id,
          documentId: document.id,
          side: index === 0 ? parsed.subType : 'BACK_SIDE',
          extension,
        });
        const stored = await storage.put(key, file.buffer, file.mimetype);
        await prisma.documentImage.create({
          data: {
            documentId: document.id,
            storageKey: stored.key,
            contentType: file.mimetype,
            bytes: stored.bytes,
            sha256: stored.sha256,
            side: (index === 0 ? parsed.subType : 'BACK_SIDE') as never,
            capturedBy: parsed.capturedBy as never,
          },
        });
      }

      await writeAudit(request, {
        action: 'document.uploaded',
        resourceType: 'Document',
        resourceId: document.id,
        after: { type: document.type, images: files.length },
      });

      return reply.status(201).send({
        document: { id: document.id, type: document.type, status: document.status },
        images: files.length,
      });
    },
  );

  // --- Submit for verification ---
  app.post<{ Params: { id: string } }>('/v1/applicants/:id/submit', async (request) => {
    const caller = requireCaller(request);
    assertOwnRecord(caller, request.params.id);

    const applicant = await prisma.applicant.findFirstOrThrow({
      where: { id: request.params.id, tenantId: caller.tenantId },
      include: { level: true, documents: true },
    });

    const resubmission = applicant.reviewStatus === 'REJECTED_RETRY';
    // Legality of the transition is decided by the state machine, not by the
    // handler guessing — an illegal submit throws with the allowed states listed.
    const next = transition(
      applicant.reviewStatus as never,
      resubmission ? 'APPLICANT_RESUBMITTED' : 'APPLICANT_SUBMITTED',
      { actorType: caller.kind === 'applicant' ? 'APPLICANT' : 'API' },
    );

    await prisma.$transaction([
      prisma.applicant.update({
        where: { id: applicant.id },
        data: {
          reviewStatus: next.to as never,
          status: next.applicantStatus as never,
          submittedAt: applicant.submittedAt ?? new Date(),
        },
      }),
      prisma.applicantStatusEvent.create({
        data: {
          applicantId: applicant.id,
          fromStatus: next.from as never,
          toStatus: next.to as never,
          reason: resubmission ? 'Applicant resubmitted' : 'Applicant submitted for verification',
          actorType: caller.kind === 'applicant' ? 'APPLICANT' : 'API',
        },
      }),
    ]);

    await enqueueVerification({
      tenantId: caller.tenantId,
      applicantId: applicant.id,
      trigger: resubmission ? 'RESUBMITTED' : 'SUBMITTED',
    });

    await writeAudit(request, {
      action: 'applicant.submitted',
      resourceType: 'Applicant',
      resourceId: applicant.id,
    });

    return { status: next.to, queued: true };
  });

  // --- Requirements (what is still outstanding) ---
  app.get<{ Params: { id: string } }>('/v1/applicants/:id/requirements', async (request) => {
    const caller = requireCaller(request);
    assertOwnRecord(caller, request.params.id);

    const applicant = await prisma.applicant.findFirstOrThrow({
      where: { id: request.params.id, tenantId: caller.tenantId },
      include: { level: true, documents: true },
    });

    const steps = parseLevelSteps(applicant.level.steps);
    const usable = new Set(
      applicant.documents
        .filter((d) => d.status !== 'REJECTED' && d.status !== 'SUPERSEDED')
        .map((d) => d.type),
    );
    const completed = new Set(
      steps
        .filter((s) =>
          (s.config.acceptedDocumentTypes ?? []).some((t) => usable.has(t as never)),
        )
        .map((s) => s.id),
    );

    return {
      levelName: applicant.level.name,
      status: applicant.reviewStatus,
      outstanding: outstandingSteps(steps, completed).map((s) => ({
        id: s.id,
        type: s.type,
        label: s.label ?? s.type,
        acceptedDocumentTypes: s.config.acceptedDocumentTypes ?? [],
        requireBothSides: s.config.requireBothSides ?? false,
      })),
      allSteps: steps.map((s) => ({
        id: s.id,
        type: s.type,
        required: s.required,
        satisfied: completed.has(s.id),
      })),
    };
  });

  // --- SDK access token (backend mints, browser holds) ---
  app.post('/v1/sdk/tokens', async (request) => {
    const caller = requireBackend(request);
    const body = CreateSdkTokenSchema.parse(request.body);

    const level = await prisma.verificationLevel.findFirst({
      where: { tenantId: caller.tenantId, name: body.levelName, isActive: true },
      orderBy: { version: 'desc' },
    });
    if (!level) throw notFound('Verification level', body.levelName);

    const applicant = await prisma.applicant.upsert({
      where: {
        tenantId_externalUserId: {
          tenantId: caller.tenantId,
          externalUserId: body.externalUserId,
        },
      },
      create: {
        tenantId: caller.tenantId,
        externalUserId: body.externalUserId,
        levelId: level.id,
      },
      update: {},
    });

    return {
      token: signToken(
        {
          sub: applicant.id,
          kind: 'applicant',
          tenantId: caller.tenantId,
          externalUserId: body.externalUserId,
        },
        body.ttlSeconds,
      ),
      applicantId: applicant.id,
      expiresInSeconds: body.ttlSeconds,
      levelName: level.name,
    };
  });

  // --- Reset (privileged: wipes verification state, keeps the identity) ---
  app.post<{ Params: { id: string } }>('/v1/applicants/:id/reset', async (request) => {
    const user = requireRole(request, 'ADMIN');
    const applicant = await prisma.applicant.findFirstOrThrow({
      where: { id: request.params.id, tenantId: user.tenantId },
    });

    const next = transition(applicant.reviewStatus as never, 'RESET_BY_ADMIN', {
      actorType: 'USER',
      actorRole: user.role,
    });

    await prisma.$transaction([
      prisma.applicant.update({
        where: { id: applicant.id },
        data: {
          reviewStatus: next.to as never,
          status: 'INIT',
          riskScore: 0,
          riskLevel: 'LOW',
          reviewedAt: null,
          submittedAt: null,
        },
      }),
      prisma.check.deleteMany({ where: { applicantId: applicant.id } }),
      prisma.document.updateMany({
        where: { applicantId: applicant.id },
        data: { status: 'SUPERSEDED' },
      }),
      prisma.applicantStatusEvent.create({
        data: {
          applicantId: applicant.id,
          fromStatus: applicant.reviewStatus as never,
          toStatus: next.to as never,
          reason: 'Reset by administrator',
          actorType: 'USER',
          actorId: user.userId,
        },
      }),
    ]);

    await writeAudit(request, {
      action: 'applicant.reset',
      resourceType: 'Applicant',
      resourceId: applicant.id,
      before: { reviewStatus: applicant.reviewStatus },
    });

    return { status: next.to, reset: true };
  });
};

/** Operational view: what a backend caller or dashboard sees. */
function operationalView(applicant: {
  id: string;
  externalUserId: string;
  status: string;
  reviewStatus: string;
  riskScore: number;
  riskLevel: string;
  ddLevel: string;
  firstName: string | null;
  lastName: string | null;
  country: string | null;
  email: string | null;
  tags: string[];
  createdAt: Date;
  updatedAt: Date;
  reviewedAt: Date | null;
  submittedAt: Date | null;
}) {
  return {
    id: applicant.id,
    externalUserId: applicant.externalUserId,
    status: applicant.status,
    reviewStatus: applicant.reviewStatus,
    riskScore: applicant.riskScore,
    riskLevel: applicant.riskLevel,
    ddLevel: applicant.ddLevel,
    firstName: applicant.firstName,
    lastName: applicant.lastName,
    country: applicant.country,
    email: applicant.email,
    tags: applicant.tags,
    createdAt: applicant.createdAt,
    updatedAt: applicant.updatedAt,
    submittedAt: applicant.submittedAt,
    reviewedAt: applicant.reviewedAt,
  };
}

/**
 * Applicant-facing view.
 *
 * Built additively — only these fields are ever returned — so a field added to
 * the operational view above cannot leak here by omission.
 */
function applicantView(applicant: {
  id: string;
  reviewStatus: string;
  level: { name: string; displayName: string };
  documents: Array<{ id: string; type: string; status: string; rejectLabels: string[] }>;
  reviews: Array<{ decision: string; rejectLabels: string[]; clientComment: string | null }>;
}) {
  const copy = STATUS_COPY[applicant.reviewStatus as keyof typeof STATUS_COPY];
  const latest = applicant.reviews[0];

  return {
    id: applicant.id,
    reviewStatus: applicant.reviewStatus,
    statusTitle: copy?.title,
    statusDetail: copy?.detail,
    levelName: applicant.level.name,
    levelDisplayName: applicant.level.displayName,
    canResubmit: acceptsSubmissions(applicant.reviewStatus as never),
    documents: applicant.documents.map((d) => ({
      id: d.id,
      type: d.type,
      status: d.status,
      // Applicant-safe wording, never the internal label codes.
      issues: clientMessagesFor(d.rejectLabels),
    })),
    decision: latest
      ? {
          decision: latest.decision,
          comment: latest.clientComment,
          reasons: clientMessagesFor(latest.rejectLabels),
        }
      : null,
  };
}

export default applicantsRoutes;
