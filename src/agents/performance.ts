/**
 * WTE — Performance Agent (Section 16). Latency sampling of the root URL:
 * TTFB and total response time, N samples, simple percentile stats with
 * threshold-based findings. NOT a load test (Java load worker is a later phase).
 */
import { BaseAgent, type AgentRunContext } from './base.js';
import type { StepResult, Finding } from '../core/types.js';
import type { HttpProbeOutput } from '../tools/http.js';
import { createFinding } from '../findings/findings.js';

function percentile(sorted: number[], p: number): number {
  if (sorted.length === 0) return 0;
  const idx = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, idx)] ?? 0;
}

export const PERF_THRESHOLDS = {
  ttfbWarnMs: 800,
  p95WarnMs: 2000,
  sizeWarnBytes: 2 * 1024 * 1024,
};

export class PerformanceAgent extends BaseAgent {
  readonly id = 'performance-agent';
  readonly name = 'Performance Sampling Agent';
  readonly requiredTools = ['http.probe'];

  protected async execute(run: AgentRunContext): Promise<StepResult> {
    const ctx = this.ctx(run);
    const target = run.objective.target;
    const samples = Math.max(2, Math.min(10, run.objective.options.perfSamples ?? 5));
    const ttfbs: number[] = [];
    const totals: number[] = [];
    let bytes = 0;
    let failures = 0;

    for (let i = 0; i < samples; i++) {
      const r = await this.deps.tools.invoke<{ url: string }, HttpProbeOutput>('http.probe', { url: target }, ctx);
      if (r.data && !r.data.error) {
        ttfbs.push(r.data.timing.ttfbMs);
        totals.push(r.data.timing.totalMs);
        bytes = Math.max(bytes, r.data.bodyBytes);
      } else {
        failures += 1;
      }
    }

    if (ttfbs.length === 0) {
      return this.ok({ status: 'degraded', logs: ['all performance samples failed'] });
    }

    ttfbs.sort((a, b) => a - b);
    totals.sort((a, b) => a - b);
    const stats = {
      meanTtfb: Math.round(ttfbs.reduce((a, b) => a + b, 0) / ttfbs.length),
      p50Ttfb: percentile(ttfbs, 50),
      p95Ttfb: percentile(ttfbs, 95),
      p95Total: percentile(totals, 95),
      samples: ttfbs.length,
      failures,
      bytes,
    };

    const findings: Finding[] = [];
    if (stats.p50Ttfb > PERF_THRESHOLDS.ttfbWarnMs) {
      findings.push(
        createFinding({
          category: 'performance',
          severity: 'medium',
          title: `Slow time-to-first-byte (p50 ${stats.p50Ttfb}ms)`,
          description: 'Server-side latency dominates initial response; investigate backend/render path.',
          expected: `p50 TTFB ≤ ${PERF_THRESHOLDS.ttfbWarnMs}ms`,
          actual: `p50 ${stats.p50Ttfb}ms, p95 ${stats.p95Ttfb}ms over ${stats.samples} samples`,
          url: target,
          component: 'server-response',
        }),
      );
    }
    if (stats.p95Total > PERF_THRESHOLDS.p95WarnMs) {
      findings.push(
        createFinding({
          category: 'performance',
          severity: 'medium',
          title: `Slow full response (p95 ${stats.p95Total}ms)`,
          description: 'Total document delivery exceeds the responsiveness budget.',
          expected: `p95 total ≤ ${PERF_THRESHOLDS.p95WarnMs}ms`,
          actual: `p95 ${stats.p95Total}ms`,
          url: target,
          component: 'server-response',
        }),
      );
    }
    if (bytes > PERF_THRESHOLDS.sizeWarnBytes) {
      findings.push(
        createFinding({
          category: 'performance',
          severity: 'low',
          title: `Large HTML payload (${Math.round(bytes / 1024)}KB)`,
          description: 'Oversized documents delay interactive readiness, especially on mobile networks.',
          expected: `≤ ${PERF_THRESHOLDS.sizeWarnBytes / 1024}KB HTML`,
          actual: `${Math.round(bytes / 1024)}KB`,
          url: target,
          component: 'document',
        }),
      );
    }
    if (failures > 0) {
      findings.push(
        createFinding({
          category: 'reliability',
          severity: 'medium',
          title: `${failures}/${samples} performance samples failed`,
          description: 'Intermittent reachability failures during sampling.',
          expected: '0 failed samples',
          actual: `${failures} failures`,
          url: target,
          component: 'network',
          rootCause: {
            summary: 'intermittent connectivity or server instability',
            classification: 'network-issue',
            confidence: 0.55,
            evidence: [`${failures} failed samples out of ${samples}`],
            affectedComponent: target,
            recommendedAction: 'Correlate with infrastructure health; re-run sampling against a stable window.',
          },
        }),
      );
    }

    this.deps.memory.saveBaseline(new URL(target).origin, {
      ttfb_p50: stats.p50Ttfb,
      ttfb_p95: stats.p95Ttfb,
      total_p95: stats.p95Total,
    });

    return this.ok({
      status: 'passed',
      findings,
      logs: [`perf: p50=${stats.p50Ttfb}ms p95=${stats.p95Ttfb}ms total-p95=${stats.p95Total}ms bytes=${bytes} samples=${stats.samples}`],
      metrics: {
        'perf.ttfb_p50_ms': stats.p50Ttfb,
        'perf.ttfb_p95_ms': stats.p95Ttfb,
        'perf.total_p95_ms': stats.p95Total,
        'perf.bytes': bytes,
        'perf.sample_failures': failures,
      },
    });
  }
}
