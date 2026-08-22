/**
 * WTE — Self-healing engine (Section 43).
 * STRICTLY limited to automation-reliability problems: timing/wait policy,
 * stale selectors (GUI phase), retry policy. Business logic is never touched.
 * Every action: explainable, confidence-scored, logged, versioned, reversible,
 * and verified through re-execution by the execution engine.
 */
import type { ExecutionStep, HealingEvent } from '../core/types.js';

export interface HealingCandidate {
  step: ExecutionStep;
  classification: string;
  failureCount: number;
}

export interface HealingStrategy {
  name: string;
  applies(c: HealingCandidate): boolean;
  confidence(c: HealingCandidate): number;
  describe(c: HealingCandidate): string;
  apply(c: HealingCandidate): Partial<Pick<ExecutionStep, 'timeoutMs' | 'maxAttempts'>>;
}

/** Timeout escalation: step keeps timing out → heal the wait policy, never the assertion. */
const timeoutEscalation: HealingStrategy = {
  name: 'timeout-escalation',
  applies: (c) => c.classification === 'timing-issue' && c.failureCount >= 1,
  confidence: (c) => Math.min(0.9, 0.55 + c.failureCount * 0.1),
  describe: (c) => `Raise step "${c.step.name}" timeout by 50% (automation-reliability only; no business logic touched).`,
  apply: (c) => ({ timeoutMs: Math.min(120_000, Math.round(c.step.timeoutMs * 1.5)) }),
};

/** Retry widening: flaky classification → one extra attempt to confirm stability. */
const retryWidening: HealingStrategy = {
  name: 'retry-widening',
  applies: (c) => c.classification === 'flaky-behavior',
  confidence: () => 0.5,
  describe: (c) => `Allow one additional attempt for flaky step "${c.step.name}" to confirm stability.`,
  apply: (c) => ({ maxAttempts: c.step.maxAttempts + 1 }),
};

export const HEALING_STRATEGIES: readonly HealingStrategy[] = [timeoutEscalation, retryWidening];

export class Healer {
  /** Returns a HealingEvent proposal, never mutating silently. */
  propose(candidate: HealingCandidate): HealingEvent | null {
    for (const strategy of HEALING_STRATEGIES) {
      if (!strategy.applies(candidate)) continue;
      return {
        strategy: strategy.name,
        description: strategy.describe(candidate),
        confidence: strategy.confidence(candidate),
        reversible: true,
        appliedAt: new Date().toISOString(),
        outcome: 'applied',
      };
    }
    return null;
  }

  /** Applies the healing adjustment to the step definition (reversible: original values preserved by caller). */
  apply(candidate: HealingCandidate): Partial<Pick<ExecutionStep, 'timeoutMs' | 'maxAttempts'>> | null {
    for (const strategy of HEALING_STRATEGIES) {
      if (!strategy.applies(candidate)) continue;
      return strategy.apply(candidate);
    }
    return null;
  }
}
