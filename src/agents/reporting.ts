/**
 * WTE — Reporting Agent (Section 53). Renders HTML + JSON + Markdown reports
 * into the execution artifact directory.
 */
import { BaseAgent, type AgentRunContext } from './base.js';
import type { Execution, StepResult } from '../core/types.js';
import { renderHtmlReport, renderMarkdownReport } from '../reporting/html.js';

export class ReportingAgent extends BaseAgent {
  readonly id = 'reporting-agent';
  readonly name = 'Reporting Agent';
  readonly requiredTools = ['filesystem.write'];

  protected async execute(run: AgentRunContext): Promise<StepResult> {
    const exec = run.shared.get('execution') as Execution | undefined;
    if (!exec) return this.ok({ status: 'degraded', logs: ['no execution record shared — cannot render report'] });

    const ctx = this.ctx(run);
    const base = `artifacts/${exec.id}`;
    const paths: string[] = [];

    const write = async (path: string, content: string) => {
      const r = await this.deps.tools.invoke<{ path: string; content: string }, { path: string; bytes: number }>(
        'filesystem.write',
        { path, content },
        ctx,
      );
      if (!r.ok) throw new Error(`report write failed for ${path}: ${r.error}`);
      paths.push(path);
    };

    await write(`${base}/report.html`, renderHtmlReport(exec));
    await write(`${base}/report.json`, JSON.stringify({ execution: exec }, null, 2));
    await write(`${base}/report.md`, renderMarkdownReport(exec));

    exec.reportPaths = paths;
    this.deps.bus.emit('report.generated', run.executionId, { paths });

    return this.ok({
      status: 'passed',
      logs: paths.map((p) => `wrote ${p}`),
      evidence: paths.map((p) => this.evidence('artifact', p, p)),
      metrics: { 'report.files': paths.length },
    });
  }
}
