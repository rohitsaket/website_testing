/**
 * WTE — Root Cause Analysis (Sections 41–42).
 * Classification is rule-based and CONFIDENCE-SCORED. When evidence is
 * insufficient the engine reports 'unknown' instead of inventing certainty.
 */
import type { RootCause, RootCauseClassification } from '../core/types.js';

export interface FailureSignal {
  error?: string;
  httpStatus?: number;
  timeoutOccurred?: boolean;
  dnsFailure?: boolean;
  connectionRefused?: boolean;
  tlsFailure?: boolean;
  consecutiveFailures?: number; // same step failing repeatedly → less likely flaky
  historicalPasses?: number;
  historicalFailures?: number;
}

interface Rule {
  classification: RootCauseClassification;
  matches(s: FailureSignal): boolean;
  confidence(s: FailureSignal): number;
  action(s: FailureSignal): string;
}

const RULES: Rule[] = [
  {
    classification: 'authentication-issue',
    matches: (s) => s.httpStatus === 401 || s.httpStatus === 403,
    confidence: () => 0.85,
    action: () => 'Verify credentials/token validity and authorization scope for the test identity.',
  },
  {
    classification: 'application-defect',
    matches: (s) => s.httpStatus !== undefined && s.httpStatus >= 500,
    confidence: () => 0.8,
    action: (s) => `Server-side fault (HTTP ${s.httpStatus}). Inspect application logs and recent deployments for the affected endpoint.`,
  },
  {
    classification: 'application-defect',
    matches: (s) => s.httpStatus === 404,
    confidence: () => 0.6,
    action: () => 'Resource not found — either a broken route (application defect) or a stale locator in the test (test defect). Cross-check the route inventory before triage.',
  },
  {
    classification: 'network-issue',
    matches: (s) => s.dnsFailure === true,
    confidence: () => 0.9,
    action: () => 'DNS resolution failed. Verify hostname, resolver configuration and connectivity from the worker.',
  },
  {
    classification: 'network-issue',
    matches: (s) => s.connectionRefused === true,
    confidence: () => 0.85,
    action: () => 'TCP connection refused — the target service appears down or the port is filtered. Check service health and firewall rules.',
  },
  {
    classification: 'network-issue',
    matches: (s) => s.tlsFailure === true,
    confidence: () => 0.8,
    action: () => 'TLS handshake failure. Validate certificate chain, expiry and protocol/cipher compatibility.',
  },
  {
    classification: 'timing-issue',
    matches: (s) => s.timeoutOccurred === true,
    confidence: (s) => ((s.historicalPasses ?? 0) > 0 ? 0.7 : 0.5),
    action: () => 'Operation exceeded its timeout. Check target latency and consider healing the wait policy if the step has a history of passing.',
  },
  {
    classification: 'environment-issue',
    matches: (s) => /ENOTFOUND|EAI_AGAIN|EADDRNOTAVAIL|ECONNRESET/i.test(s.error ?? ''),
    confidence: () => 0.75,
    action: () => 'Environment-level fault detected in worker networking. Verify worker DNS/proxy configuration.',
  },
  {
    classification: 'flaky-behavior',
    matches: (s) => (s.historicalFailures ?? 0) > 0 && (s.historicalPasses ?? 0) > 0,
    confidence: (s) => {
      const p = s.historicalPasses ?? 0;
      const f = s.historicalFailures ?? 0;
      return Math.min(0.85, 0.4 + (Math.min(p, f) / Math.max(p, f, 1)) * 0.4);
    },
    action: () => 'Step has passed and failed under similar conditions. Quarantine and stabilize before trusting its verdicts.',
  },
];

export function analyzeFailure(component: string, signal: FailureSignal, evidence: string[] = []): RootCause {
  for (const rule of RULES) {
    if (rule.matches(signal)) {
      return {
        summary: `${rule.classification} in ${component}`,
        classification: rule.classification,
        confidence: Math.round(rule.confidence(signal) * 100) / 100,
        evidence,
        affectedComponent: component,
        recommendedAction: rule.action(signal),
      };
    }
  }
  return {
    summary: `inconclusive failure in ${component}`,
    classification: 'unknown',
    confidence: 0.2,
    evidence,
    affectedComponent: component,
    recommendedAction: 'Insufficient evidence to classify. Collect additional signals (logs, traces, network capture) and re-execute before triage.',
  };
}
