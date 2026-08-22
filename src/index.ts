/**
 * WTE Platform — Phase 1 Foundation public API surface.
 */
export * from './core/types.js';
export { ROLE_CATALOG, selectRoles, findRole } from './core/roles.js';
export { planExecution, decideMode, type GuiAvailability, type ExecutionPlan } from './core/decision-engine.js';
export { ScopeGuard, AuthorizationError } from './core/authorization.js';
export { EventBus, AuditLog, Logger, type WteEvent, type AuditRecord } from './core/observability.js';
export { createFinding, deduplicateFindings, summarize, fingerprintOf } from './findings/findings.js';
export { computeQualityScore } from './scoring/quality.js';
export { decideRelease } from './scoring/release.js';
export { analyzeFailure } from './analysis/rca.js';
export { Healer, HEALING_STRATEGIES } from './healing/healer.js';
export { ExecutionEngine, type StepDefinition, type EngineDeps } from './execution/engine.js';
export { ExecutionIdSeq, resumeSequenceFromIds } from './execution/ids.js';
export { ToolRegistry } from './tools/registry.js';
export { checkCommandSafety, TerminalExecuteTool } from './tools/terminal.js';
export { HttpProbeTool, ApiRequestTool } from './tools/http.js';
export { FilesystemReadTool, FilesystemWriteTool } from './tools/filesystem.js';
export { parseHtml, detectTechnologies, resolveSameOriginLinks } from './core/htmllite.js';
export { MemoryStore } from './memory/store.js';
export { Orchestrator, type OrchestratorConfig, type ScanResult } from './orchestrator/orchestrator.js';
export { startWteServer, type WteServerOptions } from './server/server.js';
