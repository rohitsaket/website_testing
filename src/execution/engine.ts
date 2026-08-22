/**
 * WTE — Test Execution Engine (Sections 48, 52).
 * Serial/parallel step execution, retries, timeouts, cancellation,
 * healing-in-the-loop, and real-time state emission over the event bus.
 */
import { randomUUID } from 'node:crypto';
import type { EventBus } from '../core/observability.js';
import {
  type Execution,
  type ExecutionState,
  type ExecutionStep,
  type StepResult,
  type TestObjective,
} from '../core/types.js';
import { Healer } from '../healing/healer.js';
import { ExecutionIdSeq } from './ids.js';

export interface StepDefinition {
  name: string;
  agentId: string;
  toolIds: string[];
  timeoutMs: number;
  maxAttempts: number;
  run: () => Promise<StepResult>;
}

export interface EngineDeps {
  bus: EventBus;
  workerId: string;
  idSeq: ExecutionIdSeq;
  concurrency?: number;
}

export class ExecutionCancelledError extends Error {
  constructor() {
    super('execution cancelled');
    this.name = 'ExecutionCancelledError';
  }
}

export class ExecutionEngine {
  private readonly healer = new Healer();
  private executions = new Map<string, Execution>();
  private cancelFlags = new Set<string>();

  constructor(private readonly deps: EngineDeps) {}

  get(id: string): Execution | undefined {
    return this.executions.get(id);
  }

  list(): Execution[] {
    return [...this.executions.values()].sort((a, b) => (b.createdAt < a.createdAt ? -1 : 1));
  }

  /** The ID the next execution will receive (for pre-sharing with agents). */
  peekNextId(): string {
    return this.deps.idSeq.peek();
  }

  cancel(id: string): boolean {
    if (!this.executions.has(id)) return false;
    this.cancelFlags.add(id);
    return true;
  }

  private setState(exec: Execution, state: ExecutionState): void {
    exec.state = state;
    this.deps.bus.emit('execution.state', exec.id, { state });
  }

  private setStepState(exec: Execution, step: ExecutionStep, state: ExecutionState): void {
    step.state = state;
    this.deps.bus.emit('step.state', exec.id, { stepId: step.id, name: step.name, state, attempts: step.attempts });
  }

  private throwIfCancelled(execId: string): void {
    if (this.cancelFlags.has(execId)) throw new ExecutionCancelledError();
  }

  /** Executes one step with retry + healing loop. */
  private async runStep(exec: Execution, step: ExecutionStep, def: StepDefinition): Promise<void> {
    const execId = exec.id;
    for (step.attempts = step.attempts + 1; ; step.attempts += 1) {
      this.throwIfCancelled(execId);
      this.setStepState(exec, step, 'RUNNING');
      const started = Date.now();
      let timer: NodeJS.Timeout | undefined;
      try {
        const result = await Promise.race([
          def.run(),
          new Promise<never>((_, reject) => {
            timer = setTimeout(() => reject(Object.assign(new Error('step timeout'), { wteTimeout: true })), step.timeoutMs);
          }),
        ]);
        result.durationMs = result.durationMs || Date.now() - started;
        step.result = result;
        this.setStepState(exec, step, result.status === 'failed' ? 'FAILED' : 'COMPLETED');
        return;
      } catch (err) {
        const isTimeout = (err as { wteTimeout?: boolean })?.wteTimeout === true;
        const message = err instanceof Error ? err.message : String(err);
        step.error = message;

        if (step.attempts < step.maxAttempts) {
          // Attempt self-healing for timing/flaky classes (Section 43) before retrying.
          const classification = isTimeout ? 'timing-issue' : /flaky/i.test(message) ? 'flaky-behavior' : 'unknown';
          this.setStepState(exec, step, 'HEALING');
          this.setState(exec, 'HEALING');
          const candidate = { step, classification, failureCount: step.attempts };
          const proposal = this.healer.propose(candidate);
          if (proposal) {
            step.healingEvents.push(proposal);
            const adj = this.healer.apply(candidate);
            if (adj?.timeoutMs) step.timeoutMs = adj.timeoutMs;
            this.deps.bus.emit('healing.applied', execId, {
              stepId: step.id,
              strategy: proposal.strategy,
              confidence: proposal.confidence,
              description: proposal.description,
            });
          } else {
            this.setStepState(exec, step, 'RETRYING');
          }
          this.setState(exec, 'RUNNING');
          continue;
        }

        step.result = {
          status: 'failed',
          findings: [],
          evidence: [],
          metrics: {},
          logs: [message],
          durationMs: Date.now() - started,
        };
        this.setStepState(exec, step, isTimeout ? 'TIMEOUT' : 'FAILED');
        return;
      } finally {
        if (timer) clearTimeout(timer); // watchdog never outlives the attempt
      }
    }
  }

  /**
   * Runs steps honoring the configured concurrency. With `deferTerminal: true`
   * the engine leaves the final emission to the caller (used by the orchestrator,
   * which inserts ANALYZING/reporting before settling the terminal state).
   */
  async execute(
    objective: TestObjective,
    mode: Execution['mode'],
    roles: string[],
    defs: StepDefinition[],
    forcedId?: string,
    opts: { deferTerminal?: boolean } = {},
  ): Promise<Execution> {
    // Consume the counter when the caller pre-reserved the peeked ID, so IDs stay unique.
    let id: string;
    if (forcedId !== undefined) {
      id = forcedId;
      if (forcedId === this.deps.idSeq.peek()) this.deps.idSeq.next();
    } else {
      id = this.deps.idSeq.next();
    }
    const exec: Execution = {
      id,
      objective,
      state: 'QUEUED',
      mode,
      roles,
      steps: defs.map((d, i) => ({
        id: `STEP-${id}-${(i + 1).toString().padStart(2, '0')}`,
        name: d.name,
        agentId: d.agentId,
        toolIds: d.toolIds,
        state: 'QUEUED',
        attempts: 0,
        maxAttempts: d.maxAttempts,
        timeoutMs: d.timeoutMs,
        healingEvents: [],
      })),
      findings: [],
      reportPaths: [],
      workerId: this.deps.workerId,
      agentRuns: [],
      createdAt: new Date().toISOString(),
    };
    this.executions.set(id, exec);
    this.setState(exec, 'QUEUED');

    const concurrency = Math.max(1, this.deps.concurrency ?? 2);
    exec.startedAt = new Date().toISOString();
    this.setState(exec, 'STARTING');
    this.setState(exec, 'RUNNING');

    const queue = defs.map((d, i) => ({ def: d, step: exec.steps[i]! }));
    let cancelled = false;
    try {
      const workers = Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        for (let item = queue.shift(); item; item = queue.shift()) {
          await this.runStep(exec, item.step, item.def);
        }
      });
      await Promise.all(workers);
    } catch (err) {
      if (err instanceof ExecutionCancelledError) {
        cancelled = true;
      } else {
        throw err;
      }
    } finally {
      exec.endedAt = new Date().toISOString();
      exec.findings = exec.steps.flatMap((s) => s.result?.findings ?? []);
    }

    this.cancelFlags.delete(id);
    const terminal: 'CANCELLED' | 'FAILED' | 'COMPLETED' = cancelled
      ? 'CANCELLED'
      : exec.steps.some((s) => s.state === 'FAILED' || s.state === 'TIMEOUT')
        ? 'FAILED'
        : 'COMPLETED';
    if (cancelled) {
      for (const s of exec.steps) if (s.state === 'QUEUED' || s.state === 'RUNNING') s.state = 'CANCELLED';
    }
    if (opts.deferTerminal) {
      exec.state = terminal; // recorded, emitted later by the orchestrator
    } else {
      this.setState(exec, terminal);
    }
    return exec;
  }

  /** Mark analysis phase explicitly (used by orchestrators between execute & report). */
  markAnalyzing(exec: Execution): void {
    this.setState(exec, 'ANALYZING');
  }

  /** Restore a terminal state after post-execution analysis/reporting completes (§52). */
  settle(exec: Execution, finalState: Extract<ExecutionState, 'COMPLETED' | 'FAILED' | 'CANCELLED'>): void {
    this.setState(exec, finalState);
  }
}

export function newWorkerId(): string {
  return `WORKER-${randomUUID().slice(0, 8)}`;
}
