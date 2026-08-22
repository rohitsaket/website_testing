/**
 * WTE — Accessibility Agent (Section 18). Static WCAG linting over the parsed
 * document. Honest limits: no rendered contrast, no keyboard/screen-reader
 * until the GUI phase. Findings are labeled 'static-analysis'.
 */
import { BaseAgent, type AgentRunContext } from './base.js';
import type { StepResult, Finding } from '../core/types.js';
import type { ParsedPage } from '../core/htmllite.js';
import { createFinding } from '../findings/findings.js';

export class AccessibilityAgent extends BaseAgent {
  readonly id = 'accessibility-agent';
  readonly name = 'Accessibility (Static WCAG) Agent';
  readonly requiredTools = [];

  protected async execute(run: AgentRunContext): Promise<StepResult> {
    const page = run.shared.get('parsedPage') as ParsedPage | undefined;
    const target = run.objective.target;
    if (!page) return this.ok({ status: 'degraded', logs: ['no parsed page available — skipping accessibility validation'] });

    const findings: Finding[] = [];
    const push = (d: Parameters<typeof createFinding>[0]) => findings.push(createFinding(d));

    if (!page.lang) {
      push({
        category: 'accessibility',
        severity: 'medium',
        title: 'Missing lang attribute on <html>',
        description: 'Screen readers need the document language to choose correct pronunciation rules (WCAG 3.1.1).',
        expected: '<html lang="...">',
        actual: 'No lang attribute',
        url: target,
        component: 'document',
      });
    }

    if (!page.title) {
      push({
        category: 'accessibility',
        severity: 'medium',
        title: 'Missing page title',
        description: 'Assistive technologies announce the title first; absence harms orientation (WCAG 2.4.2).',
        expected: 'Descriptive <title>',
        actual: 'None present',
        url: target,
        component: 'document',
      });
    }

    const imagesNoAlt = page.images.filter((i) => i.alt === null);
    if (imagesNoAlt.length > 0) {
      push({
        category: 'accessibility',
        severity: 'high',
        title: `${imagesNoAlt.length} image(s) missing alt text`,
        description: 'Images without alt are invisible to screen-reader users (WCAG 1.1.1). Decorative images need alt="".',
        expected: 'alt attribute on every <img>',
        actual: `${imagesNoAlt.length} missing (e.g. ${imagesNoAlt[0]?.src ?? 'n/a'})`,
        url: target,
        component: 'images',
      });
    }

    let unlabeled = 0;
    for (const form of page.forms) {
      unlabeled += form.inputs.filter((inp) => !inp.hasLabel && !['hidden', 'submit', 'button'].includes(inp.type)).length;
    }
    if (unlabeled > 0) {
      push({
        category: 'accessibility',
        severity: 'high',
        title: `${unlabeled} form control(s) without accessible names`,
        description: 'Inputs without labels/aria-label are unusable for assistive-technology users (WCAG 1.3.1 / 4.1.2).',
        expected: 'Every control associated with a <label> or aria-label',
        actual: `${unlabeled} unlabeled control(s)`,
        url: target,
        component: 'forms',
      });
    }

    const h1s = page.headings.filter((h) => h.level === 1);
    if (h1s.length === 0) {
      push({
        category: 'accessibility',
        severity: 'low',
        title: 'No <h1> heading',
        description: 'A primary heading structures the page for navigation by assistive technology.',
        expected: 'Exactly one descriptive <h1>',
        actual: 'None found',
        url: target,
        component: 'document',
      });
    } else if (h1s.length > 1) {
      push({
        category: 'accessibility',
        severity: 'low',
        title: `${h1s.length} <h1> headings on one page`,
        description: 'Multiple top-level headings can confuse outline-based navigation.',
        expected: 'One <h1> per document',
        actual: `${h1s.length} found`,
        url: target,
        component: 'document',
      });
    }

    const emptyLinks = page.links.filter((l) => l.text.length === 0 && !l.href.startsWith('#')).length;
    if (emptyLinks > 0) {
      push({
        category: 'accessibility',
        severity: 'medium',
        title: `${emptyLinks} link(s) with no accessible text`,
        description: 'Links without text give screen-reader users no destination context (WCAG 2.4.4).',
        expected: 'Meaningful link text or aria-label',
        actual: `${emptyLinks} textless link(s)`,
        url: target,
        component: 'links',
      });
    }

    return this.ok({
      status: 'passed',
      findings,
      logs: [`accessibility static lint: ${findings.length} finding(s) (rendered contrast/keyboard deferred to GUI phase)`],
      metrics: { 'a11y.findings': findings.length, 'a11y.images_no_alt': imagesNoAlt.length, 'a11y.unlabeled_controls': unlabeled },
    });
  }
}
