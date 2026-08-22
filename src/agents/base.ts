/**
 * WTE — Agent framework (Section 58). Agents are orchestrated capabilities;
 * they may ONLY interact with the world through registered, audited tools.
 */
import type { StepResult, TestObjective, EvidenceRef } from '../core/types.js';
import type { ToolRegistry } from '../tools/registry.js';
import type { ToolContext } from '../tools/tool.js';
import type { MemoryStore } from '../memory/store.js';
import type { Logger } from '../core/observability.js';
import { makeToolContext, type PlatformDeps } from '../tools/registry.js';

export interface AgentRunContext {
  executionId: string;
  stepId: string;
  workerId: string;
  objective: TestObjective;
  shared: Map<string, unknown>; // inter-agent context (e.g. discovery model feeds others)
}

export abstract class BaseAgent {
  abstract readonly id: string;
  abstract readonly name: string;
  abstract readonly requiredTools: string[];

  constructor(
    protected readonly deps: PlatformDeps & { tools: ToolRegistry; memory: MemoryStore; logger: Logger },
  ) {}

  protected ctx(run: AgentRunContext): ToolContext {
    return makeToolContext(this.deps, {
      executionId: run.executionId,
      stepId: run.stepId,
      agentId: this.id,
      workerId: run.workerId,
      authorization: run.objective.authorization,
    });
  }

  async run(run: AgentRunContext): Promise<StepResult> {
    const started = Date.now();
    this.deps.bus.emit('agent.start', run.executionId, { agentId: this.id, stepId: run.stepId });
    for (const t of this.requiredTools) {
      if (!this.deps.tools.has(t)) throw new Error(`agent ${this.id} requires unregistered tool: ${t}`);
    }
    try {
      const result = await this.execute(run);
      result.durationMs = Date.now() - started;
      this.deps.bus.emit('agent.end', run.executionId, { agentId: this.id, status: result.status, durationMs: result.durationMs });
      this.deps.memory.getApplication(''); // touch (ensures store loaded contract)
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.deps.bus.emit('agent.end', run.executionId, { agentId: this.id, status: 'failed', error: message });
      return {
        status: 'failed',
        findings: [],
        evidence: [],
        metrics: {},
        logs: [message],
        durationMs: Date.now() - started,
      };
    }
  }

  protected abstract execute(run: AgentRunContext): Promise<StepResult>;

  protected ok(partial: Partial<StepResult>): StepResult {
    return {
      status: partial.status ?? 'passed',
      findings: partial.findings ?? [],
      evidence: partial.evidence ?? [],
      metrics: partial.metrics ?? {},
      logs: partial.logs ?? [],
      durationMs: partial.durationMs ?? 0,
    };
  }

  protected evidence(kind: EvidenceRef['kind'], description: string, path?: string): EvidenceRef {
    return {
      id: `EV-${Math.random().toString(36).slice(2, 10)}`,
      kind,
      description,
      path,
      createdAt: new Date().toISOString(),
    };
  }
}
