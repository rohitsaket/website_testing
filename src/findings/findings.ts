/**
 * WTE — Finding lifecycle (Section 45): creation, normalization, deduplication.
 * Fingerprint = stable hash of category+title+url+component so the same defect
 * found by two runs is merged, with firstDetected/lastDetected preserved.
 */
import { createHash } from 'node:crypto';
import type { Finding, FindingCategory, RootCause, Severity } from '../core/types.js';

export interface FindingDraft {
  category: FindingCategory;
  severity: Severity;
  title: string;
  description: string;
  expected: string;
  actual: string;
  confidence?: number;
  url?: string;
  component?: string;
  testId?: string;
  evidence?: Finding['evidence'];
  rootCause?: RootCause;
}

const SEVERITY_PRIORITY: Record<Severity, Finding['priority']> = {
  critical: 'P0',
  high: 'P1',
  medium: 'P2',
  low: 'P3',
  info: 'P4',
};

let counter = 0;

export function fingerprintOf(d: FindingDraft): string {
  const basis = [d.category, d.title.toLowerCase().trim(), d.url ?? '', d.component ?? ''].join('|');
  return createHash('sha256').update(basis).digest('hex').slice(0, 16);
}

export function createFinding(draft: FindingDraft, now = new Date()): Finding {
  counter += 1;
  return {
    id: `FND-${now.getFullYear()}-${counter.toString().padStart(5, '0')}`,
    fingerprint: fingerprintOf(draft),
    category: draft.category,
    severity: draft.severity,
    priority: SEVERITY_PRIORITY[draft.severity],
    title: draft.title.trim(),
    description: draft.description,
    expected: draft.expected,
    actual: draft.actual,
    confidence: draft.confidence ?? 0.8,
    rootCause: draft.rootCause,
    url: draft.url,
    component: draft.component,
    testId: draft.testId,
    evidence: draft.evidence ?? [],
    firstDetected: now.toISOString(),
    lastDetected: now.toISOString(),
    status: 'open',
    related: [],
  };
}

/** Merge findings: same fingerprint → one record, updated lastDetected, union of evidence. */
export function deduplicateFindings(findings: Finding[]): Finding[] {
  const byFp = new Map<string, Finding>();
  for (const f of findings) {
    const existing = byFp.get(f.fingerprint);
    if (!existing) {
      byFp.set(f.fingerprint, f);
      continue;
    }
    existing.lastDetected = f.lastDetected > existing.lastDetected ? f.lastDetected : existing.lastDetected;
    existing.firstDetected = f.firstDetected < existing.firstDetected ? f.firstDetected : existing.firstDetected;
    f.status = 'duplicate';
    (existing.related ??= []).push(f.id);
    const seen = new Set(existing.evidence.map((e) => e.id));
    for (const e of f.evidence) if (!seen.has(e.id)) existing.evidence.push(e);
  }
  return [...byFp.values()];
}

export function summarize(findings: Finding[]): Record<string, number> {
  const counts: Record<string, number> = { critical: 0, high: 0, medium: 0, low: 0, info: 0, total: 0 };
  for (const f of findings) {
    counts[f.severity] = (counts[f.severity] ?? 0) + 1;
    counts['total'] = (counts['total'] ?? 0) + 1;
  }
  return counts;
}
