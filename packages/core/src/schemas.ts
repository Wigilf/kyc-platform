import { z } from 'zod';
import { SUPPORT_INTENTS } from './support.js';
import { DocumentTypeEnum, LevelDefinitionSchema, StepDefinitionSchema } from './levels.js';

/**
 * API request/response schemas. Single source of truth: the API validates
 * against these, the OpenAPI document is generated from them, and the dashboard
 * and WebSDK import the inferred types.
 */

const Alpha3 = z
  .string()
  .length(3)
  .regex(/^[A-Za-z]{3}$/, 'expected an ISO 3166-1 alpha-3 country code')
  .transform((s) => s.toUpperCase());

const IsoDate = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/, 'expected YYYY-MM-DD')
  .refine((s) => !Number.isNaN(Date.parse(s)), 'not a real date');

export const AddressSchema = z.object({
  line1: z.string().min(1).max(200),
  line2: z.string().max(200).optional(),
  city: z.string().min(1).max(120),
  state: z.string().max(120).optional(),
  postCode: z.string().max(32).optional(),
  country: Alpha3,
});

export const ApplicantInfoSchema = z.object({
  firstName: z.string().min(1).max(120).optional(),
  middleName: z.string().max(120).optional(),
  lastName: z.string().min(1).max(120).optional(),
  /** Some jurisdictions record a single unsplit name; keep both options open. */
  fullName: z.string().max(300).optional(),
  dob: IsoDate.optional(),
  placeOfBirth: z.string().max(200).optional(),
  gender: z.enum(['M', 'F', 'X']).optional(),
  nationality: Alpha3.optional(),
  country: Alpha3.optional(),
  email: z.string().email().max(320).optional(),
  phone: z.string().min(5).max(32).optional(),
  address: AddressSchema.optional(),
  occupation: z.string().max(200).optional(),
  employerName: z.string().max(200).optional(),
  taxResidency: Alpha3.optional(),
  taxId: z.string().max(64).optional(),
  /** Applicant's own declaration; screening does not rely on it. */
  isPep: z.boolean().optional(),
  expectedMonthlyVolume: z.number().nonnegative().optional(),
  sourceOfFunds: z.string().max(500).optional(),
});

export const CreateApplicantSchema = z.object({
  externalUserId: z.string().min(1).max(200),
  levelName: z.string().min(1).max(120),
  subjectType: z.enum(['INDIVIDUAL', 'COMPANY']).default('INDIVIDUAL'),
  info: ApplicantInfoSchema.optional(),
  email: z.string().email().optional(),
  phone: z.string().optional(),
  lang: z.string().length(2).default('en'),
  sourceKey: z.string().max(120).optional(),
  tags: z.array(z.string().max(64)).max(32).default([]),
  metadata: z.record(z.unknown()).default({}),
  /** Client-supplied applicant context for fraud signals. */
  ipAddress: z.string().max(64).optional(),
  userAgent: z.string().max(512).optional(),
});

export const UpdateApplicantSchema = z.object({
  info: ApplicantInfoSchema.optional(),
  tags: z.array(z.string().max(64)).max(32).optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const ListApplicantsQuerySchema = z.object({
  reviewStatus: z
    .enum([
      'NOT_STARTED', 'PENDING', 'QUEUED', 'ON_HOLD',
      'APPROVED', 'REJECTED_RETRY', 'REJECTED_FINAL',
    ])
    .optional(),
  riskLevel: z.enum(['LOW', 'MEDIUM', 'HIGH', 'CRITICAL']).optional(),
  levelName: z.string().optional(),
  country: Alpha3.optional(),
  tag: z.string().optional(),
  search: z.string().max(200).optional(),
  createdAfter: z.string().datetime().optional(),
  createdBefore: z.string().datetime().optional(),
  /** Opaque cursor. Keyset pagination, because offsets drift under live inserts. */
  cursor: z.string().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(25),
  sort: z.enum(['createdAt', 'updatedAt', 'riskScore']).default('createdAt'),
  order: z.enum(['asc', 'desc']).default('desc'),
});

/**
 * A chip read forwarded by a mobile app.
 *
 * Base64 rather than binary because it arrives as JSON, and capped because a
 * data group is kilobytes — a megabyte of "DG2" is somebody probing, not a
 * portrait. The security object is required: without it there is nothing to
 * verify the rest against, and accepting a bag of unverifiable data groups
 * would be indistinguishable from accepting anything the phone chose to send.
 */
export const NfcSubmissionSchema = z.object({
  dataGroups: z
    .record(z.string().regex(/^[A-Za-z0-9_]{2,10}$/), z.string().base64().max(500_000))
    .refine((groups) => 'SOD' in groups || 'EF_SOD' in groups, {
      message: 'A security object (SOD) is required; without it nothing can be verified.',
    }),
  documentNumber: z.string().min(1).max(20),
  /** YYMMDD, as it appears in the machine-readable zone. */
  dateOfBirth: z.string().regex(/^\d{6}$/),
  dateOfExpiry: z.string().regex(/^\d{6}$/),
});

export const UploadDocumentMetaSchema = z.object({
  type: DocumentTypeEnum,
  subType: z.enum(['FRONT_SIDE', 'BACK_SIDE', 'BOTH_SIDES', 'PAGE']).default('FRONT_SIDE'),
  country: Alpha3.optional(),
  number: z.string().max(64).optional(),
  issuedDate: IsoDate.optional(),
  expiryDate: IsoDate.optional(),
  capturedBy: z
    .enum(['UPLOAD', 'WEB_SDK_CAMERA', 'MOBILE_SDK_CAMERA', 'NFC_CHIP', 'API'])
    .default('API'),
});

export const SubmitDecisionSchema = z.object({
  decision: z.enum(['APPROVED', 'REJECTED_RETRY', 'REJECTED_FINAL', 'ON_HOLD']),
  rejectLabels: z.array(z.string()).default([]),
  clientComment: z.string().max(2000).optional(),
  moderationComment: z.string().max(4000).optional(),
})
  .refine(
    (v) => v.decision === 'APPROVED' || v.decision === 'ON_HOLD' || v.rejectLabels.length > 0,
    { message: 'a rejection must carry at least one reject label', path: ['rejectLabels'] },
  );

export const CreateLevelSchema = LevelDefinitionSchema;
export const UpdateLevelStepsSchema = z.object({
  steps: z.array(StepDefinitionSchema).min(1),
  changeNote: z.string().max(500).optional(),
});

export const ScreeningRequestSchema = z.object({
  applicantId: z.string().optional(),
  companyId: z.string().optional(),
  name: z.string().min(2).max(300),
  dob: IsoDate.optional(),
  country: Alpha3.optional(),
  entityType: z.enum(['INDIVIDUAL', 'COMPANY']).default('INDIVIDUAL'),
  listTypes: z
    .array(
      z.enum([
        'SANCTIONS', 'PEP', 'ADVERSE_MEDIA', 'WANTED',
        'REGULATORY_ENFORCEMENT', 'INTERNAL_BLOCKLIST', 'DISQUALIFIED_DIRECTOR',
      ]),
    )
    .default(['SANCTIONS', 'PEP']),
  fuzziness: z.number().min(0).max(1).default(0.75),
  trigger: z
    .enum([
      'INITIAL', 'RESUBMISSION', 'ONGOING_MONITORING',
      'LIST_UPDATE', 'MANUAL', 'PERIODIC_REVIEW',
    ])
    .default('MANUAL'),
});

export const ResolveHitSchema = z.object({
  resolution: z.enum(['TRUE_POSITIVE', 'FALSE_POSITIVE', 'UNABLE_TO_DETERMINE']),
  note: z.string().min(1).max(4000),
  /** Suppress future identical matches for this applicant. */
  addToAllowlist: z.boolean().default(false),
});

export const CreateCompanySchema = z.object({
  externalUserId: z.string().min(1).max(200),
  levelName: z.string().min(1),
  legalName: z.string().min(1).max(300),
  tradingName: z.string().max(300).optional(),
  registrationNumber: z.string().max(64).optional(),
  taxId: z.string().max(64).optional(),
  lei: z.string().length(20).optional(),
  country: Alpha3,
  jurisdiction: z.string().max(120).optional(),
  legalForm: z.string().max(120).optional(),
  incorporatedAt: IsoDate.optional(),
  registeredAddress: AddressSchema.optional(),
  website: z.string().url().optional(),
  industryCodes: z.array(z.string().max(32)).default([]),
});

export const AddOwnershipEdgeSchema = z.object({
  childCompanyId: z.string().min(1),
  parentCompanyId: z.string().optional(),
  parentPersonName: z.string().max(300).optional(),
  parentPersonDob: IsoDate.optional(),
  parentPersonCountry: Alpha3.optional(),
  ownershipPercent: z.number().min(0).max(100),
  votingPercent: z.number().min(0).max(100).optional(),
  controlType: z
    .enum(['SHARES', 'VOTING_RIGHTS', 'BOARD_APPOINTMENT', 'SIGNIFICANT_INFLUENCE', 'OTHER_CONTROL'])
    .default('SHARES'),
  isNominee: z.boolean().default(false),
  source: z.string().max(64).optional(),
}).refine(
  (v) => Boolean(v.parentCompanyId) !== Boolean(v.parentPersonName),
  { message: 'exactly one of parentCompanyId or parentPersonName is required' },
);

export const IngestTransactionSchema = z.object({
  externalId: z.string().min(1).max(200),
  applicantExternalUserId: z.string().max(200).optional(),
  direction: z.enum(['INBOUND', 'OUTBOUND', 'INTERNAL']),
  type: z
    .enum(['TRANSFER', 'DEPOSIT', 'WITHDRAWAL', 'CARD_PAYMENT', 'TRADE', 'EXCHANGE', 'REFUND', 'FEE', 'PAYOUT'])
    .default('TRANSFER'),
  amount: z.number().positive(),
  currency: z.string().length(3),
  /** Optional pre-converted amount; the worker converts when absent. */
  amountBase: z.number().positive().optional(),
  counterpartyName: z.string().max(300).optional(),
  counterpartyCountry: Alpha3.optional(),
  counterpartyAccount: z.string().max(64).optional(),
  counterpartyWallet: z.string().max(128).optional(),
  chain: z.string().max(32).optional(),
  txHash: z.string().max(128).optional(),
  paymentMethod: z.string().max(64).optional(),
  deviceId: z.string().max(128).optional(),
  ipAddress: z.string().max(64).optional(),
  occurredAt: z.string().datetime(),
  metadata: z.record(z.unknown()).default({}),
});

export const CreateWebhookSchema = z.object({
  url: z.string().url().refine((u) => u.startsWith('https://') || u.includes('localhost'), {
    message: 'webhook URLs must use https outside local development',
  }),
  description: z.string().max(200).optional(),
  eventTypes: z.array(z.string()).min(1),
  environment: z.enum(['SANDBOX', 'PRODUCTION']).default('SANDBOX'),
});

export const CreateSdkTokenSchema = z.object({
  externalUserId: z.string().min(1).max(200),
  levelName: z.string().min(1),
  /** Token lifetime in seconds. Short by default; the SDK refreshes. */
  ttlSeconds: z.number().int().min(60).max(86_400).default(3600),
});

export const CreateSupportTicketSchema = z.object({
  applicantExternalUserId: z.string().max(200).optional(),
  applicantId: z.string().optional(),
  channel: z
    .enum(['WEB_SDK', 'MOBILE_SDK', 'EMAIL', 'CHAT_WIDGET', 'API', 'WHATSAPP', 'SLACK', 'PHONE_TRANSCRIPT'])
    .default('API'),
  subject: z.string().min(1).max(300),
  message: z.string().min(1).max(8000),
  language: z.string().length(2).default('en'),
  intent: z.enum(SUPPORT_INTENTS).optional(),
  metadata: z.record(z.unknown()).default({}),
});

export const PostSupportMessageSchema = z.object({
  message: z.string().min(1).max(8000),
  /** When set, the message is from a human agent rather than the applicant. */
  asHumanAgent: z.boolean().default(false),
});

export const ResolveEscalationSchema = z.object({
  humanResolution: z.string().min(1).max(4000),
  returnToAgent: z.boolean().default(false),
  csatRequested: z.boolean().default(false),
});

export const CreateRuleSchema = z.object({
  name: z.string().min(1).max(120),
  description: z.string().max(500).optional(),
  scope: z.enum([
    'APPLICANT_RISK', 'DOCUMENT', 'SCREENING', 'TRANSACTION',
    'ONGOING_MONITORING', 'COMPANY', 'SUPPORT_ROUTING',
  ]),
  priority: z.number().int().min(0).max(10_000).default(100),
  isActive: z.boolean().default(true),
  isShadow: z.boolean().default(false),
  conditions: z.unknown(),
  actions: z.array(z.unknown()).default([]),
  changeNote: z.string().max(500).optional(),
});

export const ReportRequestSchema = z.object({
  type: z.enum([
    'APPLICANT_EXPORT', 'DECISION_AUDIT', 'SAR_PACKAGE', 'SCREENING_SUMMARY',
    'TRANSACTION_MONITORING', 'CONVERSION_FUNNEL', 'AGENT_PERFORMANCE',
    'REGULATORY_PERIODIC', 'DATA_SUBJECT_ACCESS',
  ]),
  from: z.string().datetime().optional(),
  to: z.string().datetime().optional(),
  format: z.enum(['csv', 'json']).default('csv'),
  parameters: z.record(z.unknown()).default({}),
});

export type CreateApplicantInput = z.infer<typeof CreateApplicantSchema>;
export type ApplicantInfoInput = z.infer<typeof ApplicantInfoSchema>;
export type UploadDocumentMeta = z.infer<typeof UploadDocumentMetaSchema>;
export type SubmitDecisionInput = z.infer<typeof SubmitDecisionSchema>;
export type ScreeningRequestInput = z.infer<typeof ScreeningRequestSchema>;
export type IngestTransactionInput = z.infer<typeof IngestTransactionSchema>;
export type CreateSupportTicketInput = z.infer<typeof CreateSupportTicketSchema>;
export type CreateCompanyInput = z.infer<typeof CreateCompanySchema>;
export type ListApplicantsQuery = z.infer<typeof ListApplicantsQuerySchema>;
