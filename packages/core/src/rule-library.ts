import type { RuleDefinition } from './rules.js';
import { EMBARGOED_COUNTRIES, FATF_BLACKLIST, FATF_GREYLIST } from './countries.js';

/**
 * Default rulesets seeded for a new tenant.
 *
 * Priority convention:
 *   0-99    hard stops (legal bars). Nothing downstream can overturn these.
 *   100-199 fraud and document integrity.
 *   200-299 risk scoring contributions.
 *   300-399 routing, monitoring, and workflow.
 *   400+    transaction monitoring.
 *
 * Each rule reads as a sentence a compliance officer could have written, because
 * they are the ones who will maintain them.
 */

export const APPLICANT_RULES: RuleDefinition[] = [
  {
    name: 'embargoed-country-block',
    description:
      'Applicants resident in or holding documents from comprehensively sanctioned jurisdictions cannot be onboarded.',
    scope: 'APPLICANT_RISK',
    priority: 1,
    isActive: true,
    isShadow: false,
    conditions: {
      any: [
        { fact: 'applicant.country', op: 'in', value: [...EMBARGOED_COUNTRIES], label: 'residence country embargoed' },
        { fact: 'applicant.nationality', op: 'in', value: [...EMBARGOED_COUNTRIES], label: 'nationality embargoed' },
        { fact: 'document.issuingCountry', op: 'in', value: [...EMBARGOED_COUNTRIES], label: 'document issuer embargoed' },
      ],
    },
    actions: [
      { type: 'AUTO_REJECT', value: ['PROHIBITED_COUNTRY'], reason: 'Comprehensive sanctions programme' },
      { type: 'ADD_RISK', value: 100 },
      { type: 'ADD_TAG', value: ['embargoed-jurisdiction'] },
    ],
  },
  {
    name: 'confirmed-sanctions-match',
    description:
      'A sanctions hit an analyst confirmed as a true positive is a final rejection and a filing obligation.',
    scope: 'SCREENING',
    priority: 2,
    isActive: true,
    isShadow: false,
    conditions: {
      all: [
        { fact: 'screening.confirmedSanctionsHits', op: 'gte', value: 1, label: 'confirmed sanctions hits' },
      ],
    },
    actions: [
      { type: 'AUTO_REJECT', value: ['SANCTIONS_MATCH'] },
      { type: 'ADD_RISK', value: 100 },
      { type: 'CREATE_CASE', params: { type: 'AML_HIT_REVIEW', priority: 'CRITICAL' } },
      { type: 'NOTIFY_TEAM', params: { role: 'MLRO', urgency: 'immediate' } },
      { type: 'ADD_TAG', value: ['sanctions-confirmed'] },
    ],
  },
  {
    name: 'unresolved-sanctions-hit-requires-review',
    description:
      'Any open sanctions or wanted-list hit must be dispositioned by a human before onboarding proceeds.',
    scope: 'SCREENING',
    priority: 10,
    isActive: true,
    isShadow: false,
    conditions: {
      all: [
        { fact: 'screening.openHits', op: 'gte', value: 1 },
        {
          fact: 'screening.openHitListTypes',
          op: 'containsAny',
          value: ['SANCTIONS', 'WANTED', 'INTERNAL_BLOCKLIST'],
          label: 'open hit on a blocking list',
        },
      ],
    },
    actions: [
      { type: 'REQUIRE_MANUAL_REVIEW', reason: 'Open sanctions/wanted hit' },
      { type: 'ASSIGN_QUEUE', value: 'aml-hits' },
      { type: 'ADD_RISK', value: 55 },
      { type: 'CREATE_CASE', params: { type: 'AML_HIT_REVIEW', priority: 'HIGH' } },
    ],
  },
  {
    name: 'pep-requires-enhanced-diligence',
    description:
      'Politically exposed persons require EDD and senior sign-off; tier 1-2 exposure is treated as high risk.',
    scope: 'SCREENING',
    priority: 20,
    isActive: true,
    isShadow: false,
    conditions: {
      all: [
        { fact: 'screening.pepHits', op: 'gte', value: 1 },
        { fact: 'screening.maxPepTier', op: 'lte', value: 2, label: 'senior PEP tier' },
      ],
    },
    actions: [
      { type: 'REQUIRE_EDD', reason: 'Senior PEP exposure' },
      { type: 'ADD_RISK', value: 45 },
      { type: 'ASSIGN_QUEUE', value: 'edd-review' },
      { type: 'ENABLE_ONGOING_MONITORING' },
      { type: 'ADD_TAG', value: ['pep', 'edd-required'] },
    ],
  },
  {
    name: 'junior-pep-monitor',
    description: 'Lower-tier PEPs are onboarded with monitoring rather than full EDD.',
    scope: 'SCREENING',
    priority: 21,
    isActive: true,
    isShadow: false,
    conditions: {
      all: [
        { fact: 'screening.pepHits', op: 'gte', value: 1 },
        { fact: 'screening.maxPepTier', op: 'gte', value: 3 },
      ],
    },
    actions: [
      { type: 'ADD_RISK', value: 18 },
      { type: 'ENABLE_ONGOING_MONITORING' },
      { type: 'ADD_TAG', value: ['pep-junior'] },
    ],
  },
  {
    name: 'adverse-media-financial-crime',
    description:
      'Adverse media alleging financial crime warrants review even without a sanctions hit.',
    scope: 'SCREENING',
    priority: 30,
    isActive: true,
    isShadow: false,
    conditions: {
      all: [
        { fact: 'screening.adverseMediaHits', op: 'gte', value: 1 },
        {
          fact: 'screening.adverseMediaCategories',
          op: 'containsAny',
          value: ['fraud', 'money-laundering', 'terrorism-financing', 'corruption', 'sanctions-evasion'],
        },
      ],
    },
    actions: [
      { type: 'REQUIRE_MANUAL_REVIEW' },
      { type: 'ADD_RISK', value: 35 },
      { type: 'ASSIGN_QUEUE', value: 'aml-hits' },
      { type: 'ADD_TAG', value: ['adverse-media'] },
    ],
  },

  // --- Document integrity & fraud ---
  {
    name: 'document-forgery-detected',
    description: 'Authenticity checks indicating tampering are a final rejection.',
    scope: 'DOCUMENT',
    priority: 100,
    isActive: true,
    isShadow: false,
    conditions: {
      any: [
        { fact: 'document.authenticityScore', op: 'lt', value: 30, label: 'authenticity score critically low' },
        {
          fact: 'document.tamperFlags',
          op: 'containsAny',
          value: ['DIGITAL_EDIT', 'FONT_MISMATCH', 'PHOTO_SUBSTITUTION', 'TEMPLATE_MISMATCH'],
          label: 'tamper indicators present',
        },
      ],
    },
    actions: [
      { type: 'AUTO_REJECT', value: ['FORGED_DOCUMENT'] },
      { type: 'ADD_RISK', value: 100 },
      { type: 'CREATE_CASE', params: { type: 'FRAUD_INVESTIGATION', priority: 'HIGH' } },
      { type: 'ADD_TAG', value: ['suspected-forgery'] },
    ],
  },
  {
    name: 'presentation-attack-detected',
    description: 'Mask, replay, or deepfake detection during liveness is a final rejection.',
    scope: 'APPLICANT_RISK',
    priority: 101,
    isActive: true,
    isShadow: false,
    conditions: {
      any: [
        { fact: 'liveness.spoofDetected', op: 'eq', value: true },
        { fact: 'liveness.attackType', op: 'in', value: ['MASK', 'REPLAY', 'DEEPFAKE', 'PRINTED_PHOTO'] },
      ],
    },
    actions: [
      { type: 'AUTO_REJECT', value: ['SPOOF_ATTEMPT'] },
      { type: 'ADD_RISK', value: 95 },
      { type: 'CREATE_CASE', params: { type: 'FRAUD_INVESTIGATION', priority: 'CRITICAL' } },
    ],
  },
  {
    name: 'duplicate-face-different-identity',
    description:
      'The same face claiming a different identity is the strongest single synthetic-identity signal we have.',
    scope: 'APPLICANT_RISK',
    priority: 102,
    isActive: true,
    isShadow: false,
    conditions: {
      all: [
        { fact: 'duplicate.faceMatchCount', op: 'gte', value: 1 },
        { fact: 'duplicate.sameIdentity', op: 'eq', value: false },
      ],
    },
    actions: [
      { type: 'AUTO_REJECT', value: ['DUPLICATE_FACE'] },
      { type: 'ADD_RISK', value: 85 },
      { type: 'CREATE_CASE', params: { type: 'DUPLICATE_ACCOUNT', priority: 'HIGH' } },
    ],
  },
  {
    name: 'expired-document',
    description: 'Expired documents are rejected with a retry, since the applicant can fix it.',
    scope: 'DOCUMENT',
    priority: 110,
    isActive: true,
    isShadow: false,
    conditions: {
      all: [{ fact: 'document.expiryDate', op: 'olderThan', value: '0d', label: 'expiry in the past' }],
    },
    actions: [{ type: 'AUTO_REJECT', value: ['DOCUMENT_EXPIRED'] }],
  },
  {
    name: 'face-match-below-threshold',
    description: 'Selfie does not match the document portrait.',
    scope: 'APPLICANT_RISK',
    priority: 111,
    isActive: true,
    isShadow: false,
    conditions: {
      all: [
        { fact: 'faceMatch.score', op: 'exists' },
        { fact: 'faceMatch.score', op: 'lt', value: 0.8 },
      ],
    },
    actions: [
      { type: 'ADD_REJECT_LABEL', value: ['SELFIE_MISMATCH'] },
      { type: 'REQUIRE_MANUAL_REVIEW' },
      { type: 'ADD_RISK', value: 45 },
    ],
  },
  {
    name: 'mrz-checksum-failure',
    description:
      'Failed MRZ check digits mean either poor capture or a fabricated document; a human decides which.',
    scope: 'DOCUMENT',
    priority: 112,
    isActive: true,
    isShadow: false,
    conditions: { all: [{ fact: 'document.mrzValid', op: 'eq', value: false }] },
    actions: [
      { type: 'REQUIRE_MANUAL_REVIEW' },
      { type: 'ADD_REJECT_LABEL', value: ['MRZ_CHECKSUM_FAILED'] },
      { type: 'ADD_RISK', value: 40 },
    ],
  },
  {
    name: 'declared-data-mismatch',
    description: 'Self-declared identity fields disagree with the document.',
    scope: 'APPLICANT_RISK',
    priority: 120,
    isActive: true,
    isShadow: false,
    conditions: {
      any: [
        { fact: 'match.nameSimilarity', op: 'lt', value: 0.85, label: 'declared name vs document' },
        { fact: 'match.dobMatches', op: 'eq', value: false, label: 'declared dob vs document' },
      ],
    },
    actions: [
      { type: 'REQUIRE_MANUAL_REVIEW' },
      { type: 'ADD_REJECT_LABEL', value: ['DATA_MISMATCH'] },
      { type: 'ADD_RISK', value: 25 },
    ],
  },
  {
    name: 'underage-applicant',
    description: 'Below the minimum age for the service. Not retryable — age does not change on appeal.',
    scope: 'APPLICANT_RISK',
    priority: 121,
    isActive: true,
    isShadow: false,
    conditions: {
      all: [
        { fact: 'applicant.age', op: 'exists' },
        { fact: 'applicant.age', op: 'lt', value: 18 },
      ],
    },
    actions: [{ type: 'AUTO_REJECT', value: ['UNDERAGE'] }],
  },

  // --- Risk scoring contributions ---
  {
    name: 'fatf-blacklist-country-risk',
    description: 'FATF Call for Action jurisdictions carry the highest country risk weighting.',
    scope: 'APPLICANT_RISK',
    priority: 200,
    isActive: true,
    isShadow: false,
    conditions: {
      any: [
        { fact: 'applicant.country', op: 'in', value: [...FATF_BLACKLIST] },
        { fact: 'applicant.nationality', op: 'in', value: [...FATF_BLACKLIST] },
      ],
    },
    actions: [
      { type: 'ADD_RISK', value: 50 },
      { type: 'REQUIRE_EDD' },
      { type: 'ADD_TAG', value: ['fatf-blacklist'] },
    ],
  },
  {
    name: 'fatf-greylist-country-risk',
    scope: 'APPLICANT_RISK',
    description: 'FATF Increased Monitoring jurisdictions add moderate country risk.',
    priority: 201,
    isActive: true,
    isShadow: false,
    conditions: {
      any: [
        { fact: 'applicant.country', op: 'in', value: [...FATF_GREYLIST] },
        { fact: 'applicant.nationality', op: 'in', value: [...FATF_GREYLIST] },
      ],
    },
    actions: [
      { type: 'ADD_RISK', value: 20 },
      { type: 'ADD_TAG', value: ['fatf-greylist'] },
    ],
  },
  {
    name: 'anonymising-network-usage',
    description:
      'Tor or VPN use during verification is weak signal alone but compounds with other indicators.',
    scope: 'APPLICANT_RISK',
    priority: 210,
    isActive: true,
    isShadow: false,
    conditions: {
      any: [
        { fact: 'device.isTor', op: 'eq', value: true },
        { fact: 'device.isProxy', op: 'eq', value: true },
      ],
    },
    actions: [
      { type: 'ADD_RISK', value: 15 },
      { type: 'ADD_TAG', value: ['anonymising-network'] },
    ],
  },
  {
    name: 'emulator-or-rooted-device',
    description: 'Emulators and rooted devices are heavily over-represented in fraud farms.',
    scope: 'APPLICANT_RISK',
    priority: 211,
    isActive: true,
    isShadow: false,
    conditions: {
      any: [
        { fact: 'device.isEmulator', op: 'eq', value: true },
        { fact: 'device.isRooted', op: 'eq', value: true },
      ],
    },
    actions: [
      { type: 'ADD_RISK', value: 30 },
      { type: 'REQUIRE_MANUAL_REVIEW' },
      { type: 'ADD_TAG', value: ['device-integrity'] },
    ],
  },
  {
    name: 'geo-mismatch',
    description: 'IP country disagreeing with the document country is worth a look, not a block.',
    scope: 'APPLICANT_RISK',
    priority: 212,
    isActive: true,
    isShadow: false,
    conditions: {
      all: [
        { fact: 'applicant.ipCountry', op: 'exists' },
        { fact: 'applicant.country', op: 'exists' },
        { fact: 'match.countryMatches', op: 'eq', value: false },
      ],
    },
    actions: [
      { type: 'ADD_RISK', value: 10 },
      { type: 'ADD_TAG', value: ['geo-mismatch'] },
    ],
  },
  {
    name: 'disposable-contact-details',
    description: 'Disposable email or VOIP numbers correlate with throwaway accounts.',
    scope: 'APPLICANT_RISK',
    priority: 213,
    isActive: true,
    isShadow: false,
    conditions: {
      any: [
        { fact: 'contact.emailDisposable', op: 'eq', value: true },
        { fact: 'contact.phoneVoip', op: 'eq', value: true },
      ],
    },
    actions: [{ type: 'ADD_RISK', value: 12 }, { type: 'ADD_TAG', value: ['disposable-contact'] }],
  },
  {
    name: 'high-risk-occupation',
    description:
      'Occupations with structurally elevated ML risk. Not disqualifying, but they change the diligence owed.',
    scope: 'APPLICANT_RISK',
    priority: 214,
    isActive: true,
    isShadow: false,
    conditions: {
      all: [
        {
          fact: 'applicant.occupation',
          op: 'matches',
          value: '(casino|gambling|betting|arms|weapon|precious metal|antiquit|art dealer|crypto|money service|money transfer|shell|offshore)',
        },
      ],
    },
    actions: [{ type: 'ADD_RISK', value: 20 }, { type: 'ADD_TAG', value: ['high-risk-occupation'] }],
  },
  {
    name: 'multiple-weak-fraud-signals',
    description:
      'Individually tolerable signals become a review trigger in combination. Three or more is not coincidence.',
    scope: 'APPLICANT_RISK',
    priority: 220,
    isActive: true,
    isShadow: false,
    conditions: {
      atLeast: 3,
      of: [
        { fact: 'device.isVpn', op: 'eq', value: true },
        { fact: 'match.countryMatches', op: 'eq', value: false },
        { fact: 'contact.emailDisposable', op: 'eq', value: true },
        { fact: 'contact.emailAgeDays', op: 'lt', value: 30 },
        { fact: 'device.botScore', op: 'gte', value: 60 },
        { fact: 'applicant.submissionAttempts', op: 'gte', value: 3 },
        { fact: 'duplicate.deviceSharedWithCount', op: 'gte', value: 3 },
      ],
    },
    actions: [
      { type: 'REQUIRE_MANUAL_REVIEW', reason: 'Three or more weak fraud indicators co-occurring' },
      { type: 'ADD_RISK', value: 35 },
      { type: 'ASSIGN_QUEUE', value: 'fraud-review' },
      { type: 'ADD_TAG', value: ['compound-fraud-signals'] },
    ],
  },
  {
    name: 'shared-device-cluster',
    description: 'One device fingerprint behind many applicants suggests a signup farm.',
    scope: 'APPLICANT_RISK',
    priority: 221,
    isActive: true,
    isShadow: false,
    conditions: { all: [{ fact: 'duplicate.deviceSharedWithCount', op: 'gte', value: 5 }] },
    actions: [
      { type: 'REQUIRE_MANUAL_REVIEW' },
      { type: 'ADD_RISK', value: 40 },
      { type: 'CREATE_CASE', params: { type: 'FRAUD_INVESTIGATION', priority: 'MEDIUM' } },
      { type: 'ADD_TAG', value: ['device-cluster'] },
    ],
  },
  {
    name: 'duplicate-identity-existing-account',
    description: 'Same identity already verified under another account.',
    scope: 'APPLICANT_RISK',
    priority: 222,
    isActive: true,
    isShadow: false,
    conditions: { all: [{ fact: 'duplicate.identityMatchCount', op: 'gte', value: 1 }] },
    actions: [
      { type: 'REQUIRE_MANUAL_REVIEW' },
      { type: 'ADD_REJECT_LABEL', value: ['DUPLICATE_ACCOUNT'] },
      { type: 'ADD_RISK', value: 50 },
      { type: 'ASSIGN_QUEUE', value: 'fraud-review' },
    ],
  },

  // --- Workflow & routing ---
  {
    name: 'clean-low-risk-auto-approve',
    description:
      'Everything passed, nothing outstanding, low score: approve without human time. This is the rule that pays for the platform.',
    scope: 'APPLICANT_RISK',
    priority: 300,
    isActive: true,
    isShadow: false,
    conditions: {
      all: [
        { fact: 'checks.allRequiredPassed', op: 'eq', value: true },
        { fact: 'checks.failedCount', op: 'eq', value: 0 },
        { fact: 'checks.warningCount', op: 'eq', value: 0 },
        { fact: 'screening.openHits', op: 'eq', value: 0 },
        { fact: 'applicant.riskScore', op: 'lt', value: 30 },
        { fact: 'applicant.ddLevel', op: 'neq', value: 'EDD' },
      ],
    },
    actions: [{ type: 'AUTO_APPROVE', reason: 'All checks clean, low risk' }],
  },
  {
    name: 'edd-never-auto-approves',
    description:
      'Enhanced due diligence outcomes require a named human decision-maker. Non-negotiable.',
    scope: 'APPLICANT_RISK',
    priority: 301,
    isActive: true,
    isShadow: false,
    conditions: { all: [{ fact: 'applicant.ddLevel', op: 'eq', value: 'EDD' }] },
    actions: [
      { type: 'REQUIRE_MANUAL_REVIEW', reason: 'EDD requires human sign-off' },
      { type: 'ASSIGN_QUEUE', value: 'edd-review' },
    ],
  },
  {
    name: 'enable-monitoring-on-approval',
    description: 'Approved customers are screened continuously, not just at onboarding.',
    scope: 'ONGOING_MONITORING',
    priority: 310,
    isActive: true,
    isShadow: false,
    conditions: { all: [{ fact: 'applicant.reviewStatus', op: 'eq', value: 'APPROVED' }] },
    actions: [{ type: 'ENABLE_ONGOING_MONITORING' }],
  },
  {
    name: 'new-list-match-on-existing-customer',
    description:
      'A watchlist update matching an already-approved customer freezes the account pending review.',
    scope: 'ONGOING_MONITORING',
    priority: 311,
    isActive: true,
    isShadow: false,
    conditions: {
      all: [
        { fact: 'screening.trigger', op: 'in', value: ['ONGOING_MONITORING', 'LIST_UPDATE'] },
        { fact: 'screening.newHits', op: 'gte', value: 1 },
        { fact: 'applicant.reviewStatus', op: 'eq', value: 'APPROVED' },
      ],
    },
    actions: [
      { type: 'CREATE_CASE', params: { type: 'AML_HIT_REVIEW', priority: 'CRITICAL' } },
      { type: 'NOTIFY_TEAM', params: { role: 'COMPLIANCE_OFFICER', urgency: 'immediate' } },
      { type: 'ADD_TAG', value: ['monitoring-hit'] },
      { type: 'CREATE_ALERT', params: { title: 'Existing customer matched a watchlist update', severity: 'CRITICAL' } },
    ],
  },
];

export const COMPANY_RULES: RuleDefinition[] = [
  {
    name: 'company-dissolved',
    description: 'A dissolved or struck-off entity cannot be onboarded.',
    scope: 'COMPANY',
    priority: 50,
    isActive: true,
    isShadow: false,
    conditions: {
      all: [{ fact: 'company.status', op: 'in', value: ['DISSOLVED', 'LIQUIDATION'] }],
    },
    actions: [{ type: 'AUTO_REJECT', value: ['COMPANY_DISSOLVED'] }, { type: 'ADD_RISK', value: 60 }],
  },
  {
    name: 'ubo-chain-unresolved',
    description:
      'Ownership that does not resolve to natural persons is the classic laundering structure; it must be resolved, not waived.',
    scope: 'COMPANY',
    priority: 120,
    isActive: true,
    isShadow: false,
    conditions: {
      any: [
        { fact: 'company.uboUnresolved', op: 'eq', value: true },
        { fact: 'company.unresolvedOwnershipPercent', op: 'gte', value: 25 },
      ],
    },
    actions: [
      { type: 'REQUIRE_MANUAL_REVIEW' },
      { type: 'ADD_REJECT_LABEL', value: ['UBO_UNRESOLVED'] },
      { type: 'ADD_RISK', value: 55 },
      { type: 'ASSIGN_QUEUE', value: 'kyb-review' },
    ],
  },
  {
    name: 'nominee-shareholders-present',
    scope: 'COMPANY',
    description: 'Nominee holdings deliberately obscure control and require documentary rebuttal.',
    priority: 121,
    isActive: true,
    isShadow: false,
    conditions: { all: [{ fact: 'company.hasNomineeShareholders', op: 'eq', value: true }] },
    actions: [
      { type: 'REQUIRE_EDD' },
      { type: 'ADD_RISK', value: 40 },
      { type: 'REQUEST_DOCUMENT', value: ['UBO_DECLARATION', 'SHAREHOLDER_REGISTRY'] },
      { type: 'ADD_TAG', value: ['nominee-structure'] },
    ],
  },
  {
    name: 'offshore-layering',
    description:
      'Several layers of offshore intermediaries between the customer and its owners is a structuring indicator.',
    scope: 'COMPANY',
    priority: 122,
    isActive: true,
    isShadow: false,
    conditions: {
      all: [
        { fact: 'company.offshoreLayerCount', op: 'gte', value: 2 },
        { fact: 'company.uboDepth', op: 'gte', value: 3 },
      ],
    },
    actions: [
      { type: 'REQUIRE_EDD' },
      { type: 'ADD_RISK', value: 45 },
      { type: 'ADD_TAG', value: ['offshore-layering'] },
    ],
  },
  {
    name: 'sanctioned-ubo',
    description: 'A sanctioned beneficial owner sanctions the entity in substance (50% rule).',
    scope: 'COMPANY',
    priority: 3,
    isActive: true,
    isShadow: false,
    conditions: {
      all: [{ fact: 'company.sanctionedOwnershipPercent', op: 'gte', value: 50 }],
    },
    actions: [
      { type: 'AUTO_REJECT', value: ['SANCTIONS_MATCH'] },
      { type: 'ADD_RISK', value: 100 },
      { type: 'NOTIFY_TEAM', params: { role: 'MLRO', urgency: 'immediate' } },
    ],
  },
  {
    name: 'shell-company-indicators',
    description: 'No substance: no employees, no premises, no filings, recently incorporated.',
    scope: 'COMPANY',
    priority: 130,
    isActive: true,
    isShadow: false,
    conditions: {
      atLeast: 3,
      of: [
        { fact: 'company.employeeCount', op: 'lte', value: 1 },
        { fact: 'company.hasRegisteredOfficeOnly', op: 'eq', value: true },
        { fact: 'company.incorporatedDaysAgo', op: 'lt', value: 90 },
        { fact: 'company.filingsCount', op: 'eq', value: 0 },
        { fact: 'company.sharedAddressCompanyCount', op: 'gte', value: 20 },
      ],
    },
    actions: [
      { type: 'REQUIRE_MANUAL_REVIEW' },
      { type: 'ADD_RISK', value: 50 },
      { type: 'ADD_TAG', value: ['shell-indicators'] },
      { type: 'ASSIGN_QUEUE', value: 'kyb-review' },
    ],
  },
];

export const TRANSACTION_RULES: RuleDefinition[] = [
  {
    name: 'sanctioned-counterparty',
    description: 'Any transfer touching a sanctioned party is blocked before settlement, not after.',
    scope: 'TRANSACTION',
    priority: 400,
    isActive: true,
    isShadow: false,
    conditions: {
      any: [
        { fact: 'tx.counterpartySanctioned', op: 'eq', value: true },
        { fact: 'tx.counterpartyCountry', op: 'in', value: [...EMBARGOED_COUNTRIES] },
      ],
    },
    actions: [
      { type: 'BLOCK_TRANSACTION' },
      { type: 'CREATE_ALERT', params: { title: 'Sanctioned counterparty', severity: 'CRITICAL' } },
      { type: 'CREATE_CASE', params: { type: 'TRANSACTION_ALERT', priority: 'CRITICAL' } },
      { type: 'NOTIFY_TEAM', params: { role: 'MLRO', urgency: 'immediate' } },
    ],
  },
  {
    name: 'wallet-illicit-exposure',
    description: 'Direct exposure to darknet, mixer, or ransomware clusters blocks the transfer.',
    scope: 'TRANSACTION',
    priority: 401,
    isActive: true,
    isShadow: false,
    conditions: {
      all: [
        {
          fact: 'tx.walletCategories',
          op: 'containsAny',
          value: ['darknet', 'mixer', 'ransomware', 'sanctioned-entity', 'stolen-funds', 'terrorism-financing'],
        },
        { fact: 'tx.walletExposureHops', op: 'lte', value: 2 },
      ],
    },
    actions: [
      { type: 'BLOCK_TRANSACTION' },
      { type: 'CREATE_ALERT', params: { title: 'Illicit chain exposure within 2 hops', severity: 'CRITICAL' } },
      { type: 'CREATE_CASE', params: { type: 'TRANSACTION_ALERT', priority: 'CRITICAL' } },
    ],
  },
  {
    name: 'structuring-below-threshold',
    description:
      'Several transfers just under the reporting threshold in a short window is the textbook structuring pattern.',
    scope: 'TRANSACTION',
    priority: 410,
    isActive: true,
    isShadow: false,
    conditions: {
      all: [
        { fact: 'agg.count24h', op: 'gte', value: 3 },
        { fact: 'tx.amountBase', op: 'between', value: [8000, 10000] },
        { fact: 'agg.sum24h', op: 'gte', value: 24000 },
      ],
    },
    actions: [
      { type: 'FLAG_TRANSACTION' },
      { type: 'CREATE_ALERT', params: { title: 'Possible structuring', severity: 'HIGH' } },
      { type: 'CREATE_CASE', params: { type: 'TRANSACTION_ALERT', priority: 'HIGH' } },
    ],
  },
  {
    name: 'velocity-spike',
    description: 'Transaction volume far above the customer\'s own established baseline.',
    scope: 'TRANSACTION',
    priority: 411,
    isActive: true,
    isShadow: false,
    conditions: {
      all: [
        { fact: 'agg.sum24h', op: 'gt', value: 0 },
        { fact: 'agg.baselineDailyAvg', op: 'gt', value: 0 },
        { fact: 'agg.sum24hOverBaseline', op: 'gte', value: 5, label: '24h volume ≥ 5x baseline' },
      ],
    },
    actions: [
      { type: 'FLAG_TRANSACTION' },
      { type: 'CREATE_ALERT', params: { title: 'Velocity spike vs customer baseline', severity: 'MEDIUM' } },
    ],
  },
  {
    name: 'rapid-in-out-passthrough',
    description:
      'Funds in and straight back out with little retained balance: classic pass-through / mule behaviour.',
    scope: 'TRANSACTION',
    priority: 412,
    isActive: true,
    isShadow: false,
    conditions: {
      all: [
        { fact: 'tx.direction', op: 'eq', value: 'OUTBOUND' },
        { fact: 'agg.minutesSinceLastInbound', op: 'lte', value: 60 },
        { fact: 'agg.outboundToInboundRatio', op: 'gte', value: 0.9 },
        { fact: 'tx.amountBase', op: 'gte', value: 1000 },
      ],
    },
    actions: [
      { type: 'FLAG_TRANSACTION' },
      { type: 'CREATE_ALERT', params: { title: 'Rapid pass-through of funds', severity: 'HIGH' } },
      { type: 'ADD_TAG', value: ['passthrough'] },
    ],
  },
  {
    name: 'first-transaction-large',
    description: 'A large first transaction from a new customer deserves a look before it settles.',
    scope: 'TRANSACTION',
    priority: 420,
    isActive: true,
    isShadow: false,
    conditions: {
      all: [
        { fact: 'agg.lifetimeCount', op: 'lte', value: 1 },
        { fact: 'tx.amountBase', op: 'gte', value: 10000 },
      ],
    },
    actions: [
      { type: 'HOLD_TRANSACTION' },
      { type: 'CREATE_ALERT', params: { title: 'Large first transaction', severity: 'MEDIUM' } },
    ],
  },
  {
    name: 'high-risk-jurisdiction-transfer',
    scope: 'TRANSACTION',
    description: 'Transfers to FATF-listed jurisdictions are monitored and reported on.',
    priority: 421,
    isActive: true,
    isShadow: false,
    conditions: {
      all: [
        { fact: 'tx.counterpartyCountry', op: 'in', value: [...FATF_BLACKLIST, ...FATF_GREYLIST] },
        { fact: 'tx.amountBase', op: 'gte', value: 1000 },
      ],
    },
    actions: [
      { type: 'FLAG_TRANSACTION' },
      { type: 'CREATE_ALERT', params: { title: 'Transfer to FATF-listed jurisdiction', severity: 'MEDIUM' } },
    ],
  },
  {
    name: 'travel-rule-threshold',
    description:
      'Crypto transfers at or above the threshold require originator/beneficiary data exchange (FATF R16).',
    scope: 'TRANSACTION',
    priority: 430,
    isActive: true,
    isShadow: false,
    conditions: {
      all: [
        { fact: 'tx.isCrypto', op: 'eq', value: true },
        { fact: 'tx.amountBase', op: 'gte', value: 1000 },
      ],
    },
    actions: [
      { type: 'SET_FACT', value: true, params: { name: 'tx.travelRuleRequired' } },
      { type: 'ADD_TAG', value: ['travel-rule'] },
    ],
  },
  {
    name: 'unverified-customer-transacting',
    description: 'Transactions from an unverified or frozen customer must not settle.',
    scope: 'TRANSACTION',
    priority: 402,
    isActive: true,
    isShadow: false,
    conditions: {
      all: [
        { fact: 'applicant.reviewStatus', op: 'nin', value: ['APPROVED'] },
        { fact: 'tx.amountBase', op: 'gt', value: 0 },
      ],
    },
    actions: [
      { type: 'BLOCK_TRANSACTION' },
      { type: 'CREATE_ALERT', params: { title: 'Transaction from an unverified customer', severity: 'HIGH' } },
    ],
  },
];

/**
 * Support routing rules. The agentic layer consults these before it decides
 * whether it may handle a ticket itself.
 */
export const SUPPORT_RULES: RuleDefinition[] = [
  {
    name: 'final-rejection-appeals-need-human',
    description:
      'Appeals against a final rejection are a compliance decision and never an AI decision.',
    scope: 'SUPPORT_ROUTING',
    priority: 10,
    isActive: true,
    isShadow: false,
    conditions: {
      all: [
        { fact: 'ticket.intent', op: 'eq', value: 'APPEAL_DECISION' },
        { fact: 'applicant.reviewStatus', op: 'eq', value: 'REJECTED_FINAL' },
      ],
    },
    actions: [
      { type: 'REQUIRE_HUMAN_HANDOFF', reason: 'Final rejection appeal' },
      { type: 'CREATE_CASE', params: { type: 'APPEAL', priority: 'HIGH' } },
    ],
  },
  {
    name: 'screening-disputes-need-human',
    description:
      'Someone contesting a sanctions match is disputing a legal determination; an analyst must own it.',
    scope: 'SUPPORT_ROUTING',
    priority: 11,
    isActive: true,
    isShadow: false,
    conditions: { all: [{ fact: 'ticket.intent', op: 'eq', value: 'SCREENING_DISPUTE' }] },
    actions: [
      { type: 'REQUIRE_HUMAN_HANDOFF', reason: 'Sanctions/PEP determination dispute' },
      { type: 'ASSIGN_QUEUE', value: 'aml-hits' },
    ],
  },
  {
    name: 'data-subject-rights-need-human',
    description: 'GDPR erasure and access requests carry statutory deadlines and legal exemptions.',
    scope: 'SUPPORT_ROUTING',
    priority: 12,
    isActive: true,
    isShadow: false,
    conditions: {
      all: [{ fact: 'ticket.intent', op: 'in', value: ['DATA_DELETION', 'DATA_CORRECTION'] }],
    },
    actions: [
      { type: 'REQUIRE_HUMAN_HANDOFF', reason: 'Data subject rights request' },
      { type: 'CREATE_CASE', params: { type: 'DATA_SUBJECT_REQUEST', priority: 'HIGH' } },
    ],
  },
  {
    name: 'fraud-reports-need-human',
    scope: 'SUPPORT_ROUTING',
    description: 'An applicant reporting identity theft needs an investigator, immediately.',
    priority: 13,
    isActive: true,
    isShadow: false,
    conditions: { all: [{ fact: 'ticket.intent', op: 'eq', value: 'FRAUD_REPORT' }] },
    actions: [
      { type: 'REQUIRE_HUMAN_HANDOFF', reason: 'Fraud report' },
      { type: 'CREATE_CASE', params: { type: 'FRAUD_INVESTIGATION', priority: 'HIGH' } },
      { type: 'NOTIFY_TEAM', params: { role: 'COMPLIANCE_OFFICER', urgency: 'high' } },
    ],
  },
  {
    name: 'repeat-contact-escalates',
    description:
      'A third contact on the same issue means the agent is not solving it. Stop retrying and hand over.',
    scope: 'SUPPORT_ROUTING',
    priority: 20,
    isActive: true,
    isShadow: false,
    conditions: { all: [{ fact: 'ticket.priorTicketsSameIntent', op: 'gte', value: 2 }] },
    actions: [{ type: 'ESCALATE', reason: 'Third contact on the same issue' }],
  },
  {
    name: 'complaints-escalate',
    scope: 'SUPPORT_ROUTING',
    description: 'Regulated firms must log and route complaints to a human owner.',
    priority: 21,
    isActive: true,
    isShadow: false,
    conditions: {
      any: [
        { fact: 'ticket.intent', op: 'eq', value: 'COMPLAINT' },
        { fact: 'ticket.sentiment', op: 'lte', value: -0.6 },
        { fact: 'ticket.mentionsRegulator', op: 'eq', value: true },
      ],
    },
    actions: [
      { type: 'REQUIRE_HUMAN_HANDOFF', reason: 'Complaint handling obligation' },
      { type: 'ASSIGN_QUEUE', value: 'complaints' },
    ],
  },
  {
    name: 'routine-status-questions-stay-with-agent',
    description:
      'Status, upload help, and timeline questions are exactly what the agent should own end to end.',
    scope: 'SUPPORT_ROUTING',
    priority: 100,
    isActive: true,
    isShadow: false,
    conditions: {
      all: [
        {
          fact: 'ticket.intent',
          op: 'in',
          value: [
            'VERIFICATION_STATUS', 'UPLOAD_HELP', 'TIMELINE_QUESTION',
            'DOCUMENT_REJECTED', 'LIVENESS_FAILURE', 'TECHNICAL_ISSUE',
          ],
        },
      ],
    },
    actions: [{ type: 'ROUTE_TO_SUPPORT_AGENT', value: 'kyc-support-agent' }],
  },
];

export const ALL_DEFAULT_RULES: RuleDefinition[] = [
  ...APPLICANT_RULES,
  ...COMPANY_RULES,
  ...TRANSACTION_RULES,
  ...SUPPORT_RULES,
];
