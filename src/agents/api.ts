/**
 * WTE — API Agent (Section 11). Probes explicitly-declared endpoints:
 * status, JSON validity, content-type, latency. Endpoints come from the
 * objective (never guessed aggressively in the foundation phase).
 */
import { BaseAgent, type AgentRunContext } from './base.js';
import type { StepResult, Finding } from '../core/types.js';
import type { ApiRequestOutput } from '../tools/http.js';
import { createFinding } from '../findings/findings.js';

export class ApiAgent extends BaseAgent {
  readonly id = 'api-agent';
  readonly name = 'API Testing Agent';
  readonly requiredTools = ['api.request'];

  protected async execute(run: AgentRunContext): Promise<StepResult> {
    const ctx = this.ctx(run);
    const endpoints = run.objective.options.endpoints ?? [];
    if (endpoints.length === 0) {
      return this.ok({ status: 'degraded', logs: ['no endpoints declared in objective — skipping API testing'] });
    }

    const findings: Finding[] = [];
    const logs: string[] = [];
    const metrics: Record<string, number> = {};
    let ok = 0;

    for (const endpoint of endpoints) {
      const url = new URL(endpoint, run.objective.target).toString();
      const r = await this.deps.tools.invoke<{ url: string }, ApiRequestOutput>('api.request', { url }, ctx);
      const data = r.data;
      if (!data || data.error) {
        findings.push(
          createFinding({
            category: 'api',
            severity: 'high',
            title: `Endpoint unreachable: ${endpoint}`,
            description: `Request failed: ${data?.error ?? r.error ?? 'unknown'}`,
            expected: 'Endpoint responds',
            actual: data?.error ?? r.error ?? 'no response',
            url,
            component: endpoint,
          }),
        );
        logs.push(`✗ ${endpoint} unreachable`);
        continue;
      }

      ok += 1;
      metrics[`api.${endpoint}.status`] = data.status;
      metrics[`api.${endpoint}.latency_ms`] = data.timing.totalMs;
      const isJsonish = data.contentType.includes('json');

      if (data.status >= 500) {
        findings.push(
          createFinding({
            category: 'api',
            severity: 'high',
            title: `Endpoint returns HTTP ${data.status}: ${endpoint}`,
            description: 'Server-side API error.',
            expected: 'HTTP < 500',
            actual: `HTTP ${data.status}`,
            url,
            component: endpoint,
            rootCause: {
              summary: `application-defect at ${endpoint}`,
              classification: 'application-defect',
              confidence: 0.8,
              evidence: [`HTTP ${data.status} observed`],
              affectedComponent: endpoint,
              recommendedAction: 'Inspect server logs for this route.',
            },
          }),
        );
      } else if (data.status === 404) {
        findings.push(
          createFinding({
            category: 'api',
            severity: 'medium',
            title: `Endpoint not found: ${endpoint}`,
            description: 'Declared endpoint returns 404 — route missing or objective stale.',
            expected: 'Endpoint exists',
            actual: 'HTTP 404',
            url,
            component: endpoint,
          }),
        );
      }

      if (data.status >= 200 && data.status < 300 && isJsonish && !data.jsonValid) {
        findings.push(
          createFinding({
            category: 'api',
            severity: 'medium',
            title: `Invalid JSON from ${endpoint}`,
            description: 'Payload advertises JSON but fails to parse — a contract violation for clients.',
            expected: 'Well-formed JSON body',
            actual: data.bodyText.slice(0, 120),
            url,
            component: endpoint,
          }),
        );
      }

      if (data.status >= 200 && data.status < 300 && !isJsonish && endpoint.startsWith('/api')) {
        findings.push(
          createFinding({
            category: 'api',
            severity: 'low',
            title: `Non-JSON content-type on API path ${endpoint}`,
            description: `API path served '${data.contentType || 'unknown'}' — confirm this is intended.`,
            expected: 'application/json',
            actual: data.contentType || 'unknown',
            url,
            component: endpoint,
          }),
        );
      }
      logs.push(`✓ ${endpoint} → ${data.status} ${isJsonish ? (data.jsonValid ? 'json' : 'INVALID-JSON') : data.contentType || 'n/a'} ${data.timing.totalMs}ms`);
    }

    metrics['api.endpoints_ok'] = ok;
    metrics['api.endpoints_total'] = endpoints.length;

    return this.ok({
      status: 'passed',
      findings,
      logs,
      metrics,
      evidence: [this.evidence('json', `API probe results for ${endpoints.length} endpoint(s)`)],
    });
  }
}
