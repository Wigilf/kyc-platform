import { assessCountry } from './countries.js';
import { nameSimilarity, normalizeCountry, toDateOnly } from './normalize.js';
import { riskWeightFor } from './reject-labels.js';
import type { Facts } from './rules.js';

/**
 * Risk scoring.
 *
 * The scoring model is deliberately not a sum. Summing lets a pile of weak
 * signals (VPN + new email + odd timezone) manufacture a 90 and auto-reject a
 * legitimate customer, while also letting a single decisive signal get diluted.
 *
 * Instead factors combine probabilistically: each factor is treated as an
 * independent contribution to "something is wrong here", and the total is
 * 1 - Π(1 - wᵢ). That is monotonic, saturating, and gives a single 100-weight
 * factor an unassailable 100 — which is what a confirmed sanctions match should
 * do — while three 20s land at 49, not 60.
 */

export type RiskLevel = 'LOW' | 'MEDIUM' | 'HIGH' | 'CRITICAL';
export type DdLevel = 'SDD' | 'CDD' | 'EDD';

export interface RiskFactor {
  code: string;
  /** 0-100 contribution. */
  weight: number;
  category: string;
  detail?: string;
}

export interface RiskAssessment {
  score: number;
  level: RiskLevel;
  ddLevel: DdLevel;
  factors: RiskFactor[];
  /** The single heaviest factor, which is what a reviewer reads first. */
  primaryDriver?: RiskFactor;
}

export function combineRiskFactors(factors: RiskFactor[]): number {
  let survival = 1;
  for (const f of factors) {
    const w = Math.max(0, Math.min(100, f.weight)) / 100;
    survival *= 1 - w;
  }
  return Math.round((1 - survival) * 100);
}

export function riskLevelFor(score: number): RiskLevel {
  if (score >= 80) return 'CRITICAL';
  if (score >= 55) return 'HIGH';
  if (score >= 30) return 'MEDIUM';
  return 'LOW';
}

/**
 * Due-diligence level. Ratchets upward only: once a customer has been put
 * through EDD, a later clean re-screen does not demote them, because the reason
 * for the EDD (a PEP position, a high-risk nationality) has not gone away.
 */
export function ddLevelFor(
  score: number,
  opts: { current?: DdLevel; forceEdd?: boolean } = {},
): DdLevel {
  const computed: DdLevel =
    opts.forceEdd || score >= 55 ? 'EDD' : score >= 25 ? 'CDD' : 'SDD';
  const rank: Record<DdLevel, number> = { SDD: 0, CDD: 1, EDD: 2 };
  const current = opts.current ?? 'SDD';
  return rank[computed] >= rank[current] ? computed : current;
}

export function assessRisk(
  factors: RiskFactor[],
  opts: { currentDdLevel?: DdLevel; forceEdd?: boolean } = {},
): RiskAssessment {
  const present = factors.filter((f) => f.weight > 0);
  const score = combineRiskFactors(present);
  const sorted = [...present].sort((a, b) => b.weight - a.weight);
  return {
    score,
    level: riskLevelFor(score),
    ddLevel: ddLevelFor(score, {
      current: opts.currentDdLevel,
      forceEdd: opts.forceEdd,
    }),
    factors: sorted,
    ...(sorted[0] ? { primaryDriver: sorted[0] } : {}),
  };
}

export function calculateAge(
  dob: Date | string | null | undefined,
  now: Date = new Date(),
): number | null {
  const iso = toDateOnly(dob);
  if (!iso) return null;
  const birth = new Date(`${iso}T00:00:00Z`);
  let age = now.getUTCFullYear() - birth.getUTCFullYear();
  const monthDelta = now.getUTCMonth() - birth.getUTCMonth();
  if (monthDelta < 0 || (monthDelta === 0 && now.getUTCDate() < birth.getUTCDate())) {
    age--;
  }
  return age < 0 || age > 130 ? null : age;
}

export function daysUntil(date: Date | string | null | undefined, now = new Date()): number | null {
  if (!date) return null;
  const d = date instanceof Date ? date : new Date(date);
  if (Number.isNaN(d.getTime())) return null;
  return Math.floor((d.getTime() - now.getTime()) / 86_400_000);
}

// ---------------------------------------------------------------------------
// Fact assembly
// ---------------------------------------------------------------------------

/**
 * Everything the rules engine may reference for an applicant decision. Built in
 * one place so the fact namespace is a contract rather than whatever each caller
 * happened to pass, and so a rule author can be shown the available facts.
 */
export interface ApplicantSnapshot {
  applicant: {
    id: string;
    externalUserId: string;
    reviewStatus: string;
    riskScore?: number;
    ddLevel?: DdLevel;
    firstName?: string | null;
    lastName?: string | null;
    dob?: Date | string | null;
    country?: string | null;
    nationality?: string | null;
    email?: string | null;
    phone?: string | null;
    ipCountry?: string | null;
    occupation?: string | null;
    submissionAttempts?: number;
    createdAt?: Date | string;
    tags?: string[];
  };
  documents?: Array<{
    type: string;
    country?: string | null;
    number?: string | null;
    expiryDate?: Date | string | null;
    authenticityScore?: number | null;
    tamperFlags?: string[];
    mrzValid?: boolean | null;
    nfcVerified?: boolean | null;
    extracted?: Record<string, unknown>;
  }>;
  checks?: Array<{
    type: string;
    status: string;
    result?: string | null;
    score?: number | null;
    rejectLabels?: string[];
  }>;
  screening?: {
    trigger?: string;
    openHits?: number;
    newHits?: number;
    confirmedSanctionsHits?: number;
    pepHits?: number;
    maxPepTier?: number | null;
    adverseMediaHits?: number;
    adverseMediaCategories?: string[];
    openHitListTypes?: string[];
  };
  device?: {
    isVpn?: boolean;
    isTor?: boolean;
    isProxy?: boolean;
    isEmulator?: boolean;
    isRooted?: boolean;
    botScore?: number;
    geoMismatch?: boolean;
  };
  contact?: {
    emailDisposable?: boolean;
    emailAgeDays?: number | null;
    phoneVoip?: boolean;
    phoneCarrierCountry?: string | null;
  };
  duplicate?: {
    identityMatchCount?: number;
    faceMatchCount?: number;
    sameIdentity?: boolean;
    deviceSharedWithCount?: number;
  };
  liveness?: {
    score?: number | null;
    spoofDetected?: boolean;
    attackType?: string | null;
  };
  faceMatch?: { score?: number | null };
  requiredStepIds?: string[];
  completedStepIds?: string[];
}

export function buildApplicantFacts(
  snapshot: ApplicantSnapshot,
  now: Date = new Date(),
): Facts {
  const a = snapshot.applicant;
  const documents = snapshot.documents ?? [];
  const checks = snapshot.checks ?? [];

  // The identity document drives most document facts; pick the most recent one
  // that actually produced extracted data.
  const idDoc =
    documents.find((d) =>
      ['PASSPORT', 'ID_CARD', 'DRIVERS_LICENSE', 'RESIDENCE_PERMIT'].includes(d.type),
    ) ?? documents[0];

  const declaredName = [a.firstName, a.lastName].filter(Boolean).join(' ');
  const docName = idDoc?.extracted
    ? [idDoc.extracted['firstName'], idDoc.extracted['lastName']]
        .filter(Boolean)
        .join(' ')
    : '';
  const docDob = idDoc?.extracted ? toDateOnly(idDoc.extracted['dob'] as string) : null;

  const completed = new Set(snapshot.completedStepIds ?? []);
  const required = snapshot.requiredStepIds ?? [];

  const failedChecks = checks.filter((c) => c.result === 'FAIL');
  const warningChecks = checks.filter((c) => c.result === 'WARNING');
  const pendingChecks = checks.filter(
    (c) => c.status === 'PENDING' || c.status === 'RUNNING',
  );

  const countryRisk = assessCountry(normalizeCountry(a.country));
  const nationalityRisk = assessCountry(normalizeCountry(a.nationality));

  return {
    applicant: {
      ...a,
      country: normalizeCountry(a.country),
      nationality: normalizeCountry(a.nationality),
      ipCountry: normalizeCountry(a.ipCountry),
      age: calculateAge(a.dob, now),
      riskScore: a.riskScore ?? 0,
      ddLevel: a.ddLevel ?? 'SDD',
      submissionAttempts: a.submissionAttempts ?? 0,
      tags: a.tags ?? [],
      accountAgeDays:
        a.createdAt !== undefined
          ? Math.max(0, -(daysUntil(a.createdAt, now) ?? 0))
          : null,
    },
    country: {
      score: countryRisk.score,
      categories: countryRisk.categories,
      blocked: countryRisk.blocked,
      requiresEdd: countryRisk.requiresEdd,
      nationalityScore: nationalityRisk.score,
      nationalityCategories: nationalityRisk.categories,
    },
    document: idDoc
      ? {
          type: idDoc.type,
          issuingCountry: normalizeCountry(idDoc.country),
          number: idDoc.number ?? null,
          expiryDate: idDoc.expiryDate ?? null,
          daysUntilExpiry: daysUntil(idDoc.expiryDate, now),
          authenticityScore: idDoc.authenticityScore ?? null,
          tamperFlags: idDoc.tamperFlags ?? [],
          mrzValid: idDoc.mrzValid ?? null,
          nfcVerified: idDoc.nfcVerified ?? null,
        }
      : {},
    documents: documents.map((d) => ({
      type: d.type,
      issuingCountry: normalizeCountry(d.country),
      daysUntilExpiry: daysUntil(d.expiryDate, now),
      authenticityScore: d.authenticityScore ?? null,
      tamperFlags: d.tamperFlags ?? [],
    })),
    checks: {
      total: checks.length,
      failedCount: failedChecks.length,
      warningCount: warningChecks.length,
      pendingCount: pendingChecks.length,
      failedTypes: failedChecks.map((c) => c.type),
      // "All required passed" needs every required step complete AND no failures.
      // Either condition alone is insufficient: a missing step is not a pass.
      allRequiredPassed:
        required.every((id) => completed.has(id)) &&
        failedChecks.length === 0 &&
        pendingChecks.length === 0,
      byType: Object.fromEntries(
        checks.map((c) => [
          c.type,
          { status: c.status, result: c.result ?? null, score: c.score ?? null },
        ]),
      ),
      rejectLabels: [...new Set(checks.flatMap((c) => c.rejectLabels ?? []))],
    },
    screening: {
      trigger: snapshot.screening?.trigger ?? 'INITIAL',
      openHits: snapshot.screening?.openHits ?? 0,
      newHits: snapshot.screening?.newHits ?? 0,
      confirmedSanctionsHits: snapshot.screening?.confirmedSanctionsHits ?? 0,
      pepHits: snapshot.screening?.pepHits ?? 0,
      // Absent PEP tier must not read as "tier 0" (more senior than tier 1) in a
      // `lte` comparison, so use a value no tier can satisfy.
      maxPepTier: snapshot.screening?.maxPepTier ?? 99,
      adverseMediaHits: snapshot.screening?.adverseMediaHits ?? 0,
      adverseMediaCategories: snapshot.screening?.adverseMediaCategories ?? [],
      openHitListTypes: snapshot.screening?.openHitListTypes ?? [],
    },
    device: {
      isVpn: false,
      isTor: false,
      isProxy: false,
      isEmulator: false,
      isRooted: false,
      botScore: 0,
      ...snapshot.device,
    },
    contact: { ...snapshot.contact },
    duplicate: {
      identityMatchCount: 0,
      faceMatchCount: 0,
      sameIdentity: true,
      deviceSharedWithCount: 0,
      ...snapshot.duplicate,
    },
    liveness: { spoofDetected: false, ...snapshot.liveness },
    faceMatch: { ...snapshot.faceMatch },
    match: {
      nameSimilarity:
        declaredName && docName ? nameSimilarity(declaredName, docName) : null,
      dobMatches:
        docDob && a.dob ? docDob === toDateOnly(a.dob) : null,
      countryMatches:
        a.ipCountry && a.country
          ? normalizeCountry(a.ipCountry) === normalizeCountry(a.country)
          : null,
      docCountryMatchesNationality:
        idDoc?.country && a.nationality
          ? normalizeCountry(idDoc.country) === normalizeCountry(a.nationality)
          : null,
    },
    steps: {
      requiredCount: required.length,
      completedCount: required.filter((id) => completed.has(id)).length,
      outstanding: required.filter((id) => !completed.has(id)),
    },
  };
}

/**
 * Derives risk factors from the same snapshot. Rules can add more via ADD_RISK;
 * these are the intrinsic ones that hold regardless of tenant policy.
 */
export function deriveRiskFactors(snapshot: ApplicantSnapshot): RiskFactor[] {
  const factors: RiskFactor[] = [];
  const a = snapshot.applicant;

  const countryRisk = assessCountry(normalizeCountry(a.country));
  if (countryRisk.score > 0) {
    factors.push({
      code: 'COUNTRY_RISK',
      weight: countryRisk.score,
      category: 'geography',
      detail: `${countryRisk.country}: ${countryRisk.categories.join(', ')}`,
    });
  }

  const nationalityRisk = assessCountry(normalizeCountry(a.nationality));
  if (nationalityRisk.score > 0 && nationalityRisk.country !== countryRisk.country) {
    factors.push({
      code: 'NATIONALITY_RISK',
      // Nationality is a weaker signal than residence for AML purposes.
      weight: Math.round(nationalityRisk.score * 0.6),
      category: 'geography',
      detail: `${nationalityRisk.country}: ${nationalityRisk.categories.join(', ')}`,
    });
  }

  const screening = snapshot.screening;
  if (screening?.confirmedSanctionsHits) {
    factors.push({
      code: 'SANCTIONS_CONFIRMED',
      weight: 100,
      category: 'screening',
      detail: `${screening.confirmedSanctionsHits} confirmed match(es)`,
    });
  } else if (screening?.openHits) {
    factors.push({
      code: 'SCREENING_OPEN_HITS',
      weight: Math.min(60, 25 + screening.openHits * 10),
      category: 'screening',
      detail: `${screening.openHits} open hit(s)`,
    });
  }
  if (screening?.pepHits) {
    const tier = screening.maxPepTier ?? 4;
    factors.push({
      code: 'PEP_EXPOSURE',
      // Tier 1 (head of state) is materially riskier than tier 4 (local official).
      weight: tier <= 1 ? 50 : tier === 2 ? 40 : tier === 3 ? 22 : 15,
      category: 'screening',
      detail: `PEP tier ${tier}`,
    });
  }
  if (screening?.adverseMediaHits) {
    factors.push({
      code: 'ADVERSE_MEDIA',
      weight: 30,
      category: 'screening',
      detail: (screening.adverseMediaCategories ?? []).join(', ') || undefined,
    });
  }

  const labels = [
    ...new Set((snapshot.checks ?? []).flatMap((c) => c.rejectLabels ?? [])),
  ];
  const labelWeight = riskWeightFor(labels);
  if (labelWeight > 0) {
    factors.push({
      code: 'CHECK_FINDINGS',
      weight: labelWeight,
      category: 'verification',
      detail: labels.join(', '),
    });
  }

  const d = snapshot.device;
  if (d?.isEmulator || d?.isRooted) {
    factors.push({
      code: 'DEVICE_INTEGRITY',
      weight: 30,
      category: 'device',
      detail: d.isEmulator ? 'emulator' : 'rooted/jailbroken',
    });
  }
  if (d?.isTor) {
    factors.push({ code: 'TOR_EXIT', weight: 20, category: 'device' });
  } else if (d?.isVpn || d?.isProxy) {
    factors.push({ code: 'ANONYMISING_PROXY', weight: 10, category: 'device' });
  }
  if ((d?.botScore ?? 0) >= 60) {
    factors.push({
      code: 'AUTOMATION_SUSPECTED',
      weight: 25,
      category: 'device',
      detail: `bot score ${d?.botScore}`,
    });
  }

  const dup = snapshot.duplicate;
  if (dup?.faceMatchCount && dup.sameIdentity === false) {
    factors.push({ code: 'DUPLICATE_FACE', weight: 85, category: 'fraud' });
  }
  if (dup?.identityMatchCount) {
    factors.push({
      code: 'DUPLICATE_IDENTITY',
      weight: 50,
      category: 'fraud',
      detail: `${dup.identityMatchCount} existing account(s)`,
    });
  }
  if ((dup?.deviceSharedWithCount ?? 0) >= 5) {
    factors.push({
      code: 'DEVICE_CLUSTER',
      weight: 40,
      category: 'fraud',
      detail: `${dup?.deviceSharedWithCount} applicants share this device`,
    });
  }

  if (snapshot.liveness?.spoofDetected) {
    factors.push({
      code: 'PRESENTATION_ATTACK',
      weight: 95,
      category: 'fraud',
      detail: snapshot.liveness.attackType ?? undefined,
    });
  }

  const fm = snapshot.faceMatch?.score;
  if (typeof fm === 'number' && fm < 0.8) {
    factors.push({
      code: 'FACE_MATCH_LOW',
      // Scale so 0.79 is a mild concern and 0.4 is decisive.
      weight: Math.round(Math.min(70, (0.8 - fm) * 200)),
      category: 'biometric',
      detail: `similarity ${fm.toFixed(2)}`,
    });
  }

  if (snapshot.contact?.emailDisposable) {
    factors.push({ code: 'DISPOSABLE_EMAIL', weight: 12, category: 'contact' });
  }
  if (snapshot.contact?.phoneVoip) {
    factors.push({ code: 'VOIP_PHONE', weight: 10, category: 'contact' });
  }

  return factors;
}

// ---------------------------------------------------------------------------
// Transaction facts
// ---------------------------------------------------------------------------

export interface TransactionSnapshot {
  tx: {
    id: string;
    externalId: string;
    direction: string;
    type: string;
    amountBase: number;
    currency: string;
    counterpartyName?: string | null;
    counterpartyCountry?: string | null;
    counterpartySanctioned?: boolean;
    counterpartyWallet?: string | null;
    chain?: string | null;
    walletCategories?: string[];
    walletRiskScore?: number | null;
    walletExposureHops?: number | null;
    ipCountry?: string | null;
    occurredAt: Date | string;
    paymentMethod?: string | null;
  };
  applicant?: {
    id: string;
    reviewStatus: string;
    riskLevel?: string;
    country?: string | null;
    ddLevel?: string;
  };
  /** Pre-computed aggregates. Computing these in the worker keeps rules pure. */
  aggregates?: {
    count24h?: number;
    sum24h?: number;
    count7d?: number;
    sum7d?: number;
    count30d?: number;
    sum30d?: number;
    lifetimeCount?: number;
    lifetimeSum?: number;
    baselineDailyAvg?: number;
    minutesSinceLastInbound?: number | null;
    inboundSum24h?: number;
    outboundSum24h?: number;
    distinctCounterparties30d?: number;
  };
}

export function buildTransactionFacts(snapshot: TransactionSnapshot): Facts {
  const t = snapshot.tx;
  const agg = snapshot.aggregates ?? {};
  const inbound = agg.inboundSum24h ?? 0;
  const outbound = agg.outboundSum24h ?? 0;

  return {
    tx: {
      ...t,
      counterpartyCountry: normalizeCountry(t.counterpartyCountry),
      ipCountry: normalizeCountry(t.ipCountry),
      isCrypto: Boolean(t.chain),
      walletCategories: t.walletCategories ?? [],
      walletExposureHops: t.walletExposureHops ?? 99,
      counterpartySanctioned: t.counterpartySanctioned ?? false,
    },
    applicant: {
      reviewStatus: 'NOT_STARTED',
      riskLevel: 'LOW',
      ...snapshot.applicant,
      country: normalizeCountry(snapshot.applicant?.country),
    },
    agg: {
      count24h: agg.count24h ?? 0,
      sum24h: agg.sum24h ?? 0,
      count7d: agg.count7d ?? 0,
      sum7d: agg.sum7d ?? 0,
      count30d: agg.count30d ?? 0,
      sum30d: agg.sum30d ?? 0,
      lifetimeCount: agg.lifetimeCount ?? 0,
      lifetimeSum: agg.lifetimeSum ?? 0,
      baselineDailyAvg: agg.baselineDailyAvg ?? 0,
      minutesSinceLastInbound: agg.minutesSinceLastInbound ?? null,
      inboundSum24h: inbound,
      outboundSum24h: outbound,
      distinctCounterparties30d: agg.distinctCounterparties30d ?? 0,
      // Derived ratios the rules reference directly, so rule authors do not have
      // to express arithmetic in the AST.
      sum24hOverBaseline:
        (agg.baselineDailyAvg ?? 0) > 0
          ? (agg.sum24h ?? 0) / (agg.baselineDailyAvg ?? 1)
          : 0,
      outboundToInboundRatio: inbound > 0 ? outbound / inbound : 0,
    },
  };
}
