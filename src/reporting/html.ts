/**
 * WTE — HTML report renderer (Section 53). Self-contained single-file report,
 * no external assets, works offline and in restricted networks.
 */
import type { Execution, Finding, QualityScore, ReleaseDecision, Severity } from '../core/types.js';
import { summarize } from '../findings/findings.js';

function esc(s: string | undefined | null): string {
  return String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

const SEV_ORDER: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

function severityBadge(sev: Severity): string {
  return `<span class="badge sev-${sev}">${sev.toUpperCase()}</span>`;
}

function findingRow(f: Finding): string {
  return `<tr>
    <td>${severityBadge(f.severity)}</td>
    <td>${esc(f.category)}</td>
    <td><strong>${esc(f.title)}</strong><br/><span class="muted">${esc(f.description)}</span>
        ${f.rootCause ? `<br/><span class="rca">ROOT CAUSE (${esc(f.rootCause.classification)}, confidence ${Math.round(f.rootCause.confidence * 100)}%): ${esc(f.rootCause.summary)} → ${esc(f.rootCause.recommendedAction)}</span>` : ''}
    </td>
    <td class="muted">${esc(f.url ?? '')}<br/>expected: ${esc(f.expected)}<br/>actual: ${esc(f.actual)}</td>
    <td>${Math.round(f.confidence * 100)}%</td>
    <td>${esc(f.status)}</td>
  </tr>`;
}

function scoreCell(v: number | null): string {
  if (v === null) return '<td class="score na">n/a</td>';
  const cls = v >= 85 ? 'good' : v >= 70 ? 'warn' : 'bad';
  return `<td class="score ${cls}">${v}</td>`;
}

function scoreRow(score: QualityScore | undefined): string {
  if (!score) return '<tr><td colspan="11">score not computed</td></tr>';
  const domains: [string, number | null][] = [
    ['Overall', score.overall],
    ['Functional', score.functional],
    ['UI', score.ui],
    ['API', score.api],
    ['Performance', score.performance],
    ['Accessibility', score.accessibility],
    ['SEO', score.seo],
    ['Security', score.security],
    ['Reliability', score.reliability],
  ];
  return (
    '<tr>' + domains.map(([label, v]) => `${scoreCell(v)}`).join('') + `<td class="score">${score.coverage}%</td></tr>` +
    '<tr class="labels">' + domains.map(([l]) => `<td>${l}</td>`).join('') + '<td>Coverage</td></tr>'
  );
}

function readinessBlock(release: ReleaseDecision | undefined): string {
  if (!release) return '<p>Release decision not computed.</p>';
  const cls = release.readiness === 'READY' ? 'good' : release.readiness === 'CONDITIONALLY_READY' ? 'warn' : 'bad';
  const gates = release.gates
    .map((g) => `<li class="${g.passed ? 'good' : 'bad'}">${g.passed ? '✓' : '✗'} ${esc(g.name)} — ${esc(g.detail)}</li>`)
    .join('');
  return `
    <div class="readiness ${cls}">${release.readiness.replace('_', ' ')}</div>
    <ul>${release.reasons.map((r) => `<li>${esc(r)}</li>`).join('')}</ul>
    <h4>Quality gates</h4>
    <ul class="gates">${gates}</ul>`;
}

function stepRow(exec: Execution): string {
  return exec.steps
    .map((s) => {
      const heal = s.healingEvents
        .map((h) => `<span class="heal">healed: ${esc(h.strategy)} (confidence ${Math.round(h.confidence * 100)}%)</span>`)
        .join(' ');
      const logs = (s.result?.logs ?? []).map((l) => `<code>${esc(l)}</code>`).join('<br/>');
      return `<tr>
        <td>${esc(s.id)}</td><td>${esc(s.name)}</td><td>${esc(s.agentId)}</td>
        <td class="${s.state === 'COMPLETED' ? 'good' : s.state === 'FAILED' || s.state === 'TIMEOUT' ? 'bad' : ''}">${s.state}</td>
        <td>${s.attempts}/${s.maxAttempts} ${heal}</td>
        <td>${s.result?.durationMs ?? 0}ms</td>
        <td>${logs}</td>
      </tr>`;
    })
    .join('');
}

export function renderHtmlReport(exec: Execution): string {
  const counts = summarize(exec.findings.filter((f) => f.status !== 'duplicate'));
  const findingRows = [...exec.findings]
    .sort((a, b) => SEV_ORDER.indexOf(a.severity) - SEV_ORDER.indexOf(b.severity))
    .map(findingRow)
    .join('');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/>
<title>WTE Report — ${esc(exec.id)}</title>
<style>
:root{--bg:#0d1117;--panel:#161b22;--border:#30363d;--fg:#e6edf3;--muted:#8b949e;--good:#3fb950;--warn:#d29922;--bad:#f85149;--accent:#58a6ff}
*{box-sizing:border-box}body{margin:0;background:var(--bg);color:var(--fg);font:14px/1.5 system-ui,-apple-system,Segoe UI,Roboto,sans-serif}
header{padding:28px 36px;border-bottom:1px solid var(--border);background:linear-gradient(135deg,#0d1117,#161b22)}
h1{margin:0;font-size:24px}h1 .accent{color:var(--accent)}h2{padding:0 36px;margin-top:32px;font-size:18px;color:var(--accent)}
.meta{color:var(--muted);margin-top:6px}.pill{display:inline-block;padding:2px 10px;border-radius:12px;border:1px solid var(--border);margin-left:8px;font-size:12px}
section{margin:12px 36px 8px}table{border-collapse:collapse;width:100%;background:var(--panel);border:1px solid var(--border);border-radius:8px;overflow:hidden}
td,th{border:1px solid var(--border);padding:8px 10px;text-align:left;vertical-align:top}th{background:#1c2128;color:var(--muted);text-transform:uppercase;font-size:11px;letter-spacing:.06em}
.badge{padding:2px 8px;border-radius:4px;font-size:11px;font-weight:700;color:#0d1117}
.sev-critical{background:#f85149}.sev-high{background:#f0883e}.sev-medium{background:#d29922}.sev-low{background:#3fb950}.sev-info{background:#58a6ff}
.muted{color:var(--muted);font-size:12px}.rca{color:var(--warn);font-size:12px}
.score{font-size:20px;font-weight:700;text-align:center}
.score.good{color:var(--good)}.score.warn{color:var(--warn)}.score.bad{color:var(--bad)}.score.na{color:var(--muted)}
tr.labels td{text-align:center;color:var(--muted);font-size:11px;border-top:none}
.readiness{font-size:22px;font-weight:800;padding:14px 18px;border-radius:8px;border:1px solid var(--border);display:inline-block}
.readiness.good{color:var(--good);border-color:var(--good)}.readiness.warn{color:var(--warn);border-color:var(--warn)}.readiness.bad{color:var(--bad);border-color:var(--bad)}
.gates li{list-style:none;padding:2px 0}.good{color:var(--good)}.bad{color:var(--bad)}.warn{color:var(--warn)}
code{background:#1c2128;padding:1px 6px;border-radius:4px;font-size:12px}
.heal{color:var(--accent);font-size:12px}
.findings-grid{display:flex;gap:10px;flex-wrap:wrap}
.stat{background:var(--panel);border:1px solid var(--border);border-radius:8px;padding:12px 18px;min-width:110px}
.stat b{display:block;font-size:22px}
footer{padding:24px 36px;color:var(--muted);font-size:12px}
</style></head><body>
<header>
  <h1><span class="accent">WTE</span> Quality Engineering Report</h1>
  <div class="meta">
    Execution <strong>${esc(exec.id)}</strong>
    <span class="pill">mode: ${esc(exec.mode)}</span>
    <span class="pill">state: ${esc(exec.state)}</span>
    <span class="pill">worker: ${esc(exec.workerId)}</span><br/>
    Target: <strong>${esc(exec.objective.target)}</strong> ·
    Roles: ${esc(exec.roles.join(', '))} ·
    Started ${esc(exec.startedAt ?? '')} · Ended ${esc(exec.endedAt ?? '')}
  </div>
</header>

<h2>Quality Score</h2>
<section><table><tbody>${scoreRow(exec.score)}</tbody></table></section>

<h2>Release Readiness</h2>
<section>${readinessBlock(exec.release)}</section>

<h2>Findings (${exec.findings.length})</h2>
<section>
  <div class="findings-grid">
    ${SEV_ORDER.map((s) => `<div class="stat"><b>${counts[s] ?? 0}</b>${s}</div>`).join('')}
  </div>
  <table><thead><tr><th>Severity</th><th>Category</th><th>Finding</th><th>Evidence</th><th>Conf.</th><th>Status</th></tr></thead>
  <tbody>${findingRows || '<tr><td colspan="6">No findings — clean run.</td></tr>'}</tbody></table>
</section>

<h2>Step Execution</h2>
<section><table><thead><tr><th>Step</th><th>Name</th><th>Agent</th><th>State</th><th>Attempts</th><th>Duration</th><th>Logs</th></tr></thead>
<tbody>${stepRow(exec)}</tbody></table></section>

<footer>Generated by WTE Platform v0.1.0 (Phase 1 Foundation) · ${esc(new Date().toISOString())} · Evidence, audit JSONL and machine-readable JSON report accompany this file in the execution artifact directory.</footer>
</body></html>`;
}

export function renderMarkdownReport(exec: Execution): string {
  const lines: string[] = [];
  lines.push(`# WTE Quality Engineering Report — ${exec.id}`);
  lines.push('');
  lines.push(`- **Target**: ${exec.objective.target}`);
  lines.push(`- **Mode**: ${exec.mode} · **State**: ${exec.state}`);
  lines.push(`- **Readiness**: ${exec.release?.readiness ?? 'n/a'}`);
  lines.push(`- **Overall quality**: ${exec.score?.overall ?? 'n/a'} · **Coverage**: ${exec.score?.coverage ?? 0}%`);
  lines.push('');
  lines.push(`## Findings (${exec.findings.length})`);
  for (const f of exec.findings) {
    lines.push(`- **[${f.severity.toUpperCase()} / ${f.category}]** ${f.title} — ${f.url ?? ''} (confidence ${Math.round(f.confidence * 100)}%)`);
  }
  if (exec.findings.length === 0) lines.push('- None.');
  lines.push('');
  lines.push('## Steps');
  for (const s of exec.steps) {
    lines.push(`- ${s.name} [${s.state}] attempts=${s.attempts} duration=${s.result?.durationMs ?? 0}ms`);
  }
  return lines.join('\n') + '\n';
}
