import { normalizeCountry, normalizeEmail, normalizePhone, sha256 } from '@kyc/core';
import type {
  AdapterContext,
  AdapterResult,
  ChainAnalysisAdapter,
  ContactRiskAdapter,
  ContactRiskRequest,
  ContactRiskResult,
  DeclaredSubjectSource,
  DeviceAdapter,
  DeviceRequest,
  DeviceResult,
  Finding,
  WalletScreeningRequest,
  WalletScreeningResult,
} from '../types.js';
import {
  detectScenarios,
  hasScenario,
  seededFloat,
  seededInt,
  seededPick,
  simulateLatency,
} from '../deterministic.js';

/**
 * Device, contact, and blockchain signal adapters.
 *
 * These three produce the weak signals that the compound-fraud rules combine.
 * Individually none of them should decide anything, and the mocks are calibrated
 * accordingly: clean applicants get clean-but-not-perfect signals, so the
 * scoring model is exercised rather than trivially satisfied.
 */

const DISPOSABLE_DOMAINS = new Set([
  'mailinator.com', 'tempmail.com', 'guerrillamail.com', '10minutemail.com',
  'yopmail.com', 'trashmail.com', 'sharklasers.com', 'throwawaymail.com',
  'dispostable.com', 'maildrop.cc', 'temp-mail.org', 'getnada.com',
]);

const FREE_PROVIDERS = new Set([
  'gmail.com', 'yahoo.com', 'hotmail.com', 'outlook.com', 'icloud.com',
  'aol.com', 'gmx.com', 'protonmail.com', 'mail.com', 'yandex.com',
]);

const IP_COUNTRY_BY_PREFIX: Record<string, string> = {
  '81.': 'GBR', '82.': 'GBR', '91.': 'DEU', '78.': 'FRA', '79.': 'ITA',
  '77.': 'RUS', '185.': 'NLD', '196.': 'ZAF', '103.': 'SGP', '41.': 'NGA',
  '200.': 'BRA', '190.': 'ARG', '5.': 'IRN', '175.': 'CHN', '49.': 'IND',
};

export class MockDeviceAdapter implements DeviceAdapter {
  readonly name = 'mock-device';

  constructor(private readonly declaredSubjects: DeclaredSubjectSource) {}

  async assess(
    req: DeviceRequest,
    ctx: AdapterContext,
  ): Promise<AdapterResult<DeviceResult>> {
    const seed = `${ctx.applicantId ?? ctx.tenantId}:device:${req.fingerprint ?? req.ipAddress ?? 'unknown'}`;
    const latencyMs = await simulateLatency(seed, 20, 120);
    const scenarios = detectScenarios(
      ctx.seed,
      ctx.applicantId,
      req.userAgent,
      JSON.stringify(req.clientSignals ?? {}),
    );
    const findings: Finding[] = [];

    const isTor = hasScenario(scenarios, 'TOR');

    const ip = req.ipAddress ?? '';
    const prefixMatch = Object.keys(IP_COUNTRY_BY_PREFIX).find((p) => ip.startsWith(p));
    // Where the IP itself does not say, an applicant connecting from home is in
    // the country they declared. Picking at random instead flagged a geo mismatch
    // on roughly six applicants in seven, including clean ones.
    const declared = ctx.applicantId
      ? await this.declaredSubjects.load(ctx.applicantId)
      : null;
    const inferredCountry =
      normalizeCountry(declared?.country ?? undefined) ??
      seededPick(`${seed}:ipc`, ['GBR', 'DEU', 'FRA', 'NLD', 'ESP', 'ITA', 'USA']);
    const ipCountry = prefixMatch
      ? IP_COUNTRY_BY_PREFIX[prefixMatch]!
      : ip
        ? // Anonymised traffic genuinely exits somewhere unrelated to the user.
          isTor || hasScenario(scenarios, 'VPN')
          ? seededPick(`${seed}:exit`, ['USA', 'NLD', 'PAN', 'SYC', 'ROU'])
          : inferredCountry
        : null;
    const isVpn = hasScenario(scenarios, 'VPN') || (!isTor && seededFloat(`${seed}:vpn`, 0, 1) > 0.88);
    const isEmulator = hasScenario(scenarios, 'EMULATOR');

    if (isTor) {
      findings.push({
        code: 'TOR_EXIT_NODE',
        severity: 'HIGH',
        message: 'Session originates from a Tor exit node.',
      });
    } else if (isVpn) {
      findings.push({
        code: 'VPN_DETECTED',
        severity: 'LOW',
        message: 'Session appears to use a commercial VPN.',
      });
    }
    if (isEmulator) {
      findings.push({
        code: 'EMULATOR_DETECTED',
        severity: 'HIGH',
        message: 'Client environment appears to be an emulator or rooted device.',
      });
    }

    const botScore = isEmulator
      ? seededInt(`${seed}:bot:emu`, 65, 95)
      : isTor
        ? seededInt(`${seed}:bot:tor`, 40, 70)
        : seededInt(`${seed}:bot:clean`, 2, 28);

    const ua = req.userAgent ?? '';
    const os = /iphone|ipad/i.test(ua) ? 'iOS'
      : /android/i.test(ua) ? 'Android'
      : /mac os/i.test(ua) ? 'macOS'
      : /windows/i.test(ua) ? 'Windows'
      : /linux/i.test(ua) ? 'Linux'
      : null;
    const browser = /chrome/i.test(ua) ? 'Chrome'
      : /safari/i.test(ua) ? 'Safari'
      : /firefox/i.test(ua) ? 'Firefox'
      : /edg/i.test(ua) ? 'Edge'
      : null;

    return {
      ok: true,
      data: {
        // Stable, non-reversible device id: hashing means we can correlate
        // devices across applicants without retaining the raw fingerprint.
        //
        // The applicant is part of the hash. Without it, every applicant sharing
        // the default user agent and IP — which in seeded demo data is all of
        // them — collapses onto one fingerprint and the whole population looks
        // like a single device farm. A genuinely shared device is what the
        // DUPLICATE scenario is for, and it still produces one.
        fingerprint:
          req.fingerprint ??
          (hasScenario(scenarios, 'DUPLICATE')
            ? sha256(`shared-device|${ua}|${ip}`).slice(0, 32)
            : sha256(`${ctx.applicantId ?? ctx.tenantId}|${ua}|${ip}`).slice(0, 32)),
        ipCountry,
        asn: ip ? `AS${seededInt(`${seed}:asn`, 1000, 65000)}` : null,
        isp: isVpn ? seededPick(`${seed}:isp`, ['NordVPN', 'Mullvad', 'Surfshark']) : 'Regional Telecom',
        isVpn,
        isTor,
        isProxy: isVpn || isTor,
        isDatacenter: isVpn || isTor || seededFloat(`${seed}:dc`, 0, 1) > 0.93,
        isEmulator,
        isRooted: isEmulator || seededFloat(`${seed}:root`, 0, 1) > 0.96,
        os,
        browser,
        timezone: seededPick(`${seed}:tz`, [
          'Europe/London', 'Europe/Berlin', 'Europe/Paris', 'Europe/Madrid',
          'America/New_York', 'Asia/Singapore',
        ]),
        botScore,
        findings,
      },
      provider: this.name,
      latencyMs,
      raw: { scenarios: [...scenarios] },
    };
  }
}

export class MockContactRiskAdapter implements ContactRiskAdapter {
  readonly name = 'mock-contact-risk';

  async assess(
    req: ContactRiskRequest,
    ctx: AdapterContext,
  ): Promise<AdapterResult<ContactRiskResult>> {
    const seed = `${ctx.applicantId ?? ctx.tenantId}:contact`;
    const latencyMs = await simulateLatency(seed, 20, 100);
    const scenarios = detectScenarios(ctx.seed, req.email, req.phone);
    const findings: Finding[] = [];
    const result: ContactRiskResult = { findings };

    if (req.email) {
      const normalized = normalizeEmail(req.email);
      const domain = normalized.split('@')[1] ?? '';
      const disposable =
        DISPOSABLE_DOMAINS.has(domain) || hasScenario(scenarios, 'DISPOSABLE_EMAIL');
      const free = FREE_PROVIDERS.has(domain);
      const valid = /^[^@\s]+@[^@\s.]+\.[^@\s]+$/.test(normalized);

      // Breach presence is counter-intuitively reassuring: an address that has
      // existed long enough to appear in an old breach is not freshly minted for
      // this signup.
      const breachCount = disposable
        ? 0
        : free
          ? seededInt(`${seed}:breach`, 0, 6)
          : seededInt(`${seed}:breach:corp`, 0, 2);

      const domainAgeDays = disposable
        ? seededInt(`${seed}:domage:disp`, 30, 400)
        : free
          ? 7000
          : seededInt(`${seed}:domage`, 200, 6000);

      let riskScore = 0;
      if (!valid) riskScore += 60;
      if (disposable) riskScore += 55;
      if (domainAgeDays < 90) riskScore += 25;
      if (breachCount === 0 && !disposable) riskScore += 5;

      if (disposable) {
        findings.push({
          code: 'DISPOSABLE_EMAIL',
          severity: 'MEDIUM',
          message: `${domain} is a disposable email provider.`,
        });
      }
      if (domainAgeDays < 90) {
        findings.push({
          code: 'NEW_EMAIL_DOMAIN',
          severity: 'LOW',
          message: `Email domain is only ${domainAgeDays} days old.`,
        });
      }

      result.email = {
        valid,
        deliverable: valid ? !disposable : false,
        disposable,
        freeProvider: free,
        domainAgeDays,
        breachCount,
        riskScore: Math.min(100, riskScore),
      };
    }

    if (req.phone) {
      const normalized = normalizePhone(req.phone);
      const voip = hasScenario(scenarios, 'VOIP') || seededFloat(`${seed}:voip`, 0, 1) > 0.9;
      const valid = normalized.length >= 8;
      const lineType = voip
        ? ('VOIP' as const)
        : seededFloat(`${seed}:line`, 0, 1) > 0.15
          ? ('MOBILE' as const)
          : ('LANDLINE' as const);
      const recentlyPorted = seededFloat(`${seed}:port`, 0, 1) > 0.95;

      let riskScore = 0;
      if (!valid) riskScore += 50;
      if (voip) riskScore += 40;
      if (recentlyPorted) riskScore += 30;

      if (voip) {
        findings.push({
          code: 'VOIP_NUMBER',
          severity: 'MEDIUM',
          message: 'Phone number is a VOIP line rather than a mobile.',
        });
      }
      if (recentlyPorted) {
        findings.push({
          code: 'RECENTLY_PORTED',
          severity: 'MEDIUM',
          message: 'Number was ported recently, which is associated with SIM-swap takeover.',
        });
      }

      result.phone = {
        valid,
        lineType,
        carrier: voip ? 'Twilio' : seededPick(`${seed}:carrier`, ['Vodafone', 'O2', 'Orange', 'T-Mobile']),
        countryCode: normalized.slice(0, 3),
        recentlyPorted,
        riskScore: Math.min(100, riskScore),
      };
    }

    return { ok: true, data: result, provider: this.name, latencyMs };
  }
}

const ILLICIT_CATEGORIES = [
  'darknet', 'mixer', 'ransomware', 'sanctioned-entity', 'stolen-funds',
  'scam', 'gambling-unlicensed', 'terrorism-financing',
];

const BENIGN_CATEGORIES = ['exchange', 'merchant-services', 'mining-pool', 'defi-protocol', 'wallet-service'];

export class MockChainAnalysisAdapter implements ChainAnalysisAdapter {
  readonly name = 'mock-chain';

  async screenAddress(
    req: WalletScreeningRequest,
    ctx: AdapterContext,
  ): Promise<AdapterResult<WalletScreeningResult>> {
    const seed = `${req.chain}:${req.address}`;
    const latencyMs = await simulateLatency(seed, 60, 300);
    const scenarios = detectScenarios(ctx.seed, req.address, ctx.applicantId);
    const findings: Finding[] = [];

    const dirty =
      hasScenario(scenarios, 'DIRTY_WALLET') ||
      // Deterministic on the address itself, so the same wallet always screens
      // the same way no matter which applicant presents it.
      seededFloat(`${seed}:dirty`, 0, 1) > 0.88;

    if (!dirty) {
      const category = seededPick(`${seed}:benign`, BENIGN_CATEGORIES);
      return {
        ok: true,
        data: {
          riskScore: seededInt(`${seed}:clean`, 1, 18),
          severity: 'LOW',
          categories: [category],
          clusterName: seededPick(`${seed}:cluster`, ['Binance', 'Kraken', 'Coinbase', 'unattributed']),
          clusterCategory: category,
          exposureHops: null,
          exposureBreakdown: { [category]: 1 },
          isSanctioned: false,
          findings: [],
        },
        provider: this.name,
        latencyMs,
      };
    }

    const primary = seededPick(`${seed}:cat`, ILLICIT_CATEGORIES);
    const hops = seededInt(`${seed}:hops`, 1, 4);
    const sanctioned = primary === 'sanctioned-entity';

    // Direct exposure is a different order of concern from four hops away, where
    // most of the network is reachable from most of the network.
    const riskScore = sanctioned ? 100 : Math.max(20, 95 - (hops - 1) * 22);
    const severity =
      riskScore >= 80 ? 'CRITICAL' : riskScore >= 55 ? 'HIGH' : riskScore >= 30 ? 'MEDIUM' : 'LOW';

    findings.push({
      code: 'ILLICIT_EXPOSURE',
      severity: severity as Finding['severity'],
      message: `Address has ${hops}-hop exposure to ${primary}.`,
      detail: { category: primary, hops },
    });
    if (sanctioned) {
      findings.push({
        code: 'SANCTIONED_ADDRESS',
        severity: 'CRITICAL',
        message: 'Address is attributed to a sanctioned entity.',
      });
    }

    const directShare = Math.round((1 / hops) * 100) / 100;
    return {
      ok: true,
      data: {
        riskScore,
        severity: severity as WalletScreeningResult['severity'],
        categories: [primary],
        clusterName: sanctioned ? 'OFAC-listed cluster' : seededPick(`${seed}:dc`, ['unattributed', 'Hydra Market', 'Tornado Cash']),
        clusterCategory: primary,
        exposureHops: hops,
        exposureBreakdown: { [primary]: directShare, legitimate: Math.round((1 - directShare) * 100) / 100 },
        isSanctioned: sanctioned,
        findings,
      },
      provider: this.name,
      latencyMs,
      raw: { scenarios: [...scenarios] },
    };
  }

  async verifyOwnership(
    req: { chain: string; address: string; message: string; signature: string },
    ctx: AdapterContext,
  ): Promise<AdapterResult<{ verified: boolean; method: string }>> {
    const seed = `${req.chain}:${req.address}:ownership`;
    const latencyMs = await simulateLatency(seed, 20, 90);

    // A real implementation recovers the public key from the signature and
    // compares the derived address. The mock checks structure only, but rejects
    // obviously absent proof rather than waving it through.
    const plausible =
      req.signature.length >= 64 && req.message.includes(req.address.slice(0, 6));

    return {
      ok: true,
      data: {
        verified: plausible,
        method: 'SIGNED_MESSAGE',
      },
      provider: this.name,
      latencyMs,
      ...(plausible
        ? {}
        : {
            raw: {
              reason: 'signature too short, or the challenge message does not bind the address',
            },
          }),
    };
  }
}
