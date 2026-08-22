/**
 * API server tests: health, tools, executions, scan endpoint authorization
 * enforcement, and artifact serving.
 */
import { describe, it, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { Orchestrator } from '../src/orchestrator/orchestrator.js';
import { startWteServer } from '../src/server/server.js';
import { startFixtureApp, FIXTURE_AUTH, type FixtureServer } from './helpers/fixture-server.js';

describe('WTE API server (§52/§54)', () => {
  let fixture: FixtureServer;
  let workDir: string;
  let server: Server;
  let base: string;

  before(async () => {
    fixture = await startFixtureApp();
    workDir = await mkdtemp(join(tmpdir(), 'wte-srv-'));
    const orchestrator = new Orchestrator({ repoRoot: workDir });
    server = startWteServer({ port: 0, orchestrator, defaultAllowedHosts: ['127.0.0.1', 'localhost'] });
    await new Promise<void>((resolve) => server.on('listening', resolve));
    const { port } = server.address() as AddressInfo;
    base = `http://127.0.0.1:${port}`;
  });

  after(async () => {
    server.close();
    await fixture.close();
    await rm(workDir, { recursive: true, force: true });
  });

  it('GET / serves the dashboard', async () => {
    const r = await fetch(base + '/');
    assert.equal(r.status, 200);
    const html = await r.text();
    assert.match(html, /WTE/);
    assert.match(html, /EventSource/);
  });

  it('GET /api/health and /api/tools expose platform facts', async () => {
    const h = (await (await fetch(base + '/api/health')).json()) as { status: string; workerId: string };
    assert.equal(h.status, 'ok');
    assert.ok(h.workerId.startsWith('WORKER-'));
    const t = (await (await fetch(base + '/api/tools')).json()) as { tools: { id: string }[] };
    assert.ok(t.tools.some((x: { id: string }) => x.id === 'terminal.execute'));
    assert.ok(t.tools.some((x: { id: string }) => x.id === 'http.probe'));
  });

  it('POST /api/scans runs the full loop and returns results', async () => {
    const r = await fetch(base + '/api/scans', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: fixture.baseUrl + '/', endpoints: ['/api/health'] }),
    });
    assert.equal(r.status, 200);
    const j = (await r.json()) as { executionId: string; score: { overall: number }; readiness: string; reportPaths: string[] };
    assert.match(j.executionId, /^EXEC-/);
    assert.equal(typeof j.score.overall, 'number');
    assert.ok(['READY', 'CONDITIONALLY_READY', 'NOT_READY'].includes(j.readiness));
    assert.ok(j.reportPaths.length === 3);

    // execution is now queryable
    const exec = (await (await fetch(base + '/api/executions/' + j.executionId)).json()) as { execution: { id: string; findings: unknown[] } };
    assert.equal(exec.execution.id, j.executionId);
    assert.ok(exec.execution.findings.length > 0);

    // report artifact is served
    const rep = await fetch(base + '/artifacts/' + j.executionId + '/report.html');
    assert.equal(rep.status, 200);
    assert.match(await rep.text(), /Quality Engineering Report/);

    const list = (await (await fetch(base + '/api/executions')).json()) as { executions: { id: string }[] };
    assert.ok(list.executions.some((e: { id: string }) => e.id === j.executionId));
  });

  it('POST /api/scans rejects out-of-scope targets with 403', async () => {
    const r = await fetch(base + '/api/scans', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'https://not-authorized.example/' }),
    });
    assert.equal(r.status, 403);
    const j = (await r.json()) as { error: string };
    assert.match(j.error, /authorized scope/);
  });

  it('POST /api/scans validates input', async () => {
    const r = await fetch(base + '/api/scans', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ target: 'ftp://nope' }),
    });
    assert.equal(r.status, 400);
  });

  it('artifact serving blocks directory traversal', async () => {
    const r = await fetch(base + '/artifacts/..%2F..%2Fpackage.json');
    assert.ok([400, 404].includes(r.status));
  });
});
