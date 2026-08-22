import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { ScopeGuard, AuthorizationError } from '../src/core/authorization.js';

describe('scope guard (§64)', () => {
  it('denies by default with an empty allowlist', () => {
    const g = new ScopeGuard({ allowedHosts: [], allowPassive: true, allowActive: false });
    assert.throws(() => g.assertUrlAllowed('https://example.com'), AuthorizationError);
  });

  it('allows exact host matches', () => {
    const g = new ScopeGuard({ allowedHosts: ['example.com'], allowPassive: true, allowActive: false });
    assert.doesNotThrow(() => g.assertUrlAllowed('https://example.com/page'));
    assert.throws(() => g.assertUrlAllowed('https://evil-example.com'), AuthorizationError);
    assert.throws(() => g.assertUrlAllowed('https://sub.example.com'), AuthorizationError);
  });

  it('supports wildcard subdomains', () => {
    const g = new ScopeGuard({ allowedHosts: ['*.example.com'], allowPassive: true, allowActive: false });
    assert.doesNotThrow(() => g.assertUrlAllowed('https://sub.example.com/x'));
    assert.doesNotThrow(() => g.assertUrlAllowed('https://example.com'));
    assert.throws(() => g.assertUrlAllowed('https://example.com.evil.io'), AuthorizationError);
  });

  it('rejects unparseable URLs', () => {
    const g = new ScopeGuard({ allowedHosts: ['*'], allowPassive: true, allowActive: false });
    assert.equal(g.isHostAllowed('not-a-url'), false);
  });

  it('blocks active testing unless explicitly authorized', () => {
    const passive = new ScopeGuard({ allowedHosts: ['example.com'], allowPassive: true, allowActive: false });
    assert.throws(() => passive.assertActiveAllowed('POST /login'), /Active testing/);
    const active = new ScopeGuard({ allowedHosts: ['example.com'], allowPassive: true, allowActive: true });
    assert.doesNotThrow(() => active.assertActiveAllowed('POST /login'));
  });

  it('denies everything when no testing level is enabled', () => {
    const g = new ScopeGuard({ allowedHosts: ['example.com'], allowPassive: false, allowActive: false });
    assert.throws(() => g.assertUrlAllowed('https://example.com'), AuthorizationError);
  });
});
