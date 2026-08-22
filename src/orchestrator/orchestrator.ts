/**
 * WTE — Central Orchestrator (Sections 58, 60, 72).
 * USER INTENT → AUTHORIZATION → PLAN → ROLE/TOOL/LANGUAGE SELECTION →
 * EXECUTE (retries + healing) → OBSERVE → ANALYZE → RCA → SCORE →
 * RELEASE DECISION → REPORT → MEMORY. One unified loop.
 */
import { randomUUID } from 'node:crypto';
import { AuditLog, EventBus, Logger } from '../core/observability.js';
import { ScopeGuard } from '../core/authorization.js';
import { planExecution, type GuiAvailability } from '../core/decision-engine.js';
import { ExecutionEngine, newWorkerId, type StepDefinition } from '../execution/engine.js';
import { resumeSequenceFromIds } from '../execution/ids.js';
import { MemoryStore } from '../memory/store.js';
import { ToolRegistry, type PlatformDeps } from '../tools/registry.js';
import { TerminalExecuteTool } from '../tools/terminal.js';
import { HttpProbeTool, ApiRequestTool } from '../tools/http.js';
import { FilesystemReadTool, FilesystemWriteTool } from '../tools/filesystem.js';
import { DiscoveryAgent } from '../agents/discovery.js';
import { SecurityAgent } from '../agents/security.js';
import { AccessibilityAgent } from '../agents/accessibility.js';
import { SeoAgent } from '../agents/seo.js';
import { PerformanceAgent } from '../agents/performance.js';
import { ApiAgent } from '../agents/api.js';
import { ReportingAgent } from '../agents/reporting.js';
import { BaseAgent, type AgentRunContext } from '../agents/base.js';
import { deduplicateFindings } from '../findings/findings.js';
import { computeQualityScore } from '../scoring/quality.js';
import { decideRelease } from '../scoring/release.js';
import type { Execution, ExecutionMode, TestObjective, FindingCategory } from '../core/types.js';

export interface OrchestratorConfig {
  repoRoot: string;
  artifactsDir?: string;
  gui?: GuiAvailability;
  concurrency?: number;
}

export interface ScanResult {
  execution: Execution;
  degraded: boolean;
  degradationNotes: string[];
  planRules: string[];
}

const AGENT_DOMAINS: Record<string, FindingCategory[]> = {
  'discovery-agent': ['functional', 'ui', 'reliability'],
  'security-agent': ['security'],
  'accessibility-agent': ['accessibility'],
  'seo-agent': ['seo'],
  'performance-agent': ['performance', 'reliability'],
  'api-agent': ['api'],
};

export class Orchestrator {
  readonly bus = new EventBus();
  readonly artifactsDir: string;
  readonly repoRoot: string;
  readonly audit: AuditLog;
  readonly memory: MemoryStore;
  readonly tools = new ToolRegistry();
  engine: ExecutionEngine;
  readonly workerId = newWorkerId();
  private readonly agents = new Map<string, BaseAgent>();
  private readonly gui: GuiAvailability;
  private initialized = false;

  constructor(private readonly config: OrchestratorConfig) {
    this.repoRoot = config.repoRoot;
    this.artifactsDir = config.artifactsDir ?? `${config.repoRoot}/artifacts`;
    const artifactsDir = this.artifactsDir;
    const deps: PlatformDeps & { tools: ToolRegistry; memory: MemoryStore; logger: Logger } = {
      repoRoot: config.repoRoot,
      artifactsDir,
      bus: this.bus,
      audit: new AuditLog(`${artifactsDir}/audit.jsonl`),
      tools: this.tools,
      memory: undefined as unknown as MemoryStore,
      logger: undefined as unknown as Logger,
    };
    this.audit = deps.audit;
    this.memory = new MemoryStore(`${artifactsDir}/memory.json`);
    this.engine = new ExecutionEngine({
      bus: this.bus,
      workerId: this.workerId,
      idSeq: resumeSequenceFromIds([]),
      concurrency: 1, // Phase 1: agents share the discovered model, so steps execute in dependency order.
    });
    this.gui = config.gui ?? { browserRuntime: false, reason: 'no browser runtime configured in Phase 1' };

    // Controlled tool surface (Section 59)
    this.tools.register(new TerminalExecuteTool(config.repoRoot));
    this.tools.register(new HttpProbeTool());
    this.tools.register(new ApiRequestTool());
    this.tools.register(new FilesystemReadTool(config.repoRoot));
    this.tools.register(new FilesystemWriteTool(config.repoRoot));

    deps.memory = this.memory;
    deps.logger = new Logger(this.bus, 'platform');

    // Agent registry (Section 58)
    for (const agent of [
      new DiscoveryAgent(deps),
      new SecurityAgent(deps),
      new AccessibilityAgent(deps),
      new SeoAgent(deps),
      new PerformanceAgent(deps),
      new ApiAgent(deps),
      new ReportingAgent(deps),
    ]) {
      this.agents.set(agent.id, agent);
    }
  }

  async init(): Promise<void> {
    if (this.initialized) return;
    await this.audit.init();
    await this.memory.load();
    // Resume the EXEC counter from memory so IDs never collide across restarts.
    this.engine = new ExecutionEngine({
      bus: this.bus,
      workerId: this.workerId,
      idSeq: resumeSequenceFromIds(this.memory.listExecutions(1000).map((e) => e.id)),
      concurrency: 1,
    });
    this.initialized = true;
  }

  /** The unified WTE loop for one objective (spec §60/§72). */
  async scan(objective: Omit<TestObjective, 'id'>): Promise<ScanResult> {
    await this.init();

    // 1. AUTHORIZATION CHECK — before anything else (§60/§64).
    const full: TestObjective = { ...objective, id: `OBJ-${randomUUID().slice(0, 8)}` };
    const guard = new ScopeGuard(full.authorization);
    if (full.kind !== 'terminal-task') {
      guard.assertUrlAllowed(full.target);
    }

    // 2. TARGET UNDERSTANDING + EXECUTION DECISION (§4).
    const roleCtx = {
      kind: full.kind,
      hasForms: true,
      hasEndpoints: (full.options.endpoints ?? []).length > 0 || full.kind === 'api-probe',
      securityRelevant: true,
      performanceRelevant: true,
      accessibilityRelevant: full.kind === 'url-scan',
      seoRelevant: full.kind === 'url-scan',
    };
    const plan = planExecution(full, this.gui, roleCtx);
    this.bus.emit('log', '-', {
      level: 'info',
      scope: 'orchestrator',
      message: `plan: mode=${plan.mode} roles=[${plan.roles.join(',')}] agents=[${plan.agents.join(',')}] degraded=${plan.degraded}`,
    });
    this.audit.record({
      at: new Date().toISOString(),
      executionId: '-',
      workerId: this.workerId,
      actor: 'orchestrator',
      action: 'plan.created',
      outcome: 'ok',
      detail: `target=${full.target} mode=${plan.mode} agents=${plan.agents.join(',')}`,
    });

    // 3. BUILD STEP DEFINITIONS. Agents communicate through a shared context
    //    (discovery's application model feeds security/a11y/seo/etc).
    const shared = new Map<string, unknown>();
    const nextId = this.engine.peekNextId();
    shared.set('executionId', nextId);
    const defs: StepDefinition[] = plan.agents
      .filter((id) => id !== 'reporting-agent') // reporting runs after analysis, below
      .map((agentId) => {
        const agent = this.mustAgent(agentId);
        return {
          name: agent.name,
          agentId,
          toolIds: agent.requiredTools,
          timeoutMs: full.options.timeoutMs ?? 60_000,
          maxAttempts: 2,
          run: () => agent.run(this.agentCtx(nextId, `STEP:${agentId}`, shared, full)),
        };
      });
    // Discovery must lead: it produces the shared application model.
    defs.sort((a) => (a.agentId === 'discovery-agent' ? -1 : 0));

    // 4. EXECUTE (§48) — sequential in dependency order for Phase 1.
    //    deferTerminal: the orchestrator inserts ANALYZING/REPORTING phases
    //    before the terminal emission, keeping the §52 state machine coherent.
    const exec = await this.engine.execute(full, plan.mode as ExecutionMode, plan.roles, defs, nextId, { deferTerminal: true });
    shared.set('execution', exec);

    // 5. ANALYZE — dedup (§45) + recurrence detection against memory (§61).
    const preAnalysisState = exec.state; // terminal verdict from the engine; restored after analysis
    this.engine.markAnalyzing(exec);
    exec.findings = deduplicateFindings(exec.findings);
    const known = this.memory.knownFingerprints();
    let recurrent = 0;
    for (const f of exec.findings) {
      const prior = known.get(f.fingerprint)?.filter((id) => id !== exec.id);
      if (prior && prior.length > 0) {
        recurrent += 1;
        f.related = [...f.related, ...prior];
      }
    }
    if (recurrent > 0) {
      this.bus.emit('log', exec.id, {
        level: 'info',
        scope: 'analysis',
        message: `${recurrent} finding(s) seen in earlier executions (recurrence)`,
      });
    }

    // 6. SCORE (§46) + 7. RELEASE DECISION (§47).
    const evaluated = new Set<FindingCategory>();
    for (const a of plan.agents) for (const d of AGENT_DOMAINS[a] ?? []) evaluated.add(d);
    exec.score = computeQualityScore({
      findings: exec.findings,
      plannedSteps: exec.steps.length + 1, // + reporting step
      executedSteps: exec.steps.filter((s) => s.state === 'COMPLETED' || s.state === 'FAILED' || s.state === 'TIMEOUT').length,
      domainsEvaluated: [...evaluated],
    });
    exec.release = decideRelease({
      findings: exec.findings,
      score: exec.score,
      flakyStepCount: exec.steps.reduce((n, s) => n + (s.healingEvents.length > 0 ? 1 : 0), 0),
      failedSteps: exec.steps.filter((s) => s.state === 'FAILED' || s.state === 'TIMEOUT').length,
    });
    this.bus.emit('score.computed', exec.id, { score: exec.score, readiness: exec.release.readiness });

    // 8. SETTLE terminal state (§52) BEFORE reports render and memory persists,
    //    so every artifact and stored record carries the final verdict.
    this.engine.settle(exec, preAnalysisState === 'COMPLETED' ? 'COMPLETED' : 'FAILED');

    // 9. REPORT (§53) — rendered inside the engine ledger for traceability.
    await this.runReporting(exec, shared, full);

    // 10. MEMORY (§61) — persist everything.
    exec.summary = `${exec.state}: ${exec.findings.length} finding(s), score ${exec.score.overall}, ${exec.release.readiness}`;
    this.memory.saveExecution(exec);
    this.memory.indexFindings(exec.id, exec.findings);
    for (const s of exec.steps) for (const h of s.healingEvents) this.memory.recordHealing(h);
    await this.memory.persist();
    await this.audit.flush();

    return { execution: exec, degraded: plan.degraded, degradationNotes: plan.degradationNotes, planRules: plan.rules };
  }

  private async runReporting(exec: Execution, shared: Map<string, unknown>, objective: TestObjective): Promise<void> {
    const reporter = this.mustAgent('reporting-agent');
    exec.steps.push({
      id: `STEP-${exec.id}-${(exec.steps.length + 1).toString().padStart(2, '0')}`,
      name: reporter.name,
      agentId: reporter.id,
      toolIds: reporter.requiredTools,
      state: 'RUNNING',
      attempts: 1,
      maxAttempts: 1,
      timeoutMs: 30_000,
      healingEvents: [],
    });
    const step = exec.steps[exec.steps.length - 1]!;
    this.bus.emit('step.state', exec.id, { stepId: step.id, name: step.name, state: 'RUNNING', attempts: 1 });
    step.result = await reporter.run(this.agentCtx(exec.id, `STEP:${reporter.id}`, shared, objective));
    step.state = step.result.status === 'failed' ? 'FAILED' : 'COMPLETED';
    this.bus.emit('step.state', exec.id, { stepId: step.id, name: step.name, state: step.state, attempts: 1 });
  }

  private mustAgent(id: string): BaseAgent {
    const agent = this.agents.get(id);
    if (!agent) throw new Error(`plan references unknown agent: ${id}`);
    return agent;
  }

  private agentCtx(executionId: string, stepId: string, shared: Map<string, unknown>, objective: TestObjective): AgentRunContext {
    return { executionId, stepId, workerId: this.workerId, objective, shared };
  }

  getExecution(id: string): Execution | undefined {
    return this.engine.get(id) ?? this.memory.getExecution(id);
  }

  listExecutions(): Execution[] {
    const merge = new Map<string, Execution>();
    for (const e of this.memory.listExecutions(200)) merge.set(e.id, e);
    for (const e of this.engine.list()) merge.set(e.id, e);
    return [...merge.values()].sort((a, b) => (b.createdAt < a.createdAt ? -1 : 1));
  }
}
