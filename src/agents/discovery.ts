/**
 * WTE — Discovery Agent (Section 37). Builds the application model from
 * passive HTTP probes: technologies, pages, forms, assets, link health sample.
 */
import { BaseAgent, type AgentRunContext } from './base.js';
import type { StepResult, Finding, ApplicationModel } from '../core/types.js';
import type { HttpProbeOutput } from '../tools/http.js';
import { parseHtml, resolveSameOriginLinks } from '../core/htmllite.js';
import { createFinding } from '../findings/findings.js';

export class DiscoveryAgent extends BaseAgent {
  readonly id = 'discovery-agent';
  readonly name = 'Website Discovery Agent';
  readonly requiredTools = ['http.probe'];

  protected async execute(run: AgentRunContext): Promise<StepResult> {
    const ctx = this.ctx(run);
    const findings: Finding[] = [];
    const logs: string[] = [];
    const target = run.objective.target;

    const res = await this.deps.tools.invoke<{ url: string }, HttpProbeOutput>('http.probe', { url: target }, ctx);
    if (!res.ok || !res.data) {
      logs.push(`probe failed: ${res.error ?? 'unknown'}`);
      return this.ok({ status: 'degraded', logs });
    }
    const probe = res.data;
    if (probe.error) {
      logs.push(`target unreachable: ${probe.error}`);
      return this.ok({
        status: 'failed',
        findings: [
          createFinding({
            category: 'reliability',
            severity: 'critical',
            title: 'Target unreachable',
            description: `The root URL could not be reached: ${probe.error}`,
            expected: 'Root URL responds successfully',
            actual: probe.error,
            confidence: 0.95,
            url: target,
          }),
        ],
        logs,
      });
    }

    const html = probe.bodyText;
    const page = parseHtml(html);
    const model: ApplicationModel = {
      url: target,
      finalUrl: probe.finalUrl,
      statusCode: probe.status,
      title: page.title ?? undefined,
      language: page.lang ?? undefined,
      technologies: page.technologies,
      pages: resolveSameOriginLinks(probe.finalUrl, page.links),
      forms: page.forms.map((f) => ({ action: f.action, method: f.method, inputCount: f.inputs.length })),
      assetCounts: { scripts: page.scripts.count, stylesheets: page.stylesheetCount, images: page.images.length },
      discoveredAt: new Date().toISOString(),
    };

    run.shared.set('applicationModel', model);
    run.shared.set('parsedPage', page);
    run.shared.set('rootProbe', probe);
    this.deps.memory.saveApplication(new URL(target).origin, model);

    logs.push(
      `status=${probe.status} ttfb=${probe.timing.ttfbMs}ms total=${probe.timing.totalMs}ms bytes=${probe.bodyBytes} ` +
        `pages=${model.pages.length} forms=${model.forms.length} tech=${model.technologies.join(',') || 'none detected'}`,
    );

    if (probe.status >= 500) {
      findings.push(
        createFinding({
          category: 'functional',
          severity: 'critical',
          title: `Root URL returns HTTP ${probe.status}`,
          description: 'The application root responds with a server error.',
          expected: 'HTTP 2xx/3xx from the root URL',
          actual: `HTTP ${probe.status} ${probe.statusText}`,
          url: target,
          confidence: 0.95,
          rootCause: {
            summary: 'application-defect on root route',
            classification: 'application-defect',
            confidence: 0.8,
            evidence: [`HTTP ${probe.status} response captured via http.probe`],
            affectedComponent: target,
            recommendedAction: 'Inspect application error logs for the root route handler.',
          },
        }),
      );
    } else if (probe.status >= 400) {
      findings.push(
        createFinding({
          category: 'functional',
          severity: 'high',
          title: `Root URL returns HTTP ${probe.status}`,
          description: 'The application root responds with a client error.',
          expected: 'HTTP 2xx/3xx from the root URL',
          actual: `HTTP ${probe.status} ${probe.statusText}`,
          url: target,
          confidence: 0.9,
        }),
      );
    }

    if (!page.title) {
      findings.push(
        createFinding({
          category: 'ui',
          severity: 'low',
          title: 'Missing document title',
          description: 'The root document has no <title>, harming UX, SEO and assistive technology orientation.',
          expected: 'A meaningful <title> element',
          actual: 'No <title> present',
          url: target,
          component: 'document',
        }),
      );
    }

    // Sample same-origin links and probe their health (bounded).
    const sample = model.pages.slice(0, run.objective.options.linkSample ?? 10);
    let broken = 0;
    for (const link of sample) {
      const r = await this.deps.tools.invoke<{ url: string; method: string }, HttpProbeOutput>('http.probe', { url: link, method: 'GET' }, ctx);
      const status = r.data?.status ?? 0;
      if (status >= 400 || status === 0) {
        broken += 1;
        findings.push(
          createFinding({
            category: 'functional',
            severity: 'medium',
            title: `Broken same-origin link (HTTP ${status || 'unreachable'})`,
            description: `Discovered link returns an error status.`,
            expected: 'Link resolves with HTTP < 400',
            actual: `HTTP ${status}${r.data?.error ? ` (${r.data.error})` : ''}`,
            url: link,
            component: 'navigation',
          }),
        );
      }
    }
    if (sample.length > 0) logs.push(`link-health sample: ${sample.length - broken}/${sample.length} healthy`);

    return this.ok({
      status: 'passed',
      findings,
      logs,
      evidence: [
        this.evidence('html', `Root document snapshot (${probe.bodyBytes} bytes)`),
        this.evidence('json', 'application-model'),
      ],
      metrics: {
        'discovery.status': probe.status,
        'discovery.ttfb_ms': probe.timing.ttfbMs,
        'discovery.total_ms': probe.timing.totalMs,
        'discovery.bytes': probe.bodyBytes,
        'discovery.pages': model.pages.length,
        'discovery.forms': model.forms.length,
        'discovery.links_broken': broken,
      },
    });
  }
}
