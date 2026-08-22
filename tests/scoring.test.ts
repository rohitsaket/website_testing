import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { computeQualityScore } from '../src/scoring/quality.js';
import { decideRelease } from '../src/scoring/release.js';
import { createFinding } from '../src/findings/findings.js';
import type { Finding } from '../src/core/types.js';

function finding(sev: Finding['severity'], cat: Finding['category'] = 'security'): Finding {
  return createFinding({ category: cat, severity: sev, title: `t-${sev}-${cat}-${Math.random()}`, description: '', expected: '', actual: '' });
}

describe('quality scoring (§46)', () => {
  it('clean evaluated domain scores 100', () => {
    const s = computeQualityScore({ findings: [], plannedSteps: 5, executedSteps: 5, domainsEvaluated: ['security', 'ui'] });
    assert.equal(s.security, 100);
    assert.equal(s.ui, 100);
    assert.equal(s.overall, 100);
    assert.equal(s.coverage, 100);
  });

  it('non-evaluated domains are null, not zero', () => {
    const s = computeQualityScore({ findings: [], plannedSteps: 4, executedSteps: 4, domainsEvaluated: ['seo'] });
    assert.equal(s.seo, 100);
    assert.equal(s.security, null);
    assert.equal(s.performance, null);
  });

  it('severity penalties reduce domain score', () => {
    const s = computeQualityScore({
      findings: [finding('critical'), finding('high'), finding('high')],
      plannedSteps: 5,
      executedSteps: 5,
      domainsEvaluated: ['security'],
    });
    // penalty: 25 + 15 + 15 = 55  (confidence default 0.8 → ×0.8 each = 44)
    assert.ok(s.security! < 60);
    assert.ok(s.security! > 0);
  });

  it('coverage reflects executed vs planned steps', () => {
    const s = computeQualityScore({ findings: [], plannedSteps: 4, executedSteps: 3, domainsEvaluated: ['ui'] });
    assert.equal(s.coverage, 75);
  });
});

describe('release readiness (§47)', () => {
  const perfectScore = computeQualityScore({ findings: [], plannedSteps: 1, executedSteps: 1, domainsEvaluated: ['security'] });

  it('READY with zero findings and green gates', () => {
    const d = decideRelease({ findings: [], score: perfectScore, flakyStepCount: 0, failedSteps: 0 });
    assert.equal(d.readiness, 'READY');
    assert.ok(d.gates.every((g) => g.passed));
  });

  it('NOT_READY when any critical finding is open', () => {
    const d = decideRelease({ findings: [finding('critical')], score: perfectScore, flakyStepCount: 0, failedSteps: 0 });
    assert.equal(d.readiness, 'NOT_READY');
    assert.ok(d.reasons.some((r) => r.includes('critical')));
  });

  it('NOT_READY when 3+ high findings open', () => {
    const highs = [finding('high'), finding('high'), finding('high')];
    const d = decideRelease({ findings: highs, score: perfectScore, flakyStepCount: 0, failedSteps: 0 });
    assert.equal(d.readiness, 'NOT_READY');
  });

  it('CONDITIONALLY_READY with a single high finding', () => {
    const d = decideRelease({ findings: [finding('high')], score: perfectScore, flakyStepCount: 0, failedSteps: 0 });
    assert.equal(d.readiness, 'CONDITIONALLY_READY');
  });

  it('CONDITIONALLY_READY when healed/flaky steps exist', () => {
    const d = decideRelease({ findings: [], score: perfectScore, flakyStepCount: 1, failedSteps: 0 });
    assert.equal(d.readiness, 'CONDITIONALLY_READY');
  });

  it('gate failures are individually visible', () => {
    const d = decideRelease({ findings: [finding('critical')], score: perfectScore, flakyStepCount: 0, failedSteps: 0 });
    const gate = d.gates.find((g) => g.name === 'no-critical-findings');
    assert.equal(gate?.passed, false);
  });
});
