import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { EventBus } from '../src/core/observability.js';
import { ExecutionEngine, type StepDefinition } from '../src/execution/engine.js';
import { ExecutionIdSeq, resumeSequenceFromIds } from '../src/execution/ids.js';
import type { TestObjective } from '../src/core/types.js';

function makeEngine(bus = new EventBus()): ExecutionEngine {
  return new ExecutionEngine({ bus, workerId: 'WORKER-test', idSeq: new ExecutionIdSeq(), concurrency: 2 });
}

const objective: TestObjective = {
  id: 'OBJ-t',
  kind: 'terminal-task',
  target: 'local',
  authorization: { allowedHosts: ['localhost'], allowPassive: true, allowActive: true },
  options: {},
};

function step(name: string, run: () => Promise<{ s: string }>, opts: Partial<StepDefinition> = {}): StepDefinition {
  return {
    name,
    agentId: 'test-agent',
    toolIds: [],
    timeoutMs: opts.timeoutMs ?? 1000,
    maxAttempts: opts.maxAttempts ?? 1,
    run: async () => {
      await run();
      return { status: 'passed', findings: [], evidence: [], metrics: {}, logs: [], durationMs: 1 };
    },
  };
}

function okStep(name: string): StepDefinition {
  return {
    name,
    agentId: 'test-agent',
    toolIds: [],
    timeoutMs: 500,
    maxAttempts: 1,
    run: async () => ({ status: 'passed', findings: [], evidence: [], metrics: { m: 1 }, logs: ['ok'], durationMs: 1 }),
  };
}

describe('execution engine (§48/§52)', () => {
  it('issues correlated EXEC-YYYY-NNNNNN ids', async () => {
    const engine = makeEngine();
    const e = await engine.execute(objective, 'TERMINAL', ['sdet'], [okStep('a')]);
    assert.match(e.id, /^EXEC-\d{4}-\d{6}$/);
    const e2 = await engine.execute(objective, 'TERMINAL', ['sdet'], [okStep('b')]);
    assert.notEqual(e.id, e2.id);
    assert.ok(e2.id > e.id);
  });

  it('completes a passing step and aggregates results', async () => {
    const engine = makeEngine();
    const e = await engine.execute(objective, 'TERMINAL', [], [okStep('one'), okStep('two')]);
    assert.equal(e.state, 'COMPLETED');
    assert.equal(e.steps.length, 2);
    assert.ok(e.steps.every((s) => s.state === 'COMPLETED'));
    assert.equal(e.steps[0]!.result!.metrics['m'], 1);
  });

  it('retries a failing step up to maxAttempts then marks FAILED', async () => {
    const engine = makeEngine();
    let attempts = 0;
    const failing: StepDefinition = {
      name: 'flaky-always',
      agentId: 'test-agent',
      toolIds: [],
      timeoutMs: 500,
      maxAttempts: 3,
      run: async () => {
        attempts++;
        throw new Error('boom');
      },
    };
    const e = await engine.execute(objective, 'TERMINAL', [], [failing]);
    assert.equal(attempts, 3);
    assert.equal(e.steps[0]!.state, 'FAILED');
    assert.equal(e.state, 'FAILED');
  });

  it('flaky-then-pass succeeds on retry', async () => {
    const engine = makeEngine();
    let attempts = 0;
    const s: StepDefinition = {
      name: 'flaky-once',
      agentId: 'test-agent',
      toolIds: [],
      timeoutMs: 500,
      maxAttempts: 2,
      run: async () => {
        attempts++;
        if (attempts === 1) throw new Error('flaky transient');
        return { status: 'passed', findings: [], evidence: [], metrics: {}, logs: [], durationMs: 1 };
      },
    };
    const e = await engine.execute(objective, 'TERMINAL', [], [s]);
    assert.equal(e.state, 'COMPLETED');
    assert.equal(attempts, 2);
  });

  it('applies healing on timeout before retrying (§43)', async () => {
    const engine = makeEngine();
    const s: StepDefinition = {
      name: 'timing-out-step',
      agentId: 'test-agent',
      toolIds: [],
      timeoutMs: 50,
      maxAttempts: 2,
      run: () => new Promise<never>(() => { /* never resolves */ }),
    };
    const e = await engine.execute(objective, 'TERMINAL', [], [s]);
    assert.equal(e.steps[0]!.state, 'TIMEOUT');
    assert.ok(e.steps[0]!.healingEvents.some((h) => h.strategy === 'timeout-escalation'));
    assert.ok(e.steps[0]!.timeoutMs > 50); // healed wait policy, not business logic
  });

  it('emits real-time state events for steps and execution', async () => {
    const bus = new EventBus();
    const seen: string[] = [];
    bus.on((e) => {
      if (e.type === 'step.state' || e.type === 'execution.state') seen.push(`${e.type}:${String(e.data['state'])}`);
    });
    const engine = makeEngine(bus);
    await engine.execute(objective, 'TERMINAL', [], [okStep('x')]);
    assert.ok(seen.includes('execution.state:QUEUED'));
    assert.ok(seen.includes('execution.state:COMPLETED'));
    assert.ok(seen.includes('step.state:COMPLETED'));
  });

  it('resumeSequenceFromIds continues the ID counter across restarts', () => {
    const seq = resumeSequenceFromIds(['EXEC-2026-000007', 'EXEC-2026-000003']);
    assert.equal(seq.next(new Date('2026-01-01')), 'EXEC-2026-000008');
  });

  it('pre-reserved peeked ID is consumed exactly once', async () => {
    const engine = makeEngine();
    const peeked = engine.peekNextId();
    const e = await engine.execute(objective, 'TERMINAL', [], [okStep('y')], peeked);
    assert.equal(e.id, peeked);
    const e2 = await engine.execute(objective, 'TERMINAL', [], [okStep('z')]);
    assert.notEqual(e2.id, peeked);
    assert.ok(e2.id > peeked);
  });
});
