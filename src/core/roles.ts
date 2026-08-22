/**
 * WTE — Role registry and minimum-role selection (Section 71).
 * Roles are specialized capabilities of the testing organization.
 * The selector activates the MINIMUM required set for the objective.
 */
import type { ExecutionMode, FindingCategory, Role, WorkerLanguage } from './types.js';

const R = (
  id: string,
  title: string,
  capabilities: string[],
  domains: FindingCategory[],
  defaultMode: ExecutionMode,
  defaultLanguage: WorkerLanguage,
  risk: Role['risk'],
): Role => ({ id, title, capabilities, domains, defaultMode, defaultLanguage, risk });

/** Curated Phase 1 role catalog (subset of Sections 6–35 relevant to web/API targets). */
export const ROLE_CATALOG: readonly Role[] = [
  R('web-tester', 'Web Tester', ['dom-analysis', 'navigation', 'workflows'], ['functional', 'ui'], 'GUI', 'typescript', 'low'),
  R('web-qa-engineer', 'Web QA Engineer', ['page-validation', 'content-checks'], ['functional', 'ui'], 'HYBRID', 'typescript', 'low'),
  R('sdet', 'SDET', ['automation', 'frameworks', 'terminal-execution'], ['functional'], 'TERMINAL', 'typescript', 'low'),
  R('security-tester', 'Security Tester', ['header-validation', 'cookie-validation', 'tls-validation', 'config-validation'], ['security'], 'TERMINAL', 'typescript', 'medium'),
  R('api-tester', 'API Tester', ['endpoint-probing', 'schema-validation', 'contract-checks'], ['api'], 'TERMINAL', 'typescript', 'low'),
  R('performance-test-engineer', 'Performance Test Engineer', ['latency-sampling', 'throughput', 'ttfb'], ['performance'], 'TERMINAL', 'typescript', 'low'),
  R('accessibility-tester', 'Accessibility Tester', ['wcag-static', 'aria', 'labels', 'keyboard-static'], ['accessibility'], 'GUI', 'typescript', 'low'),
  R('seo-analyst', 'SEO Analyst', ['meta-validation', 'structured-content'], ['seo'], 'TERMINAL', 'typescript', 'low'),
  R('network-test-engineer', 'Network Test Engineer', ['dns', 'tls', 'connectivity'], ['infrastructure', 'reliability'], 'TERMINAL', 'typescript', 'low'),
  R('qa-analyst', 'QA Analyst', ['finding-triage', 'dedup', 'reporting'], ['functional'], 'TERMINAL', 'python', 'low'),
  R('release-engineer', 'Release Engineer', ['quality-gates', 'readiness'], ['reliability'], 'TERMINAL', 'typescript', 'low'),
  R('test-architect', 'Test Architect', ['strategy', 'planning', 'tool-selection'], ['functional'], 'HYBRID', 'typescript', 'low'),
] as const;

export function findRole(id: string): Role | undefined {
  return ROLE_CATALOG.find((r) => r.id === id);
}

export interface RoleSelectionContext {
  kind: 'url-scan' | 'api-probe' | 'terminal-task';
  hasForms: boolean;
  hasEndpoints: boolean;
  securityRelevant: boolean;
  performanceRelevant: boolean;
  accessibilityRelevant: boolean;
  seoRelevant: boolean;
}

/**
 * Minimum-sufficient role selection (Section 71).
 * Returns role IDs ordered by execution priority.
 */
export function selectRoles(ctx: RoleSelectionContext): string[] {
  const roles = new Set<string>();
  if (ctx.kind === 'terminal-task') return ['sdet', 'qa-analyst'];
  if (ctx.kind === 'api-probe') {
    roles.add('api-tester');
    if (ctx.performanceRelevant) roles.add('performance-test-engineer');
    if (ctx.securityRelevant) roles.add('security-tester');
    roles.add('release-engineer');
    return [...roles];
  }
  // url-scan
  roles.add('web-qa-engineer');
  roles.add('web-tester');
  if (ctx.securityRelevant) roles.add('security-tester');
  if (ctx.performanceRelevant) roles.add('performance-test-engineer');
  if (ctx.accessibilityRelevant) roles.add('accessibility-tester');
  if (ctx.seoRelevant) roles.add('seo-analyst');
  if (ctx.hasEndpoints) roles.add('api-tester');
  roles.add('release-engineer');
  return [...roles];
}
