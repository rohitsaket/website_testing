/**
 * WTE — Command-line interface (TERMINAL mode entry point, Section 3B).
 *   wte scan <url> --allow host[,host] [--endpoints /a,/b] [--perf 5]
 *   wte serve [--port 8080]
 *   wte tools
 *   wte executions
 */
import { Orchestrator } from './orchestrator/orchestrator.js';
import { startWteServer } from './server/server.js';

const repoRoot = process.cwd();

function parseFlags(args: string[]): Record<string, string> {
  const flags: Record<string, string> = {};
  for (let i = 0; i < args.length; i++) {
    const a = args[i]!;
    if (a.startsWith('--')) {
      const key = a.slice(2);
      const next = args[i + 1];
      if (next !== undefined && !next.startsWith('--')) {
        flags[key] = next;
        i++;
      } else {
        flags[key] = 'true';
      }
    }
  }
  return flags;
}

const DEFAULT_LOCAL_HOSTS = ['localhost', '127.0.0.1', '[::1]'];

async function cmdScan(args: string[]): Promise<number> {
  const target = args.find((a) => !a.startsWith('--'));
  const flags = parseFlags(args);
  if (!target) {
    console.error('usage: wte scan <url> --allow host[,host...] [--endpoints /a,/b] [--perf 5]');
    return 2;
  }
  const allowed = (flags['allow'] ?? '')
    .split(',')
    .map((s) => s.trim())
    .filter(Boolean);
  if (allowed.length === 0) {
    console.error(
      'error: no authorized hosts declared. WTE never tests a target without an explicit authorization scope (spec §64).\n' +
        'Pass --allow host[,host...] to declare the scope you are authorized to test.',
    );
    return 2;
  }
  const orchestrator = new Orchestrator({ repoRoot });
  const endpoints = (flags['endpoints'] ?? '').split(',').map((s) => s.trim()).filter(Boolean);
  const perfSamples = flags['perf'] ? parseInt(flags['perf'], 10) : undefined;

  console.log(`WTE scan → ${target}`);
  console.log(`authorization scope: [${allowed.join(', ')}] passive-only`);
  try {
    const result = await orchestrator.scan({
      kind: 'url-scan',
      target,
      authorization: {
        allowedHosts: allowed,
        allowPassive: true,
        allowActive: false,
        statement: 'Authorized via CLI flags by the invoking operator',
      },
      options: { endpoints, perfSamples },
    });
    const e = result.execution;
    console.log('');
    console.log(`execution:  ${e.id} [${e.state}] mode=${e.mode}`);
    if (result.degraded) for (const n of result.degradationNotes) console.log(`note:       ${n}`);
    for (const step of e.steps) {
      const heal = step.healingEvents.length > 0 ? ` (+${step.healingEvents.length} healing)` : '';
      console.log(`  ${step.state.padEnd(9)} ${step.name}${heal} (${step.result?.durationMs ?? 0}ms)`);
    }
    console.log('');
    console.log(`findings:   ${e.findings.length}`);
    for (const f of e.findings) {
      console.log(`  [${f.severity.toUpperCase().padEnd(8)} / ${f.category.padEnd(13)}] ${f.title}`);
    }
    console.log('');
    console.log(`score:      overall=${e.score?.overall} coverage=${e.score?.coverage}%`);
    console.log(`readiness:  ${e.release?.readiness}`);
    for (const r of e.release?.reasons ?? []) console.log(`            - ${r}`);
    for (const p of e.reportPaths) console.log(`report:     ${p}`);
    return e.release?.readiness === 'NOT_READY' ? 1 : 0;
  } catch (err) {
    console.error(`scan failed: ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
}

function cmdServe(args: string[]): void {
  const flags = parseFlags(args);
  const port = flags['port'] ? parseInt(flags['port'], 10) : 8080;
  const orchestrator = new Orchestrator({ repoRoot });
  const server = startWteServer({ port, orchestrator, defaultAllowedHosts: DEFAULT_LOCAL_HOSTS });
  server.on('listening', () => {
    console.log(`WTE platform server listening on http://0.0.0.0:${port}`);
    console.log(`dashboard: http://localhost:${port}/`);
  });
}

async function cmdTools(): Promise<number> {
  const orchestrator = new Orchestrator({ repoRoot });
  for (const t of orchestrator.tools.manifest()) {
    console.log(`${t.id.padEnd(18)} v${t.version.padEnd(8)} perms=[${t.permissions.join(',')}] timeout=${t.timeoutMs}ms — ${t.description}`);
  }
  return 0;
}

async function cmdExecutions(): Promise<number> {
  const orchestrator = new Orchestrator({ repoRoot });
  await orchestrator.init();
  for (const e of orchestrator.listExecutions()) {
    console.log(`${e.id} [${e.state}] ${e.objective.target} score=${e.score?.overall ?? 'n/a'} readiness=${e.release?.readiness ?? 'n/a'} findings=${e.findings.length}`);
  }
  return 0;
}

async function main(): Promise<number> {
  const [cmd, ...rest] = process.argv.slice(2);
  switch (cmd) {
    case 'scan':
      return await cmdScan(rest);
    case 'serve':
      cmdServe(rest);
      return 0;
    case 'tools':
      return await cmdTools();
    case 'executions':
      return await cmdExecutions();
    default:
      console.log(`WTE Platform CLI (Phase 1 Foundation)
commands:
  scan <url> --allow host[,host] [--endpoints /a,/b] [--perf n]   run the full autonomous scan loop
  serve [--port 8080]                                             start dashboard + API server
  tools                                                           list the controlled tool surface
  executions                                                      list stored executions`);
      return cmd ? 2 : 0;
  }
}

main().then(
  (code) => {
    if (code !== 0) process.exitCode = code;
    if (process.argv[2] === 'serve') return; // server keeps event loop alive
  },
  (err) => {
    console.error(err);
    process.exitCode = 1;
  },
);
