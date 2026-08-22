import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { decideMode, planExecution } from '../src/core/decision-engine.js';
import { selectRoles } from '../src/core/roles.js';
import type { TestObjective } from '../src/core/types.js';

const gui = { browserRuntime: false, reason: 'test: no browser' };
const guiUp = { browserRuntime: true };

function objective(kind: TestObjective['kind']): TestObjective {
  return {
    id: 'OBJ-test',
    kind,
    target: 'https://example.com',
    authorization: { allowedHosts: ['example.com'], allowPassive: true, allowActive: false },
    options: {},
  };
}

describe('decision engine (§4)', () => {
  it('routes api-probe to TERMINAL', () => {
    const d = decideMode(objective('api-probe'), guiUp);
    assert.equal(d.mode, 'TERMINAL');
    assert.equal(d.degraded, false);
  });

  it('routes url-scan to HYBRID when GUI is available', () => {
    const d = decideMode(objective('url-scan'), guiUp);
    assert.equal(d.mode, 'HYBRID');
    assert.equal(d.degraded, false);
  });

  it('degrades url-scan to TERMINAL without a browser runtime, with an audit note', () => {
    const d = decideMode(objective('url-scan'), gui);
    assert.equal(d.mode, 'TERMINAL');
    assert.equal(d.degraded, true);
    assert.ok(d.notes[0]?.includes('degrad'));
    assert.ok(d.rules.some((r) => r.includes('HYBRID')));
  });

  it('plans agents: discovery first-class, api-agent only when endpoints exist', () => {
    const obj = objective('url-scan');
    const noApi = planExecution(obj, gui, {
      kind: 'url-scan',
      hasForms: true,
      hasEndpoints: false,
      securityRelevant: true,
      performanceRelevant: true,
      accessibilityRelevant: true,
      seoRelevant: true,
    });
    assert.ok(noApi.agents.includes('discovery-agent'));
    assert.ok(!noApi.agents.includes('api-agent'));
    assert.ok(noApi.agents.includes('reporting-agent'));

    const withApi = planExecution({ ...obj, options: { endpoints: ['/api/health'] } }, gui, {
      kind: 'url-scan',
      hasForms: true,
      hasEndpoints: true,
      securityRelevant: true,
      performanceRelevant: true,
      accessibilityRelevant: true,
      seoRelevant: true,
    });
    assert.ok(withApi.agents.includes('api-agent'));
  });
});

describe('minimum role selection (§71)', () => {
  it('selects a focused role set for url-scan', () => {
    const roles = selectRoles({
      kind: 'url-scan',
      hasForms: true,
      hasEndpoints: false,
      securityRelevant: true,
      performanceRelevant: true,
      accessibilityRelevant: true,
      seoRelevant: true,
    });
    assert.ok(roles.includes('web-qa-engineer'));
    assert.ok(roles.includes('security-tester'));
    assert.ok(roles.includes('accessibility-tester'));
    assert.ok(roles.includes('release-engineer'));
    // Minimum sufficiency: no database/cloud/mobile roles for a pure web scan
    assert.ok(!roles.some((r) => r.includes('database')));
  });

  it('selects api-tester for api-probe', () => {
    const roles = selectRoles({
      kind: 'api-probe',
      hasForms: false,
      hasEndpoints: true,
      securityRelevant: true,
      performanceRelevant: false,
      accessibilityRelevant: false,
      seoRelevant: false,
    });
    assert.deepEqual(roles.includes('api-tester'), true);
    assert.equal(roles.includes('accessibility-tester'), false);
  });
});
