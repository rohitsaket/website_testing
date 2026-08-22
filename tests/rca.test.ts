import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { analyzeFailure } from '../src/analysis/rca.js';

describe('root cause analysis (§42)', () => {
  it('classifies 5xx as application-defect', () => {
    const rc = analyzeFailure('/api/orders', { httpStatus: 503 });
    assert.equal(rc.classification, 'application-defect');
    assert.ok(rc.confidence >= 0.7);
    assert.ok(rc.recommendedAction.length > 10);
  });

  it('classifies 401/403 as authentication-issue', () => {
    assert.equal(analyzeFailure('login', { httpStatus: 401 }).classification, 'authentication-issue');
    assert.equal(analyzeFailure('admin', { httpStatus: 403 }).classification, 'authentication-issue');
  });

  it('classifies DNS failure as network-issue', () => {
    const rc = analyzeFailure('target', { dnsFailure: true });
    assert.equal(rc.classification, 'network-issue');
    assert.ok(rc.confidence >= 0.85);
  });

  it('classifies timeout as timing-issue', () => {
    const rc = analyzeFailure('step-x', { timeoutOccurred: true, historicalPasses: 5 });
    assert.equal(rc.classification, 'timing-issue');
  });

  it('classifies pass/fail history as flaky-behavior', () => {
    const rc = analyzeFailure('step-y', { historicalPasses: 3, historicalFailures: 2 });
    assert.equal(rc.classification, 'flaky-behavior');
  });

  it('admits ignorance (unknown, low confidence) when no signal matches', () => {
    const rc = analyzeFailure('step-z', {});
    assert.equal(rc.classification, 'unknown');
    assert.ok(rc.confidence <= 0.3);
    assert.match(rc.recommendedAction, /Insufficient evidence/);
  });
});
