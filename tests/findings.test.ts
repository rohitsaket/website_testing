import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { createFinding, deduplicateFindings, fingerprintOf, summarize } from '../src/findings/findings.js';

describe('findings (§45)', () => {
  it('creates a fully-populated finding with severity-derived priority', () => {
    const f = createFinding({
      category: 'security',
      severity: 'high',
      title: 'Missing CSP',
      description: 'd',
      expected: 'e',
      actual: 'a',
      url: 'https://example.com',
    });
    assert.equal(f.priority, 'P1');
    assert.equal(f.status, 'open');
    assert.ok(f.id.startsWith('FND-'));
    assert.ok(f.fingerprint.length === 16);
    assert.ok(f.firstDetected);
  });

  it('fingerprint is stable and input-normalized', () => {
    const base = { category: 'seo' as const, severity: 'low' as const, title: 'Missing Title', description: '', expected: '', actual: '' };
    assert.equal(fingerprintOf(base), fingerprintOf({ ...base, title: 'missing title ' }));
    assert.notEqual(fingerprintOf(base), fingerprintOf({ ...base, category: 'ui' }));
  });

  it('deduplicates by fingerprint, preserving firstDetected and merging evidence', () => {
    const t1 = new Date('2026-08-01T00:00:00Z');
    const t2 = new Date('2026-08-02T00:00:00Z');
    const draft = { category: 'performance' as const, severity: 'medium' as const, title: 'Slow TTFB', description: 'd', expected: 'e', actual: 'a', url: 'https://x.y' };
    const a = createFinding(draft, t1);
    const b = createFinding({ ...draft }, t2);
    b.evidence.push({ id: 'EV-1', kind: 'metric', description: 'm', createdAt: t2.toISOString() });
    const merged = deduplicateFindings([a, b]);
    assert.equal(merged.length, 1);
    assert.equal(merged[0]!.firstDetected, t1.toISOString());
    assert.equal(merged[0]!.lastDetected, t2.toISOString());
    assert.equal(b.status, 'duplicate');
  });

  it('summarizes severity counts', () => {
    const fs = [
      createFinding({ category: 'ui', severity: 'low', title: 'a', description: '', expected: '', actual: '' }),
      createFinding({ category: 'ui', severity: 'critical', title: 'b', description: '', expected: '', actual: '' }),
      createFinding({ category: 'ui', severity: 'low', title: 'c', description: '', expected: '', actual: '' }),
    ];
    const s = summarize(fs);
    assert.equal(s['low'], 2);
    assert.equal(s['critical'], 1);
    assert.equal(s['total'], 3);
  });
});
