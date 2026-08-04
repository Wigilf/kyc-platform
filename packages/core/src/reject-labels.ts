/**
 * Reject labels.
 *
 * Two audiences, one taxonomy. Each label carries:
 *  - `retryable`: whether the applicant can fix it and resubmit. This is the
 *    single most consequential bit in the whole product — getting it wrong
 *    either traps a legitimate customer or invites a fraudster to retry.
 *  - `clientMessage`: what the applicant is told. Deliberately vague for fraud
 *    labels: telling someone their document was detected as a forgery tells
 *    them exactly what to fix.
 *  - `category`: drives dashboard grouping and conversion analytics.
 */

export type RejectCategory =
  | 'DOCUMENT_QUALITY'
  | 'DOCUMENT_VALIDITY'
  | 'BIOMETRIC'
  | 'DATA_MISMATCH'
  | 'FRAUD'
  | 'COMPLIANCE'
  | 'PROCESS'
  | 'COMPANY';

export interface RejectLabelDef {
  code: string;
  category: RejectCategory;
  retryable: boolean;
  clientMessage: string;
  description: string;
  /** Weight added to the applicant risk score when this label is applied. */
  riskWeight: number;
}

function def(
  code: string,
  category: RejectCategory,
  retryable: boolean,
  riskWeight: number,
  clientMessage: string,
  description: string,
): RejectLabelDef {
  return { code, category, retryable, riskWeight, clientMessage, description };
}

const GENERIC_FRAUD_MESSAGE =
  'We were unable to verify your identity. Please contact support if you believe this is a mistake.';

export const REJECT_LABELS: Record<string, RejectLabelDef> = Object.fromEntries(
  [
    // --- Document quality: the applicant's fault, and fixable ---
    def('BLURRY_IMAGE', 'DOCUMENT_QUALITY', true, 0,
      'Your document photo was too blurry to read. Please retake it in good lighting.',
      'Image sharpness below the OCR threshold.'),
    def('GLARE_OR_REFLECTION', 'DOCUMENT_QUALITY', true, 0,
      'There was glare on your document. Please retake the photo without direct light on it.',
      'Specular highlights obscure part of the data page.'),
    def('DOCUMENT_CROPPED', 'DOCUMENT_QUALITY', true, 0,
      'Part of your document was cut off. Please make sure all four corners are visible.',
      'Document edges not fully within frame.'),
    def('LOW_RESOLUTION', 'DOCUMENT_QUALITY', true, 0,
      'Your document photo was too small or low quality. Please upload a higher-resolution image.',
      'Pixel density insufficient for MRZ/field extraction.'),
    def('BLACK_AND_WHITE', 'DOCUMENT_QUALITY', true, 5,
      'Please upload a colour photo of your document.',
      'Greyscale scan; colour security features cannot be assessed.'),
    def('SCREENSHOT_OR_SCREEN_PHOTO', 'DOCUMENT_QUALITY', true, 25,
      'Please photograph your physical document rather than a screen.',
      'Moiré pattern or screen bezel detected; a common presentation attack.'),
    def('MISSING_BACK_SIDE', 'DOCUMENT_QUALITY', true, 0,
      'Please also upload the back of your document.',
      'Required second side not provided.'),
    def('WRONG_DOCUMENT_TYPE', 'DOCUMENT_QUALITY', true, 0,
      'The document you uploaded is not one we accept for this step.',
      'Uploaded type not in the level\'s accepted list.'),
    def('DOCUMENT_UNREADABLE', 'DOCUMENT_QUALITY', true, 0,
      'We could not read your document. Please retake the photo of the whole page, ' +
      'including the two lines of code at the bottom.',
      'No usable identity data could be extracted. Distinct from a failed check: ' +
      'nothing was read, so nothing was checked.'),
    def('MRZ_INCOMPLETE', 'DOCUMENT_QUALITY', true, 5,
      'Part of your document was cut off, so we could not fully verify it. Please ' +
      'retake the photo with the whole page in frame.',
      'Mandatory MRZ check digits absent from the read; the zone could not be ' +
      'verified. Absence, not mismatch — see MRZ_CHECKSUM_FAILED for the latter.'),
    def('OBSCURED_DATA', 'DOCUMENT_QUALITY', true, 10,
      'Some details on your document were covered. Please retake the photo with nothing over it.',
      'Fingers, stickers, or overlays covering data fields.'),

    // --- Document validity ---
    def('DOCUMENT_EXPIRED', 'DOCUMENT_VALIDITY', true, 0,
      'Your document has expired. Please upload a current one.',
      'Expiry date is in the past.'),
    def('DOCUMENT_EXPIRING_SOON', 'DOCUMENT_VALIDITY', true, 0,
      'Your document expires very soon. Please upload one valid for longer.',
      'Expiry within the tenant-configured minimum validity window.'),
    def('DOCUMENT_NOT_SUPPORTED', 'DOCUMENT_VALIDITY', true, 0,
      'We cannot currently accept documents from this issuer.',
      'Issuing country/type combination unsupported.'),
    def('UNDERAGE', 'DOCUMENT_VALIDITY', false, 0,
      'You do not meet the minimum age requirement for this service.',
      'Computed age below the level minimum. Not retryable: it will not change.'),
    def('MRZ_CHECKSUM_FAILED', 'DOCUMENT_VALIDITY', true, 40,
      'We could not read your document reliably. Please retake the photo.',
      'MRZ check digits do not validate: either bad OCR or a fabricated MRZ.'),

    // --- Biometric ---
    def('SELFIE_MISMATCH', 'BIOMETRIC', true, 45,
      GENERIC_FRAUD_MESSAGE,
      'Face-match similarity below threshold against the document portrait.'),
    def('LIVENESS_FAILED', 'BIOMETRIC', true, 20,
      'We could not confirm you were present during the check. Please try again.',
      'Passive/active liveness score below threshold.'),
    def('SPOOF_ATTEMPT', 'BIOMETRIC', false, 90,
      GENERIC_FRAUD_MESSAGE,
      'Presentation attack detected: mask, printed photo, replay, or deepfake.'),
    def('NO_FACE_DETECTED', 'BIOMETRIC', true, 0,
      'We could not find your face in the photo. Please centre your face and try again.',
      'No detectable face in the selfie frame.'),
    def('MULTIPLE_FACES', 'BIOMETRIC', true, 15,
      'Please take the photo with only yourself in frame.',
      'More than one face detected during capture.'),
    def('FACE_OBSCURED', 'BIOMETRIC', true, 10,
      'Please remove hats, sunglasses, or masks and try again.',
      'Occlusion prevents reliable landmark extraction.'),

    // --- Data mismatch ---
    def('DATA_MISMATCH', 'DATA_MISMATCH', true, 25,
      'The details you entered do not match your document. Please check and resubmit.',
      'Submitted profile fields disagree with extracted document fields.'),
    def('NAME_MISMATCH', 'DATA_MISMATCH', true, 25,
      'The name you entered does not match your document.',
      'Name similarity below threshold after normalisation.'),
    def('DOB_MISMATCH', 'DATA_MISMATCH', true, 35,
      'The date of birth you entered does not match your document.',
      'Date of birth disagrees with the document.'),
    def('ADDRESS_MISMATCH', 'DATA_MISMATCH', true, 15,
      'The address on your proof of address does not match the one you gave us.',
      'Proof-of-address document does not corroborate the declared address.'),
    def('PROOF_OF_ADDRESS_TOO_OLD', 'DATA_MISMATCH', true, 0,
      'Your proof of address is too old. Please upload one issued in the last 3 months.',
      'Document date outside the accepted recency window.'),

    // --- Fraud: not retryable, and messaging is intentionally uninformative ---
    def('FORGED_DOCUMENT', 'FRAUD', false, 100,
      GENERIC_FRAUD_MESSAGE,
      'Document authenticity checks indicate tampering or fabrication.'),
    def('DIGITAL_MANIPULATION', 'FRAUD', false, 100,
      GENERIC_FRAUD_MESSAGE,
      'Pixel-level or metadata evidence of editing.'),
    def('TEMPLATE_MISMATCH', 'FRAUD', false, 80,
      GENERIC_FRAUD_MESSAGE,
      'Document layout does not match the known template for its issuer and year.'),
    def('DUPLICATE_ACCOUNT', 'FRAUD', false, 70,
      'This identity is already registered with us.',
      'Same identity fingerprint already verified under a different account.'),
    def('DUPLICATE_FACE', 'FRAUD', false, 85,
      GENERIC_FRAUD_MESSAGE,
      'Same biometric template linked to a different claimed identity.'),
    def('STOLEN_IDENTITY_SUSPECTED', 'FRAUD', false, 95,
      GENERIC_FRAUD_MESSAGE,
      'Signals consistent with use of another person\'s genuine document.'),
    def('DEVICE_FRAUD_SIGNALS', 'FRAUD', false, 60,
      GENERIC_FRAUD_MESSAGE,
      'Emulator, farm-linked device, or coordinated-signup fingerprint.'),
    def('THIRD_PARTY_ASSISTANCE', 'FRAUD', false, 70,
      GENERIC_FRAUD_MESSAGE,
      'Evidence of coaching or remote control during capture.'),
    def('BLOCKLISTED', 'FRAUD', false, 100,
      GENERIC_FRAUD_MESSAGE,
      'Matches an internal blocklist entry.'),

    // --- Compliance: legal grounds, no resubmission path ---
    def('SANCTIONS_MATCH', 'COMPLIANCE', false, 100,
      'We are unable to offer you our services. Please contact support.',
      'Confirmed true-positive match against a sanctions list.'),
    def('PEP_UNACCEPTABLE_RISK', 'COMPLIANCE', false, 80,
      'We are unable to offer you our services at this time.',
      'PEP exposure exceeds the tenant\'s stated risk appetite.'),
    def('ADVERSE_MEDIA_CONFIRMED', 'COMPLIANCE', false, 75,
      'We are unable to offer you our services at this time.',
      'Substantiated adverse media concerning financial crime.'),
    def('PROHIBITED_COUNTRY', 'COMPLIANCE', false, 100,
      'We do not currently operate in your country.',
      'Applicant country is embargoed or blocked for this level.'),
    def('PROHIBITED_OCCUPATION', 'COMPLIANCE', false, 50,
      'We are unable to offer you our services at this time.',
      'Declared occupation or industry falls outside risk appetite.'),
    def('SOURCE_OF_FUNDS_UNCLEAR', 'COMPLIANCE', true, 50,
      'We need more information about the source of your funds.',
      'Source-of-funds evidence insufficient for the risk level.'),
    def('REGULATORY_REQUIREMENT', 'COMPLIANCE', false, 40,
      'We are unable to complete your verification for regulatory reasons.',
      'A jurisdiction-specific legal bar applies.'),

    // --- Process ---
    def('APPLICANT_ABANDONED', 'PROCESS', true, 0,
      'Your verification was not completed. You can continue where you left off.',
      'No activity within the level\'s completion window.'),
    def('CONSENT_WITHDRAWN', 'PROCESS', true, 0,
      'You withdrew consent for identity verification.',
      'Applicant revoked processing consent.'),
    def('ADDITIONAL_DOCUMENTS_REQUIRED', 'PROCESS', true, 0,
      'We need one more document from you to finish your verification.',
      'Reviewer requested supplementary evidence.'),
    def('MANUAL_REVIEW_TIMEOUT', 'PROCESS', true, 0,
      'Your verification is taking longer than expected. We will be in touch.',
      'Case exceeded its SLA without a decision.'),
    def('PROVIDER_UNAVAILABLE', 'PROCESS', true, 0,
      'We hit a technical problem. Please try again shortly.',
      'Upstream verification provider failed; not the applicant\'s fault.'),

    // --- Company / KYB ---
    def('COMPANY_NOT_FOUND', 'COMPANY', true, 20,
      'We could not find your company in the official registry. Please check the details.',
      'No registry record for the supplied registration number.'),
    def('COMPANY_DISSOLVED', 'COMPANY', false, 60,
      'This company is no longer active according to the official registry.',
      'Registry status is dissolved, struck off, or in liquidation.'),
    def('UBO_UNRESOLVED', 'COMPANY', true, 55,
      'We need more information about your company\'s ownership structure.',
      'Ownership chain does not resolve to natural persons.'),
    def('UBO_REFUSED_VERIFICATION', 'COMPANY', true, 45,
      'One or more of your beneficial owners has not completed verification.',
      'A required UBO did not complete individual KYC.'),
    def('NOMINEE_STRUCTURE', 'COMPANY', true, 50,
      'We need additional information about your company\'s ownership.',
      'Nominee shareholders obscure the real owners.'),
    def('SHELL_COMPANY_INDICATORS', 'COMPANY', false, 70,
      'We are unable to onboard this entity.',
      'No operating substance: no employees, no premises, no activity.'),
  ].map((d) => [d.code, d] as const),
);

export type RejectLabel = keyof typeof REJECT_LABELS;

export function getRejectLabel(code: string): RejectLabelDef | undefined {
  return REJECT_LABELS[code];
}

/**
 * A decision is final if ANY label is non-retryable. One unforgivable reason
 * outweighs any number of fixable ones — otherwise a fraudster could bury a
 * forgery finding under a pile of blurry-photo labels and earn a retry.
 */
export function isFinalRejection(labels: string[]): boolean {
  return labels.some((code) => REJECT_LABELS[code]?.retryable === false);
}

export function clientMessagesFor(labels: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const code of labels) {
    const message = REJECT_LABELS[code]?.clientMessage;
    if (message && !seen.has(message)) {
      seen.add(message);
      out.push(message);
    }
  }
  return out;
}

export function riskWeightFor(labels: string[]): number {
  // Same reasoning as country risk: take the max, do not sum. Three quality
  // labels on one blurry photo are one problem, not three.
  return labels.reduce(
    (max, code) => Math.max(max, REJECT_LABELS[code]?.riskWeight ?? 0),
    0,
  );
}

export function labelsByCategory(category: RejectCategory): RejectLabelDef[] {
  return Object.values(REJECT_LABELS).filter((l) => l.category === category);
}
