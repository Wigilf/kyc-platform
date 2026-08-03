/**
 * Determinism helpers for the mock adapters.
 *
 * Mock adapters must be deterministic, not random. A demo, a test, and a
 * screenshot all need the same applicant to produce the same outcome every time,
 * and a flaky mock is worse than no mock. Everything is derived from a seed
 * string — usually the applicant id — so results are stable but still varied
 * across applicants.
 *
 * Scenario triggers let a developer force a specific outcome by putting a keyword
 * in the applicant's name or document number. That is how you demo a forged
 * passport without needing a forged passport.
 */

export function hashSeed(input: string): number {
  // FNV-1a. Cheap, well-distributed, and stable across Node versions.
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return hash >>> 0;
}

/** mulberry32: small, fast, good enough, and reproducible. */
export function seededRandom(seed: string): () => number {
  let a = hashSeed(seed);
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

export function seededFloat(seed: string, min: number, max: number): number {
  return min + seededRandom(seed)() * (max - min);
}

export function seededInt(seed: string, min: number, max: number): number {
  return Math.floor(seededFloat(seed, min, max + 1));
}

export function seededPick<T>(seed: string, items: readonly T[]): T {
  if (items.length === 0) throw new Error('seededPick on an empty array');
  return items[seededInt(seed, 0, items.length - 1)]!;
}

export function seededBool(seed: string, probability: number): boolean {
  return seededRandom(seed)() < probability;
}

export type Scenario =
  | 'CLEAN'
  | 'BLURRY'
  | 'GLARE'
  | 'EXPIRED'
  | 'FORGED'
  | 'TAMPERED'
  | 'SCREEN_CAPTURE'
  | 'SPOOF'
  | 'FACE_MISMATCH'
  | 'NAME_MISMATCH'
  | 'DOB_MISMATCH'
  | 'STALE_ADDRESS'
  | 'NO_FACE'
  | 'LIVENESS_FAIL'
  | 'UNDERAGE'
  | 'MRZ_FAIL'
  | 'SANCTIONED'
  | 'PEP'
  | 'ADVERSE_MEDIA'
  | 'DUPLICATE'
  | 'VPN'
  | 'TOR'
  | 'EMULATOR'
  | 'DISPOSABLE_EMAIL'
  | 'VOIP'
  | 'DIRTY_WALLET'
  | 'SHELL_COMPANY'
  | 'DISSOLVED'
  | 'NOMINEE'
  | 'PROVIDER_ERROR';

/**
 * Keyword triggers. Matched case-insensitively against any of the strings a
 * caller passes in (name, document number, email, metadata values).
 */
const TRIGGERS: Array<[RegExp, Scenario]> = [
  [/blurr?y/i, 'BLURRY'],
  [/glare/i, 'GLARE'],
  [/expired/i, 'EXPIRED'],
  [/forg(ed|ery)/i, 'FORGED'],
  [/tamper/i, 'TAMPERED'],
  [/screencap|screenshot/i, 'SCREEN_CAPTURE'],
  [/spoof|deepfake|mask/i, 'SPOOF'],
  // The specific triggers must not also fire FACE_MISMATCH, hence the word
  // boundary on the bare keyword: "namemismatch" has no boundary before
  // "mismatch", so only the specific pattern matches it.
  [/name-?mismatch/i, 'NAME_MISMATCH'],
  [/dob-?mismatch/i, 'DOB_MISMATCH'],
  [/staleaddress|oldbill/i, 'STALE_ADDRESS'],
  [/face-?mismatch|selfie-?mismatch|\bmismatch\b/i, 'FACE_MISMATCH'],
  [/noface/i, 'NO_FACE'],
  [/liveness(fail)?/i, 'LIVENESS_FAIL'],
  [/underage|minor/i, 'UNDERAGE'],
  [/mrzfail|badmrz/i, 'MRZ_FAIL'],
  [/sanction/i, 'SANCTIONED'],
  [/\bpep\b|politic/i, 'PEP'],
  [/adverse|badpress/i, 'ADVERSE_MEDIA'],
  [/duplicate|dupe/i, 'DUPLICATE'],
  [/\bvpn\b/i, 'VPN'],
  [/\btor\b/i, 'TOR'],
  [/emulator|rooted/i, 'EMULATOR'],
  [/disposable|tempmail|mailinator/i, 'DISPOSABLE_EMAIL'],
  [/voip/i, 'VOIP'],
  [/dirtywallet|mixer|darknet/i, 'DIRTY_WALLET'],
  [/shell(co(mpany)?)?/i, 'SHELL_COMPANY'],
  [/dissolved|strikeoff/i, 'DISSOLVED'],
  [/nominee/i, 'NOMINEE'],
  [/providererror|timeout/i, 'PROVIDER_ERROR'],
];

export function detectScenarios(...inputs: Array<string | null | undefined>): Set<Scenario> {
  const haystack = inputs.filter(Boolean).join(' ');
  const found = new Set<Scenario>();
  for (const [pattern, scenario] of TRIGGERS) {
    if (pattern.test(haystack)) found.add(scenario);
  }
  if (found.size === 0) found.add('CLEAN');
  return found;
}

export function hasScenario(
  scenarios: Set<Scenario>,
  ...wanted: Scenario[]
): boolean {
  return wanted.some((s) => scenarios.has(s));
}

/** Simulates provider latency so local timings resemble production shapes. */
export async function simulateLatency(
  seed: string,
  minMs = 40,
  maxMs = 260,
): Promise<number> {
  const ms = Math.round(seededFloat(`${seed}:latency`, minMs, maxMs));
  // Kept short deliberately: realistic ordering matters for finding race
  // conditions, realistic duration only makes the test suite slow.
  await new Promise((r) => setTimeout(r, Math.min(ms, 50)));
  return ms;
}

export function isoDaysFromNow(days: number, from = new Date()): string {
  return new Date(from.getTime() + days * 86_400_000).toISOString().slice(0, 10);
}

export function isoYearsAgo(years: number, from = new Date()): string {
  const d = new Date(from);
  d.setUTCFullYear(d.getUTCFullYear() - years);
  return d.toISOString().slice(0, 10);
}
