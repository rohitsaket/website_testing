/**
 * WTE — Evidence-driven quality scoring (Section 46).
 * Score per domain = 100 − Σ severity penalties (clamped at 0).
 * Domains with zero coverage are null (not zero — absent evidence ≠ failure).
 * Overall = coverage-aware weighted blend of evidenced domains.
 */
import type { Finding, FindingCategory, QualityScore, Severity } from '../core/types.js';

const PENALTY: Record<Severity, number> = { critical: 25, high: 15, medium: 7, low: 3, info: 0.5 };

const DOMAIN_WEIGHT: Partial<Record<FindingCategory, number>> = {
  functional: 0.25,
  security: 0.2,
  performance: 0.15,
  accessibility: 0.12,
  ui: 0.1,
  api: 0.08,
  seo: 0.05,
  reliability: 0.05,
};

export interface ScoreInput {
  findings: Finding[];
  plannedSteps: number;
  executedSteps: number;
  domainsEvaluated: FindingCategory[];
}

function domainScore(findings: Finding[], category: FindingCategory): number | null {
  const relevant = findings.filter((f) => f.category === category && f.status !== 'duplicate');
  if (relevant.length === 0 && !findings.some((f) => f.category === category)) return null;
  const penalty = relevant.reduce((acc, f) => acc + PENALTY[f.severity] * f.confidence, 0);
  return Math.max(0, Math.round((100 - penalty) * 100) / 100);
}

export function computeQualityScore(input: ScoreInput): QualityScore {
  const { findings, domainsEvaluated } = input;
  const evaluated = new Set(domainsEvaluated);

  const perDomain: Record<FindingCategory, number | null> = {
    functional: evaluated.has('functional') ? domainScore(findings, 'functional') ?? 100 : null,
    ui: evaluated.has('ui') ? domainScore(findings, 'ui') ?? 100 : null,
    api: evaluated.has('api') ? domainScore(findings, 'api') ?? 100 : null,
    performance: evaluated.has('performance') ? domainScore(findings, 'performance') ?? 100 : null,
    accessibility: evaluated.has('accessibility') ? domainScore(findings, 'accessibility') ?? 100 : null,
    seo: evaluated.has('seo') ? domainScore(findings, 'seo') ?? 100 : null,
    security: evaluated.has('security') ? domainScore(findings, 'security') ?? 100 : null,
    reliability: evaluated.has('reliability') ? domainScore(findings, 'reliability') ?? 100 : null,
    data: null,
    configuration: null,
    compatibility: null,
    infrastructure: null,
  };

  // domainScore returns null only when no findings AND none recorded; inside evaluated domains,
  // zero findings should mean 100 (perfect), so coerce explicitly above.
  const scored = (Object.entries(perDomain) as [FindingCategory, number | null][]).filter(([, v]) => v !== null);
  const totalWeight = scored.reduce((acc, [c]) => acc + (DOMAIN_WEIGHT[c] ?? 0.02), 0);
  const overall =
    totalWeight === 0
      ? 0
      : Math.round(
          (scored.reduce((acc, [c, v]) => acc + (v ?? 0) * (DOMAIN_WEIGHT[c] ?? 0.02), 0) / totalWeight) * 100,
        ) / 100;

  const coverage = input.plannedSteps === 0 ? 0 : Math.round((input.executedSteps / input.plannedSteps) * 10000) / 100;

  const findingsByDomain: Record<string, number> = {};
  for (const f of findings) {
    if (f.status === 'duplicate') continue;
    findingsByDomain[f.category] = (findingsByDomain[f.category] ?? 0) + 1;
  }

  return {
    overall,
    functional: perDomain.functional,
    ui: perDomain.ui,
    api: perDomain.api,
    performance: perDomain.performance,
    accessibility: perDomain.accessibility,
    seo: perDomain.seo,
    security: perDomain.security,
    reliability: perDomain.reliability,
    coverage,
    computedAt: new Date().toISOString(),
    basis: { findingsByDomain, executedSteps: input.executedSteps, plannedSteps: input.plannedSteps },
  };
}
