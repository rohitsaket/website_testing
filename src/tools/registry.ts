/**
 * WTE — Tool registry (Section 59/57). Tools register with manifest-like
 * metadata; agents resolve tools by ID. Lookup of an unknown tool fails fast.
 */
import type { Tool, ToolContext, ToolResult } from './tool.js';
import type { EventBus, AuditLog } from '../core/observability.js';
import type { AuthorizationContext } from '../core/types.js';
import { ScopeGuard } from '../core/authorization.js';

// eslint disables: registry stores heterogeneous tools; generics are re-bound at invocation sites.
type AnyTool = Tool<never, never> | Tool<unknown, unknown> | Tool<Record<string, never>, unknown> | Tool<object, unknown>;

export class ToolRegistry {
  private tools = new Map<string, AnyTool>();

  register<T extends Tool<unknown, unknown>>(tool: T): void {
    if (this.tools.has(tool.id)) throw new Error(`duplicate tool id: ${tool.id}`);
    this.tools.set(tool.id, tool);
  }

  get<I, O>(id: string): Tool<I, O> {
    const t = this.tools.get(id);
    if (!t) throw new Error(`unknown tool: ${id} (registered: ${[...this.tools.keys()].join(', ')})`);
    return t as unknown as Tool<I, O>;
  }

  manifest(): { id: string; version: string; description: string; permissions: string[]; timeoutMs: number }[] {
    return [...this.tools.values()].map((t) => ({
      id: t.id,
      version: t.version,
      description: t.description,
      permissions: t.permissions,
      timeoutMs: t.timeoutMs,
    }));
  }

  has(id: string): boolean {
    return this.tools.has(id);
  }

  async invoke<I, O>(toolId: string, input: I, ctx: ToolContext): Promise<ToolResult<O>> {
    return this.get<I, O>(toolId).run(input, ctx);
  }
}

export interface PlatformDeps {
  repoRoot: string;
  artifactsDir: string;
  bus: EventBus;
  audit: AuditLog;
}

export function makeToolContext(
  deps: PlatformDeps,
  init: {
    executionId: string;
    stepId: string;
    agentId: string;
    workerId: string;
    authorization: AuthorizationContext;
  },
): ToolContext {
  return {
    executionId: init.executionId,
    stepId: init.stepId,
    agentId: init.agentId,
    workerId: init.workerId,
    authorization: init.authorization,
    scope: new ScopeGuard(init.authorization),
    artifactsDir: deps.artifactsDir,
    bus: deps.bus,
    audit: deps.audit,
  };
}
