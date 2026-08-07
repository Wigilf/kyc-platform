import type { FastifyPluginAsync } from 'fastify';
import {
  APPLICANT_FACING_STEPS,
  CreateApplicantSchema,
  CreateSdkTokenSchema,
  DEFAULT_REQUIRED_APPLICANT_FIELDS,
  ListApplicantsQuerySchema,
  NfcSubmissionSchema,
  PII_BLOB_FIELDS,
  STATUS_COPY,
  UpdateApplicantSchema,
  UploadDocumentMetaSchema,
  acceptsSubmissions,
  clientMessagesFor,
  decryptJson,
  documentTypesForStep,
  encryptJson,
  identityFingerprint,
  invalid,
  missingApplicantFields,
  notFound,
  outstandingSteps,
  parseLevelSteps,
  stepLabel,
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
            // What the reader extracted, so a reviewer can compare the document
            // against what the applicant declared without leaving the case.
            extracted: true,
            // Storage keys, so the console can presign and display the images.
            // Operational view only — `applicantView` builds the applicant's
            // response separately and never sees this.
            images: {
              select: { id: true, storageKey: true, side: true, contentType: true },
              orderBy: { createdAt: 'asc' },
            },
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

    // The sealed fields have to be merged, not overwritten: the blob is one
    // ciphertext, so re-encrypting only what this request sent would silently
    // drop everything the applicant supplied earlier. These were accepted by the
    // schema and then dropped entirely, so an address sent here returned 200 and
    // went nowhere — which also left the standard level's address requirement
    // impossible to satisfy through the API.
    const piiKey = process.env.PII_ENCRYPTION_KEY;
    const sealedUpdates = {
      ...(info.address !== undefined ? { address: info.address } : {}),
      ...(info.taxId !== undefined ? { taxId: info.taxId } : {}),
      ...(info.placeOfBirth !== undefined ? { placeOfBirth: info.placeOfBirth } : {}),
      ...(info.occupation !== undefined ? { occupation: info.occupation } : {}),
      ...(info.employerName !== undefined ? { employerName: info.employerName } : {}),
      ...(info.sourceOfFunds !== undefined ? { sourceOfFunds: info.sourceOfFunds } : {}),
    };
    let piiCiphertext: string | undefined;
    if (piiKey && Object.keys(sealedUpdates).length > 0) {
      let existing: Record<string, unknown> = {};
      if (applicant.piiCiphertext) {
        try {
          existing = decryptJson<Record<string, unknown>>(applicant.piiCiphertext, piiKey);
        } catch {
          // An unreadable blob is not a reason to refuse new data; the new values
          // are written and the unreadable remainder is lost either way.
        }
      }
      piiCiphertext = encryptJson({ ...existing, ...sealedUpdates }, piiKey);
    }

    const updated = await prisma.applicant.update({
      where: { id: applicant.id },
      data: {
        ...(piiCiphertext !== undefined ? { piiCiphertext } : {}),
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

      // One row per physical document; the sides are images on it.
      //
      // This used to create a document per upload, keyed by type *and* side, so
      // a passport arrived as two unrelated documents. The pipeline picks one
      // document per step with `.find()`, so it examined whichever side came
      // back first and left the other sitting at UPLOADED forever — on a real
      // passport that is a coin toss between reading the data page and reading
      // a blank back cover and calling the document unreadable.
      const existing = await prisma.document.findFirst({
        where: {
          applicantId: applicant.id,
          type: parsed.type as never,
          status: { notIn: ['SUPERSEDED', 'REJECTED'] },
        },
        orderBy: { createdAt: 'desc' },
      });

      const document = existing
        ? await prisma.document.update({
            where: { id: existing.id },
            data: {
              // Back to unexamined: a document with a new side is a new document
              // as far as the checks are concerned, and leaving it EXTRACTED
              // would let the old verdict stand over the new evidence.
              status: 'UPLOADED',
              rejectLabels: [],
              country: parsed.country ?? existing.country,
              number: parsed.number ?? existing.number,
              ...(parsed.issuedDate ? { issuedDate: new Date(parsed.issuedDate) } : {}),
              ...(parsed.expiryDate ? { expiryDate: new Date(parsed.expiryDate) } : {}),
            },
          })
        : await prisma.document.create({
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

      // Re-uploading one side replaces that side and leaves the others alone.
      // Superseding the whole document here would silently discard the back of
      // a card because the front was retaken.
      const replacedSides = new Set(
        files.map((_, index) => (index === 0 ? parsed.subType : 'BACK_SIDE')),
      );
      await prisma.documentImage.deleteMany({
        where: { documentId: document.id, side: { in: [...replacedSides] as never[] } },
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
      include: { level: true, documents: { include: { images: { select: { side: true } } } } },
    });

    const steps = parseLevelSteps(applicant.level.steps);
    const live = applicant.documents.filter(
      (d) => d.status !== 'REJECTED' && d.status !== 'SUPERSEDED',
    );
    const usable = new Set(live.map((d) => d.type as string));
    /** Types for which both sides are actually present, not just one. */
    const bothSides = new Set(
      live
        .filter((d) => {
          const sides = new Set(d.images.map((i) => i.side as string));
          return sides.has('FRONT_SIDE') && sides.has('BACK_SIDE');
        })
        .map((d) => d.type as string),
    );

    // Address and the other sealed fields only need unsealing if a step asks
    // for one of them.
    const declared: Record<string, unknown> = {
      firstName: applicant.firstName,
      lastName: applicant.lastName,
      dob: applicant.dob,
      country: applicant.country,
      nationality: applicant.nationality,
      email: applicant.email,
      phone: applicant.phone,
    };
    const needsPii = steps.some((s) =>
      (s.config.requiredFields ?? DEFAULT_REQUIRED_APPLICANT_FIELDS).some((f) =>
        PII_BLOB_FIELDS.includes(f),
      ),
    );
    if (needsPii && applicant.piiCiphertext && process.env.PII_ENCRYPTION_KEY) {
      try {
        Object.assign(
          declared,
          decryptJson<Record<string, unknown>>(
            applicant.piiCiphertext,
            process.env.PII_ENCRYPTION_KEY,
          ),
        );
      } catch {
        // Unreadable is not the same as unsupplied; the missing-field path reports it.
      }
    }

    const isSatisfied = (s: (typeof steps)[number]): boolean => {
      if (s.type === 'APPLICANT_DATA') {
        const required = s.config.requiredFields ?? DEFAULT_REQUIRED_APPLICANT_FIELDS;
        return missingApplicantFields(required, declared).length === 0;
      }
      const accepted = documentTypesForStep(s);
      // A step no document can satisfy is not satisfied by having none.
      if (accepted.length === 0) return false;
      // A level that asks for both sides is not satisfied by one. It used to be:
      // satisfaction was computed from document type alone, so an ID card was
      // complete the moment its front arrived, and only the widget's own
      // bookkeeping kept asking for the back.
      const needed = s.config.requireBothSides ? bothSides : usable;
      return accepted.some((t) => needed.has(t));
    };

    const completed = new Set(steps.filter(isSatisfied).map((s) => s.id));

    // What the applicant already told us, handed back so a correction is a
    // correction and not a retype. Only ever to the holder of this applicant's
    // own record — assertOwnRecord above — and only the fields a form collects.
    const address = declared.address as Record<string, unknown> | null | undefined;
    const supplied: Record<string, string> = {};
    for (const [field, value] of [
      ['firstName', declared.firstName],
      ['lastName', declared.lastName],
      ['dob', applicant.dob ? applicant.dob.toISOString().slice(0, 10) : null],
      ['country', declared.country],
      ['nationality', declared.nationality],
      ['email', declared.email],
      ['phone', declared.phone],
      ['addressLine1', address?.line1],
      ['addressCity', address?.city],
      ['addressPostCode', address?.postCode],
    ] as const) {
      if (typeof value === 'string' && value) supplied[field] = value;
    }

    return {
      levelName: applicant.level.name,
      status: applicant.reviewStatus,
      applicantData: supplied,
      // The widget shows this to the applicant. Someone being asked to
      // photograph their passport is entitled to know whether anything will
      // actually examine it.
      simulated: (process.env.ADAPTER_MODE ?? 'mock') !== 'live',
      outstanding: outstandingSteps(steps, completed).map((s) => ({
        id: s.id,
        type: s.type,
        label: stepLabel(s),
        acceptedDocumentTypes: documentTypesForStep(s),
        requireBothSides: s.config.requireBothSides ?? false,
      })),
      allSteps: steps.map((s) => ({
        id: s.id,
        type: s.type,
        label: stepLabel(s),
        required: s.required,
        satisfied: completed.has(s.id),
        // Carried for every step, not only outstanding ones, so an applicant can
        // go back and replace something they have already supplied.
        acceptedDocumentTypes: documentTypesForStep(s),
        requireBothSides: s.config.requireBothSides ?? false,
        // Screening and device intelligence are things we do, not things the
        // applicant does. A progress list that shows them leaves the applicant
        // looking at boxes they can never tick.
        applicantFacing: APPLICANT_FACING_STEPS.has(s.type),
      })),
    };
  });

  /**
   * Chip data from a mobile app, verified against the issuing state.
   *
   * Separate from the document upload because it is a different kind of
   * evidence entirely. An uploaded photograph is something we form an opinion
   * about; a chip read is something a government signed. The applicant's phone
   * does the reading — a browser cannot hold that conversation with a chip —
   * and the verdict is reached here, because the trust store and the decision
   * belong on a server the applicant does not control.
   */
  app.post<{ Params: { id: string } }>('/v1/applicants/:id/nfc', async (request, reply) => {
    const caller = requireCaller(request);
    assertOwnRecord(caller, request.params.id);

    const body = NfcSubmissionSchema.parse(request.body);

    const applicant = await prisma.applicant.findFirstOrThrow({
      where: { id: request.params.id, tenantId: caller.tenantId },
    });
    if (!acceptsSubmissions(applicant.reviewStatus as never)) {
      throw invalid(`Cannot add a chip read to an applicant in state ${applicant.reviewStatus}.`);
    }

    const adapters = adaptersFor(caller.tenantId);

    // Never a simulated answer here.
    //
    // A simulated document read is a defensible thing to show in a demo: it is
    // labelled, and everyone understands a photograph is being judged. A
    // simulated *chip* verification is not, because the entire value of this
    // check is that it cannot be faked — and the simulation cheerfully returned
    // passiveAuthPassed for a payload of nonsense, including claiming the clone
    // check had passed. An endpoint that answers "the issuing state vouches for
    // this" when no state was consulted is worse than no endpoint.
    if (adapters.nfc.name !== 'icao-passive-auth') {
      return reply.code(501).send({
        error: 'CHIP_VERIFICATION_NOT_CONFIGURED',
        message:
          'Chip verification is not enabled on this deployment. It requires CSCA_DIR to ' +
          'point at trusted country signing certificates; without them nothing can be ' +
          'verified, and this endpoint will not return a simulated verdict.',
      });
    }

    const result = await adapters.nfc.read(
      {
        dataGroups: body.dataGroups,
        documentNumber: body.documentNumber,
        dateOfBirth: body.dateOfBirth,
        dateOfExpiry: body.dateOfExpiry,
      },
      { tenantId: caller.tenantId, applicantId: applicant.id, requestId: request.id },
    );

    if (!result.ok || !result.data) {
      // The read could not be evaluated. Recorded as our failure rather than
      // the applicant's, the same way an unreachable provider would be.
      await prisma.check.create({
        data: {
          applicantId: applicant.id,
          type: 'NFC_CHIP',
          status: 'FAILED',
          provider: result.provider,
          errorCode: result.error?.code,
          errorMessage: result.error?.message,
        },
      });
      return reply.code(422).send({
        error: result.error?.code ?? 'NFC_READ_FAILED',
        message: result.error?.message ?? 'The chip read could not be verified.',
      });
    }

    const passed = result.data.passiveAuthPassed;
    await prisma.check.create({
      data: {
        applicantId: applicant.id,
        type: 'NFC_CHIP',
        status: 'COMPLETED',
        result: passed ? 'PASS' : 'FAIL',
        score: passed ? 100 : 0,
        rejectLabels: passed ? [] : ['CHIP_AUTHENTICATION_FAILED'],
        riskContribution: passed ? 0 : 60,
        provider: result.provider,
        providerRef: result.providerRef,
        findings: result.data.findings as never,
        raw: result.raw as never,
      },
    });

    await writeAudit(request, {
      action: 'applicant.chip_verified',
      resourceType: 'Applicant',
      resourceId: applicant.id,
      after: { passiveAuthPassed: passed, chainValid: result.data.certificateChainValid },
    });

    return {
      passiveAuthPassed: passed,
      certificateChainValid: result.data.certificateChainValid,
      // Never `false`: passive authentication cannot detect a cloned chip, and
      // reporting an unanswered question as answered is how a clone gets in.
      activeAuthPassed: result.data.activeAuthPassed,
      findings: result.data.findings,
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
