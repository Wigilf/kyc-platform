import {
  assessRisk,
  buildApplicantFacts,
  calculateAge,
  daysUntil,
  decryptJson,
  deriveRiskFactors,
  docNumberHash,
  evaluateRules,
  identityFingerprint,
  isCountryAllowedForLevel,
  isFinalRejection,
  nameSimilarity,
  parseLevelSteps,
  parseMrz,
  planSteps,
  riskWeightFor,
  summarizeActions,
  toDateOnly,
  type ApplicantSnapshot,
  type RiskFactor,
  type StepDefinition,
  hasMachineReadableZone,
} from '@kyc/core';
import { cosineSimilarity, embeddingBucket } from '@kyc/adapters';
import { appendAuditEntry, prisma } from '@kyc/db';
import { adaptersFor, loadRules } from './context.js';
import { emitEvent } from './webhooks.js';
import { runScreening } from './screening.js';
import type { VerificationJob } from './queues.js';

/**
 * The verification pipeline.
 *
 * Shape: plan the level's steps into waves → run each wave's checks concurrently
 * → assemble facts → score risk → evaluate rules → decide or queue.
 *
 * Two rules govern everything here:
 *
 *  1. **A provider failure is not a verdict.** If OCR times out, the check is
 *     FAILED (retryable infrastructure state), never FAIL (a finding about the
 *     applicant). Conflating the two is how a vendor outage turns into a wave of
 *     wrongful rejections.
 *  2. **Absence of evidence is not evidence.** A check that did not complete
 *     leaves the applicant un-decidable, not approvable. The auto-approve rule
 *     requires every required step to have completed *and* passed.
 */

export async function runVerificationPipeline(job: VerificationJob): Promise<{
  applicantId: string;
  reviewStatus: string;
  riskScore: number;
  checksRun: number;
  decided: boolean;
}> {
  const applicant = await prisma.applicant.findFirstOrThrow({
    where: { id: job.applicantId, tenantId: job.tenantId },
    include: {
      level: true,
      documents: { include: { images: true }, orderBy: { createdAt: 'desc' } },
      devices: { orderBy: { createdAt: 'desc' }, take: 1 },
    },
  });

  const adapters = adaptersFor(job.tenantId);
  const steps = parseLevelSteps(applicant.level.steps);

  await prisma.applicant.update({
    where: { id: applicant.id },
    data: { status: 'PROCESSING' },
  });

  // Country gating is a hard stop evaluated before any provider is called: there
  // is no point paying for OCR on an applicant we cannot onboard.
  const gate = isCountryAllowedForLevel(applicant.country, {
    allowedCountries: applicant.level.allowedCountries,
    blockedCountries: applicant.level.blockedCountries,
  });
  if (!gate.allowed) {
    await recordCheck(applicant.id, null, {
      type: 'SANCTIONED_COUNTRY',
      status: 'COMPLETED',
      result: 'FAIL',
      rejectLabels: ['PROHIBITED_COUNTRY'],
      findings: [{ code: 'COUNTRY_BLOCKED', severity: 'CRITICAL', message: gate.reason ?? '' }],
      riskContribution: 100,
      provider: 'internal',
    });
    return finalize(applicant.id, job.tenantId, {
      forceReject: ['PROHIBITED_COUNTRY'],
      checksRun: 1,
    });
  }

  const waves = planSteps({ steps });
  let checksRun = 0;

  for (const wave of waves) {
    // Steps in the same wave are independent by construction, so run them
    // together; sequencing them would triple the applicant's wait for nothing.
    const results = await Promise.allSettled(
      wave.map((step) => runStep(step, applicant, adapters, job)),
    );
    for (const [i, result] of results.entries()) {
      if (result.status === 'fulfilled') {
        checksRun += result.value;
      } else {
        const step = wave[i]!;
        // Record the failure as an incomplete check so the applicant stays
        // un-decided rather than being decided on missing evidence.
        await recordCheck(applicant.id, null, {
          type: checkTypeForStep(step),
          status: 'FAILED',
          errorCode: 'PIPELINE_ERROR',
          errorMessage:
            result.reason instanceof Error ? result.reason.message : 'step threw',
          provider: 'internal',
        });
      }
    }
  }

  return finalize(applicant.id, job.tenantId, { checksRun });
}

type ApplicantWithRelations = Awaited<
  ReturnType<
    typeof prisma.applicant.findFirstOrThrow<{
      include: {
        level: true;
        documents: { include: { images: true } };
        devices: true;
      };
    }>
  >
>;

function checkTypeForStep(step: StepDefinition): string {
  switch (step.type) {
    case 'IDENTITY_DOCUMENT':
      return 'DOCUMENT_OCR';
    case 'SELFIE':
      return 'FACE_MATCH';
    case 'LIVENESS':
      return 'LIVENESS';
    case 'AML_SCREENING':
      return 'AML_SCREENING';
    case 'DEVICE_INTELLIGENCE':
      return 'DEVICE_FINGERPRINT';
    case 'PROOF_OF_ADDRESS':
      return 'PROOF_OF_ADDRESS';
    case 'NFC_READ':
      return 'NFC_CHIP';
    case 'AGE_ESTIMATION':
      return 'AGE_ESTIMATION';
    case 'PHONE_VERIFICATION':
      return 'PHONE_RISK';
    case 'EMAIL_VERIFICATION':
      return 'EMAIL_RISK';
    case 'WALLET_OWNERSHIP':
      return 'WALLET_SCREENING';
    case 'COMPANY_DATA':
      return 'COMPANY_REGISTRY';
    case 'APPLICANT_DATA':
      return 'APPLICANT_DATA';
    default:
      return 'MANUAL';
  }
}

/** Runs one step; returns the number of checks recorded. */
async function runStep(
  step: StepDefinition,
  applicant: ApplicantWithRelations,
  adapters: ReturnType<typeof adaptersFor>,
  job: VerificationJob,
): Promise<number> {
  const ctx = {
    tenantId: job.tenantId,
    applicantId: applicant.id,
    // Seeding on the applicant makes mock results stable for a given applicant
    // across reruns, which is what makes the demo and the tests reproducible.
    seed: `${applicant.id}:${applicant.firstName ?? ''}${applicant.lastName ?? ''}`,
  };

  switch (step.type) {
    case 'IDENTITY_DOCUMENT':
      return runDocumentStep(step, applicant, adapters, ctx);
    case 'LIVENESS':
      return runLivenessStep(step, applicant, adapters, ctx);
    case 'SELFIE':
      return runFaceMatchStep(step, applicant, adapters, ctx);
    case 'AML_SCREENING':
      await runScreening({
        tenantId: job.tenantId,
        applicantId: applicant.id,
        trigger: job.trigger === 'RESUBMITTED' ? 'RESUBMISSION' : 'INITIAL',
        listTypes: step.config.listTypes ?? ['SANCTIONS', 'PEP'],
        fuzziness: step.config.fuzziness ?? 0.75,
      });
      return 1;
    case 'DEVICE_INTELLIGENCE':
      return runDeviceStep(applicant, adapters, ctx);
    case 'EMAIL_VERIFICATION':
    case 'PHONE_VERIFICATION':
      return runContactStep(step, applicant, adapters, ctx);
    case 'PROOF_OF_ADDRESS':
      return runProofOfAddressStep(step, applicant, adapters, ctx);
    case 'APPLICANT_DATA':
      return runApplicantDataStep(step, applicant);
    case 'NFC_READ':
      return runChipStep(step, applicant);
    default:
      // Steps with no automated component — a video interview, a wet
      // signature — are recorded so the audit shows they were considered.
      //
      // And if the level marked the step *required*, that is recorded as
      // outstanding rather than merely noted. It used to be noted: a skipped
      // check with an INFO finding and no label, which contributes nothing, so
      // an applicant could be approved automatically while a step the level
      // demanded had simply never happened. A step that did not run is not a
      // step that passed — the same mistake as a check reporting success when
      // nothing was checked.
      await recordCheck(applicant.id, null, {
        type: 'MANUAL',
        status: 'SKIPPED',
        result: step.required ? 'INCONCLUSIVE' : undefined,
        rejectLabels: step.required ? ['REQUIRED_STEP_NOT_PERFORMED'] : [],
        provider: 'internal',
        findings: [
          {
            code: 'NO_AUTOMATED_CHECK',
            severity: step.required ? ('MEDIUM' as const) : ('INFO' as const),
            message: step.required
              ? `Step ${step.id} (${step.type}) is required and has no automated check, so a person must complete it.`
              : `Step ${step.id} (${step.type}) has no automated check.`,
          },
        ],
      });
      return 1;
  }
}

/**
 * The chip, if one has been read.
 *
 * Reading it happens on a phone and arrives separately, through
 * `POST /v1/applicants/:id/nfc`. This step's job is only to notice whether it
 * did — and to say so when a level asked for a chip and none came, rather than
 * letting the requirement evaporate.
 */
async function runChipStep(
  step: StepDefinition,
  applicant: ApplicantWithRelations,
): Promise<number> {
  // Read from the database rather than from the loaded applicant: the chip
  // read arrives on its own endpoint, possibly while this pipeline run is
  // already under way, and the relation was loaded before that.
  const chip = await prisma.check.findFirst({
    where: { applicantId: applicant.id, type: 'NFC_CHIP', status: 'COMPLETED' },
    select: { id: true },
  });

  if (chip) {
    // Already recorded by the endpoint, with the verdict and the findings. Not
    // re-run here: the phone is gone and the chip with it.
    return 0;
  }

  await recordCheck(applicant.id, null, {
    type: 'NFC_CHIP',
    status: 'SKIPPED',
    result: step.required ? 'INCONCLUSIVE' : undefined,
    rejectLabels: step.required ? ['REQUIRED_STEP_NOT_PERFORMED'] : [],
    provider: 'internal',
    findings: [
      {
        code: 'CHIP_NOT_READ',
        severity: step.required ? ('MEDIUM' as const) : ('INFO' as const),
        message: step.required
          ? 'This level requires the document chip to be read, and no chip read has been submitted.'
          : 'No chip read was submitted. Optional for this level.',
      },
    ],
  });
  return 1;
}

async function runDocumentStep(
  step: StepDefinition,
  applicant: ApplicantWithRelations,
  adapters: ReturnType<typeof adaptersFor>,
  ctx: { tenantId: string; applicantId: string; seed: string },
): Promise<number> {
  const accepted = step.config.acceptedDocumentTypes ?? [
    'PASSPORT',
    'ID_CARD',
    'DRIVERS_LICENSE',
  ];
  const document = applicant.documents.find(
    (d) => accepted.includes(d.type as never) && d.status !== 'SUPERSEDED',
  );

  if (!document) {
    await recordCheck(applicant.id, null, {
      type: 'DOCUMENT_OCR',
      status: 'SKIPPED',
      result: 'INCONCLUSIVE',
      rejectLabels: step.required ? ['ADDITIONAL_DOCUMENTS_REQUIRED'] : [],
      provider: 'internal',
      findings: [
        {
          code: 'DOCUMENT_MISSING',
          severity: step.required ? 'HIGH' : 'INFO',
          message: `No document of an accepted type (${accepted.join(', ')}) has been uploaded.`,
        },
      ],
    });
    return 1;
  }

  let count = 0;

  // --- OCR ---
  const ocr = await adapters.ocr.extract(
    {
      images: document.images.map((i) => ({
        storageKey: i.storageKey,
        contentType: i.contentType,
        side: i.side as 'FRONT_SIDE' | 'BACK_SIDE' | 'PAGE',
      })),
      documentType: document.type,
      expectedCountry: document.country ?? applicant.country ?? undefined,
    },
    ctx,
  );
  count++;

  if (!ocr.ok || !ocr.data) {
    await recordCheck(applicant.id, document.id, {
      type: 'DOCUMENT_OCR',
      // FAILED, not FAIL: this is our problem, not the applicant's.
      status: 'FAILED',
      errorCode: ocr.error?.code,
      errorMessage: ocr.error?.message,
      provider: ocr.provider,
      raw: ocr.raw,
    });
    return count;
  }

  const extracted = ocr.data;
  const qualityLabels: string[] = [];
  if (extracted.quality.sharpness < 0.4) qualityLabels.push('BLURRY_IMAGE');
  if (extracted.quality.glare > 0.6) qualityLabels.push('GLARE_OR_REFLECTION');
  if (!extracted.quality.fullDocumentVisible) qualityLabels.push('DOCUMENT_CROPPED');
  if (extracted.quality.screenCaptureSuspected) qualityLabels.push('SCREENSHOT_OR_SCREEN_PHOTO');
  if (!extracted.quality.isColour) qualityLabels.push('BLACK_AND_WHITE');

  // --- MRZ validation, independent of the provider's own opinion ---
  const mrz = extracted.mrz ? parseMrz(extracted.mrz) : null;
  if (mrz) {
    await recordCheck(applicant.id, document.id, {
      type: 'MRZ_VALIDATION',
      status: 'COMPLETED',
      result: mrz.valid ? 'PASS' : 'FAIL',
      score: mrz.valid ? 100 : 0,
      rejectLabels: mrz.valid ? [] : ['MRZ_CHECKSUM_FAILED'],
      riskContribution: mrz.valid ? 0 : 40,
      provider: 'internal-mrz',
      findings: [
        ...mrz.errors.map((e) => ({ code: 'MRZ_ERROR', severity: 'HIGH' as const, message: e })),
        ...mrz.warnings.map((w) => ({ code: 'MRZ_WARNING', severity: 'LOW' as const, message: w })),
      ],
      raw: { checkDigits: mrz.checkDigits, format: mrz.format },
    });
    count++;
  }

  // Prefer MRZ values over printed OCR when both exist: the MRZ is self-checking.
  const dob = mrz?.fields?.dateOfBirth ?? extracted.fields.dob ?? null;
  const expiry = mrz?.fields?.dateOfExpiry ?? extracted.fields.expiryDate ?? null;
  const number = mrz?.fields?.documentNumber ?? extracted.fields.documentNumber ?? null;

  const expiryDays = daysUntil(expiry);
  const validityLabels: string[] = [];
  if (expiryDays !== null && expiryDays < 0) validityLabels.push('DOCUMENT_EXPIRED');
  else if (
    expiryDays !== null &&
    step.config.minValidityDays &&
    expiryDays < step.config.minValidityDays
  ) {
    validityLabels.push('DOCUMENT_EXPIRING_SOON');
  }

  const age = calculateAge(dob);
  if (step.config.minAge && age !== null && age < step.config.minAge) {
    validityLabels.push('UNDERAGE');
  }

  // Declared vs extracted identity.
  const declaredName = [applicant.firstName, applicant.lastName].filter(Boolean).join(' ');
  const docName = [extracted.fields.firstName, extracted.fields.lastName]
    .filter(Boolean)
    .join(' ');
  const similarity = declaredName && docName ? nameSimilarity(declaredName, docName) : null;
  const mismatchLabels: string[] = [];
  if (similarity !== null && similarity < 0.85) mismatchLabels.push('NAME_MISMATCH');
  if (dob && applicant.dob && toDateOnly(applicant.dob) !== dob) mismatchLabels.push('DOB_MISMATCH');

  // Nothing read is not the same as nothing wrong.
  //
  // Every label above describes a comparison that failed. A document the reader
  // could make no sense of produces none of them — no name to mismatch, no date
  // to check, no expiry to be past — and so used to come out the other side as a
  // pass. With a simulated reader that never happened, because it always
  // returned a plausible document; with a real one it is the normal outcome for
  // a photo of a cat.
  const readableLabels: string[] = [];
  const readAnything = Boolean(number || dob || docName);
  if (!readAnything) {
    // Two different facts. A passport that could not be read is a bad
    // photograph and the applicant can fix it. A utility bill was never going
    // to be machine-read at all, and telling its owner to retake it sends them
    // round a loop that cannot end. Neither is approved without a person
    // looking, which is what a label with no risk weight achieves.
    readableLabels.push(
      hasMachineReadableZone(document.type) ? 'DOCUMENT_UNREADABLE' : 'NOT_MACHINE_READABLE',
    );
  } else if (extracted.findings.some((f) => f.code === 'MRZ_INCOMPLETE')) {
    readableLabels.push('MRZ_INCOMPLETE');
  }
  // A name we could not compare is a name we did not verify. Only applies once
  // something was read, so an unreadable document reports the clearer label.
  if (readAnything && declaredName && !docName) readableLabels.push('OBSCURED_DATA');

  const ocrLabels = [...readableLabels, ...qualityLabels, ...validityLabels, ...mismatchLabels];

  await prisma.document.update({
    where: { id: document.id },
    data: {
      status: ocrLabels.length ? 'REJECTED' : 'EXTRACTED',
      number,
      numberHash: docNumberHash(number, document.country ?? extracted.detectedCountry),
      expiryDate: expiry ? new Date(expiry) : null,
      issuedDate: extracted.fields.issuedDate ? new Date(extracted.fields.issuedDate) : null,
      issuingAuthority: extracted.fields.issuingAuthority ?? null,
      country: document.country ?? extracted.detectedCountry,
      extracted: {
        ...extracted.fields,
        dob,
        expiryDate: expiry,
        documentNumber: number,
        mrzPresent: Boolean(extracted.mrz),
        fieldConfidence: extracted.fieldConfidence,
        // Which reader produced this, stored alongside the values themselves.
        //
        // A simulated reader invents fields that agree with what the applicant
        // declared rather than with the photograph, so a reviewer looking at
        // both sees plausible text beside an image it does not match. Without
        // this they cannot tell that from a genuine discrepancy — which is the
        // one thing they are there to spot.
        readBy: ocr.provider,
      } as never,
      rejectLabels: ocrLabels,
    },
  });

  await recordCheck(applicant.id, document.id, {
    type: 'DOCUMENT_OCR',
    status: 'COMPLETED',
    result: ocrLabels.length ? 'FAIL' : 'PASS',
    score: Math.round(
      (Object.values(extracted.fieldConfidence).reduce((a, b) => a + b, 0) /
        Math.max(1, Object.values(extracted.fieldConfidence).length)) *
        100,
    ),
    rejectLabels: ocrLabels,
    riskContribution: riskWeightFor(ocrLabels),
    provider: ocr.provider,
    providerRef: ocr.providerRef,
    findings: extracted.findings,
    raw: ocr.raw,
  });
  count++;

  // --- Authenticity ---
  const auth = await adapters.docAuth.verify(
    {
      images: document.images.map((i) => ({
        storageKey: i.storageKey,
        contentType: i.contentType,
        side: i.side as 'FRONT_SIDE' | 'BACK_SIDE',
      })),
      documentType: document.type,
      country: document.country ?? extracted.detectedCountry ?? 'GBR',
      ocr: extracted,
    },
    ctx,
  );
  count++;

  if (auth.ok && auth.data) {
    const forged = auth.data.tamperFlags.length > 0 || auth.data.authenticityScore < 30;
    await prisma.document.update({
      where: { id: document.id },
      data: {
        authenticityScore: auth.data.authenticityScore,
        tamperFlags: auth.data.tamperFlags,
        ...(forged ? { status: 'REJECTED' } : {}),
      },
    });
    await recordCheck(applicant.id, document.id, {
      type: 'DOCUMENT_AUTHENTICITY',
      status: 'COMPLETED',
      result: forged ? 'FAIL' : auth.data.authenticityScore < 70 ? 'WARNING' : 'PASS',
      score: auth.data.authenticityScore,
      rejectLabels: forged ? ['FORGED_DOCUMENT'] : [],
      riskContribution: forged ? 100 : auth.data.authenticityScore < 70 ? 25 : 0,
      provider: auth.provider,
      providerRef: auth.providerRef,
      findings: auth.data.findings,
      raw: auth.raw,
    });
  } else {
    await recordCheck(applicant.id, document.id, {
      type: 'DOCUMENT_AUTHENTICITY',
      status: 'FAILED',
      errorCode: auth.error?.code,
      errorMessage: auth.error?.message,
      provider: auth.provider,
    });
  }

  // --- Duplicate document number across applicants ---
  const hash = docNumberHash(number, document.country ?? extracted.detectedCountry);
  if (hash) {
    const duplicates = await prisma.applicant.count({
      where: {
        tenantId: applicant.tenantId,
        docNumberHash: hash,
        id: { not: applicant.id },
      },
    });
    if (duplicates > 0) {
      await recordCheck(applicant.id, document.id, {
        type: 'DUPLICATE_IDENTITY',
        status: 'COMPLETED',
        result: 'FAIL',
        rejectLabels: ['DUPLICATE_ACCOUNT'],
        riskContribution: 60,
        provider: 'internal',
        findings: [
          {
            code: 'DUPLICATE_DOCUMENT_NUMBER',
            severity: 'HIGH',
            message: `This document number is already registered to ${duplicates} other applicant(s).`,
          },
        ],
      });
      count++;
    }
    await prisma.applicant.update({
      where: { id: applicant.id },
      data: { docNumberHash: hash },
    });
  }

  return count;
}

async function runLivenessStep(
  step: StepDefinition,
  applicant: ApplicantWithRelations,
  adapters: ReturnType<typeof adaptersFor>,
  ctx: { tenantId: string; applicantId: string; seed: string },
): Promise<number> {
  const selfie = applicant.documents.find(
    (d) => d.type === 'SELFIE' || d.type === 'VIDEO_SELFIE',
  );
  if (!selfie?.images[0]) {
    await recordCheck(applicant.id, null, {
      type: 'LIVENESS',
      status: 'SKIPPED',
      result: 'INCONCLUSIVE',
      provider: 'internal',
      findings: [
        { code: 'SELFIE_MISSING', severity: 'HIGH', message: 'No selfie has been captured.' },
      ],
    });
    return 1;
  }

  const result = await adapters.liveness.check(
    {
      media: {
        storageKey: selfie.images[0].storageKey,
        contentType: selfie.images[0].contentType,
      },
      mode: selfie.type === 'VIDEO_SELFIE' ? 'VIDEO' : 'PASSIVE',
    },
    ctx,
  );

  if (!result.ok || !result.data) {
    await recordCheck(applicant.id, selfie.id, {
      type: 'LIVENESS',
      status: 'FAILED',
      errorCode: result.error?.code,
      errorMessage: result.error?.message,
      provider: result.provider,
    });
    return 1;
  }

  const threshold = step.config.livenessThreshold ?? 0.85;
  const labels: string[] = [];
  if (result.data.spoofDetected) labels.push('SPOOF_ATTEMPT');
  else if (!result.data.faceDetected) labels.push('NO_FACE_DETECTED');
  else if (result.data.faceCount > 1) labels.push('MULTIPLE_FACES');
  else if (result.data.score < threshold) labels.push('LIVENESS_FAILED');
  if (result.data.occlusions.length) labels.push('FACE_OBSCURED');

  await recordCheck(applicant.id, selfie.id, {
    type: 'LIVENESS',
    status: 'COMPLETED',
    result: labels.length ? 'FAIL' : 'PASS',
    score: Math.round(result.data.score * 100),
    rejectLabels: labels,
    riskContribution: riskWeightFor(labels),
    provider: result.provider,
    providerRef: result.providerRef,
    findings: result.data.findings,
    raw: result.raw,
    // Liveness is evidence of presence at a moment in time; it does not stay
    // true forever, so it carries an explicit expiry.
    expiresAt: new Date(Date.now() + 365 * 86_400_000),
  });

  // Index the biometric template for cross-applicant duplicate detection.
  let checks = 1;
  if (result.data.faceEmbedding && !result.data.spoofDetected) {
    checks += await indexFaceAndCheckDuplicates(applicant, result.data.faceEmbedding);
  }
  return checks;
}

/**
 * Stores the face template and looks for the same face under a different claimed
 * identity — the strongest single synthetic-identity signal available.
 */
async function indexFaceAndCheckDuplicates(
  applicant: ApplicantWithRelations,
  embedding: number[],
): Promise<number> {
  const bucket = embeddingBucket(embedding);

  await prisma.faceIndexEntry.create({
    data: { applicantId: applicant.id, embedding, bucket, quality: 0.9 },
  });

  // Bucketed candidate fetch: comparing against the whole index would not scale,
  // and a coarse sign-based bucket keeps near-identical vectors together.
  const candidates = await prisma.faceIndexEntry.findMany({
    where: { bucket, applicantId: { not: applicant.id } },
    include: {
      applicant: {
        select: { id: true, identityFingerprint: true, externalUserId: true },
      },
    },
    take: 500,
  });

  const fingerprint = applicant.identityFingerprint;
  const matches = candidates
    .map((c) => ({ entry: c, similarity: cosineSimilarity(embedding, c.embedding) }))
    .filter((m) => m.similarity >= 0.92);

  if (matches.length === 0) return 0;

  // Same face under the same identity is a returning customer, which is fine.
  // Same face under a *different* identity is the finding.
  const differentIdentity = matches.filter(
    (m) => !fingerprint || m.entry.applicant.identityFingerprint !== fingerprint,
  );

  await recordCheck(applicant.id, null, {
    type: 'DUPLICATE_FACE',
    status: 'COMPLETED',
    result: differentIdentity.length ? 'FAIL' : 'WARNING',
    score: Math.round(Math.max(...matches.map((m) => m.similarity)) * 100),
    rejectLabels: differentIdentity.length ? ['DUPLICATE_FACE'] : [],
    riskContribution: differentIdentity.length ? 85 : 10,
    provider: 'internal-biometric-index',
    findings: [
      {
        code: differentIdentity.length ? 'DUPLICATE_FACE_DIFFERENT_IDENTITY' : 'SAME_FACE_SAME_IDENTITY',
        severity: differentIdentity.length ? 'CRITICAL' : 'INFO',
        message: differentIdentity.length
          ? `This face matches ${differentIdentity.length} applicant(s) claiming a different identity.`
          : 'This face matches an existing record with the same identity (returning applicant).',
        detail: {
          matchedApplicantIds: matches.map((m) => m.entry.applicant.id),
          topSimilarity: Math.max(...matches.map((m) => m.similarity)),
        },
      },
    ],
  });

  return 1;
}

async function runFaceMatchStep(
  step: StepDefinition,
  applicant: ApplicantWithRelations,
  adapters: ReturnType<typeof adaptersFor>,
  ctx: { tenantId: string; applicantId: string; seed: string },
): Promise<number> {
  const selfie = applicant.documents.find((d) => d.type === 'SELFIE' || d.type === 'VIDEO_SELFIE');
  const idDoc = applicant.documents.find((d) =>
    ['PASSPORT', 'ID_CARD', 'DRIVERS_LICENSE', 'RESIDENCE_PERMIT'].includes(d.type),
  );

  if (!selfie?.images[0] || !idDoc?.images[0]) {
    await recordCheck(applicant.id, null, {
      type: 'FACE_MATCH',
      status: 'SKIPPED',
      result: 'INCONCLUSIVE',
      provider: 'internal',
      findings: [
        {
          code: 'FACE_MATCH_INPUTS_MISSING',
          severity: 'HIGH',
          message: 'A face match needs both a selfie and an identity document.',
        },
      ],
    });
    return 1;
  }

  const result = await adapters.faceMatch.compare(
    {
      documentPortrait: {
        storageKey: idDoc.images[0].storageKey,
        contentType: idDoc.images[0].contentType,
      },
      selfie: {
        storageKey: selfie.images[0].storageKey,
        contentType: selfie.images[0].contentType,
      },
    },
    ctx,
  );

  if (!result.ok || !result.data) {
    await recordCheck(applicant.id, selfie.id, {
      type: 'FACE_MATCH',
      status: 'FAILED',
      errorCode: result.error?.code,
      errorMessage: result.error?.message,
      provider: result.provider,
    });
    return 1;
  }

  // Tenant threshold wins over the provider's own opinion: risk appetite is the
  // tenant's call, not the vendor's.
  const threshold = step.config.faceMatchThreshold ?? 0.8;
  const passed = result.data.score >= threshold;

  await recordCheck(applicant.id, selfie.id, {
    type: 'FACE_MATCH',
    status: 'COMPLETED',
    result: passed ? 'PASS' : 'FAIL',
    score: Math.round(result.data.score * 100),
    rejectLabels: passed ? [] : ['SELFIE_MISMATCH'],
    riskContribution: passed ? 0 : Math.round(Math.min(70, (threshold - result.data.score) * 200)),
    provider: result.provider,
    providerRef: result.providerRef,
    findings: result.data.findings,
    raw: result.raw,
  });
  return 1;
}

async function runDeviceStep(
  applicant: ApplicantWithRelations,
  adapters: ReturnType<typeof adaptersFor>,
  ctx: { tenantId: string; applicantId: string; seed: string },
): Promise<number> {
  const result = await adapters.device.assess(
    {
      ipAddress: applicant.ipAddress ?? undefined,
      userAgent: applicant.userAgent ?? undefined,
      fingerprint: applicant.devices[0]?.fingerprint,
    },
    ctx,
  );

  if (!result.ok || !result.data) {
    await recordCheck(applicant.id, null, {
      type: 'DEVICE_FINGERPRINT',
      status: 'FAILED',
      errorCode: result.error?.code,
      provider: result.provider,
    });
    return 1;
  }

  const d = result.data;
  const geoMismatch = Boolean(
    d.ipCountry && applicant.country && d.ipCountry !== applicant.country,
  );

  // Upsert, not insert: re-running verification is the same applicant on the
  // same device, and a row per run would inflate the shared-device signal below
  // with the applicant's own duplicates.
  const deviceFields = {
    ipAddress: applicant.ipAddress,
    ipCountry: d.ipCountry,
    asn: d.asn,
    isVpn: d.isVpn,
    isTor: d.isTor,
    isProxy: d.isProxy,
    isEmulator: d.isEmulator,
    isRooted: d.isRooted,
    geoMismatch,
    os: d.os,
    browser: d.browser,
    timezone: d.timezone,
    botScore: d.botScore,
    raw: (result.raw ?? {}) as never,
  };
  await prisma.deviceSession.upsert({
    where: {
      applicantId_fingerprint: { applicantId: applicant.id, fingerprint: d.fingerprint },
    },
    create: { applicantId: applicant.id, fingerprint: d.fingerprint, ...deviceFields },
    update: deviceFields,
  });

  // How many other applicants share this device? A signup farm shows up here
  // before it shows up anywhere else.
  const sharedWith = await prisma.deviceSession.findMany({
    where: { fingerprint: d.fingerprint, applicantId: { not: applicant.id } },
    select: { applicantId: true },
    distinct: ['applicantId'],
  });

  const labels: string[] = [];
  if (d.isEmulator || d.isRooted) labels.push('DEVICE_FRAUD_SIGNALS');
  if (sharedWith.length >= 5) labels.push('DEVICE_FRAUD_SIGNALS');

  await recordCheck(applicant.id, null, {
    type: 'DEVICE_FINGERPRINT',
    status: 'COMPLETED',
    result: labels.length ? 'WARNING' : 'PASS',
    score: 100 - d.botScore,
    rejectLabels: [],
    riskContribution: labels.length ? 30 : d.isTor ? 20 : d.isVpn ? 10 : 0,
    provider: result.provider,
    findings: [
      ...d.findings,
      ...(sharedWith.length >= 3
        ? [
            {
              code: 'SHARED_DEVICE',
              severity: (sharedWith.length >= 5 ? 'HIGH' : 'MEDIUM') as 'HIGH' | 'MEDIUM',
              message: `This device fingerprint is shared with ${sharedWith.length} other applicant(s).`,
              detail: { count: sharedWith.length },
            },
          ]
        : []),
    ],
    raw: result.raw,
  });

  await recordCheck(applicant.id, null, {
    type: 'IP_GEOLOCATION',
    status: 'COMPLETED',
    result: geoMismatch ? 'WARNING' : 'PASS',
    riskContribution: geoMismatch ? 10 : 0,
    provider: result.provider,
    findings: geoMismatch
      ? [
          {
            code: 'GEO_MISMATCH',
            severity: 'LOW',
            message: `Connecting from ${d.ipCountry} but the declared country is ${applicant.country}.`,
          },
        ]
      : [],
  });

  await prisma.applicant.update({
    where: { id: applicant.id },
    data: { ipCountry: d.ipCountry },
  });

  return 2;
}

async function runContactStep(
  step: StepDefinition,
  applicant: ApplicantWithRelations,
  adapters: ReturnType<typeof adaptersFor>,
  ctx: { tenantId: string; applicantId: string; seed: string },
): Promise<number> {
  const wantEmail = step.type === 'EMAIL_VERIFICATION';
  const result = await adapters.contactRisk.assess(
    wantEmail
      ? { email: applicant.email ?? undefined }
      : { phone: applicant.phone ?? undefined },
    ctx,
  );

  const type = wantEmail ? 'EMAIL_RISK' : 'PHONE_RISK';
  if (!result.ok || !result.data) {
    await recordCheck(applicant.id, null, {
      type,
      status: 'FAILED',
      errorCode: result.error?.code,
      provider: result.provider,
    });
    return 1;
  }

  const detail = wantEmail ? result.data.email : result.data.phone;
  if (!detail) {
    await recordCheck(applicant.id, null, {
      type,
      status: 'SKIPPED',
      result: 'INCONCLUSIVE',
      provider: result.provider,
      findings: [
        {
          code: 'CONTACT_MISSING',
          severity: step.required ? 'MEDIUM' : 'INFO',
          message: `No ${wantEmail ? 'email address' : 'phone number'} on file.`,
        },
      ],
    });
    return 1;
  }

  await recordCheck(applicant.id, null, {
    type,
    status: 'COMPLETED',
    result: detail.riskScore >= 50 ? 'WARNING' : detail.valid ? 'PASS' : 'FAIL',
    score: 100 - detail.riskScore,
    riskContribution: Math.min(20, Math.round(detail.riskScore / 4)),
    provider: result.provider,
    findings: result.data.findings,
    raw: result.raw,
  });
  return 1;
}

/** Fields held in the encrypted PII blob rather than an indexed column. */
const PII_BLOB_FIELDS = [
  'address',
  'taxId',
  'placeOfBirth',
  'occupation',
  'employerName',
  'sourceOfFunds',
];

/**
 * The applicant's own declared data.
 *
 * There is no provider to call, but the step is not therefore unsatisfiable:
 * either the fields the level asks for are present or they are not. Recording it
 * as SKIPPED — which is what happened before — meant a required APPLICANT_DATA
 * step could never appear in completedStepIds, so `allRequiredPassed` was false
 * for every applicant and nobody could ever be auto-approved.
 */
async function runApplicantDataStep(
  step: StepDefinition,
  applicant: ApplicantWithRelations,
): Promise<number> {
  const required = (step.config.requiredFields as string[] | undefined) ?? [
    'firstName',
    'lastName',
    'dob',
    'country',
  ];

  // Address and tax id are not columns: they live in the envelope-encrypted PII
  // blob, so a level that requires them means unsealing it. Decrypt only when the
  // level actually asks for one of those fields.
  let sealed: Record<string, unknown> = {};
  const needsPii = required.some((f) => PII_BLOB_FIELDS.includes(f));
  if (needsPii && applicant.piiCiphertext) {
    const key = process.env.PII_ENCRYPTION_KEY;
    if (key) {
      try {
        sealed = decryptJson<Record<string, unknown>>(applicant.piiCiphertext, key);
      } catch {
        // A blob we cannot open is not the same as data the applicant withheld.
        // Leave it empty and let the missing-field path report it.
      }
    }
  }

  const values: Record<string, unknown> = {
    firstName: applicant.firstName,
    lastName: applicant.lastName,
    dob: applicant.dob,
    country: applicant.country,
    nationality: applicant.nationality,
    email: applicant.email,
    phone: applicant.phone,
    ...sealed,
  };

  const missing = required.filter((f) => {
    const v = values[f];
    return v === null || v === undefined || (typeof v === 'string' && v.trim() === '');
  });

  await recordCheck(applicant.id, null, {
    type: 'APPLICANT_DATA',
    status: 'COMPLETED',
    result: missing.length ? 'FAIL' : 'PASS',
    rejectLabels: missing.length ? ['ADDITIONAL_DOCUMENTS_REQUIRED'] : [],
    riskContribution: 0,
    provider: 'internal',
    findings: missing.length
      ? [
          {
            code: 'MISSING_APPLICANT_DATA',
            severity: 'MEDIUM' as const,
            message: `The applicant has not supplied: ${missing.join(', ')}.`,
            detail: { missing },
          },
        ]
      : [],
  });

  return 1 + (await checkForTheSamePersonAgain(applicant));
}

/**
 * Has this person already applied under a different account?
 *
 * The identity fingerprint — a hash of name, date of birth and country — was
 * being computed and stored on every applicant and then never compared against
 * anything. Duplicate detection ran on the document number alone, so the same
 * person applying twice with a second passport, or with a document the reader
 * could not read, passed as two unrelated strangers. That is the plainest
 * version of the account-farming pattern a KYC platform exists to notice.
 *
 * Not a rejection on its own: families share surnames, dates of birth collide,
 * and a legitimate applicant may be recovering an account they lost access to.
 * It is a signal weighted for a human to look at.
 */
async function checkForTheSamePersonAgain(
  applicant: ApplicantWithRelations,
): Promise<number> {
  const fingerprint = applicant.identityFingerprint;
  // An identity we do not know is not an identity we can match. Two applicants
  // who have both supplied nothing are not the same person.
  if (!fingerprint) return 0;

  const others = await prisma.applicant.findMany({
    where: {
      tenantId: applicant.tenantId,
      identityFingerprint: fingerprint,
      id: { not: applicant.id },
    },
    select: { id: true, externalUserId: true, reviewStatus: true },
    take: 10,
  });
  if (others.length === 0) return 0;

  // One fact, noticed twice, must not be charged twice.
  //
  // The document-number check already flags a repeat applicant, and when both
  // fire they are observing the same thing — this person has been here before.
  // Adding both contributions took a first-time applicant to a risk score of
  // 98 on the strength of a single observation. The finding is still recorded,
  // because *how* the repeat was spotted is worth a reviewer's attention; the
  // score is not moved a second time.
  const alreadyCounted = await prisma.check.findFirst({
    where: {
      applicantId: applicant.id,
      type: 'DUPLICATE_IDENTITY',
      result: 'FAIL',
      documentId: { not: null },
    },
    select: { id: true },
  });

  await recordCheck(applicant.id, null, {
    type: 'DUPLICATE_IDENTITY',
    status: 'COMPLETED',
    result: 'FAIL',
    rejectLabels: ['DUPLICATE_ACCOUNT'],
    riskContribution: alreadyCounted ? 0 : 40,
    provider: 'internal',
    findings: [
      {
        code: 'DUPLICATE_DECLARED_IDENTITY',
        severity: 'HIGH' as const,
        message:
          `The same name, date of birth and country are already registered to ` +
          `${others.length} other applicant(s).`,
        detail: {
          others: others.map((o) => ({
            externalUserId: o.externalUserId,
            reviewStatus: o.reviewStatus,
          })),
        },
      },
    ],
  });
  return 1;
}

async function runProofOfAddressStep(
  step: StepDefinition,
  applicant: ApplicantWithRelations,
  adapters: ReturnType<typeof adaptersFor>,
  ctx: { tenantId: string; applicantId: string; seed: string },
): Promise<number> {
  const accepted = step.config.acceptedDocumentTypes ?? [
    'UTILITY_BILL',
    'BANK_STATEMENT',
    'TAX_DOCUMENT',
    'PROOF_OF_ADDRESS',
  ];
  const doc = applicant.documents.find((d) => accepted.includes(d.type as never));

  if (!doc) {
    await recordCheck(applicant.id, null, {
      type: 'PROOF_OF_ADDRESS',
      status: 'SKIPPED',
      result: 'INCONCLUSIVE',
      rejectLabels: step.required ? ['ADDITIONAL_DOCUMENTS_REQUIRED'] : [],
      provider: 'internal',
      findings: [
        {
          code: 'PROOF_OF_ADDRESS_MISSING',
          severity: step.required ? 'MEDIUM' : 'INFO',
          message: `No proof of address uploaded. Accepted: ${accepted.join(', ')}.`,
        },
      ],
    });
    return 1;
  }

  const ocr = await adapters.ocr.extract(
    {
      images: doc.images.map((i) => ({ storageKey: i.storageKey, contentType: i.contentType })),
      documentType: doc.type,
      expectedCountry: applicant.country ?? undefined,
    },
    ctx,
  );

  const maxAge = step.config.maxDocumentAgeDays ?? 90;
  const issued = ocr.data?.fields.issuedDate ?? doc.issuedDate?.toISOString().slice(0, 10) ?? null;
  const ageDays = issued ? -(daysUntil(issued) ?? 0) : null;
  const labels: string[] = [];
  if (ageDays !== null && ageDays > maxAge) labels.push('PROOF_OF_ADDRESS_TOO_OLD');

  // The whole point of a proof of address is that it is recent and it is
  // theirs. With no date read and no address read, neither has been
  // established — and "we checked nothing, so we found nothing wrong" is not a
  // pass. The simulated reader always returned a date, so this only became
  // reachable with a real one.
  const verifiedAnything = Boolean(issued || ocr.data?.fields.address);
  if (ocr.ok && !verifiedAnything) labels.push('NOT_MACHINE_READABLE');

  await recordCheck(applicant.id, doc.id, {
    type: 'PROOF_OF_ADDRESS',
    status: ocr.ok ? 'COMPLETED' : 'FAILED',
    result: ocr.ok ? (labels.length ? 'FAIL' : 'PASS') : undefined,
    rejectLabels: labels,
    riskContribution: riskWeightFor(labels),
    provider: ocr.provider,
    errorCode: ocr.error?.code,
    findings: [
      ...(ocr.data?.findings ?? []),
      ...(ageDays !== null
        ? [
            {
              code: 'DOCUMENT_AGE',
              severity: (ageDays > maxAge ? 'MEDIUM' : 'INFO') as 'MEDIUM' | 'INFO',
              message: `Document is ${ageDays} days old (limit ${maxAge}).`,
            },
          ]
        : []),
    ],
    raw: ocr.raw,
  });
  return 1;
}

// ---------------------------------------------------------------------------
// Decisioning
// ---------------------------------------------------------------------------

/**
 * Assembles facts, scores risk, evaluates rules, and either decides or queues.
 *
 * Auto-approval requires positive evidence of completion, not merely the absence
 * of failure — see the `checks.allRequiredPassed` fact in @kyc/core.
 */
export async function finalize(
  applicantId: string,
  tenantId: string,
  options: { forceReject?: string[]; checksRun?: number } = {},
) {
  const applicant = await prisma.applicant.findFirstOrThrow({
    where: { id: applicantId, tenantId },
    include: {
      level: true,
      documents: true,
      checks: { orderBy: { createdAt: 'desc' } },
      devices: { orderBy: { createdAt: 'desc' }, take: 1 },
      screeningRuns: {
        orderBy: { startedAt: 'desc' },
        take: 1,
        include: { hits: true },
      },
    },
  });

  const steps = parseLevelSteps(applicant.level.steps);
  const requiredStepIds = steps.filter((s) => s.required).map((s) => s.id);

  // Only the *current* state of each check counts.
  //
  // The check table accumulates every check ever run, including superseded
  // attempts. Evaluating the whole history means a failure the applicant has
  // since corrected keeps rejecting them forever — a resubmission could never
  // clear a rejection. Keyed by document as well as type, because a single run
  // legitimately produces one DOCUMENT_OCR per uploaded document and collapsing
  // those would discard a real result.
  //
  // Superseded documents drop out entirely. Keying by document is what lets one
  // run OCR several documents without them overwriting each other, but it also
  // means a replaced document keeps its own slot — so the failing check on the
  // blurry passport someone has since re-uploaded would still be "current" and
  // would block them for good.
  const supersededDocumentIds = new Set(
    applicant.documents.filter((d) => d.status === 'SUPERSEDED').map((d) => d.id),
  );

  type CheckRow = (typeof applicant.checks)[number];
  const latestByKey = new Map<string, CheckRow>();
  for (const c of applicant.checks) {
    if (c.documentId && supersededDocumentIds.has(c.documentId)) continue;
    const key = `${c.type}:${c.documentId ?? ''}`;
    const seen = latestByKey.get(key);
    if (!seen || c.createdAt > seen.createdAt) latestByKey.set(key, c);
  }
  const latestChecks = [...latestByKey.values()];

  const checksByType = new Map<string, CheckRow>();
  for (const c of latestChecks) {
    const seen = checksByType.get(c.type);
    if (!seen || c.createdAt > seen.createdAt) checksByType.set(c.type, c);
  }

  // A required step is satisfied when every current check of its type completed
  // without failing. "Every", not "any": one passing document does not excuse
  // another that failed.
  const completedStepIds = steps
    .filter((s) => {
      const type = checkTypeForStep(s);
      const relevant = latestChecks.filter((c) => c.type === type);
      return (
        relevant.length > 0 &&
        relevant.every((c) => c.status === 'COMPLETED' && c.result !== 'FAIL')
      );
    })
    .map((s) => s.id);

  const run = applicant.screeningRuns[0];
  const openHits = run?.hits.filter((h) => h.status === 'OPEN' || h.status === 'IN_REVIEW') ?? [];
  const pepHits = openHits.filter((h) => h.listType === 'PEP');
  const device = applicant.devices[0];

  const snapshot: ApplicantSnapshot = {
    applicant: {
      id: applicant.id,
      externalUserId: applicant.externalUserId,
      reviewStatus: applicant.reviewStatus,
      riskScore: applicant.riskScore,
      ddLevel: applicant.ddLevel,
      firstName: applicant.firstName,
      lastName: applicant.lastName,
      dob: applicant.dob,
      country: applicant.country,
      nationality: applicant.nationality,
      email: applicant.email,
      phone: applicant.phone,
      ipCountry: applicant.ipCountry,
      createdAt: applicant.createdAt,
      tags: applicant.tags,
      // Distinct documents OCR'd, not OCR checks run. Each genuine resubmission
      // creates a new document; re-running the pipeline over the same one is not
      // another attempt, and counting it as one inflates the risk score.
      submissionAttempts: new Set(
        applicant.checks.filter((c) => c.type === 'DOCUMENT_OCR').map((c) => c.documentId),
      ).size,
    },
    documents: applicant.documents.map((d) => ({
      type: d.type,
      country: d.country,
      number: d.number,
      expiryDate: d.expiryDate,
      authenticityScore: d.authenticityScore,
      tamperFlags: d.tamperFlags,
      mrzVerified: undefined,
      extracted: d.extracted as Record<string, unknown>,
    })) as ApplicantSnapshot['documents'],
    checks: latestChecks.map((c) => ({
      type: c.type,
      status: c.status,
      result: c.result,
      score: c.score,
      rejectLabels: c.rejectLabels,
    })),
    screening: {
      trigger: run?.trigger ?? 'INITIAL',
      openHits: openHits.length,
      newHits: openHits.length,
      confirmedSanctionsHits: (run?.hits ?? []).filter(
        (h) => h.listType === 'SANCTIONS' && h.resolution === 'TRUE_POSITIVE',
      ).length,
      pepHits: pepHits.length,
      maxPepTier: pepHits.length
        ? Math.min(...pepHits.map((h) => (h.snapshot as { pepTier?: number })?.pepTier ?? 4))
        : null,
      adverseMediaHits: openHits.filter((h) => h.listType === 'ADVERSE_MEDIA').length,
      adverseMediaCategories: openHits.flatMap(
        (h) => ((h.snapshot as { categories?: string[] })?.categories ?? []),
      ),
      openHitListTypes: [...new Set(openHits.map((h) => h.listType))],
    },
    device: device
      ? {
          isVpn: device.isVpn,
          isTor: device.isTor,
          isProxy: device.isProxy,
          isEmulator: device.isEmulator,
          isRooted: device.isRooted,
          botScore: device.botScore,
          geoMismatch: device.geoMismatch,
        }
      : {},
    liveness: {
      score: checksByType.get('LIVENESS' as never)?.score ?? null,
      spoofDetected:
        checksByType.get('LIVENESS' as never)?.rejectLabels.includes('SPOOF_ATTEMPT') ?? false,
    },
    faceMatch: {
      score: (checksByType.get('FACE_MATCH' as never)?.score ?? null) === null
        ? null
        : (checksByType.get('FACE_MATCH' as never)!.score! / 100),
    },
    duplicate: {
      identityMatchCount: checksByType.get('DUPLICATE_IDENTITY' as never)?.result === 'FAIL' ? 1 : 0,
      faceMatchCount: checksByType.get('DUPLICATE_FACE' as never) ? 1 : 0,
      sameIdentity: checksByType.get('DUPLICATE_FACE' as never)?.result !== 'FAIL',
      deviceSharedWithCount: 0,
    },
    requiredStepIds,
    completedStepIds,
  };

  const facts = buildApplicantFacts(snapshot);
  const rules = await loadRules(tenantId, [
    'APPLICANT_RISK',
    'DOCUMENT',
    'SCREENING',
    'ONGOING_MONITORING',
  ]);
  const evaluation = evaluateRules(rules, facts);
  const hints = summarizeActions(evaluation.actions);

  // Intrinsic factors plus whatever the tenant's rules added.
  const factors: RiskFactor[] = deriveRiskFactors(snapshot);
  if (evaluation.riskDelta > 0) {
    factors.push({
      code: 'TENANT_RULES',
      weight: evaluation.riskDelta,
      category: 'policy',
      detail: evaluation.fired
        .filter((f) => !f.isShadow)
        .map((f) => f.ruleName)
        .join(', '),
    });
  }
  const assessment = assessRisk(factors, {
    currentDdLevel: applicant.ddLevel,
    forceEdd: hints.requiresEdd,
  });

  const forced = options.forceReject ?? [];
  // Current labels only. Reading the full history means a label from an attempt
  // the applicant has already corrected still blocks auto-approval, so anyone who
  // ever failed a check would be stuck in manual review permanently.
  const rejectLabels = [
    ...new Set([
      ...forced,
      ...hints.rejectLabels,
      ...latestChecks.flatMap((c) => c.rejectLabels),
    ]),
  ];

  const level = applicant.level;
  const overRejectThreshold = level.autoReject && assessment.score >= level.autoRejectScore;
  const overReviewThreshold = assessment.score >= level.manualReviewScore;

  const shouldReject = forced.length > 0 || hints.autoReject || overRejectThreshold;
  const canAutoApprove =
    level.autoApprove &&
    hints.autoApprove &&
    !shouldReject &&
    !hints.requiresManualReview &&
    !overReviewThreshold &&
    rejectLabels.length === 0;

  let reviewStatus: string;
  let decision: string | null = null;

  if (shouldReject) {
    const final = isFinalRejection(rejectLabels);
    reviewStatus = final ? 'REJECTED_FINAL' : 'REJECTED_RETRY';
    decision = reviewStatus;
  } else if (canAutoApprove) {
    reviewStatus = 'APPROVED';
    decision = 'APPROVED';
  } else {
    // Everything else waits for a human. This is the safe default and, by
    // design, what happens whenever the evidence is incomplete.
    reviewStatus = 'QUEUED';
  }

  const applicantStatus =
    reviewStatus === 'QUEUED'
      ? 'QUEUED'
      : reviewStatus === 'REJECTED_RETRY'
        ? 'AWAITING_USER'
        : 'COMPLETED';

  await prisma.$transaction([
    prisma.applicant.update({
      where: { id: applicant.id },
      data: {
        reviewStatus: reviewStatus as never,
        status: applicantStatus as never,
        riskScore: assessment.score,
        riskLevel: assessment.level as never,
        ddLevel: assessment.ddLevel as never,
        tags: [...new Set([...applicant.tags, ...hints.tags])],
        identityFingerprint:
          applicant.identityFingerprint ??
          identityFingerprint({
            firstName: applicant.firstName,
            lastName: applicant.lastName,
            dob: applicant.dob,
            country: applicant.country,
          }),
        ...(decision ? { reviewedAt: new Date() } : {}),
        ...(level.reverifyAfterDays > 0 && decision === 'APPROVED'
          ? { nextReviewAt: new Date(Date.now() + level.reverifyAfterDays * 86_400_000) }
          : {}),
      },
    }),
    prisma.applicantStatusEvent.create({
      data: {
        applicantId: applicant.id,
        fromStatus: applicant.reviewStatus,
        toStatus: reviewStatus as never,
        reason: decision
          ? `Automated decision (risk ${assessment.score}, ${assessment.primaryDriver?.code ?? 'no dominant factor'})`
          : 'Routed to manual review',
        actorType: 'SYSTEM',
        metadata: {
          riskScore: assessment.score,
          firedRules: evaluation.fired.filter((f) => !f.isShadow).map((f) => f.ruleName),
          shadowRules: evaluation.fired.filter((f) => f.isShadow).map((f) => f.ruleName),
          skippedRules: evaluation.skipped,
          factors: assessment.factors,
        } as never,
      },
    }),
  ]);

  if (decision) {
    await prisma.review.create({
      data: {
        applicantId: applicant.id,
        decision: decision as never,
        source: 'AUTOMATED',
        rejectLabels: decision === 'APPROVED' ? [] : rejectLabels,
        clientComment:
          decision === 'APPROVED'
            ? null
            : // Applicant-facing wording only; the internal reasoning stays in the
              // status event and the case file.
              rejectLabels
                .map((l) => l)
                .slice(0, 3)
                .join('; '),
        riskScoreAtDecision: assessment.score,
        firedRuleIds: evaluation.fired.filter((f) => !f.isShadow).map((f) => f.ruleId),
      },
    });

    // An automated decision is as consequential as a human one — a final
    // rejection is a legal position either way — so it belongs in the same
    // tamper-evident chain, attributed to SYSTEM and carrying the rules that
    // produced it. Without this, the audit log could show a reviewer opening a
    // record but never show who or what rejected them.
    await appendAuditEntry({
      tenantId,
      actorType: 'SYSTEM',
      action: `applicant.${decision.toLowerCase()}`,
      resourceType: 'Applicant',
      resourceId: applicant.id,
      before: { reviewStatus: applicant.reviewStatus, riskScore: applicant.riskScore },
      after: {
        reviewStatus,
        riskScore: assessment.score,
        riskLevel: assessment.level,
        ddLevel: assessment.ddLevel,
        rejectLabels: decision === 'APPROVED' ? [] : rejectLabels,
        firedRules: evaluation.fired.filter((f) => !f.isShadow).map((f) => f.ruleName),
        decidedBy: 'verification-pipeline',
      },
    });
  }

  // Manual review, EDD, and open hits all need a case with the context already
  // assembled — a reviewer should never have to reconstruct why they are looking
  // at this applicant.
  if (reviewStatus === 'QUEUED') {
    await ensureReviewCase(applicant.id, tenantId, {
      queueName: hints.queue,
      riskScore: assessment.score,
      firedRules: evaluation.fired.filter((f) => !f.isShadow).map((f) => f.ruleName),
      failedChecks: latestChecks.filter((c) => c.result === 'FAIL').map((c) => c.type),
      openHits: openHits.length,
      priority:
        assessment.level === 'CRITICAL' ? 'CRITICAL' : assessment.level === 'HIGH' ? 'HIGH' : 'MEDIUM',
    });
  }

  if (hints.enableMonitoring && decision === 'APPROVED') {
    const config = level.screeningConfig as { frequency?: string; listTypes?: string[] };
    await prisma.monitoringSubscription.upsert({
      where: { applicantId: applicant.id },
      create: {
        applicantId: applicant.id,
        isActive: true,
        frequency: (config.frequency ?? 'DAILY') as never,
        listTypes: (config.listTypes ?? ['SANCTIONS', 'PEP']) as never[],
        nextScreenAt: new Date(Date.now() + 86_400_000),
      },
      update: { isActive: true, nextScreenAt: new Date(Date.now() + 86_400_000) },
    });
  }

  await emitEvent(tenantId, decision ? 'applicant.reviewed' : 'applicant.pending', {
    applicantId: applicant.id,
    externalUserId: applicant.externalUserId,
    levelName: level.name,
    reviewStatus,
    reviewedAt: new Date().toISOString(),
    riskScore: assessment.score,
    riskLevel: assessment.level,
    rejectLabels: decision && decision !== 'APPROVED' ? rejectLabels : [],
    canResubmit: reviewStatus === 'REJECTED_RETRY',
    reviewSource: 'AUTOMATED',
  }, applicant.id);

  return {
    applicantId: applicant.id,
    reviewStatus,
    riskScore: assessment.score,
    // Checks executed by this run, not the applicant's lifetime total — the
    // latter grows on every re-verification and reads as runaway work.
    checksRun: options.checksRun ?? latestChecks.length,
    decided: Boolean(decision),
  };
}

async function ensureReviewCase(
  applicantId: string,
  tenantId: string,
  context: Record<string, unknown> & { queueName?: string; priority: string },
) {
  const existing = await prisma.case.findFirst({
    where: {
      applicantId,
      type: 'MANUAL_REVIEW',
      status: { in: ['OPEN', 'ASSIGNED', 'IN_PROGRESS'] },
    },
  });
  if (existing) {
    await prisma.case.update({
      where: { id: existing.id },
      data: { context: context as never, priority: context.priority as never },
    });
    return existing.id;
  }

  const queue = context.queueName
    ? await prisma.queue.findFirst({ where: { tenantId, name: context.queueName } })
    : await prisma.queue.findFirst({ where: { tenantId, isDefault: true } });

  const count = await prisma.case.count({ where: { tenantId } });
  const created = await prisma.case.create({
    data: {
      tenantId,
      reference: `CASE-${1000 + count + 1}`,
      type: 'MANUAL_REVIEW',
      applicantId,
      queueId: queue?.id,
      title: 'Manual verification review',
      summary: `Risk ${context.riskScore}. ${(context.firedRules as string[])?.length ?? 0} rule(s) fired.`,
      priority: context.priority as never,
      context: context as never,
      dueAt: queue
        ? new Date(Date.now() + queue.slaResolutionMinutes * 60_000)
        : new Date(Date.now() + 86_400_000),
    },
  });
  return created.id;
}

/** Persists a check result. Centralised so every check is shaped the same way. */
export async function recordCheck(
  applicantId: string,
  documentId: string | null,
  data: {
    type: string;
    status: string;
    result?: string;
    score?: number;
    rejectLabels?: string[];
    riskContribution?: number;
    provider?: string;
    providerRef?: string;
    findings?: unknown[];
    raw?: unknown;
    errorCode?: string;
    errorMessage?: string;
    expiresAt?: Date;
  },
): Promise<void> {
  const attempt = await prisma.check.count({
    where: { applicantId, type: data.type as never },
  });

  await prisma.check.create({
    data: {
      applicantId,
      documentId,
      type: data.type as never,
      status: data.status as never,
      result: (data.result ?? null) as never,
      score: data.score ?? null,
      riskContribution: data.riskContribution ?? 0,
      provider: data.provider ?? null,
      providerRef: data.providerRef ?? null,
      raw: (data.raw ?? {}) as never,
      findings: (data.findings ?? []) as never,
      rejectLabels: data.rejectLabels ?? [],
      errorCode: data.errorCode ?? null,
      errorMessage: data.errorMessage ?? null,
      startedAt: new Date(),
      completedAt: data.status === 'COMPLETED' ? new Date() : null,
      expiresAt: data.expiresAt ?? null,
      attempt: attempt + 1,
    },
  });
}
