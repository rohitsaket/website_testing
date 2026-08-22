/**
 * WTE — Release readiness gate (Section 47).
 * Deterministic, auditable rules. No LLM guessing in the release decision path.
 */
import type { Finding, QualityScore, ReleaseDecision, ReleaseGate } from '../core/types.js';

export interface ReleaseInput {
  findings: Finding[];
  score: QualityScore;
  flakyStepCount: number;
  failedSteps: number;
}

export function decideRelease(input: ReleaseInput): ReleaseDecision {
  const open = input.findings.filter((f) => f.status === 'open' || f.status === 'acknowledged');
  const critical = open.filter((f) => f.severity === 'critical').length;
  const high = open.filter((f) => f.severity === 'high').length;
  const medium = open.filter((f) => f.severity === 'medium').length;

  const gates: ReleaseGate[] = [
    { name: 'no-critical-findings', passed: critical === 0, detail: `${critical} critical finding(s) open` },
    { name: 'high-findings-within-tolerance', passed: high < 3, detail: `${high} high finding(s) open (gate: <3)` },
    { name: 'security-floor', passed: (input.score.security ?? 100) >= 60, detail: `security score ${input.score.security ?? 'n/a'} (gate: ≥60)` },
    { name: 'no-failed-steps', passed: input.failedSteps === 0, detail: `${input.failedSteps} failed step(s)` },
    { name: 'no-flaky-steps', passed: input.flakyStepCount === 0, detail: `${input.flakyStepCount} flaky/healed step(s)` },
    { name: 'coverage-floor', passed: input.score.coverage >= 80, detail: `coverage ${input.score.coverage}% (gate: ≥80%)` },
    { name: 'performance-floor', passed: (input.score.performance ?? 100) >= 70, detail: `performance score ${input.score.performance ?? 'n/a'} (gate: ≥70)` },
  ];

  let readiness: ReleaseDecision['readiness'] = 'READY';
  const reasons: string[] = [];

  if (critical > 0 || (input.score.security ?? 100) < 60 || high >= 3) {
    readiness = 'NOT_READY';
    if (critical > 0) reasons.push(`${critical} open critical finding(s)`);
    if (high >= 3) reasons.push(`${high} open high findings exceed tolerance (3)`);
    if ((input.score.security ?? 100) < 60) reasons.push(`security score below floor (${input.score.security})`);
  } else if (
    high > 0 ||
    medium > 5 ||
    (input.score.performance ?? 100) < 70 ||
    input.flakyStepCount > 0 ||
    input.failedSteps > 0 ||
    input.score.coverage < 90
  ) {
    readiness = 'CONDITIONALLY_READY';
    if (high > 0) reasons.push(`${high} open high finding(s) require acceptance or fix`);
    if (medium > 5) reasons.push(`${medium} medium findings warrant triage`);
    if ((input.score.performance ?? 100) < 70) reasons.push(`performance below floor (${input.score.performance})`);
    if (input.flakyStepCount > 0) reasons.push(`${input.flakyStepCount} healed/flaky step(s) need stabilization`);
    if (input.failedSteps > 0) reasons.push(`${input.failedSteps} step(s) failed (non-blocking class)`);
    if (input.score.coverage < 90) reasons.push(`coverage below 90% (${input.score.coverage}%)`);
  } else {
    reasons.push('all gates green; no blocking findings');
  }

  return { readiness, reasons, gates, decidedAt: new Date().toISOString() };
}
