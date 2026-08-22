/**
 * WTE — Execution Decision Engine (Section 4).
 * TARGET → TEST TYPE → REQUIRED INTERFACE → GUI/TERMINAL/HYBRID → ROLE → TOOL → LANGUAGE.
 */
import type { ExecutionMode, TestObjective, WorkerLanguage } from './types.js';
import { selectRoles, type RoleSelectionContext } from './roles.js';

export interface GuiAvailability {
  browserRuntime: boolean; // Playwright/Chromium configured
  reason?: string;
}

export interface ExecutionPlan {
  mode: ExecutionMode;
  language: WorkerLanguage;
  roles: string[];
  agents: string[];
  rules: string[]; // decision rules that fired (auditability)
  degraded: boolean;
  degradationNotes: string[];
}

export function decideMode(objective: TestObjective, gui: GuiAvailability): { mode: ExecutionMode; rules: string[]; degraded: boolean; notes: string[] } {
  const rules: string[] = [];
  const notes: string[] = [];
  let degraded = false;

  let desired: ExecutionMode;
  if (objective.kind === 'terminal-task') {
    desired = 'TERMINAL';
    rules.push('terminal-task → TERMINAL (deterministic programmatic execution)');
  } else if (objective.kind === 'api-probe') {
    desired = 'TERMINAL';
    rules.push('api-only testing → TERMINAL');
  } else {
    // URL scan of a web application — visual/interaction state matters → HYBRID desired.
    desired = 'HYBRID';
    rules.push('web application with browser + backend validation → HYBRID');
  }

  if (desired !== 'TERMINAL' && !gui.browserRuntime) {
    degraded = true;
    notes.push(
      `GUI runtime unavailable (${gui.reason ?? 'no browser runtime configured'}); ` +
        'degrading to TERMINAL-only execution with HTTP/DOM-static probes. Visual, screenshot, ' +
        'and interaction coverage deferred to a GUI-enabled phase.',
    );
    rules.push('GUI unavailable → degraded TERMINAL with static DOM analysis');
    desired = 'TERMINAL';
  }
  return { mode: desired, rules, degraded, notes };
}

/** Build the full execution plan for an objective. */
export function planExecution(objective: TestObjective, gui: GuiAvailability, roleCtx: RoleSelectionContext): ExecutionPlan {
  const { mode, rules, degraded, notes } = decideMode(objective, gui);
  const roles = selectRoles(roleCtx);
  const agents: string[] = [];
  if (objective.kind === 'terminal-task') {
    agents.push('terminal-agent');
  } else {
    agents.push('discovery-agent');
    if (objective.kind === 'url-scan') {
      agents.push('security-agent', 'accessibility-agent', 'seo-agent', 'performance-agent');
    }
    if ((objective.options.endpoints ?? []).length > 0 || objective.kind === 'api-probe') {
      agents.push('api-agent');
    }
  }
  agents.push('reporting-agent');

  const language: WorkerLanguage = mode === 'GUI' || mode === 'HYBRID' || objective.kind !== 'terminal-task' ? 'typescript' : 'typescript';
  return { mode, language, roles, agents, rules, degraded, degradationNotes: notes };
}
