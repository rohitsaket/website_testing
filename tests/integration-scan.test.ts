/**
 * Phase 1 acceptance test: the FULL WTE loop against a fixture application.
 * DISCOVER → plan → execute → findings → RCA → score → release → report → memory.
 * Assertions verify the platform DETECTS the flaws seeded in the fixture.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { existsSync } from 'node:fs';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { startFixtureApp, FIXTURE_AUTH, type FixtureServer } from './helpers/fixture-server.js';

describe('WTE full-loop integration (§60/§72)', () => {
  let fixture: FixtureServer;
  let workDir: string;
  let orchestrator: Orchestrator;

  before(async () => {
    fixture = await startFixtureApp();
    workDir = await mkdtemp(join(tmpdir(), 'wte-it-'));
    orchestrator = new Orchestrator({ repoRoot: workDir });
  });

  after(async () => {
    await fixture.close();
    await rm(workDir, { recursive: true, force: true });
  });

  it('detects seeded flaws end-to-end and produces all artifacts', async () => {
    const result = await orchestrator.scan({
      kind: 'url-scan',
      target: fixture.baseUrl + '/',
      authorization: FIXTURE_AUTH,
      options: { endpoints: ['/api/health', '/api/bad-json', '/api/error', '/api/missing'], perfSamples: 3 },
    });
    const e = result.execution;

    // Execution identity + lifecycle (§51/§52)
    assert.match(e.id, /^EXEC-\d{4}-\d{6}$/);
    assert.equal(e.state, 'COMPLETED');
    assert.equal(e.mode, 'TERMINAL'); // degraded from HYBRID: no GUI runtime in Phase 1
    assert.ok(result.degraded);
    assert.ok(result.degradationNotes.length > 0);

    // Step roster (§58)
    const agentIds = e.steps.map((s) => s.agentId);
    for (const expected of ['discovery-agent', 'security-agent', 'accessibility-agent', 'seo-agent', 'performance-agent', 'api-agent', 'reporting-agent']) {
      assert.ok(agentIds.includes(expected), `missing step for ${expected}`);
    }

    const titles = e.findings.map((f) => f.title);

    // Security agent — passive validation (§17)
    assert.ok(titles.some((t) => t.includes('content-security-policy')), 'missing CSP finding');
    assert.ok(titles.some((t) => t.includes('HttpOnly')), 'missing cookie HttpOnly finding');
    assert.ok(titles.some((t) => t.includes('Server version disclosed')), 'missing server disclosure finding');

    // Accessibility agent — static WCAG (§18)
    assert.ok(titles.some((t) => t.includes('lang attribute')), 'missing lang finding');
    assert.ok(titles.some((t) => t.includes('alt text')), 'missing alt finding');
    assert.ok(titles.some((t) => t.includes('accessible names')), 'missing form-labels finding');

    // SEO agent (§36.13)
    assert.ok(titles.some((t) => t.includes('<title>') || t.includes('meta description')), 'missing seo finding');

    // Discovery agent — broken link detection (§37)
    assert.ok(titles.some((t) => t.includes('Broken same-origin link')), 'missing broken link finding');

    // API agent — contract validation (§11)
    assert.ok(titles.some((t) => t.includes('Invalid JSON')), 'missing invalid-json finding');
    assert.ok(titles.some((t) => t.includes('/api/error')), 'missing 5xx api finding');
    assert.ok(titles.some((t) => t.includes('Endpoint not found')), 'missing 404 api finding');
    // healthy endpoint must NOT be flagged
    assert.ok(!e.findings.some((f) => f.url?.includes('/api/health') && f.severity !== 'info'), 'false positive on healthy endpoint');

    // RCA attached to 5xx API findings (§42)
    const apiError = e.findings.find((f) => f.title.includes('/api/error'));
    assert.ok(apiError?.rootCause);
    assert.equal(apiError!.rootCause!.classification, 'application-defect');

    // Quality score (§46)
    assert.ok(e.score);
    assert.ok(e.score!.overall >= 0 && e.score!.overall < 100);
    assert.ok(e.score!.security !== null && e.score!.security < 100);
    assert.ok(e.score!.accessibility !== null);
    assert.ok(e.score!.api !== null);
    assert.ok(e.score!.coverage >= 80);

    // Release readiness (§47) — high-severity a11y findings + api 5xx ⇒ not plain READY
    assert.ok(e.release);
    assert.notEqual(e.release!.readiness, 'READY');
    assert.ok(e.release!.gates.find((g) => g.name === 'security-floor'));

    // Reports (§53)
    assert.equal(e.reportPaths.length, 3);
    for (const p of e.reportPaths) assert.ok(existsSync(join(workDir, p)), `report missing: ${p}`);
    const html = await readFile(join(workDir, 'artifacts', e.id, 'report.html'), 'utf8');
    assert.match(html, /Quality Engineering Report/);
    assert.match(html, /content-security-policy/);
    const json = JSON.parse(await readFile(join(workDir, 'artifacts', e.id, 'report.json'), 'utf8'));
    assert.equal(json.execution.id, e.id);

    // Memory (§61)
    const model = orchestrator.memory.getApplication(new URL(fixture.baseUrl).origin);
    assert.ok(model);
    assert.ok(model!.pages.some((p) => p.includes('/ok-page')));
    assert.ok(orchestrator.memory.getExecution(e.id));

    // Audit trail (§62) — every tool call recorded with execution ID
    const audit = orchestrator.audit.records();
    assert.ok(audit.some((r) => r.executionId === e.id && r.toolId === 'http.probe'));
    assert.ok(audit.some((r) => r.toolId === 'filesystem.write'));
  });

  it('denies scans outside the authorized scope before any network activity', async () => {
    await assert.rejects(
      () =>
        orchestrator.scan({
          kind: 'url-scan',
          target: 'https://out-of-scope.example/',
          authorization: { allowedHosts: ['127.0.0.1'], allowPassive: true, allowActive: false },
          options: {},
        }),
      /NOT in the authorized scope/,
    );
  });

  it('detects recurrence across repeated runs via memory', async () => {
    const first = await orchestrator.scan({
      kind: 'url-scan',
      target: fixture.baseUrl + '/',
      authorization: FIXTURE_AUTH,
      options: { perfSamples: 2, linkSample: 2 },
    });
    const second = await orchestrator.scan({
      kind: 'url-scan',
      target: fixture.baseUrl + '/',
      authorization: FIXTURE_AUTH,
      options: { perfSamples: 2, linkSample: 2 },
    });
    assert.notEqual(first.execution.id, second.execution.id);
    const secondFps = new Set(second.execution.findings.map((f) => f.fingerprint));
    const recurrent = first.execution.findings.filter((f) => secondFps.has(f.fingerprint));
    assert.ok(recurrent.length > 0, 'expected recurrent findings across runs');
    // second run findings should reference the first execution in related[]
    assert.ok(second.execution.findings.some((f) => f.related.includes(first.execution.id)));
  });
});
