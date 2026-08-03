/**
 * Vendor adapter contracts.
 *
 * Every external verification capability sits behind one of these interfaces.
 * The rule is that no domain code may know which vendor is in use — swapping an
 * OCR provider must be a config change, not a refactor.
 *
 * Two design choices worth stating:
 *  - Adapters return *normalised findings*, never raw provider payloads, as their
 *    primary result. The raw payload rides along in `raw` for dispute handling,
 *    but nothing downstream is allowed to depend on its shape.
 *  - Adapters never decide. They report evidence and confidence; the rules engine
 *    decides. A provider saying "fail" is an input to a decision, not a decision.
 */

export interface AdapterContext {
  tenantId: string;
  applicantId?: string;
  /** Correlates provider calls with the request that caused them. */
  requestId?: string;
  /** Deterministic seed for mock adapters, so tests and demos reproduce. */
  seed?: string;
  timeoutMs?: number;
}

export interface AdapterResult<T> {
  ok: boolean;
  data?: T;
  provider: string;
  providerRef?: string;
  latencyMs: number;
  /** Verbatim provider response. Retained for disputes and model retraining. */
  raw?: unknown;
  error?: {
    code: string;
    message: string;
    /** Transient failures are retried by the worker; permanent ones are not. */
    retryable: boolean;
  };
}

export interface Finding {
  code: string;
  severity: 'INFO' | 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  message: string;
  detail?: Record<string, unknown>;
}

// ---------------------------------------------------------------------------
// Document OCR
// ---------------------------------------------------------------------------

export interface ImageInput {
  /** Storage key, so adapters fetch bytes themselves rather than us buffering. */
  storageKey?: string;
  bytes?: Buffer;
  contentType: string;
  side?: 'FRONT_SIDE' | 'BACK_SIDE' | 'PAGE';
}

export interface OcrRequest {
  images: ImageInput[];
  documentType: string;
  /** Hint from the applicant; the adapter must still detect for itself. */
  expectedCountry?: string;
}

export interface OcrResult {
  documentType: string;
  detectedCountry: string | null;
  fields: {
    firstName?: string;
    lastName?: string;
    middleName?: string;
    fullName?: string;
    documentNumber?: string;
    dob?: string;
    sex?: 'M' | 'F' | 'X';
    nationality?: string;
    issuedDate?: string;
    expiryDate?: string;
    issuingAuthority?: string;
    placeOfBirth?: string;
    address?: string;
    personalNumber?: string;
  };
  /** Raw MRZ lines when present, for independent validation. */
  mrz?: string;
  /** Per-field confidence, 0-1. Low confidence on a critical field is a retake. */
  fieldConfidence: Record<string, number>;
  /** Image quality assessment, used to ask for a retake before deciding. */
  quality: {
    sharpness: number;
    glare: number;
    brightness: number;
    resolution: { width: number; height: number };
    isColour: boolean;
    fullDocumentVisible: boolean;
    /** Screen capture / photo-of-a-photo indicators. */
    screenCaptureSuspected: boolean;
  };
  findings: Finding[];
}

export interface OcrAdapter {
  readonly name: string;
  extract(req: OcrRequest, ctx: AdapterContext): Promise<AdapterResult<OcrResult>>;
}

// ---------------------------------------------------------------------------
// Document authenticity
// ---------------------------------------------------------------------------

export interface DocAuthRequest {
  images: ImageInput[];
  documentType: string;
  country: string;
  /** OCR output, so authenticity can cross-check printed vs MRZ data. */
  ocr?: OcrResult;
}

export interface DocAuthResult {
  /** 0-100. Not a verdict — the threshold is tenant policy. */
  authenticityScore: number;
  /** Specific tamper indicators, each individually actionable. */
  tamperFlags: string[];
  /** Whether the layout matches the known template for issuer/series. */
  templateMatched: boolean;
  templateName?: string;
  /** Security feature checks the provider could actually perform. */
  securityFeatures: Array<{
    feature: string;
    present: boolean | null;
    confidence: number;
  }>;
  findings: Finding[];
}

export interface DocAuthAdapter {
  readonly name: string;
  verify(req: DocAuthRequest, ctx: AdapterContext): Promise<AdapterResult<DocAuthResult>>;
}

// ---------------------------------------------------------------------------
// Biometrics
// ---------------------------------------------------------------------------

export interface LivenessRequest {
  /** Video for active liveness, or a single frame for passive. */
  media: ImageInput;
  mode: 'PASSIVE' | 'ACTIVE' | 'VIDEO';
  challengeResponses?: string[];
}

export interface LivenessResult {
  /** 0-1 confidence that a live human was present. */
  score: number;
  spoofDetected: boolean;
  attackType?: 'MASK' | 'REPLAY' | 'DEEPFAKE' | 'PRINTED_PHOTO' | 'INJECTION' | null;
  faceDetected: boolean;
  faceCount: number;
  occlusions: string[];
  /** Biometric template for dedup. A vector, never an image. */
  faceEmbedding?: number[];
  /** Coarse bucket key so dedup search does not scan the whole index. */
  embeddingBucket?: string;
  estimatedAge?: number;
  findings: Finding[];
}

export interface LivenessAdapter {
  readonly name: string;
  check(req: LivenessRequest, ctx: AdapterContext): Promise<AdapterResult<LivenessResult>>;
}

export interface FaceMatchRequest {
  documentPortrait: ImageInput;
  selfie: ImageInput;
}

export interface FaceMatchResult {
  /** 0-1 similarity. */
  score: number;
  /** Provider's own pass threshold, for reference only. */
  providerThreshold: number;
  findings: Finding[];
}

export interface FaceMatchAdapter {
  readonly name: string;
  compare(req: FaceMatchRequest, ctx: AdapterContext): Promise<AdapterResult<FaceMatchResult>>;
}

// ---------------------------------------------------------------------------
// NFC chip
// ---------------------------------------------------------------------------

export interface NfcRequest {
  /** Base64 data groups read from the chip by the mobile SDK. */
  dataGroups: Record<string, string>;
  documentNumber: string;
  dateOfBirth: string;
  dateOfExpiry: string;
}

export interface NfcResult {
  /** Passive authentication: the issuer's signature over the data groups. */
  passiveAuthPassed: boolean;
  /** Active authentication / chip authentication, where supported. */
  activeAuthPassed: boolean | null;
  /** Certificate chain terminated at a trusted CSCA. */
  certificateChainValid: boolean;
  fields: OcrResult['fields'];
  portraitStorageKey?: string;
  findings: Finding[];
}

export interface NfcAdapter {
  readonly name: string;
  read(req: NfcRequest, ctx: AdapterContext): Promise<AdapterResult<NfcResult>>;
}

// ---------------------------------------------------------------------------
// Screening
// ---------------------------------------------------------------------------

export interface ScreeningRequest {
  name: string;
  entityType: 'INDIVIDUAL' | 'COMPANY';
  dob?: string;
  yearOfBirth?: number;
  country?: string;
  nationality?: string;
  documentNumber?: string;
  listTypes: string[];
  /** 0-1. Lower means a wider net and more false positives. */
  fuzziness: number;
  /** Hits previously cleared as false positives, to suppress. */
  suppressedEntryIds?: string[];
}

export interface ScreeningHit {
  entryId: string;
  listType: string;
  listName: string;
  matchedName: string;
  aliases: string[];
  matchScore: number;
  matchedFields: string[];
  dob?: string | null;
  countries: string[];
  positions?: string[];
  pepTier?: number | null;
  program?: string | null;
  remarks?: string | null;
  /** Categories for adverse media, e.g. ["fraud", "corruption"]. */
  categories?: string[];
  sourceUrl?: string;
  listedAt?: string | null;
  snapshot: Record<string, unknown>;
}

export interface ScreeningResult {
  hits: ScreeningHit[];
  /** How many list entries were considered. Useful for coverage assurance. */
  searchedEntries: number;
  listsSearched: string[];
  findings: Finding[];
}

export interface ScreeningAdapter {
  readonly name: string;
  search(req: ScreeningRequest, ctx: AdapterContext): Promise<AdapterResult<ScreeningResult>>;
}

// ---------------------------------------------------------------------------
// Company registry (KYB)
// ---------------------------------------------------------------------------

export interface RegistryLookupRequest {
  country: string;
  registrationNumber?: string;
  legalName?: string;
}

export interface RegistryOfficer {
  fullName: string;
  role: string;
  dob?: string | null;
  country?: string | null;
  appointedAt?: string | null;
  resignedAt?: string | null;
}

export interface RegistryShareholder {
  name: string;
  isCompany: boolean;
  registrationNumber?: string;
  country?: string;
  ownershipPercent: number;
  votingPercent?: number;
  isNominee?: boolean;
  dob?: string | null;
}

export interface RegistryResult {
  found: boolean;
  registry: string;
  legalName: string;
  tradingName?: string;
  registrationNumber: string;
  status: 'ACTIVE' | 'DISSOLVED' | 'LIQUIDATION' | 'SUSPENDED' | 'UNKNOWN';
  legalForm?: string;
  incorporatedAt?: string;
  dissolvedAt?: string;
  registeredAddress?: Record<string, unknown>;
  industryCodes: string[];
  officers: RegistryOfficer[];
  shareholders: RegistryShareholder[];
  /** Signals for the shell-company ruleset. */
  substance: {
    employeeCount?: number | null;
    filingsCount?: number;
    lastFilingAt?: string | null;
    registeredOfficeOnly?: boolean;
    companiesAtSameAddress?: number;
  };
  findings: Finding[];
}

export interface RegistryAdapter {
  readonly name: string;
  lookup(
    req: RegistryLookupRequest,
    ctx: AdapterContext,
  ): Promise<AdapterResult<RegistryResult>>;
}

// ---------------------------------------------------------------------------
// Device & network intelligence
// ---------------------------------------------------------------------------

export interface DeviceRequest {
  fingerprint?: string;
  ipAddress?: string;
  userAgent?: string;
  /** Client-collected signals from the SDK. */
  clientSignals?: Record<string, unknown>;
}

export interface DeviceResult {
  fingerprint: string;
  ipCountry: string | null;
  asn: string | null;
  isp: string | null;
  isVpn: boolean;
  isTor: boolean;
  isProxy: boolean;
  isDatacenter: boolean;
  isEmulator: boolean;
  isRooted: boolean;
  os: string | null;
  browser: string | null;
  timezone: string | null;
  /** 0-100 likelihood the session is automated. */
  botScore: number;
  findings: Finding[];
}

export interface DeviceAdapter {
  readonly name: string;
  assess(req: DeviceRequest, ctx: AdapterContext): Promise<AdapterResult<DeviceResult>>;
}

// ---------------------------------------------------------------------------
// Contact risk (email / phone)
// ---------------------------------------------------------------------------

export interface ContactRiskRequest {
  email?: string;
  phone?: string;
}

export interface ContactRiskResult {
  email?: {
    valid: boolean;
    deliverable: boolean | null;
    disposable: boolean;
    freeProvider: boolean;
    /** Domain age in days; brand-new domains are a signal. */
    domainAgeDays: number | null;
    /** Whether the address appears in known breach corpora — proves it is real. */
    breachCount: number | null;
    riskScore: number;
  };
  phone?: {
    valid: boolean;
    lineType: 'MOBILE' | 'LANDLINE' | 'VOIP' | 'UNKNOWN';
    carrier: string | null;
    countryCode: string | null;
    /** Recently ported numbers correlate with SIM-swap takeover. */
    recentlyPorted: boolean | null;
    riskScore: number;
  };
  findings: Finding[];
}

export interface ContactRiskAdapter {
  readonly name: string;
  assess(
    req: ContactRiskRequest,
    ctx: AdapterContext,
  ): Promise<AdapterResult<ContactRiskResult>>;
}

// ---------------------------------------------------------------------------
// Blockchain analytics
// ---------------------------------------------------------------------------

export interface WalletScreeningRequest {
  chain: string;
  address: string;
  /** Screening a specific transfer rather than the address in general. */
  txHash?: string;
  direction?: 'INBOUND' | 'OUTBOUND';
}

export interface WalletScreeningResult {
  riskScore: number;
  severity: 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
  /** Exposure categories, e.g. ["mixer", "darknet"]. */
  categories: string[];
  /** Named cluster owner where attribution exists. */
  clusterName: string | null;
  clusterCategory: string | null;
  /** Hops to the nearest illicit counterparty; 1 = direct. */
  exposureHops: number | null;
  /** Share of value by category, for the exposure breakdown view. */
  exposureBreakdown: Record<string, number>;
  isSanctioned: boolean;
  findings: Finding[];
}

export interface ChainAnalysisAdapter {
  readonly name: string;
  screenAddress(
    req: WalletScreeningRequest,
    ctx: AdapterContext,
  ): Promise<AdapterResult<WalletScreeningResult>>;
  /** Verifies an applicant controls an address via a signed message. */
  verifyOwnership(
    req: { chain: string; address: string; message: string; signature: string },
    ctx: AdapterContext,
  ): Promise<AdapterResult<{ verified: boolean; method: string }>>;
}

// ---------------------------------------------------------------------------
// Storage & notifications
// ---------------------------------------------------------------------------

export interface StorageAdapter {
  readonly name: string;
  put(
    key: string,
    bytes: Buffer,
    contentType: string,
  ): Promise<{ key: string; bytes: number; sha256: string }>;
  get(key: string): Promise<{ bytes: Buffer; contentType: string }>;
  /** Time-limited URL so document images are never served from our own process. */
  presignGet(key: string, ttlSeconds: number): Promise<string>;
  delete(key: string): Promise<void>;
  exists(key: string): Promise<boolean>;
}

export interface NotificationAdapter {
  readonly name: string;
  sendEmail(args: {
    to: string;
    subject: string;
    body: string;
    template?: string;
    variables?: Record<string, unknown>;
  }): Promise<{ messageId: string }>;
  sendSms(args: { to: string; body: string }): Promise<{ messageId: string }>;
}

// ---------------------------------------------------------------------------
// Registry of all adapters
// ---------------------------------------------------------------------------

export interface AdapterRegistry {
  ocr: OcrAdapter;
  docAuth: DocAuthAdapter;
  liveness: LivenessAdapter;
  faceMatch: FaceMatchAdapter;
  nfc: NfcAdapter;
  screening: ScreeningAdapter;
  registry: RegistryAdapter;
  device: DeviceAdapter;
  contactRisk: ContactRiskAdapter;
  chain: ChainAnalysisAdapter;
  storage: StorageAdapter;
  notifications: NotificationAdapter;
}
