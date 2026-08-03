import type {
  AdapterContext,
  AdapterResult,
  FaceMatchAdapter,
  FaceMatchRequest,
  FaceMatchResult,
  Finding,
  LivenessAdapter,
  LivenessRequest,
  LivenessResult,
} from '../types.js';
import {
  detectScenarios,
  hasScenario,
  seededFloat,
  seededInt,
  seededPick,
  seededRandom,
  simulateLatency,
} from '../deterministic.js';

/**
 * Mock biometric adapters.
 *
 * The face embedding matters more than it looks: duplicate-face detection is
 * built on it, so the mock derives the vector from the applicant's *identity*
 * rather than from the applicant id. That way two applicants with the same
 * underlying person produce near-identical vectors and the dedup check has
 * something real to find.
 */

const EMBEDDING_DIM = 64;

function seedOf(ctx: AdapterContext, extra = ''): string {
  return `${ctx.seed ?? ctx.applicantId ?? ctx.tenantId}:${extra}`;
}

/**
 * Deterministic unit-norm vector. Derived from `identitySeed` so the same claimed
 * person yields the same face; the small per-capture jitter mimics the fact that
 * two photos of one face never produce identical embeddings.
 */
export function mockEmbedding(identitySeed: string, captureSeed?: string): number[] {
  const base = seededRandom(`embedding:${identitySeed}`);
  const jitter = captureSeed ? seededRandom(`jitter:${captureSeed}`) : null;
  const raw: number[] = [];
  for (let i = 0; i < EMBEDDING_DIM; i++) {
    const v = base() * 2 - 1;
    raw.push(jitter ? v + (jitter() - 0.5) * 0.04 : v);
  }
  const norm = Math.sqrt(raw.reduce((s, v) => s + v * v, 0)) || 1;
  return raw.map((v) => Math.round((v / norm) * 10000) / 10000);
}

export function cosineSimilarity(a: number[], b: number[]): number {
  const n = Math.min(a.length, b.length);
  let dot = 0;
  let na = 0;
  let nb = 0;
  for (let i = 0; i < n; i++) {
    dot += a[i]! * b[i]!;
    na += a[i]! * a[i]!;
    nb += b[i]! * b[i]!;
  }
  const denom = Math.sqrt(na) * Math.sqrt(nb);
  return denom === 0 ? 0 : dot / denom;
}

/**
 * Bucket key for the dedup index. Signs of the first few dimensions give a
 * coarse partition: near-identical vectors land in the same bucket, so we compare
 * against a few hundred candidates instead of the entire index. A production
 * deployment replaces this with pgvector or a dedicated ANN index.
 */
export function embeddingBucket(embedding: number[]): string {
  return embedding
    .slice(0, 8)
    .map((v) => (v >= 0 ? '1' : '0'))
    .join('');
}

export class MockLivenessAdapter implements LivenessAdapter {
  readonly name = 'mock-liveness';

  async check(
    req: LivenessRequest,
    ctx: AdapterContext,
  ): Promise<AdapterResult<LivenessResult>> {
    const seed = seedOf(ctx, `liveness:${req.mode}`);
    const latencyMs = await simulateLatency(seed, 80, 400);
    const scenarios = detectScenarios(ctx.seed, ctx.applicantId, req.media.storageKey);
    const findings: Finding[] = [];

    if (hasScenario(scenarios, 'NO_FACE')) {
      return {
        ok: true,
        data: {
          score: 0,
          spoofDetected: false,
          attackType: null,
          faceDetected: false,
          faceCount: 0,
          occlusions: [],
          findings: [
            {
              code: 'NO_FACE_DETECTED',
              severity: 'HIGH',
              message: 'No face was found in the captured media.',
            },
          ],
        },
        provider: this.name,
        latencyMs,
      };
    }

    const spoof = hasScenario(scenarios, 'SPOOF');
    const weakLiveness = hasScenario(scenarios, 'LIVENESS_FAIL');

    const attackType = spoof
      ? seededPick(`${seed}:attack`, ['MASK', 'REPLAY', 'DEEPFAKE', 'PRINTED_PHOTO'] as const)
      : null;

    if (spoof) {
      findings.push({
        code: 'PRESENTATION_ATTACK',
        severity: 'CRITICAL',
        message: `Presentation attack detected: ${attackType}.`,
        detail: { attackType },
      });
    } else if (weakLiveness) {
      findings.push({
        code: 'LIVENESS_INCONCLUSIVE',
        severity: 'MEDIUM',
        message: 'Could not confirm liveness; capture conditions were poor.',
      });
    }

    const score = spoof
      ? Math.round(seededFloat(`${seed}:score:spoof`, 0.02, 0.2) * 100) / 100
      : weakLiveness
        ? Math.round(seededFloat(`${seed}:score:weak`, 0.45, 0.74) * 100) / 100
        : Math.round(seededFloat(`${seed}:score:good`, 0.9, 0.995) * 100) / 100;

    // Passive liveness on a still frame is inherently weaker evidence than an
    // active challenge, so cap it lower even on a clean capture.
    const adjusted = req.mode === 'PASSIVE' ? Math.min(score, 0.96) : score;

    const occlusions: string[] = [];
    if (seededFloat(`${seed}:occl`, 0, 1) > 0.9) occlusions.push('GLASSES');

    // The identity seed deliberately ignores the capture: it represents the
    // person, so the same person re-verifying produces a matching template.
    const identitySeed = ctx.seed ?? ctx.applicantId ?? 'unknown';
    const embedding = mockEmbedding(identitySeed, `${identitySeed}:${req.mode}`);

    return {
      ok: true,
      data: {
        score: adjusted,
        spoofDetected: spoof,
        attackType,
        faceDetected: true,
        faceCount: seededFloat(`${seed}:faces`, 0, 1) > 0.97 ? 2 : 1,
        occlusions,
        faceEmbedding: embedding,
        embeddingBucket: embeddingBucket(embedding),
        estimatedAge: seededInt(`${seed}:agest`, 19, 62),
        findings,
      },
      provider: this.name,
      providerRef: `mock-liveness-${seededInt(seed, 100000, 999999)}`,
      latencyMs,
      raw: { mode: req.mode, scenarios: [...scenarios] },
    };
  }
}

export class MockFaceMatchAdapter implements FaceMatchAdapter {
  readonly name = 'mock-facematch';

  async compare(
    req: FaceMatchRequest,
    ctx: AdapterContext,
  ): Promise<AdapterResult<FaceMatchResult>> {
    const seed = seedOf(ctx, 'facematch');
    const latencyMs = await simulateLatency(seed);
    const scenarios = detectScenarios(
      ctx.seed,
      ctx.applicantId,
      req.selfie.storageKey,
      req.documentPortrait.storageKey,
    );

    const mismatch = hasScenario(scenarios, 'FACE_MISMATCH', 'SPOOF');
    const score = mismatch
      ? Math.round(seededFloat(`${seed}:mismatch`, 0.18, 0.62) * 1000) / 1000
      : Math.round(seededFloat(`${seed}:match`, 0.86, 0.99) * 1000) / 1000;

    const findings: Finding[] = [];
    if (score < 0.8) {
      findings.push({
        code: 'FACE_MATCH_BELOW_THRESHOLD',
        severity: score < 0.5 ? 'CRITICAL' : 'HIGH',
        message: `Selfie similarity to the document portrait is ${score.toFixed(2)}.`,
        detail: { score },
      });
    }

    return {
      ok: true,
      data: { score, providerThreshold: 0.8, findings },
      provider: this.name,
      providerRef: `mock-fm-${seededInt(seed, 100000, 999999)}`,
      latencyMs,
      raw: { scenarios: [...scenarios] },
    };
  }
}
