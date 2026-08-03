import { describe, expect, it } from 'vitest';
import {
  assessRisk,
  calculateAge,
  combineRiskFactors,
  daysUntil,
  ddLevelFor,
  riskLevelFor,
} from '../src/risk.js';

describe('riskLevelFor', () => {
  it('bands monotonically and never exceeds CRITICAL', () => {
    const bands = [0, 24, 25, 54, 55, 79, 80, 100].map(riskLevelFor);
    const rank = { LOW: 0, MEDIUM: 1, HIGH: 2, CRITICAL: 3 } as const;
    for (let i = 1; i < bands.length; i++) {
      expect(rank[bands[i]!]).toBeGreaterThanOrEqual(rank[bands[i - 1]!]);
    }
    expect(riskLevelFor(100)).toBe('CRITICAL');
    expect(riskLevelFor(0)).toBe('LOW');
  });
});

describe('combineRiskFactors', () => {
  it('is bounded at 100 however many factors pile up', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      code: `F${i}`,
      weight: 40,
      detail: '',
    }));
    const score = combineRiskFactors(many as never);
    expect(score).toBeLessThanOrEqual(100);
    expect(score).toBeGreaterThan(0);
  });

  it('scores nothing as zero', () => {
    expect(combineRiskFactors([])).toBe(0);
  });
});

describe('ddLevelFor', () => {
  it('escalates with score', () => {
    expect(ddLevelFor(10)).toBe('SDD');
    expect(ddLevelFor(30)).toBe('CDD');
    expect(ddLevelFor(70)).toBe('EDD');
  });

  it('honours forceEdd regardless of score', () => {
    expect(ddLevelFor(0, { forceEdd: true })).toBe('EDD');
  });

  /**
   * The ratchet is deliberate: the reason someone was put through enhanced
   * diligence — a PEP position, a high-risk nationality — does not stop being
   * true because a later re-screen came back clean. This test exists so the
   * behaviour is not "fixed" by someone who reads a demotion as a bug.
   */
  it('never demotes an applicant who has already reached a higher level', () => {
    expect(ddLevelFor(0, { current: 'EDD' })).toBe('EDD');
    expect(ddLevelFor(10, { current: 'CDD' })).toBe('CDD');
  });

  it('still promotes from a lower current level', () => {
    expect(ddLevelFor(70, { current: 'SDD' })).toBe('EDD');
  });
});

describe('assessRisk', () => {
  it('carries the ratchet through to the assessment', () => {
    const clean = assessRisk([], { currentDdLevel: 'EDD' });
    expect(clean.score).toBe(0);
    expect(clean.level).toBe('LOW');
    expect(clean.ddLevel).toBe('EDD');
  });
});

describe('date helpers', () => {
  it('calculates age without rolling over before the birthday', () => {
    const now = new Date('2026-05-11T00:00:00Z');
    expect(calculateAge('1990-05-12', now)).toBe(35);
    expect(calculateAge('1990-05-11', now)).toBe(36);
  });

  it('returns null for a missing date rather than guessing', () => {
    expect(calculateAge(null)).toBeNull();
    expect(daysUntil(null)).toBeNull();
  });

  it('reports a past date as negative days', () => {
    const now = new Date('2026-01-31T00:00:00Z');
    expect(daysUntil('2026-01-01', now)).toBe(-30);
    expect(daysUntil('2026-03-02', now)).toBe(30);
  });
});
