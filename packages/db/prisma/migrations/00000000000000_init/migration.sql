-- CreateSchema
CREATE SCHEMA IF NOT EXISTS "public";

-- CreateEnum
CREATE TYPE "Industry" AS ENUM ('FINTECH', 'CRYPTO', 'BANKING', 'GAMBLING', 'MARKETPLACE', 'LENDING', 'INSURANCE', 'TRAVEL', 'OTHER');

-- CreateEnum
CREATE TYPE "Env" AS ENUM ('SANDBOX', 'PRODUCTION');

-- CreateEnum
CREATE TYPE "UserRole" AS ENUM ('OWNER', 'ADMIN', 'COMPLIANCE_OFFICER', 'MLRO', 'AGENT', 'AUDITOR', 'AI_AGENT');

-- CreateEnum
CREATE TYPE "SubjectType" AS ENUM ('INDIVIDUAL', 'COMPANY');

-- CreateEnum
CREATE TYPE "ApplicantStatus" AS ENUM ('INIT', 'PENDING', 'AWAITING_USER', 'QUEUED', 'PROCESSING', 'ON_HOLD', 'COMPLETED');

-- CreateEnum
CREATE TYPE "ReviewStatus" AS ENUM ('NOT_STARTED', 'PENDING', 'QUEUED', 'ON_HOLD', 'APPROVED', 'REJECTED_RETRY', 'REJECTED_FINAL');

-- CreateEnum
CREATE TYPE "RiskLevel" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "DdLevel" AS ENUM ('SDD', 'CDD', 'EDD');

-- CreateEnum
CREATE TYPE "ActorType" AS ENUM ('SYSTEM', 'USER', 'APPLICANT', 'AI_AGENT', 'API', 'SCHEDULER');

-- CreateEnum
CREATE TYPE "ConsentType" AS ENUM ('TERMS_OF_SERVICE', 'PRIVACY_POLICY', 'BIOMETRIC_PROCESSING', 'DATA_SHARING', 'ONGOING_MONITORING');

-- CreateEnum
CREATE TYPE "DocumentType" AS ENUM ('PASSPORT', 'ID_CARD', 'DRIVERS_LICENSE', 'RESIDENCE_PERMIT', 'VISA', 'SELFIE', 'VIDEO_SELFIE', 'PROOF_OF_ADDRESS', 'BANK_STATEMENT', 'UTILITY_BILL', 'PAYSLIP', 'TAX_DOCUMENT', 'SOURCE_OF_FUNDS', 'COMPANY_REGISTRATION', 'ARTICLES_OF_ASSOCIATION', 'SHAREHOLDER_REGISTRY', 'UBO_DECLARATION', 'POWER_OF_ATTORNEY', 'OTHER');

-- CreateEnum
CREATE TYPE "DocumentSubType" AS ENUM ('FRONT_SIDE', 'BACK_SIDE', 'BOTH_SIDES', 'PAGE');

-- CreateEnum
CREATE TYPE "DocumentStatus" AS ENUM ('UPLOADED', 'PROCESSING', 'EXTRACTED', 'VERIFIED', 'REJECTED', 'EXPIRED', 'SUPERSEDED');

-- CreateEnum
CREATE TYPE "CaptureMethod" AS ENUM ('UPLOAD', 'WEB_SDK_CAMERA', 'MOBILE_SDK_CAMERA', 'NFC_CHIP', 'API');

-- CreateEnum
CREATE TYPE "CheckType" AS ENUM ('DOCUMENT_OCR', 'DOCUMENT_AUTHENTICITY', 'MRZ_VALIDATION', 'NFC_CHIP', 'LIVENESS', 'FACE_MATCH', 'DUPLICATE_FACE', 'DUPLICATE_IDENTITY', 'AML_SCREENING', 'ADVERSE_MEDIA', 'PROOF_OF_ADDRESS', 'AGE_ESTIMATION', 'TIN_VALIDATION', 'BANK_ACCOUNT', 'PHONE_RISK', 'EMAIL_RISK', 'IP_GEOLOCATION', 'DEVICE_FINGERPRINT', 'BEHAVIORAL_BIOMETRICS', 'COMPANY_REGISTRY', 'UBO_DISCOVERY', 'WALLET_SCREENING', 'SANCTIONED_COUNTRY', 'QUESTIONNAIRE', 'APPLICANT_DATA', 'MANUAL');

-- CreateEnum
CREATE TYPE "CheckStatus" AS ENUM ('PENDING', 'RUNNING', 'COMPLETED', 'FAILED', 'SKIPPED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "CheckResult" AS ENUM ('PASS', 'FAIL', 'WARNING', 'INCONCLUSIVE');

-- CreateEnum
CREATE TYPE "ReviewDecision" AS ENUM ('APPROVED', 'REJECTED_RETRY', 'REJECTED_FINAL', 'ON_HOLD', 'ESCALATED');

-- CreateEnum
CREATE TYPE "ReviewSource" AS ENUM ('AUTOMATED', 'MANUAL', 'AI_ASSISTED', 'API');

-- CreateEnum
CREATE TYPE "WatchlistType" AS ENUM ('SANCTIONS', 'PEP', 'ADVERSE_MEDIA', 'WANTED', 'REGULATORY_ENFORCEMENT', 'INTERNAL_BLOCKLIST', 'INTERNAL_ALLOWLIST', 'DISQUALIFIED_DIRECTOR');

-- CreateEnum
CREATE TYPE "ScreeningTrigger" AS ENUM ('INITIAL', 'RESUBMISSION', 'ONGOING_MONITORING', 'LIST_UPDATE', 'MANUAL', 'PERIODIC_REVIEW');

-- CreateEnum
CREATE TYPE "HitStatus" AS ENUM ('OPEN', 'IN_REVIEW', 'RESOLVED', 'SUPPRESSED');

-- CreateEnum
CREATE TYPE "HitResolution" AS ENUM ('TRUE_POSITIVE', 'FALSE_POSITIVE', 'UNABLE_TO_DETERMINE');

-- CreateEnum
CREATE TYPE "MonitoringFrequency" AS ENUM ('DAILY', 'WEEKLY', 'MONTHLY', 'QUARTERLY');

-- CreateEnum
CREATE TYPE "CompanyStatus" AS ENUM ('PENDING', 'ACTIVE', 'DISSOLVED', 'LIQUIDATION', 'SUSPENDED', 'UNKNOWN');

-- CreateEnum
CREATE TYPE "PositionRole" AS ENUM ('DIRECTOR', 'SHADOW_DIRECTOR', 'SECRETARY', 'OFFICER', 'SIGNATORY', 'SHAREHOLDER', 'UBO', 'TRUSTEE', 'SETTLOR', 'BENEFICIARY', 'NOMINEE', 'LEGAL_REPRESENTATIVE');

-- CreateEnum
CREATE TYPE "ControlType" AS ENUM ('SHARES', 'VOTING_RIGHTS', 'BOARD_APPOINTMENT', 'SIGNIFICANT_INFLUENCE', 'OTHER_CONTROL');

-- CreateEnum
CREATE TYPE "TxDirection" AS ENUM ('INBOUND', 'OUTBOUND', 'INTERNAL');

-- CreateEnum
CREATE TYPE "TxType" AS ENUM ('TRANSFER', 'DEPOSIT', 'WITHDRAWAL', 'CARD_PAYMENT', 'TRADE', 'EXCHANGE', 'REFUND', 'FEE', 'PAYOUT');

-- CreateEnum
CREATE TYPE "TxStatus" AS ENUM ('PENDING', 'APPROVED', 'BLOCKED', 'REVERSED', 'SETTLED', 'UNDER_REVIEW');

-- CreateEnum
CREATE TYPE "RuleScope" AS ENUM ('APPLICANT_RISK', 'DOCUMENT', 'SCREENING', 'TRANSACTION', 'ONGOING_MONITORING', 'COMPANY', 'SUPPORT_ROUTING');

-- CreateEnum
CREATE TYPE "Severity" AS ENUM ('LOW', 'MEDIUM', 'HIGH', 'CRITICAL');

-- CreateEnum
CREATE TYPE "AlertStatus" AS ENUM ('OPEN', 'IN_CASE', 'DISMISSED', 'ESCALATED', 'CLOSED');

-- CreateEnum
CREATE TYPE "TravelRuleStatus" AS ENUM ('PENDING', 'SENT', 'ACCEPTED', 'REJECTED', 'UNSUPPORTED_COUNTERPARTY', 'EXEMPT', 'FAILED');

-- CreateEnum
CREATE TYPE "ShareStatus" AS ENUM ('REQUESTED', 'CONSENTED', 'DECLINED', 'REVOKED', 'EXPIRED');

-- CreateEnum
CREATE TYPE "CaseType" AS ENUM ('MANUAL_REVIEW', 'AML_HIT_REVIEW', 'FRAUD_INVESTIGATION', 'TRANSACTION_ALERT', 'DOCUMENT_ISSUE', 'KYB_REVIEW', 'UBO_RESOLUTION', 'DUPLICATE_ACCOUNT', 'APPEAL', 'SUPPORT_ESCALATION', 'PERIODIC_REVIEW', 'DATA_SUBJECT_REQUEST');

-- CreateEnum
CREATE TYPE "CaseStatus" AS ENUM ('OPEN', 'ASSIGNED', 'IN_PROGRESS', 'WAITING_ON_APPLICANT', 'WAITING_ON_THIRD_PARTY', 'ESCALATED', 'RESOLVED', 'CLOSED');

-- CreateEnum
CREATE TYPE "CaseOutcome" AS ENUM ('APPROVED', 'REJECTED', 'NO_ACTION', 'SAR_FILED', 'ACCOUNT_CLOSED', 'FALSE_POSITIVE', 'DUPLICATE');

-- CreateEnum
CREATE TYPE "DeliveryStatus" AS ENUM ('PENDING', 'RETRYING', 'DELIVERED', 'FAILED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "SupportChannel" AS ENUM ('WEB_SDK', 'MOBILE_SDK', 'EMAIL', 'CHAT_WIDGET', 'API', 'WHATSAPP', 'SLACK', 'PHONE_TRANSCRIPT');

-- CreateEnum
CREATE TYPE "SupportIntent" AS ENUM ('UNKNOWN', 'VERIFICATION_STATUS', 'DOCUMENT_REJECTED', 'UPLOAD_HELP', 'LIVENESS_FAILURE', 'APPEAL_DECISION', 'DATA_CORRECTION', 'DATA_DELETION', 'SCREENING_DISPUTE', 'ACCOUNT_ACCESS', 'TIMELINE_QUESTION', 'TECHNICAL_ISSUE', 'COMPLAINT', 'FRAUD_REPORT', 'OTHER');

-- CreateEnum
CREATE TYPE "TicketStatus" AS ENUM ('OPEN', 'AGENT_HANDLING', 'AWAITING_APPLICANT', 'ESCALATED', 'PENDING_HUMAN', 'RESOLVED', 'CLOSED', 'ABANDONED');

-- CreateEnum
CREATE TYPE "HandlerType" AS ENUM ('AI_AGENT', 'HUMAN', 'HYBRID');

-- CreateEnum
CREATE TYPE "MessageRole" AS ENUM ('SYSTEM', 'APPLICANT', 'ASSISTANT', 'TOOL', 'HUMAN_AGENT', 'NOTE');

-- CreateEnum
CREATE TYPE "AgentRunStatus" AS ENUM ('RUNNING', 'COMPLETED', 'ESCALATED', 'MAX_TURNS', 'BLOCKED_BY_POLICY', 'FAILED');

-- CreateEnum
CREATE TYPE "ToolEffect" AS ENUM ('READ', 'WRITE', 'EXTERNAL');

-- CreateEnum
CREATE TYPE "ToolStatus" AS ENUM ('OK', 'DENIED_BY_POLICY', 'NEEDS_APPROVAL', 'FAILED', 'TIMEOUT');

-- CreateEnum
CREATE TYPE "EscalationReason" AS ENUM ('LOW_CONFIDENCE', 'POLICY_REQUIRES_HUMAN', 'APPLICANT_REQUESTED', 'REGULATORY_DECISION', 'SENTIMENT_NEGATIVE', 'REPEAT_CONTACT', 'TOOL_FAILURE', 'MAX_TURNS_REACHED', 'SUSPECTED_FRAUD', 'COMPLAINT', 'DATA_SUBJECT_RIGHTS');

-- CreateEnum
CREATE TYPE "EscalationStatus" AS ENUM ('PENDING', 'ACCEPTED', 'RESOLVED', 'RETURNED_TO_AGENT', 'CANCELLED');

-- CreateEnum
CREATE TYPE "ReportType" AS ENUM ('APPLICANT_EXPORT', 'DECISION_AUDIT', 'SAR_PACKAGE', 'SCREENING_SUMMARY', 'TRANSACTION_MONITORING', 'CONVERSION_FUNNEL', 'AGENT_PERFORMANCE', 'REGULATORY_PERIODIC', 'DATA_SUBJECT_ACCESS');

-- CreateEnum
CREATE TYPE "ReportStatus" AS ENUM ('QUEUED', 'RUNNING', 'READY', 'FAILED', 'EXPIRED');

-- CreateTable
CREATE TABLE "Tenant" (
    "id" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "slug" TEXT NOT NULL,
    "homeCountry" TEXT NOT NULL DEFAULT 'GBR',
    "industry" "Industry" NOT NULL DEFAULT 'FINTECH',
    "dataResidency" TEXT NOT NULL DEFAULT 'eu',
    "retentionDays" INTEGER NOT NULL DEFAULT 2555,
    "settings" JSONB NOT NULL DEFAULT '{}',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Tenant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApiKey" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "keyId" TEXT NOT NULL,
    "secretHash" TEXT NOT NULL,
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "environment" "Env" NOT NULL DEFAULT 'SANDBOX',
    "lastUsedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "revokedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApiKey_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "User" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "email" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "role" "UserRole" NOT NULL DEFAULT 'AGENT',
    "scopes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "passwordHash" TEXT,
    "mfaSecret" TEXT,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "lastLoginAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "User_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "VerificationLevel" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "displayName" TEXT NOT NULL,
    "description" TEXT,
    "subjectType" "SubjectType" NOT NULL DEFAULT 'INDIVIDUAL',
    "version" INTEGER NOT NULL DEFAULT 1,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "steps" JSONB NOT NULL DEFAULT '[]',
    "allowedCountries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "blockedCountries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "autoApprove" BOOLEAN NOT NULL DEFAULT true,
    "autoReject" BOOLEAN NOT NULL DEFAULT false,
    "manualReviewScore" INTEGER NOT NULL DEFAULT 40,
    "autoRejectScore" INTEGER NOT NULL DEFAULT 80,
    "reverifyAfterDays" INTEGER NOT NULL DEFAULT 0,
    "screeningConfig" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "VerificationLevel_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Applicant" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "externalUserId" TEXT NOT NULL,
    "levelId" TEXT NOT NULL,
    "subjectType" "SubjectType" NOT NULL DEFAULT 'INDIVIDUAL',
    "status" "ApplicantStatus" NOT NULL DEFAULT 'INIT',
    "reviewStatus" "ReviewStatus" NOT NULL DEFAULT 'NOT_STARTED',
    "riskScore" INTEGER NOT NULL DEFAULT 0,
    "riskLevel" "RiskLevel" NOT NULL DEFAULT 'LOW',
    "ddLevel" "DdLevel" NOT NULL DEFAULT 'SDD',
    "firstName" TEXT,
    "lastName" TEXT,
    "dob" TIMESTAMP(3),
    "country" TEXT,
    "nationality" TEXT,
    "email" TEXT,
    "phone" TEXT,
    "piiCiphertext" TEXT,
    "piiKeyVersion" INTEGER NOT NULL DEFAULT 1,
    "identityFingerprint" TEXT,
    "docNumberHash" TEXT,
    "ipAddress" TEXT,
    "ipCountry" TEXT,
    "userAgent" TEXT,
    "lang" TEXT NOT NULL DEFAULT 'en',
    "sourceKey" TEXT,
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "companyId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "submittedAt" TIMESTAMP(3),
    "reviewedAt" TIMESTAMP(3),
    "nextReviewAt" TIMESTAMP(3),
    "redactedAt" TIMESTAMP(3),

    CONSTRAINT "Applicant_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ApplicantStatusEvent" (
    "id" TEXT NOT NULL,
    "applicantId" TEXT NOT NULL,
    "fromStatus" "ReviewStatus",
    "toStatus" "ReviewStatus" NOT NULL,
    "reason" TEXT,
    "actorType" "ActorType" NOT NULL DEFAULT 'SYSTEM',
    "actorId" TEXT,
    "metadata" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ApplicantStatusEvent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "QuestionnaireResponse" (
    "id" TEXT NOT NULL,
    "applicantId" TEXT NOT NULL,
    "formId" TEXT NOT NULL,
    "answers" JSONB NOT NULL DEFAULT '{}',
    "score" INTEGER NOT NULL DEFAULT 0,
    "submittedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "QuestionnaireResponse_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Consent" (
    "id" TEXT NOT NULL,
    "applicantId" TEXT NOT NULL,
    "type" "ConsentType" NOT NULL,
    "granted" BOOLEAN NOT NULL,
    "policyVersion" TEXT NOT NULL,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Consent_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Document" (
    "id" TEXT NOT NULL,
    "applicantId" TEXT NOT NULL,
    "type" "DocumentType" NOT NULL,
    "subType" "DocumentSubType",
    "country" TEXT,
    "status" "DocumentStatus" NOT NULL DEFAULT 'UPLOADED',
    "number" TEXT,
    "numberHash" TEXT,
    "issuedDate" TIMESTAMP(3),
    "expiryDate" TIMESTAMP(3),
    "issuingAuthority" TEXT,
    "extracted" JSONB NOT NULL DEFAULT '{}',
    "authenticityScore" INTEGER,
    "tamperFlags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "nfcVerified" BOOLEAN,
    "rejectLabels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "reviewNote" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Document_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DocumentImage" (
    "id" TEXT NOT NULL,
    "documentId" TEXT NOT NULL,
    "storageKey" TEXT NOT NULL,
    "contentType" TEXT NOT NULL,
    "bytes" INTEGER NOT NULL,
    "sha256" TEXT NOT NULL,
    "side" "DocumentSubType" NOT NULL DEFAULT 'FRONT_SIDE',
    "quality" JSONB NOT NULL DEFAULT '{}',
    "capturedBy" "CaptureMethod" NOT NULL DEFAULT 'UPLOAD',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "DocumentImage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Check" (
    "id" TEXT NOT NULL,
    "applicantId" TEXT NOT NULL,
    "documentId" TEXT,
    "type" "CheckType" NOT NULL,
    "status" "CheckStatus" NOT NULL DEFAULT 'PENDING',
    "result" "CheckResult",
    "score" INTEGER,
    "riskContribution" INTEGER NOT NULL DEFAULT 0,
    "provider" TEXT,
    "providerRef" TEXT,
    "raw" JSONB NOT NULL DEFAULT '{}',
    "findings" JSONB NOT NULL DEFAULT '[]',
    "rejectLabels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "errorCode" TEXT,
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3),
    "completedAt" TIMESTAMP(3),
    "expiresAt" TIMESTAMP(3),
    "attempt" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Check_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Review" (
    "id" TEXT NOT NULL,
    "applicantId" TEXT NOT NULL,
    "decision" "ReviewDecision" NOT NULL,
    "source" "ReviewSource" NOT NULL DEFAULT 'AUTOMATED',
    "reviewerId" TEXT,
    "rejectLabels" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "clientComment" TEXT,
    "moderationComment" TEXT,
    "riskScoreAtDecision" INTEGER NOT NULL DEFAULT 0,
    "firedRuleIds" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "supersedesId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Review_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WatchlistEntry" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "listType" "WatchlistType" NOT NULL,
    "listName" TEXT NOT NULL,
    "sourceRef" TEXT,
    "entityType" "SubjectType" NOT NULL DEFAULT 'INDIVIDUAL',
    "fullName" TEXT NOT NULL,
    "aliases" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "dob" TIMESTAMP(3),
    "yobOnly" INTEGER,
    "countries" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "nameTokens" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "positions" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "pepTier" INTEGER,
    "program" TEXT,
    "remarks" TEXT,
    "listedAt" TIMESTAMP(3),
    "delistedAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "raw" JSONB NOT NULL DEFAULT '{}',
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "WatchlistEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AmlScreeningRun" (
    "id" TEXT NOT NULL,
    "applicantId" TEXT,
    "companyId" TEXT,
    "trigger" "ScreeningTrigger" NOT NULL DEFAULT 'INITIAL',
    "queryName" TEXT NOT NULL,
    "queryDob" TIMESTAMP(3),
    "queryCountry" TEXT,
    "listTypes" "WatchlistType"[] DEFAULT ARRAY[]::"WatchlistType"[],
    "fuzziness" DOUBLE PRECISION NOT NULL DEFAULT 0.75,
    "status" "CheckStatus" NOT NULL DEFAULT 'PENDING',
    "hitCount" INTEGER NOT NULL DEFAULT 0,
    "openHitCount" INTEGER NOT NULL DEFAULT 0,
    "provider" TEXT,
    "raw" JSONB NOT NULL DEFAULT '{}',
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "AmlScreeningRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AmlHit" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "entryId" TEXT,
    "listType" "WatchlistType" NOT NULL,
    "listName" TEXT NOT NULL,
    "matchedName" TEXT NOT NULL,
    "matchScore" DOUBLE PRECISION NOT NULL,
    "matchedFields" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "status" "HitStatus" NOT NULL DEFAULT 'OPEN',
    "resolution" "HitResolution",
    "resolvedBy" TEXT,
    "resolvedAt" TIMESTAMP(3),
    "note" TEXT,
    "snapshot" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AmlHit_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "MonitoringSubscription" (
    "id" TEXT NOT NULL,
    "applicantId" TEXT NOT NULL,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "listTypes" "WatchlistType"[] DEFAULT ARRAY[]::"WatchlistType"[],
    "frequency" "MonitoringFrequency" NOT NULL DEFAULT 'DAILY',
    "lastScreenedAt" TIMESTAMP(3),
    "nextScreenAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "MonitoringSubscription_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Company" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "legalName" TEXT NOT NULL,
    "tradingName" TEXT,
    "registrationNumber" TEXT,
    "taxId" TEXT,
    "lei" TEXT,
    "country" TEXT NOT NULL,
    "jurisdiction" TEXT,
    "legalForm" TEXT,
    "incorporatedAt" TIMESTAMP(3),
    "status" "CompanyStatus" NOT NULL DEFAULT 'PENDING',
    "registeredAddress" JSONB NOT NULL DEFAULT '{}',
    "industryCodes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "website" TEXT,
    "riskScore" INTEGER NOT NULL DEFAULT 0,
    "riskLevel" "RiskLevel" NOT NULL DEFAULT 'LOW',
    "uboUnresolved" BOOLEAN NOT NULL DEFAULT false,
    "uboDepth" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Company_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyRegistryRecord" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "registry" TEXT NOT NULL,
    "fetchedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "payload" JSONB NOT NULL DEFAULT '{}',
    "documentUrl" TEXT,

    CONSTRAINT "CompanyRegistryRecord_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CompanyPosition" (
    "id" TEXT NOT NULL,
    "companyId" TEXT NOT NULL,
    "role" "PositionRole" NOT NULL,
    "fullName" TEXT NOT NULL,
    "dob" TIMESTAMP(3),
    "country" TEXT,
    "applicantExternalId" TEXT,
    "appointedAt" TIMESTAMP(3),
    "resignedAt" TIMESTAMP(3),
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "screened" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CompanyPosition_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "OwnershipEdge" (
    "id" TEXT NOT NULL,
    "childId" TEXT NOT NULL,
    "parentCompanyId" TEXT,
    "parentPersonName" TEXT,
    "parentPersonDob" TIMESTAMP(3),
    "parentPersonCountry" TEXT,
    "ownershipPercent" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "votingPercent" DOUBLE PRECISION,
    "controlType" "ControlType" NOT NULL DEFAULT 'SHARES',
    "isNominee" BOOLEAN NOT NULL DEFAULT false,
    "source" TEXT,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "OwnershipEdge_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Transaction" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "applicantId" TEXT,
    "externalId" TEXT NOT NULL,
    "direction" "TxDirection" NOT NULL,
    "type" "TxType" NOT NULL DEFAULT 'TRANSFER',
    "status" "TxStatus" NOT NULL DEFAULT 'PENDING',
    "amount" DECIMAL(24,8) NOT NULL,
    "currency" TEXT NOT NULL,
    "amountBase" DECIMAL(24,8) NOT NULL,
    "baseCurrency" TEXT NOT NULL DEFAULT 'EUR',
    "fxRate" DECIMAL(18,8),
    "counterpartyName" TEXT,
    "counterpartyCountry" TEXT,
    "counterpartyAccountHash" TEXT,
    "counterpartyWallet" TEXT,
    "chain" TEXT,
    "txHash" TEXT,
    "paymentMethod" TEXT,
    "deviceId" TEXT,
    "ipAddress" TEXT,
    "ipCountry" TEXT,
    "occurredAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "riskScore" INTEGER NOT NULL DEFAULT 0,
    "isFlagged" BOOLEAN NOT NULL DEFAULT false,
    "metadata" JSONB NOT NULL DEFAULT '{}',

    CONSTRAINT "Transaction_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Rule" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "scope" "RuleScope" NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "isShadow" BOOLEAN NOT NULL DEFAULT false,
    "conditions" JSONB NOT NULL DEFAULT '{}',
    "actions" JSONB NOT NULL DEFAULT '[]',
    "currentVersion" INTEGER NOT NULL DEFAULT 1,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "Rule_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "RuleVersion" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT NOT NULL,
    "version" INTEGER NOT NULL,
    "conditions" JSONB NOT NULL DEFAULT '{}',
    "actions" JSONB NOT NULL DEFAULT '[]',
    "changeNote" TEXT,
    "authorId" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "RuleVersion_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Alert" (
    "id" TEXT NOT NULL,
    "ruleId" TEXT,
    "transactionId" TEXT,
    "severity" "Severity" NOT NULL DEFAULT 'MEDIUM',
    "title" TEXT NOT NULL,
    "detail" JSONB NOT NULL DEFAULT '{}',
    "status" "AlertStatus" NOT NULL DEFAULT 'OPEN',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Alert_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletAddress" (
    "id" TEXT NOT NULL,
    "applicantId" TEXT,
    "chain" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "ownershipProof" JSONB,
    "verifiedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletAddress_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WalletScreening" (
    "id" TEXT NOT NULL,
    "walletId" TEXT,
    "transactionId" TEXT,
    "chain" TEXT NOT NULL,
    "address" TEXT NOT NULL,
    "riskScore" INTEGER NOT NULL DEFAULT 0,
    "severity" "Severity" NOT NULL DEFAULT 'LOW',
    "categories" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "clusterName" TEXT,
    "exposureHops" INTEGER,
    "provider" TEXT,
    "raw" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WalletScreening_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Vasp" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "legalName" TEXT,
    "country" TEXT NOT NULL,
    "protocol" TEXT NOT NULL DEFAULT 'TRP',
    "endpoint" TEXT,
    "publicKey" TEXT,
    "didKey" TEXT,
    "isTrusted" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Vasp_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "TravelRuleMessage" (
    "id" TEXT NOT NULL,
    "transactionId" TEXT NOT NULL,
    "direction" "TxDirection" NOT NULL,
    "status" "TravelRuleStatus" NOT NULL DEFAULT 'PENDING',
    "protocol" TEXT NOT NULL DEFAULT 'TRP',
    "originatorVaspId" TEXT,
    "beneficiaryVaspId" TEXT,
    "originatorPayload" TEXT,
    "beneficiaryPayload" TEXT,
    "thresholdExempt" BOOLEAN NOT NULL DEFAULT false,
    "rejectReason" TEXT,
    "sentAt" TIMESTAMP(3),
    "respondedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "TravelRuleMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "DeviceSession" (
    "id" TEXT NOT NULL,
    "applicantId" TEXT NOT NULL,
    "fingerprint" TEXT NOT NULL,
    "ipAddress" TEXT,
    "ipCountry" TEXT,
    "asn" TEXT,
    "isVpn" BOOLEAN NOT NULL DEFAULT false,
    "isTor" BOOLEAN NOT NULL DEFAULT false,
    "isProxy" BOOLEAN NOT NULL DEFAULT false,
    "isEmulator" BOOLEAN NOT NULL DEFAULT false,
    "isRooted" BOOLEAN NOT NULL DEFAULT false,
    "geoMismatch" BOOLEAN NOT NULL DEFAULT false,
    "os" TEXT,
    "browser" TEXT,
    "screen" TEXT,
    "timezone" TEXT,
    "botScore" INTEGER NOT NULL DEFAULT 0,
    "raw" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "DeviceSession_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "FaceIndexEntry" (
    "id" TEXT NOT NULL,
    "applicantId" TEXT NOT NULL,
    "embedding" DOUBLE PRECISION[],
    "bucket" TEXT NOT NULL,
    "quality" DOUBLE PRECISION NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "FaceIndexEntry_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ReusableKycShare" (
    "id" TEXT NOT NULL,
    "applicantId" TEXT NOT NULL,
    "sourceTenantId" TEXT NOT NULL,
    "targetTenantId" TEXT NOT NULL,
    "status" "ShareStatus" NOT NULL DEFAULT 'REQUESTED',
    "sharedScope" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "consentId" TEXT,
    "expiresAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "respondedAt" TIMESTAMP(3),

    CONSTRAINT "ReusableKycShare_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Queue" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "routing" JSONB NOT NULL DEFAULT '{}',
    "slaFirstResponseMinutes" INTEGER NOT NULL DEFAULT 240,
    "slaResolutionMinutes" INTEGER NOT NULL DEFAULT 1440,
    "isDefault" BOOLEAN NOT NULL DEFAULT false,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Queue_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Case" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "type" "CaseType" NOT NULL,
    "status" "CaseStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "Severity" NOT NULL DEFAULT 'MEDIUM',
    "applicantId" TEXT,
    "queueId" TEXT,
    "assigneeId" TEXT,
    "title" TEXT NOT NULL,
    "summary" TEXT,
    "context" JSONB NOT NULL DEFAULT '{}',
    "dueAt" TIMESTAMP(3),
    "firstTouchedAt" TIMESTAMP(3),
    "breachedSla" BOOLEAN NOT NULL DEFAULT false,
    "outcome" "CaseOutcome",
    "resolution" TEXT,
    "sarFiledAt" TIMESTAMP(3),
    "sarReference" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "closedAt" TIMESTAMP(3),

    CONSTRAINT "Case_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseNote" (
    "id" TEXT NOT NULL,
    "caseId" TEXT NOT NULL,
    "authorId" TEXT,
    "actorType" "ActorType" NOT NULL DEFAULT 'USER',
    "body" TEXT NOT NULL,
    "isInternal" BOOLEAN NOT NULL DEFAULT true,
    "attachments" JSONB NOT NULL DEFAULT '[]',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "CaseNote_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "CaseAlert" (
    "caseId" TEXT NOT NULL,
    "alertId" TEXT NOT NULL,

    CONSTRAINT "CaseAlert_pkey" PRIMARY KEY ("caseId","alertId")
);

-- CreateTable
CREATE TABLE "WebhookEndpoint" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "url" TEXT NOT NULL,
    "description" TEXT,
    "secret" TEXT NOT NULL,
    "eventTypes" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "environment" "Env" NOT NULL DEFAULT 'SANDBOX',
    "consecutiveFailures" INTEGER NOT NULL DEFAULT 0,
    "disabledAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookEndpoint_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "WebhookDelivery" (
    "id" TEXT NOT NULL,
    "endpointId" TEXT NOT NULL,
    "applicantId" TEXT,
    "eventType" TEXT NOT NULL,
    "eventId" TEXT NOT NULL,
    "payload" JSONB NOT NULL,
    "status" "DeliveryStatus" NOT NULL DEFAULT 'PENDING',
    "attempt" INTEGER NOT NULL DEFAULT 0,
    "maxAttempts" INTEGER NOT NULL DEFAULT 8,
    "responseStatus" INTEGER,
    "responseBody" TEXT,
    "errorMessage" TEXT,
    "nextAttemptAt" TIMESTAMP(3),
    "deliveredAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "WebhookDelivery_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportTicket" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "reference" TEXT NOT NULL,
    "applicantId" TEXT,
    "channel" "SupportChannel" NOT NULL DEFAULT 'WEB_SDK',
    "intent" "SupportIntent" DEFAULT 'UNKNOWN',
    "subject" TEXT NOT NULL,
    "status" "TicketStatus" NOT NULL DEFAULT 'OPEN',
    "priority" "Severity" NOT NULL DEFAULT 'MEDIUM',
    "language" TEXT NOT NULL DEFAULT 'en',
    "handledBy" "HandlerType" NOT NULL DEFAULT 'AI_AGENT',
    "caseId" TEXT,
    "csatScore" INTEGER,
    "csatComment" TEXT,
    "autoResolved" BOOLEAN NOT NULL DEFAULT false,
    "firstResponseAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportTicket_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportConversation" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "sessionKey" TEXT NOT NULL,
    "agentName" TEXT NOT NULL DEFAULT 'kyc-support-agent',
    "model" TEXT,
    "policyVersion" TEXT NOT NULL DEFAULT 'v1',
    "isActive" BOOLEAN NOT NULL DEFAULT true,
    "turnCount" INTEGER NOT NULL DEFAULT 0,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updatedAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "SupportConversation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "SupportMessage" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "role" "MessageRole" NOT NULL,
    "content" TEXT NOT NULL,
    "redactedContent" TEXT,
    "authorUserId" TEXT,
    "toolCalls" JSONB NOT NULL DEFAULT '[]',
    "inputTokens" INTEGER,
    "outputTokens" INTEGER,
    "latencyMs" INTEGER,
    "guardrail" JSONB NOT NULL DEFAULT '{}',
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "SupportMessage_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AgentRun" (
    "id" TEXT NOT NULL,
    "conversationId" TEXT NOT NULL,
    "status" "AgentRunStatus" NOT NULL DEFAULT 'RUNNING',
    "runtime" TEXT NOT NULL DEFAULT 'claude',
    "model" TEXT,
    "turns" INTEGER NOT NULL DEFAULT 0,
    "maxTurns" INTEGER NOT NULL DEFAULT 12,
    "stopReason" TEXT,
    "inputTokens" INTEGER NOT NULL DEFAULT 0,
    "outputTokens" INTEGER NOT NULL DEFAULT 0,
    "costUsd" DECIMAL(12,6),
    "errorMessage" TEXT,
    "startedAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "finishedAt" TIMESTAMP(3),

    CONSTRAINT "AgentRun_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "ToolInvocation" (
    "id" TEXT NOT NULL,
    "runId" TEXT NOT NULL,
    "messageId" TEXT,
    "toolName" TEXT NOT NULL,
    "input" JSONB NOT NULL DEFAULT '{}',
    "output" JSONB NOT NULL DEFAULT '{}',
    "effect" "ToolEffect" NOT NULL DEFAULT 'READ',
    "status" "ToolStatus" NOT NULL DEFAULT 'OK',
    "approvedByUserId" TEXT,
    "errorMessage" TEXT,
    "latencyMs" INTEGER,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "ToolInvocation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Escalation" (
    "id" TEXT NOT NULL,
    "ticketId" TEXT NOT NULL,
    "reason" "EscalationReason" NOT NULL,
    "detail" TEXT,
    "agentConfidence" DOUBLE PRECISION,
    "status" "EscalationStatus" NOT NULL DEFAULT 'PENDING',
    "assigneeId" TEXT,
    "dueAt" TIMESTAMP(3),
    "acceptedAt" TIMESTAMP(3),
    "resolvedAt" TIMESTAMP(3),
    "humanResolution" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "Escalation_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "KnowledgeArticle" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT,
    "slug" TEXT NOT NULL,
    "title" TEXT NOT NULL,
    "body" TEXT NOT NULL,
    "intents" "SupportIntent"[] DEFAULT ARRAY[]::"SupportIntent"[],
    "locale" TEXT NOT NULL DEFAULT 'en',
    "tags" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "keywords" TEXT[] DEFAULT ARRAY[]::TEXT[],
    "isPublished" BOOLEAN NOT NULL DEFAULT true,
    "version" INTEGER NOT NULL DEFAULT 1,
    "updatedAt" TIMESTAMP(3) NOT NULL,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "KnowledgeArticle_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "AuditLog" (
    "id" TEXT NOT NULL,
    "seq" BIGSERIAL NOT NULL,
    "tenantId" TEXT,
    "actorType" "ActorType" NOT NULL,
    "actorId" TEXT,
    "action" TEXT NOT NULL,
    "resourceType" TEXT NOT NULL,
    "resourceId" TEXT,
    "before" JSONB,
    "after" JSONB,
    "ipAddress" TEXT,
    "userAgent" TEXT,
    "requestId" TEXT,
    "prevHash" TEXT,
    "hash" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "AuditLog_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "Report" (
    "id" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "type" "ReportType" NOT NULL,
    "status" "ReportStatus" NOT NULL DEFAULT 'QUEUED',
    "parameters" JSONB NOT NULL DEFAULT '{}',
    "format" TEXT NOT NULL DEFAULT 'csv',
    "storageKey" TEXT,
    "rowCount" INTEGER,
    "requestedBy" TEXT,
    "errorMessage" TEXT,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "completedAt" TIMESTAMP(3),

    CONSTRAINT "Report_pkey" PRIMARY KEY ("id")
);

-- CreateTable
CREATE TABLE "IdempotencyRecord" (
    "key" TEXT NOT NULL,
    "tenantId" TEXT NOT NULL,
    "endpoint" TEXT NOT NULL,
    "requestHash" TEXT NOT NULL,
    "statusCode" INTEGER,
    "response" JSONB,
    "createdAt" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expiresAt" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "IdempotencyRecord_pkey" PRIMARY KEY ("key")
);

-- CreateIndex
CREATE UNIQUE INDEX "Tenant_slug_key" ON "Tenant"("slug");

-- CreateIndex
CREATE INDEX "Tenant_slug_idx" ON "Tenant"("slug");

-- CreateIndex
CREATE UNIQUE INDEX "ApiKey_keyId_key" ON "ApiKey"("keyId");

-- CreateIndex
CREATE INDEX "ApiKey_tenantId_environment_idx" ON "ApiKey"("tenantId", "environment");

-- CreateIndex
CREATE INDEX "User_tenantId_role_idx" ON "User"("tenantId", "role");

-- CreateIndex
CREATE UNIQUE INDEX "User_tenantId_email_key" ON "User"("tenantId", "email");

-- CreateIndex
CREATE INDEX "VerificationLevel_tenantId_isActive_idx" ON "VerificationLevel"("tenantId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "VerificationLevel_tenantId_name_version_key" ON "VerificationLevel"("tenantId", "name", "version");

-- CreateIndex
CREATE INDEX "Applicant_tenantId_reviewStatus_idx" ON "Applicant"("tenantId", "reviewStatus");

-- CreateIndex
CREATE INDEX "Applicant_tenantId_status_idx" ON "Applicant"("tenantId", "status");

-- CreateIndex
CREATE INDEX "Applicant_tenantId_riskLevel_idx" ON "Applicant"("tenantId", "riskLevel");

-- CreateIndex
CREATE INDEX "Applicant_identityFingerprint_idx" ON "Applicant"("identityFingerprint");

-- CreateIndex
CREATE INDEX "Applicant_docNumberHash_idx" ON "Applicant"("docNumberHash");

-- CreateIndex
CREATE INDEX "Applicant_nextReviewAt_idx" ON "Applicant"("nextReviewAt");

-- CreateIndex
CREATE INDEX "Applicant_tenantId_createdAt_idx" ON "Applicant"("tenantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Applicant_tenantId_externalUserId_key" ON "Applicant"("tenantId", "externalUserId");

-- CreateIndex
CREATE INDEX "ApplicantStatusEvent_applicantId_createdAt_idx" ON "ApplicantStatusEvent"("applicantId", "createdAt");

-- CreateIndex
CREATE INDEX "QuestionnaireResponse_applicantId_formId_idx" ON "QuestionnaireResponse"("applicantId", "formId");

-- CreateIndex
CREATE INDEX "Consent_applicantId_type_idx" ON "Consent"("applicantId", "type");

-- CreateIndex
CREATE INDEX "Document_applicantId_type_idx" ON "Document"("applicantId", "type");

-- CreateIndex
CREATE INDEX "Document_numberHash_idx" ON "Document"("numberHash");

-- CreateIndex
CREATE INDEX "DocumentImage_documentId_idx" ON "DocumentImage"("documentId");

-- CreateIndex
CREATE INDEX "DocumentImage_sha256_idx" ON "DocumentImage"("sha256");

-- CreateIndex
CREATE INDEX "Check_applicantId_type_idx" ON "Check"("applicantId", "type");

-- CreateIndex
CREATE INDEX "Check_applicantId_status_idx" ON "Check"("applicantId", "status");

-- CreateIndex
CREATE INDEX "Review_applicantId_createdAt_idx" ON "Review"("applicantId", "createdAt");

-- CreateIndex
CREATE INDEX "Review_reviewerId_idx" ON "Review"("reviewerId");

-- CreateIndex
CREATE INDEX "WatchlistEntry_listType_isActive_idx" ON "WatchlistEntry"("listType", "isActive");

-- CreateIndex
CREATE INDEX "WatchlistEntry_tenantId_listType_idx" ON "WatchlistEntry"("tenantId", "listType");

-- CreateIndex
CREATE INDEX "WatchlistEntry_fullName_idx" ON "WatchlistEntry"("fullName");

-- CreateIndex
CREATE INDEX "AmlScreeningRun_applicantId_startedAt_idx" ON "AmlScreeningRun"("applicantId", "startedAt");

-- CreateIndex
CREATE INDEX "AmlScreeningRun_companyId_startedAt_idx" ON "AmlScreeningRun"("companyId", "startedAt");

-- CreateIndex
CREATE INDEX "AmlHit_runId_status_idx" ON "AmlHit"("runId", "status");

-- CreateIndex
CREATE INDEX "AmlHit_status_createdAt_idx" ON "AmlHit"("status", "createdAt");

-- CreateIndex
CREATE INDEX "MonitoringSubscription_isActive_nextScreenAt_idx" ON "MonitoringSubscription"("isActive", "nextScreenAt");

-- CreateIndex
CREATE UNIQUE INDEX "MonitoringSubscription_applicantId_key" ON "MonitoringSubscription"("applicantId");

-- CreateIndex
CREATE INDEX "Company_tenantId_legalName_idx" ON "Company"("tenantId", "legalName");

-- CreateIndex
CREATE UNIQUE INDEX "Company_tenantId_country_registrationNumber_key" ON "Company"("tenantId", "country", "registrationNumber");

-- CreateIndex
CREATE INDEX "CompanyRegistryRecord_companyId_fetchedAt_idx" ON "CompanyRegistryRecord"("companyId", "fetchedAt");

-- CreateIndex
CREATE INDEX "CompanyPosition_companyId_role_idx" ON "CompanyPosition"("companyId", "role");

-- CreateIndex
CREATE INDEX "OwnershipEdge_childId_idx" ON "OwnershipEdge"("childId");

-- CreateIndex
CREATE INDEX "OwnershipEdge_parentCompanyId_idx" ON "OwnershipEdge"("parentCompanyId");

-- CreateIndex
CREATE INDEX "Transaction_tenantId_occurredAt_idx" ON "Transaction"("tenantId", "occurredAt");

-- CreateIndex
CREATE INDEX "Transaction_applicantId_occurredAt_idx" ON "Transaction"("applicantId", "occurredAt");

-- CreateIndex
CREATE INDEX "Transaction_tenantId_isFlagged_idx" ON "Transaction"("tenantId", "isFlagged");

-- CreateIndex
CREATE UNIQUE INDEX "Transaction_tenantId_externalId_key" ON "Transaction"("tenantId", "externalId");

-- CreateIndex
CREATE INDEX "Rule_tenantId_scope_isActive_idx" ON "Rule"("tenantId", "scope", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "Rule_tenantId_name_key" ON "Rule"("tenantId", "name");

-- CreateIndex
CREATE UNIQUE INDEX "RuleVersion_ruleId_version_key" ON "RuleVersion"("ruleId", "version");

-- CreateIndex
CREATE INDEX "Alert_status_severity_idx" ON "Alert"("status", "severity");

-- CreateIndex
CREATE INDEX "Alert_transactionId_idx" ON "Alert"("transactionId");

-- CreateIndex
CREATE INDEX "WalletAddress_address_idx" ON "WalletAddress"("address");

-- CreateIndex
CREATE UNIQUE INDEX "WalletAddress_chain_address_applicantId_key" ON "WalletAddress"("chain", "address", "applicantId");

-- CreateIndex
CREATE INDEX "WalletScreening_address_createdAt_idx" ON "WalletScreening"("address", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "Vasp_tenantId_name_key" ON "Vasp"("tenantId", "name");

-- CreateIndex
CREATE INDEX "TravelRuleMessage_transactionId_idx" ON "TravelRuleMessage"("transactionId");

-- CreateIndex
CREATE INDEX "TravelRuleMessage_status_idx" ON "TravelRuleMessage"("status");

-- CreateIndex
CREATE INDEX "DeviceSession_fingerprint_idx" ON "DeviceSession"("fingerprint");

-- CreateIndex
CREATE INDEX "DeviceSession_applicantId_createdAt_idx" ON "DeviceSession"("applicantId", "createdAt");

-- CreateIndex
CREATE UNIQUE INDEX "DeviceSession_applicantId_fingerprint_key" ON "DeviceSession"("applicantId", "fingerprint");

-- CreateIndex
CREATE INDEX "FaceIndexEntry_bucket_idx" ON "FaceIndexEntry"("bucket");

-- CreateIndex
CREATE INDEX "FaceIndexEntry_applicantId_idx" ON "FaceIndexEntry"("applicantId");

-- CreateIndex
CREATE INDEX "ReusableKycShare_targetTenantId_status_idx" ON "ReusableKycShare"("targetTenantId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "ReusableKycShare_applicantId_targetTenantId_key" ON "ReusableKycShare"("applicantId", "targetTenantId");

-- CreateIndex
CREATE UNIQUE INDEX "Queue_tenantId_name_key" ON "Queue"("tenantId", "name");

-- CreateIndex
CREATE INDEX "Case_tenantId_status_priority_idx" ON "Case"("tenantId", "status", "priority");

-- CreateIndex
CREATE INDEX "Case_assigneeId_status_idx" ON "Case"("assigneeId", "status");

-- CreateIndex
CREATE INDEX "Case_queueId_status_idx" ON "Case"("queueId", "status");

-- CreateIndex
CREATE UNIQUE INDEX "Case_tenantId_reference_key" ON "Case"("tenantId", "reference");

-- CreateIndex
CREATE INDEX "CaseNote_caseId_createdAt_idx" ON "CaseNote"("caseId", "createdAt");

-- CreateIndex
CREATE INDEX "WebhookEndpoint_tenantId_isActive_idx" ON "WebhookEndpoint"("tenantId", "isActive");

-- CreateIndex
CREATE UNIQUE INDEX "WebhookDelivery_eventId_key" ON "WebhookDelivery"("eventId");

-- CreateIndex
CREATE INDEX "WebhookDelivery_status_nextAttemptAt_idx" ON "WebhookDelivery"("status", "nextAttemptAt");

-- CreateIndex
CREATE INDEX "WebhookDelivery_endpointId_createdAt_idx" ON "WebhookDelivery"("endpointId", "createdAt");

-- CreateIndex
CREATE INDEX "SupportTicket_tenantId_status_idx" ON "SupportTicket"("tenantId", "status");

-- CreateIndex
CREATE INDEX "SupportTicket_applicantId_idx" ON "SupportTicket"("applicantId");

-- CreateIndex
CREATE UNIQUE INDEX "SupportTicket_tenantId_reference_key" ON "SupportTicket"("tenantId", "reference");

-- CreateIndex
CREATE UNIQUE INDEX "SupportConversation_sessionKey_key" ON "SupportConversation"("sessionKey");

-- CreateIndex
CREATE INDEX "SupportConversation_ticketId_idx" ON "SupportConversation"("ticketId");

-- CreateIndex
CREATE INDEX "SupportMessage_conversationId_createdAt_idx" ON "SupportMessage"("conversationId", "createdAt");

-- CreateIndex
CREATE INDEX "AgentRun_conversationId_startedAt_idx" ON "AgentRun"("conversationId", "startedAt");

-- CreateIndex
CREATE INDEX "ToolInvocation_runId_createdAt_idx" ON "ToolInvocation"("runId", "createdAt");

-- CreateIndex
CREATE INDEX "ToolInvocation_toolName_createdAt_idx" ON "ToolInvocation"("toolName", "createdAt");

-- CreateIndex
CREATE INDEX "Escalation_status_dueAt_idx" ON "Escalation"("status", "dueAt");

-- CreateIndex
CREATE INDEX "Escalation_ticketId_idx" ON "Escalation"("ticketId");

-- CreateIndex
CREATE INDEX "KnowledgeArticle_locale_isPublished_idx" ON "KnowledgeArticle"("locale", "isPublished");

-- CreateIndex
CREATE UNIQUE INDEX "KnowledgeArticle_tenantId_slug_locale_key" ON "KnowledgeArticle"("tenantId", "slug", "locale");

-- CreateIndex
CREATE INDEX "AuditLog_tenantId_seq_idx" ON "AuditLog"("tenantId", "seq");

-- CreateIndex
CREATE INDEX "AuditLog_tenantId_createdAt_idx" ON "AuditLog"("tenantId", "createdAt");

-- CreateIndex
CREATE INDEX "AuditLog_resourceType_resourceId_idx" ON "AuditLog"("resourceType", "resourceId");

-- CreateIndex
CREATE INDEX "AuditLog_actorId_createdAt_idx" ON "AuditLog"("actorId", "createdAt");

-- CreateIndex
CREATE INDEX "Report_tenantId_type_createdAt_idx" ON "Report"("tenantId", "type", "createdAt");

-- CreateIndex
CREATE INDEX "IdempotencyRecord_expiresAt_idx" ON "IdempotencyRecord"("expiresAt");

-- AddForeignKey
ALTER TABLE "ApiKey" ADD CONSTRAINT "ApiKey_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "User" ADD CONSTRAINT "User_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "VerificationLevel" ADD CONSTRAINT "VerificationLevel_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Applicant" ADD CONSTRAINT "Applicant_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Applicant" ADD CONSTRAINT "Applicant_levelId_fkey" FOREIGN KEY ("levelId") REFERENCES "VerificationLevel"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Applicant" ADD CONSTRAINT "Applicant_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ApplicantStatusEvent" ADD CONSTRAINT "ApplicantStatusEvent_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "Applicant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "QuestionnaireResponse" ADD CONSTRAINT "QuestionnaireResponse_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "Applicant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Consent" ADD CONSTRAINT "Consent_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "Applicant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Document" ADD CONSTRAINT "Document_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "Applicant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DocumentImage" ADD CONSTRAINT "DocumentImage_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Check" ADD CONSTRAINT "Check_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "Applicant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Check" ADD CONSTRAINT "Check_documentId_fkey" FOREIGN KEY ("documentId") REFERENCES "Document"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "Applicant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Review" ADD CONSTRAINT "Review_reviewerId_fkey" FOREIGN KEY ("reviewerId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WatchlistEntry" ADD CONSTRAINT "WatchlistEntry_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmlScreeningRun" ADD CONSTRAINT "AmlScreeningRun_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "Applicant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmlScreeningRun" ADD CONSTRAINT "AmlScreeningRun_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmlHit" ADD CONSTRAINT "AmlHit_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AmlScreeningRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AmlHit" ADD CONSTRAINT "AmlHit_entryId_fkey" FOREIGN KEY ("entryId") REFERENCES "WatchlistEntry"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "MonitoringSubscription" ADD CONSTRAINT "MonitoringSubscription_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "Applicant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Company" ADD CONSTRAINT "Company_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyRegistryRecord" ADD CONSTRAINT "CompanyRegistryRecord_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CompanyPosition" ADD CONSTRAINT "CompanyPosition_companyId_fkey" FOREIGN KEY ("companyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnershipEdge" ADD CONSTRAINT "OwnershipEdge_childId_fkey" FOREIGN KEY ("childId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "OwnershipEdge" ADD CONSTRAINT "OwnershipEdge_parentCompanyId_fkey" FOREIGN KEY ("parentCompanyId") REFERENCES "Company"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Transaction" ADD CONSTRAINT "Transaction_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "Applicant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Rule" ADD CONSTRAINT "Rule_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleVersion" ADD CONSTRAINT "RuleVersion_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "Rule"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "RuleVersion" ADD CONSTRAINT "RuleVersion_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_ruleId_fkey" FOREIGN KEY ("ruleId") REFERENCES "Rule"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Alert" ADD CONSTRAINT "Alert_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletAddress" ADD CONSTRAINT "WalletAddress_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "Applicant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletScreening" ADD CONSTRAINT "WalletScreening_walletId_fkey" FOREIGN KEY ("walletId") REFERENCES "WalletAddress"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WalletScreening" ADD CONSTRAINT "WalletScreening_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Vasp" ADD CONSTRAINT "Vasp_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TravelRuleMessage" ADD CONSTRAINT "TravelRuleMessage_transactionId_fkey" FOREIGN KEY ("transactionId") REFERENCES "Transaction"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TravelRuleMessage" ADD CONSTRAINT "TravelRuleMessage_originatorVaspId_fkey" FOREIGN KEY ("originatorVaspId") REFERENCES "Vasp"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "TravelRuleMessage" ADD CONSTRAINT "TravelRuleMessage_beneficiaryVaspId_fkey" FOREIGN KEY ("beneficiaryVaspId") REFERENCES "Vasp"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "DeviceSession" ADD CONSTRAINT "DeviceSession_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "Applicant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "FaceIndexEntry" ADD CONSTRAINT "FaceIndexEntry_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "Applicant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReusableKycShare" ADD CONSTRAINT "ReusableKycShare_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "Applicant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReusableKycShare" ADD CONSTRAINT "ReusableKycShare_sourceTenantId_fkey" FOREIGN KEY ("sourceTenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ReusableKycShare" ADD CONSTRAINT "ReusableKycShare_targetTenantId_fkey" FOREIGN KEY ("targetTenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Queue" ADD CONSTRAINT "Queue_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Case" ADD CONSTRAINT "Case_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Case" ADD CONSTRAINT "Case_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "Applicant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Case" ADD CONSTRAINT "Case_queueId_fkey" FOREIGN KEY ("queueId") REFERENCES "Queue"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Case" ADD CONSTRAINT "Case_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseNote" ADD CONSTRAINT "CaseNote_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseNote" ADD CONSTRAINT "CaseNote_authorId_fkey" FOREIGN KEY ("authorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseAlert" ADD CONSTRAINT "CaseAlert_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "CaseAlert" ADD CONSTRAINT "CaseAlert_alertId_fkey" FOREIGN KEY ("alertId") REFERENCES "Alert"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookEndpoint" ADD CONSTRAINT "WebhookEndpoint_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_endpointId_fkey" FOREIGN KEY ("endpointId") REFERENCES "WebhookEndpoint"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "WebhookDelivery" ADD CONSTRAINT "WebhookDelivery_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "Applicant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_applicantId_fkey" FOREIGN KEY ("applicantId") REFERENCES "Applicant"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportTicket" ADD CONSTRAINT "SupportTicket_caseId_fkey" FOREIGN KEY ("caseId") REFERENCES "Case"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportConversation" ADD CONSTRAINT "SupportConversation_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "SupportTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "SupportConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "SupportMessage" ADD CONSTRAINT "SupportMessage_authorUserId_fkey" FOREIGN KEY ("authorUserId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AgentRun" ADD CONSTRAINT "AgentRun_conversationId_fkey" FOREIGN KEY ("conversationId") REFERENCES "SupportConversation"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolInvocation" ADD CONSTRAINT "ToolInvocation_runId_fkey" FOREIGN KEY ("runId") REFERENCES "AgentRun"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "ToolInvocation" ADD CONSTRAINT "ToolInvocation_messageId_fkey" FOREIGN KEY ("messageId") REFERENCES "SupportMessage"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Escalation" ADD CONSTRAINT "Escalation_ticketId_fkey" FOREIGN KEY ("ticketId") REFERENCES "SupportTicket"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Escalation" ADD CONSTRAINT "Escalation_assigneeId_fkey" FOREIGN KEY ("assigneeId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "KnowledgeArticle" ADD CONSTRAINT "KnowledgeArticle_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "AuditLog" ADD CONSTRAINT "AuditLog_actorId_fkey" FOREIGN KEY ("actorId") REFERENCES "User"("id") ON DELETE SET NULL ON UPDATE CASCADE;

-- AddForeignKey
ALTER TABLE "Report" ADD CONSTRAINT "Report_tenantId_fkey" FOREIGN KEY ("tenantId") REFERENCES "Tenant"("id") ON DELETE CASCADE ON UPDATE CASCADE;

