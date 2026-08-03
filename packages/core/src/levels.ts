import { z } from 'zod';

/**
 * Verification levels: the declarative flow definition a tenant assembles in the
 * dashboard's level designer and that the WebSDK renders.
 *
 * A level is data, not code. The pipeline reads it to decide which checks to
 * run, the SDK reads it to decide which screens to show, and support tooling
 * reads it to tell an applicant what is still outstanding. One definition, three
 * consumers, no drift.
 */

export const StepType = z.enum([
  'APPLICANT_DATA', // structured profile fields
  'IDENTITY_DOCUMENT', // passport / ID card / driving licence
  'SELFIE', // still portrait for face match
  'LIVENESS', // active or passive presence check
  'NFC_READ', // read the document chip
  'PROOF_OF_ADDRESS',
  'QUESTIONNAIRE',
  'PHONE_VERIFICATION',
  'EMAIL_VERIFICATION',
  'AML_SCREENING',
  'DEVICE_INTELLIGENCE',
  'AGE_ESTIMATION',
  'TIN_VALIDATION',
  'BANK_ACCOUNT',
  'VIDEO_INTERVIEW', // human-conducted, for EDD
  'COMPANY_DATA',
  'COMPANY_DOCUMENTS',
  'UBO_DISCOVERY',
  'UBO_VERIFICATION', // each UBO runs an individual level
  'REPRESENTATIVE_KYC',
  'WALLET_OWNERSHIP',
  'SOURCE_OF_FUNDS',
  'E_SIGNATURE',
]);
export type StepType = z.infer<typeof StepType>;

export const DocumentTypeEnum = z.enum([
  'PASSPORT', 'ID_CARD', 'DRIVERS_LICENSE', 'RESIDENCE_PERMIT', 'VISA',
  'SELFIE', 'VIDEO_SELFIE', 'PROOF_OF_ADDRESS', 'BANK_STATEMENT',
  'UTILITY_BILL', 'PAYSLIP', 'TAX_DOCUMENT', 'SOURCE_OF_FUNDS',
  'COMPANY_REGISTRATION', 'ARTICLES_OF_ASSOCIATION', 'SHAREHOLDER_REGISTRY',
  'UBO_DECLARATION', 'POWER_OF_ATTORNEY', 'OTHER',
]);

export const StepConfigSchema = z
  .object({
    /** Document types the applicant may satisfy this step with. */
    acceptedDocumentTypes: z.array(DocumentTypeEnum).optional(),
    /** Require both sides (ID cards, driving licences). */
    requireBothSides: z.boolean().optional(),
    /** Reject documents expiring within this many days. */
    minValidityDays: z.number().int().min(0).optional(),
    /** Proof of address must be issued within this many days. */
    maxDocumentAgeDays: z.number().int().min(0).optional(),
    /** Minimum applicant age in years. */
    minAge: z.number().int().min(0).optional(),
    maxAge: z.number().int().min(0).optional(),
    /** Face-match similarity floor, 0-1. */
    faceMatchThreshold: z.number().min(0).max(1).optional(),
    /** Liveness confidence floor, 0-1. */
    livenessThreshold: z.number().min(0).max(1).optional(),
    /** Which profile fields the applicant must supply. */
    requiredFields: z.array(z.string()).optional(),
    /** Questionnaire definition id. */
    formId: z.string().optional(),
    /** Watchlists to search at this step. */
    listTypes: z
      .array(
        z.enum([
          'SANCTIONS', 'PEP', 'ADVERSE_MEDIA', 'WANTED',
          'REGULATORY_ENFORCEMENT', 'INTERNAL_BLOCKLIST',
          'DISQUALIFIED_DIRECTOR',
        ]),
      )
      .optional(),
    /** Name-match sensitivity, 0-1. Lower = more hits, more false positives. */
    fuzziness: z.number().min(0).max(1).optional(),
    /** Ownership percentage at or above which a person counts as a UBO. */
    uboThresholdPercent: z.number().min(0).max(100).optional(),
    /** How deep to walk the ownership graph before giving up. */
    maxOwnershipDepth: z.number().int().min(1).max(10).optional(),
    /** Chains an applicant may prove wallet ownership on. */
    chains: z.array(z.string()).optional(),
    /** Free-form provider options. */
    providerOptions: z.record(z.unknown()).optional(),
  })
  .strict();

export const StepDefinitionSchema = z
  .object({
    id: z.string().min(1),
    type: StepType,
    /** Shown in the SDK. */
    label: z.string().optional(),
    /** Optional steps are offered but do not block completion. */
    required: z.boolean().default(true),
    /**
     * Steps run in ascending order. Same-order steps may run concurrently,
     * which is how the pipeline parallelises independent checks.
     */
    order: z.number().int().min(0).default(0),
    /** Retake/resubmit attempts the applicant gets before we hard-stop. */
    maxAttempts: z.number().int().min(1).max(10).default(3),
    /**
     * Only apply this step when the condition matches (rules AST, see rules.ts).
     * Used for country-specific or risk-triggered steps — e.g. request source of
     * funds only when the declared income band is high.
     */
    condition: z.unknown().optional(),
    config: StepConfigSchema.default({}),
  })
  .strict();

export type StepDefinition = z.infer<typeof StepDefinitionSchema>;

export const LevelDefinitionSchema = z.object({
  name: z.string().min(1),
  displayName: z.string().min(1),
  description: z.string().optional(),
  subjectType: z.enum(['INDIVIDUAL', 'COMPANY']).default('INDIVIDUAL'),
  steps: z.array(StepDefinitionSchema).min(1),
  allowedCountries: z.array(z.string()).default([]),
  blockedCountries: z.array(z.string()).default([]),
  autoApprove: z.boolean().default(true),
  autoReject: z.boolean().default(false),
  manualReviewScore: z.number().int().min(0).max(100).default(40),
  autoRejectScore: z.number().int().min(0).max(100).default(80),
  reverifyAfterDays: z.number().int().min(0).default(0),
  screeningConfig: z
    .object({
      ongoingMonitoring: z.boolean().default(false),
      frequency: z.enum(['DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY']).default('DAILY'),
      listTypes: z.array(z.string()).default(['SANCTIONS', 'PEP']),
      fuzziness: z.number().min(0).max(1).default(0.75),
    })
    .default({}),
});

export type LevelDefinition = z.infer<typeof LevelDefinitionSchema>;

/** Which check types a step produces. Drives pipeline planning. */
export const STEP_CHECKS: Record<StepType, string[]> = {
  APPLICANT_DATA: [],
  IDENTITY_DOCUMENT: ['DOCUMENT_OCR', 'DOCUMENT_AUTHENTICITY', 'MRZ_VALIDATION'],
  SELFIE: ['FACE_MATCH', 'DUPLICATE_FACE'],
  LIVENESS: ['LIVENESS'],
  NFC_READ: ['NFC_CHIP'],
  PROOF_OF_ADDRESS: ['PROOF_OF_ADDRESS'],
  QUESTIONNAIRE: ['QUESTIONNAIRE'],
  PHONE_VERIFICATION: ['PHONE_RISK'],
  EMAIL_VERIFICATION: ['EMAIL_RISK'],
  AML_SCREENING: ['AML_SCREENING', 'ADVERSE_MEDIA'],
  DEVICE_INTELLIGENCE: ['DEVICE_FINGERPRINT', 'IP_GEOLOCATION'],
  AGE_ESTIMATION: ['AGE_ESTIMATION'],
  TIN_VALIDATION: ['TIN_VALIDATION'],
  BANK_ACCOUNT: ['BANK_ACCOUNT'],
  VIDEO_INTERVIEW: ['MANUAL'],
  COMPANY_DATA: ['COMPANY_REGISTRY'],
  COMPANY_DOCUMENTS: ['DOCUMENT_OCR'],
  UBO_DISCOVERY: ['UBO_DISCOVERY'],
  UBO_VERIFICATION: [],
  REPRESENTATIVE_KYC: [],
  WALLET_OWNERSHIP: ['WALLET_SCREENING'],
  SOURCE_OF_FUNDS: ['DOCUMENT_OCR'],
  E_SIGNATURE: [],
};

/** Steps that need the applicant to upload or do something. */
export const APPLICANT_FACING_STEPS: ReadonlySet<StepType> = new Set<StepType>([
  'APPLICANT_DATA', 'IDENTITY_DOCUMENT', 'SELFIE', 'LIVENESS', 'NFC_READ',
  'PROOF_OF_ADDRESS', 'QUESTIONNAIRE', 'PHONE_VERIFICATION',
  'EMAIL_VERIFICATION', 'VIDEO_INTERVIEW', 'COMPANY_DATA',
  'COMPANY_DOCUMENTS', 'WALLET_OWNERSHIP', 'SOURCE_OF_FUNDS', 'E_SIGNATURE',
  'AGE_ESTIMATION',
]);

function step(
  id: string,
  type: StepType,
  order: number,
  config: z.input<typeof StepConfigSchema> = {},
  overrides: Partial<StepDefinition> = {},
): StepDefinition {
  return StepDefinitionSchema.parse({ id, type, order, config, ...overrides });
}

/**
 * Built-in level templates. These are the starting points a tenant clones; they
 * encode the common regulatory shapes rather than being exhaustive.
 */
export const LEVEL_TEMPLATES: Record<string, LevelDefinition> = {
  'basic-kyc': LevelDefinitionSchema.parse({
    name: 'basic-kyc',
    displayName: 'Basic KYC',
    description: 'Document plus selfie. The minimum defensible identity check.',
    steps: [
      step('data', 'APPLICANT_DATA', 0, {
        requiredFields: ['firstName', 'lastName', 'dob', 'country'],
      }),
      step('id-doc', 'IDENTITY_DOCUMENT', 1, {
        acceptedDocumentTypes: ['PASSPORT', 'ID_CARD', 'DRIVERS_LICENSE'],
        requireBothSides: true,
        minValidityDays: 0,
        minAge: 18,
      }),
      step('selfie', 'SELFIE', 2, { faceMatchThreshold: 0.8 }),
      step('liveness', 'LIVENESS', 2, { livenessThreshold: 0.85 }),
      step('device', 'DEVICE_INTELLIGENCE', 3, {}, { required: false }),
    ],
    manualReviewScore: 40,
    autoRejectScore: 85,
  }),

  'standard-kyc-aml': LevelDefinitionSchema.parse({
    name: 'standard-kyc-aml',
    displayName: 'Standard KYC + AML',
    description: 'Basic KYC plus sanctions/PEP screening and ongoing monitoring.',
    steps: [
      step('data', 'APPLICANT_DATA', 0, {
        requiredFields: ['firstName', 'lastName', 'dob', 'country', 'address', 'email'],
      }),
      step('id-doc', 'IDENTITY_DOCUMENT', 1, {
        acceptedDocumentTypes: ['PASSPORT', 'ID_CARD', 'DRIVERS_LICENSE'],
        requireBothSides: true,
        minValidityDays: 30,
        minAge: 18,
      }),
      step('selfie', 'SELFIE', 2, { faceMatchThreshold: 0.82 }),
      step('liveness', 'LIVENESS', 2, { livenessThreshold: 0.85 }),
      step('poa', 'PROOF_OF_ADDRESS', 3, {
        acceptedDocumentTypes: ['UTILITY_BILL', 'BANK_STATEMENT', 'TAX_DOCUMENT'],
        maxDocumentAgeDays: 90,
      }),
      step('screening', 'AML_SCREENING', 4, {
        listTypes: ['SANCTIONS', 'PEP', 'ADVERSE_MEDIA', 'INTERNAL_BLOCKLIST'],
        fuzziness: 0.78,
      }),
      step('device', 'DEVICE_INTELLIGENCE', 4),
    ],
    manualReviewScore: 35,
    autoRejectScore: 80,
    reverifyAfterDays: 730,
    screeningConfig: {
      ongoingMonitoring: true,
      frequency: 'DAILY',
      listTypes: ['SANCTIONS', 'PEP', 'ADVERSE_MEDIA'],
      fuzziness: 0.78,
    },
  }),

  'enhanced-due-diligence': LevelDefinitionSchema.parse({
    name: 'enhanced-due-diligence',
    displayName: 'Enhanced Due Diligence',
    description:
      'For high-risk customers: source of funds, video interview, and no auto-approval.',
    steps: [
      step('data', 'APPLICANT_DATA', 0, {
        requiredFields: [
          'firstName', 'lastName', 'dob', 'country', 'address', 'email',
          'phone', 'occupation', 'employerName',
        ],
      }),
      step('id-doc', 'IDENTITY_DOCUMENT', 1, {
        acceptedDocumentTypes: ['PASSPORT', 'ID_CARD'],
        requireBothSides: true,
        minValidityDays: 90,
        minAge: 18,
      }),
      step('nfc', 'NFC_READ', 1, {}, { required: false }),
      step('selfie', 'SELFIE', 2, { faceMatchThreshold: 0.86 }),
      step('liveness', 'LIVENESS', 2, { livenessThreshold: 0.9 }),
      step('poa', 'PROOF_OF_ADDRESS', 3, {
        acceptedDocumentTypes: ['UTILITY_BILL', 'BANK_STATEMENT'],
        maxDocumentAgeDays: 90,
      }),
      step('sof', 'SOURCE_OF_FUNDS', 3, {
        acceptedDocumentTypes: ['SOURCE_OF_FUNDS', 'PAYSLIP', 'TAX_DOCUMENT', 'BANK_STATEMENT'],
      }),
      step('wealth-questionnaire', 'QUESTIONNAIRE', 3, { formId: 'source-of-wealth-v1' }),
      step('screening', 'AML_SCREENING', 4, {
        listTypes: [
          'SANCTIONS', 'PEP', 'ADVERSE_MEDIA', 'WANTED',
          'REGULATORY_ENFORCEMENT', 'INTERNAL_BLOCKLIST',
        ],
        fuzziness: 0.7, // wider net: for EDD we would rather review than miss
      }),
      step('interview', 'VIDEO_INTERVIEW', 5),
    ],
    // EDD outcomes are a human's call by definition.
    autoApprove: false,
    manualReviewScore: 0,
    autoRejectScore: 95,
    reverifyAfterDays: 365,
    screeningConfig: {
      ongoingMonitoring: true,
      frequency: 'DAILY',
      listTypes: ['SANCTIONS', 'PEP', 'ADVERSE_MEDIA', 'WANTED'],
      fuzziness: 0.7,
    },
  }),

  'crypto-onboarding': LevelDefinitionSchema.parse({
    name: 'crypto-onboarding',
    displayName: 'Crypto Exchange Onboarding',
    description: 'KYC/AML plus wallet ownership proof and chain-exposure screening.',
    steps: [
      step('data', 'APPLICANT_DATA', 0, {
        requiredFields: ['firstName', 'lastName', 'dob', 'country', 'address', 'email'],
      }),
      step('id-doc', 'IDENTITY_DOCUMENT', 1, {
        acceptedDocumentTypes: ['PASSPORT', 'ID_CARD', 'DRIVERS_LICENSE'],
        requireBothSides: true,
        minValidityDays: 30,
        minAge: 18,
      }),
      step('selfie', 'SELFIE', 2, { faceMatchThreshold: 0.84 }),
      step('liveness', 'LIVENESS', 2, { livenessThreshold: 0.88 }),
      step('screening', 'AML_SCREENING', 3, {
        listTypes: ['SANCTIONS', 'PEP', 'ADVERSE_MEDIA', 'INTERNAL_BLOCKLIST'],
        fuzziness: 0.75,
      }),
      step('wallet', 'WALLET_OWNERSHIP', 3, {
        chains: ['bitcoin', 'ethereum', 'tron', 'solana'],
      }),
      step('sof-questionnaire', 'QUESTIONNAIRE', 4, { formId: 'crypto-source-of-funds-v1' }),
      step('device', 'DEVICE_INTELLIGENCE', 4),
    ],
    blockedCountries: ['PRK', 'IRN', 'SYR', 'CUB', 'USA'], // USA excluded: separate licensing
    manualReviewScore: 30,
    autoRejectScore: 75,
    screeningConfig: {
      ongoingMonitoring: true,
      frequency: 'DAILY',
      listTypes: ['SANCTIONS', 'PEP', 'ADVERSE_MEDIA'],
      fuzziness: 0.75,
    },
  }),

  'age-verification': LevelDefinitionSchema.parse({
    name: 'age-verification',
    displayName: 'Age Verification Only',
    description:
      'Proves an age threshold with the least data possible. Estimation first, document only on failure.',
    steps: [
      step('age-estimate', 'AGE_ESTIMATION', 0, { minAge: 18 }),
      // Fallback: only requested when estimation is inconclusive, so most users
      // never hand over a document at all.
      step('id-doc', 'IDENTITY_DOCUMENT', 1, {
        acceptedDocumentTypes: ['PASSPORT', 'ID_CARD', 'DRIVERS_LICENSE'],
        minAge: 18,
      }, { required: false }),
    ],
    manualReviewScore: 50,
    autoRejectScore: 90,
  }),

  'kyb-standard': LevelDefinitionSchema.parse({
    name: 'kyb-standard',
    displayName: 'Business Verification (KYB)',
    description:
      'Registry lookup, corporate documents, UBO discovery, and individual KYC for each owner.',
    subjectType: 'COMPANY',
    steps: [
      step('company-data', 'COMPANY_DATA', 0, {
        requiredFields: ['legalName', 'registrationNumber', 'country'],
      }),
      step('company-docs', 'COMPANY_DOCUMENTS', 1, {
        acceptedDocumentTypes: [
          'COMPANY_REGISTRATION', 'ARTICLES_OF_ASSOCIATION', 'SHAREHOLDER_REGISTRY',
        ],
      }),
      step('representative', 'REPRESENTATIVE_KYC', 1),
      step('ubo-discovery', 'UBO_DISCOVERY', 2, {
        uboThresholdPercent: 25,
        maxOwnershipDepth: 5,
      }),
      step('ubo-kyc', 'UBO_VERIFICATION', 3),
      step('screening', 'AML_SCREENING', 4, {
        listTypes: [
          'SANCTIONS', 'PEP', 'ADVERSE_MEDIA', 'REGULATORY_ENFORCEMENT',
          'DISQUALIFIED_DIRECTOR',
        ],
        fuzziness: 0.75,
      }),
    ],
    autoApprove: false,
    manualReviewScore: 25,
    autoRejectScore: 80,
    reverifyAfterDays: 365,
    screeningConfig: {
      ongoingMonitoring: true,
      frequency: 'WEEKLY',
      listTypes: ['SANCTIONS', 'PEP', 'ADVERSE_MEDIA'],
      fuzziness: 0.75,
    },
  }),

  'non-doc-verification': LevelDefinitionSchema.parse({
    name: 'non-doc-verification',
    displayName: 'Database Verification (no documents)',
    description:
      'Verifies identity against authoritative data sources. Lower friction, thinner evidence.',
    steps: [
      step('data', 'APPLICANT_DATA', 0, {
        requiredFields: ['firstName', 'lastName', 'dob', 'address', 'country'],
      }),
      step('phone', 'PHONE_VERIFICATION', 1),
      step('email', 'EMAIL_VERIFICATION', 1),
      step('tin', 'TIN_VALIDATION', 2, {}, { required: false }),
      step('screening', 'AML_SCREENING', 2, { listTypes: ['SANCTIONS', 'PEP'] }),
      step('device', 'DEVICE_INTELLIGENCE', 2),
    ],
    manualReviewScore: 30,
    autoRejectScore: 70,
  }),
};

/** Steps ordered for execution, grouped into concurrently-runnable waves. */
export function planSteps(level: { steps: StepDefinition[] }): StepDefinition[][] {
  const byOrder = new Map<number, StepDefinition[]>();
  for (const s of level.steps) {
    const bucket = byOrder.get(s.order) ?? [];
    bucket.push(s);
    byOrder.set(s.order, bucket);
  }
  return [...byOrder.entries()]
    .sort(([a], [b]) => a - b)
    .map(([, steps]) => steps.sort((a, b) => a.id.localeCompare(b.id)));
}

export function parseLevelSteps(raw: unknown): StepDefinition[] {
  const result = z.array(StepDefinitionSchema).safeParse(raw);
  return result.success ? result.data : [];
}

/**
 * Which required steps the applicant has not satisfied yet. This is what the
 * SDK renders and what the support agent quotes back to a confused applicant,
 * so it must be phrased in terms of what they still have to *do*.
 */
export function outstandingSteps(
  steps: StepDefinition[],
  completedStepIds: Set<string>,
): StepDefinition[] {
  return steps
    .filter((s) => s.required && !completedStepIds.has(s.id))
    .filter((s) => APPLICANT_FACING_STEPS.has(s.type))
    .sort((a, b) => a.order - b.order);
}
