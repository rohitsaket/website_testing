/**
 * WTE — Core type system (Section 36/45/46/47/52 of the master spec).
 * Every subsystem speaks these shared contracts so evidence can be
 * correlated across GUI, terminal, API, database, and reporting layers.
 */

/** Execution interface decision (Section 3/4). */
export type ExecutionMode = 'GUI' | 'TERMINAL' | 'HYBRID';

/** Implementation language decision (Section 5). */
export type WorkerLanguage = 'typescript' | 'python' | 'java';

/** Execution state machine (Section 52). */
export type ExecutionState =
  | 'QUEUED'
  | 'STARTING'
  | 'RUNNING'
  | 'WAITING'
  | 'RETRYING'
  | 'HEALING'
  | 'ANALYZING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED'
  | 'TIMEOUT';

export type Severity = 'critical' | 'high' | 'medium' | 'low' | 'info';

export type FindingCategory =
  | 'functional'
  | 'ui'
  | 'api'
  | 'performance'
  | 'accessibility'
  | 'seo'
  | 'security'
  | 'reliability'
  | 'data'
  | 'configuration'
  | 'compatibility'
  | 'infrastructure';

export type FindingStatus = 'open' | 'acknowledged' | 'fixed' | 'wontfix' | 'duplicate';

/** Finding contract (Section 45). */
export interface Finding {
  id: string;
  fingerprint: string;
  category: FindingCategory;
  severity: Severity;
  priority: 'P0' | 'P1' | 'P2' | 'P3' | 'P4';
  title: string;
  description: string;
  expected: string;
  actual: string;
  rootCause?: RootCause;
  confidence: number; // 0..1
  url?: string;
  component?: string;
  testId?: string;
  evidence: EvidenceRef[];
  firstDetected: string; // ISO
  lastDetected: string; // ISO
  status: FindingStatus;
  owner?: string;
  related: string[];
}

/** Root cause analysis contract (Section 42). */
export interface RootCause {
  summary: string;
  classification: RootCauseClassification;
  confidence: number;
  evidence: string[];
  affectedComponent?: string;
  reproduction?: string;
  recommendedAction: string;
}

export type RootCauseClassification =
  | 'application-defect'
  | 'test-defect'
  | 'environment-issue'
  | 'infrastructure-issue'
  | 'browser-issue'
  | 'timing-issue'
  | 'network-issue'
  | 'data-issue'
  | 'authentication-issue'
  | 'dependency-issue'
  | 'flaky-behavior'
  | 'unknown';

export interface EvidenceRef {
  id: string;
  kind: 'screenshot' | 'video' | 'trace' | 'har' | 'dom' | 'log' | 'json' | 'html' | 'metric' | 'text' | 'artifact';
  path?: string;
  description: string;
  createdAt: string;
}

/** Quality score broken down per domain (Section 46). */
export interface QualityScore {
  overall: number;
  functional: number | null;
  ui: number | null;
  api: number | null;
  performance: number | null;
  accessibility: number | null;
  seo: number | null;
  security: number | null;
  reliability: number | null;
  coverage: number;
  computedAt: string;
  basis: { findingsByDomain: Record<string, number>; executedSteps: number; plannedSteps: number };
}

/** Release readiness decision (Section 47). */
export type ReleaseReadiness = 'READY' | 'CONDITIONALLY_READY' | 'NOT_READY';

export interface ReleaseDecision {
  readiness: ReleaseReadiness;
  reasons: string[];
  gates: ReleaseGate[];
  decidedAt: string;
}

export interface ReleaseGate {
  name: string;
  passed: boolean;
  detail: string;
}

/** Role contract (Sections 6–35). */
export interface Role {
  id: string;
  title: string;
  capabilities: string[];
  domains: FindingCategory[];
  defaultMode: ExecutionMode;
  defaultLanguage: WorkerLanguage;
  risk: 'low' | 'medium' | 'high';
}

/** Authorization / scope model (Section 64). */
export interface AuthorizationContext {
  allowedHosts: string[];
  allowPassive: boolean;
  allowActive: boolean;
  statement?: string;
}

/** Objective given to the orchestrator (the "user intent"). */
export interface TestObjective {
  id: string;
  kind: 'url-scan' | 'api-probe' | 'terminal-task';
  target: string;
  authorization: AuthorizationContext;
  options: {
    endpoints?: string[];
    linkSample?: number;
    perfSamples?: number;
    timeoutMs?: number;
  };
  requestedBy?: string;
}

export interface ExecutionStep {
  id: string;
  name: string;
  agentId: string;
  toolIds: string[];
  state: ExecutionState;
  attempts: number;
  maxAttempts: number;
  timeoutMs: number;
  healingEvents: HealingEvent[];
  result?: StepResult;
  error?: string;
}

export interface StepResult {
  status: 'passed' | 'failed' | 'degraded';
  findings: Finding[];
  evidence: EvidenceRef[];
  metrics: Record<string, number>;
  logs: string[];
  durationMs: number;
}

export interface HealingEvent {
  strategy: string;
  description: string;
  confidence: number;
  reversible: boolean;
  appliedAt: string;
  outcome: 'applied' | 'verified' | 'rolled-back' | 'rejected';
}

/** Full execution record (Section 51/52/62). */
export interface Execution {
  id: string; // EXEC-YYYY-NNNNNN
  objective: TestObjective;
  state: ExecutionState;
  mode: ExecutionMode;
  roles: string[];
  steps: ExecutionStep[];
  findings: Finding[];
  score?: QualityScore;
  release?: ReleaseDecision;
  reportPaths: string[];
  workerId: string;
  agentRuns: { agentId: string; startedAt: string; durationMs: number }[];
  createdAt: string;
  startedAt?: string;
  endedAt?: string;
  summary?: string;
}

/** Discovered application model (Section 37/38). */
export interface ApplicationModel {
  url: string;
  finalUrl: string;
  statusCode: number;
  title?: string;
  language?: string;
  technologies: string[];
  pages: string[];
  forms: { action: string; method: string; inputCount: number }[];
  assetCounts: { scripts: number; stylesheets: number; images: number };
  discoveredAt: string;
}
