import { describe, it, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { MemoryStore } from '../src/memory/store.js';
import { createFinding } from '../src/findings/findings.js';
import type { ApplicationModel, Execution } from '../src/core/types.js';

const model: ApplicationModel = {
  url: 'https://example.com',
  finalUrl: 'https://example.com',
  statusCode: 200,
  title: 'Example',
  technologies: ['React'],
  pages: ['https://example.com/a'],
  forms: [],
  assetCounts: { scripts: 1, stylesheets: 1, images: 0 },
  discoveredAt: new Date().toISOString(),
};

function execStub(id: string): Execution {
  return {
    id,
    objective: { id: 'o', kind: 'url-scan', target: 'https://example.com', authorization: { allowedHosts: ['example.com'], allowPassive: true, allowActive: false }, options: {} },
    state: 'COMPLETED',
    mode: 'TERMINAL',
    roles: [],
    steps: [],
    findings: [],
    reportPaths: [],
    workerId: 'WORKER-t',
    agentRuns: [],
    createdAt: new Date().toISOString(),
  };
}

describe('memory store (§61)', () => {
  let dir: string;

  after(async () => {
    if (dir) await rm(dir, { recursive: true, force: true });
  });

  it('persists and reloads applications, executions, baselines and indexes', async () => {
    dir = await mkdtemp(join(tmpdir(), 'wte-mem-'));
    const file = join(dir, 'memory.json');
    const store = new MemoryStore(file);
    await store.load();
    store.saveApplication('https://example.com', model);
    store.saveExecution(execStub('EXEC-2026-000042'));
    store.saveBaseline('https://example.com', { ttfb_p50: 120 });
    store.indexFindings('EXEC-2026-000042', [
      createFinding({ category: 'ui', severity: 'low', title: 'X', description: '', expected: '', actual: '', url: 'https://example.com' }),
    ]);
    await store.persist();

    const reloaded = new MemoryStore(file);
    await reloaded.load();
    assert.equal(reloaded.getApplication('https://example.com')?.technologies[0], 'React');
    assert.equal(reloaded.getExecution('EXEC-2026-000042')?.state, 'COMPLETED');
    assert.equal(reloaded.getBaseline('https://example.com')?.ttfb_p50, 120);
    assert.equal(reloaded.executionCounter(), 42);
    assert.equal(reloaded.knownFingerprints().size, 1);
  });

  it('refuses to persist objects that look like stored secrets', async () => {
    dir = await mkdtemp(join(tmpdir(), 'wte-mem-'));
    const file = join(dir, 'memory.json');
    const store = new MemoryStore(file);
    await store.load();
    store.saveBaseline('https://example.com', {});
    // simulate a caller trying to stash credentials into baselines object
    (store as unknown as { data: { baselines: Record<string, object> } }).data.baselines['evil'] = { api_key: 'supersecret' };
    await assert.rejects(() => store.persist(), /secrets/);
  });

  it('starts empty when the file does not exist', async () => {
    dir = await mkdtemp(join(tmpdir(), 'wte-mem-'));
    const store = new MemoryStore(join(dir, 'nope.json'));
    await store.load();
    assert.equal(store.executionCounter(), 0);
    assert.deepEqual(store.listExecutions(), []);
  });
});
