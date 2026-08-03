import { describe, expect, it } from 'vitest';
import {
  acceptsSubmissions,
  canTransition,
  isTerminal,
  transition,
  TRIGGERS as TRANSITIONS,
} from '../src/state-machine.js';

/**
 * The state machine is where authority is enforced. These assert the guards that
 * exist to stop an automated component doing something only a person may do.
 */

describe('authority guards', () => {
  it('lets the pipeline route and auto-decide without a human', () => {
    expect(canTransition('PENDING', 'ROUTED_TO_QUEUE', { actorType: 'SYSTEM' }).ok).toBe(true);
    expect(canTransition('PENDING', 'AUTO_APPROVED', { actorType: 'SYSTEM' }).ok).toBe(true);
    expect(canTransition('PENDING', 'AUTO_REJECTED', { actorType: 'SYSTEM' }).ok).toBe(true);
  });

  it('never lets an automated actor reach REJECTED_FINAL', () => {
    // The pipeline can auto-reject, but only to the retryable state. A final
    // rejection is a legal position and requires a person.
    expect(TRANSITIONS.filter((t) => t !== 'REVIEWER_REJECTED_FINAL')
      .every((t) => {
        try {
          return transition('PENDING', t, { actorType: 'SYSTEM' }).to !== 'REJECTED_FINAL';
        } catch {
          return true;
        }
      })).toBe(true);
    expect(canTransition('QUEUED', 'REVIEWER_REJECTED_FINAL', { actorType: 'SYSTEM' }).ok).toBe(
      false,
    );
  });

  it('refuses a reviewer approval from a non-human actor', () => {
    const result = canTransition('QUEUED', 'REVIEWER_APPROVED', { actorType: 'SYSTEM' });
    expect(result.ok).toBe(false);
    expect(result.ok === false && result.reason).toMatch(/human/i);
  });

  it('does not treat the AI support agent as a human', () => {
    const result = canTransition('QUEUED', 'REVIEWER_APPROVED', { actorType: 'AI_AGENT' });
    expect(result.ok).toBe(false);
  });

  it('refuses to overturn a final rejection without a privileged role', () => {
    const asAgent = canTransition('REJECTED_FINAL', 'DECISION_OVERTURNED_ON_APPEAL', {
      actorType: 'USER',
      actorRole: 'AGENT',
    });
    expect(asAgent.ok).toBe(false);

    const asMlro = canTransition('REJECTED_FINAL', 'DECISION_OVERTURNED_ON_APPEAL', {
      actorType: 'USER',
      actorRole: 'MLRO',
    });
    expect(asMlro.ok).toBe(true);
  });

  it('throws rather than silently ignoring an illegal transition', () => {
    expect(() => transition('APPROVED', 'AUTO_APPROVED', { actorType: 'SYSTEM' })).toThrow();
  });
});

describe('terminal states', () => {
  it('treats a final rejection as terminal and closed to resubmission', () => {
    expect(isTerminal('REJECTED_FINAL')).toBe(true);
    expect(acceptsSubmissions('REJECTED_FINAL')).toBe(false);
  });

  it('lets a retryable rejection be resubmitted', () => {
    expect(isTerminal('REJECTED_RETRY')).toBe(false);
    expect(acceptsSubmissions('REJECTED_RETRY')).toBe(true);
  });
});
