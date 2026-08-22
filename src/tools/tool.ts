/**
 * WTE — Controlled tool architecture (Section 59).
 * Every tool: schema, permissions, timeout, resource limits, audit logging.
 * Agents never touch the system directly — they operate through this layer.
 */
import type { EventBus, AuditLog } from '../core/observability.js';
import type { AuthorizationContext } from '../core/types.js';
import { ScopeGuard } from '../core/authorization.js';
import { redactSecrets } from '../core/observability.js';

export interface ToolContext {
  executionId: string;
  stepId: string;
  agentId: string;
  workerId: string;
  authorization: AuthorizationContext;
  scope: ScopeGuard;
  artifactsDir: string;
  bus: EventBus;
  audit: AuditLog;
}

export interface ToolResult<T> {
  ok: boolean;
  data?: T;
  error?: string;
  durationMs: number;
}

export interface Tool<I = unknown, O = unknown> {
  readonly id: string; // e.g. "terminal.execute"
  readonly version: string;
  readonly description: string;
  readonly permissions: string[]; // e.g. ["shell"], ["network:outbound"]
  readonly timeoutMs: number;
  /** Returns list of validation errors, or empty array when input is valid. */
  validate(input: I): string[];
  run(input: I, ctx: ToolContext): Promise<ToolResult<O>>;
}

export abstract class BaseTool<I, O> implements Tool<I, O> {
  abstract readonly id: string;
  abstract readonly version: string;
  abstract readonly description: string;
  abstract readonly permissions: string[];
  abstract readonly timeoutMs: number;

  abstract validate(input: I): string[];
  protected abstract execute(input: I, ctx: ToolContext): Promise<O>;

  async run(input: I, ctx: ToolContext): Promise<ToolResult<O>> {
    const started = Date.now();
    const errors = this.validate(input);
    if (errors.length > 0) {
      ctx.audit.record({
        at: new Date().toISOString(),
        executionId: ctx.executionId,
        workerId: ctx.workerId,
        actor: ctx.agentId,
        action: 'tool.call.invalid-input',
        toolId: this.id,
        inputSummary: safeSummary(input),
        outcome: 'denied',
        detail: errors.join('; '),
      });
      return { ok: false, error: `invalid input: ${errors.join('; ')}`, durationMs: 0 };
    }

    ctx.bus.emit('tool.call', ctx.executionId, {
      stepId: ctx.stepId,
      agentId: ctx.agentId,
      toolId: this.id,
      inputSummary: safeSummary(input),
    });

    let timer: NodeJS.Timeout | undefined;
    try {
      const data = await Promise.race([
        this.execute(input, ctx),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error(`tool ${this.id} timed out after ${this.timeoutMs}ms`)), this.timeoutMs);
        }),
      ]);
      const durationMs = Date.now() - started;
      ctx.bus.emit('tool.result', ctx.executionId, { stepId: ctx.stepId, toolId: this.id, ok: true, durationMs });
      ctx.audit.record({
        at: new Date().toISOString(),
        executionId: ctx.executionId,
        workerId: ctx.workerId,
        actor: ctx.agentId,
        action: 'tool.call',
        toolId: this.id,
        inputSummary: safeSummary(input),
        outcome: 'ok',
        durationMs,
      });
      return { ok: true, data, durationMs };
    } catch (err) {
      const durationMs = Date.now() - started;
      const message = err instanceof Error ? err.message : String(err);
      ctx.bus.emit('tool.result', ctx.executionId, { stepId: ctx.stepId, toolId: this.id, ok: false, durationMs, error: message });
      ctx.audit.record({
        at: new Date().toISOString(),
        executionId: ctx.executionId,
        workerId: ctx.workerId,
        actor: ctx.agentId,
        action: 'tool.call',
        toolId: this.id,
        inputSummary: safeSummary(input),
        outcome: 'error',
        durationMs,
        detail: message,
      });
      return { ok: false, error: message, durationMs };
    } finally {
      if (timer) clearTimeout(timer);
    }
  }
}

export function safeSummary(input: unknown): string {
  try {
    return redactSecrets(JSON.stringify(input)).slice(0, 300);
  } catch {
    return '[unserializable input]';
  }
}
