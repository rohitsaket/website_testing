/**
 * WTE — SEO Agent (Section 36.13). Static meta/structure validation.
 */
import { BaseAgent, type AgentRunContext } from './base.js';
import type { StepResult, Finding } from '../core/types.js';
import type { ParsedPage } from '../core/htmllite.js';
import { createFinding } from '../findings/findings.js';

export class SeoAgent extends BaseAgent {
  readonly id = 'seo-agent';
  readonly name = 'SEO Validation Agent';
  readonly requiredTools = [];

  protected async execute(run: AgentRunContext): Promise<StepResult> {
    const page = run.shared.get('parsedPage') as ParsedPage | undefined;
    const target = run.objective.target;
    if (!page) return this.ok({ status: 'degraded', logs: ['no parsed page available — skipping SEO validation'] });

    const findings: Finding[] = [];
    const push = (d: Parameters<typeof createFinding>[0]) => findings.push(createFinding(d));
    const meta = (name: string) => page.meta.find((m) => m.name?.toLowerCase() === name)?.content;
    const og = (prop: string) => page.meta.find((m) => m.property?.toLowerCase() === prop)?.content;

    if (!page.title) {
      push({
        category: 'seo',
        severity: 'high',
        title: 'Missing <title>',
        description: 'The title is the primary SERP headline signal.',
        expected: 'Unique, descriptive title (10–60 chars)',
        actual: 'Absent',
        url: target,
        component: 'document',
      });
    } else if (page.title.length > 60) {
      push({
        category: 'seo',
        severity: 'low',
        title: 'Title longer than 60 characters',
        description: 'Long titles truncate in search results.',
        expected: '≤ 60 characters',
        actual: `${page.title.length} characters`,
        url: target,
        component: 'document',
      });
    }

    if (!meta('description')) {
      push({
        category: 'seo',
        severity: 'medium',
        title: 'Missing meta description',
        description: 'Search engines fall back to arbitrary page text for the snippet.',
        expected: 'A 50–160 character meta description',
        actual: 'Absent',
        url: target,
        component: 'head',
      });
    }

    if (!page.meta.some((m) => m.charset) && !page.meta.some((m) => m.name === undefined && m.content === undefined)) {
      push({
        category: 'seo',
        severity: 'low',
        title: 'No charset declaration detected',
        description: 'Missing charset can mojibake non-ASCII content in indexing.',
        expected: '<meta charset="utf-8">',
        actual: 'Not found',
        url: target,
        component: 'head',
      });
    }

    if (meta('robots')?.includes('noindex')) {
      push({
        category: 'seo',
        severity: 'medium',
        title: 'Page marked noindex',
        description: 'This page instructs search engines NOT to index it — verify that is intentional.',
        expected: 'index,follow for indexable pages',
        actual: meta('robots') ?? 'noindex',
        url: target,
        component: 'head',
      });
    }

    if (!og('og:title') && !og('og:description')) {
      push({
        category: 'seo',
        severity: 'info',
        title: 'No OpenGraph metadata',
        description: 'Social shares will render without title/description cards.',
        expected: 'og:title / og:description present',
        actual: 'Absent',
        url: target,
        component: 'head',
      });
    }

    return this.ok({
      status: 'passed',
      findings,
      logs: [`seo validation: ${findings.length} finding(s)`],
      metrics: { 'seo.findings': findings.length },
    });
  }
}
