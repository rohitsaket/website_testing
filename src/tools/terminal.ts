/**
 * WTE — terminal.execute tool (Sections 3B, 49, 59).
 * Safety model: destructive-pattern denylist (always enforced), sandboxed cwd,
 * captured stdout/stderr/exit code/duration, full audit. Spec §49 checklist:
 *  understand → state-change? → permissions → verify target → capture → record.
 */
import { exec } from 'node:child_process';
import { BaseTool, type ToolContext } from './tool.js';

export interface TerminalInput {
  command: string;
  cwd?: string; // relative to repo root
  timeoutMs?: number;
  mutating?: boolean; // caller-declared: does this change state?
}

export interface TerminalOutput {
  command: string;
  stdout: string;
  stderr: string;
  exitCode: number | null;
  signal: string | null;
  durationMs: number;
  cwd: string;
  killed: boolean;
}

/** Patterns blocked unconditionally — no authorization level permits these (§49.5). */
const DENIED_PATTERNS: { re: RegExp; why: string }[] = [
  { re: /\brm\s+(-[a-zA-Z]*[rf][a-zA-Z]*\s+)*\s*\/(\s|$|\*)/, why: 'recursive/forced delete from filesystem root' },
  { re: /\brm\s+-[a-zA-Z]*[rf][a-zA-Z]*\s+~/, why: 'recursive/forced delete of home directory' },
  { re: /\bmkfs\b/, why: 'filesystem formatting' },
  { re: /\bdd\b.*\bof=\/dev\//, why: 'raw disk write' },
  { re: /:\(\)\s*\{\s*:\|:&\s*\}\s*;:/, why: 'fork bomb' },
  { re: /\b(shutdown|reboot|halt|poweroff)\b/, why: 'system power state change' },
  { re: /\bkill(all)?\s+-9\s+-1\b/, why: 'kill all processes' },
  { re: /\bchmod\s+-R\s+777\s+\/(\s|$)/, why: 'world-writable permission change on root' },
  { re: /(curl|wget)[^|]*\|\s*(sudo\s+)?(ba)?sh\b/, why: 'pipe remote script into shell (unchecked remote code execution)' },
  { re: /\bgit\s+push\b.*--force/, why: 'force push (history destruction)' },
];

export function checkCommandSafety(command: string): { safe: boolean; reason?: string } {
  const c = command.trim();
  if (c.length === 0) return { safe: false, reason: 'empty command' };
  if (c.length > 4000) return { safe: false, reason: 'command too long (>4000 chars)' };
  for (const { re, why } of DENIED_PATTERNS) {
    if (re.test(c)) return { safe: false, reason: `blocked destructive pattern: ${why}` };
  }
  return { safe: true };
}

export class TerminalExecuteTool extends BaseTool<TerminalInput, TerminalOutput> {
  readonly id = 'terminal.execute';
  readonly version = '1.0.0';
  readonly description = 'Executes a shell command inside the sandboxed workspace root, capturing stdout/stderr/exit code with full audit.';
  readonly permissions = ['shell'];
  readonly timeoutMs = 30_000;

  constructor(private readonly repoRoot: string) {
    super();
  }

  validate(input: TerminalInput): string[] {
    const errors: string[] = [];
    if (!input || typeof input.command !== 'string') errors.push('command is required');
    if (input.timeoutMs !== undefined && (input.timeoutMs < 100 || input.timeoutMs > 120_000)) {
      errors.push('timeoutMs must be 100..120000');
    }
    return errors;
  }

  protected async execute(input: TerminalInput, ctx: ToolContext): Promise<TerminalOutput> {
    const safety = checkCommandSafety(input.command);
    if (!safety.safe) {
      ctx.bus.emit('authorization.denied', ctx.executionId, { toolId: this.id, reason: safety.reason });
      ctx.audit.record({
        at: new Date().toISOString(),
        executionId: ctx.executionId,
        workerId: ctx.workerId,
        actor: ctx.agentId,
        action: 'terminal.denied',
        toolId: this.id,
        inputSummary: input.command.slice(0, 300),
        outcome: 'denied',
        detail: safety.reason,
      });
      throw new Error(`terminal.execute denied: ${safety.reason}`);
    }
    if (input.mutating) {
      ctx.scope.assertActiveAllowed(`mutating terminal command: ${input.command.slice(0, 120)}`);
    }

    const cwd = input.cwd ? `${this.repoRoot}/${input.cwd}` : this.repoRoot;
    if (!cwd.startsWith(this.repoRoot)) throw new Error('cwd escapes the workspace root — denied');

    const started = Date.now();
    return await new Promise<TerminalOutput>((resolve) => {
      exec(
        input.command,
        {
          cwd,
          env: { ...process.env, WTE_EXECUTION_ID: ctx.executionId },
          timeout: input.timeoutMs ?? this.timeoutMs,
          maxBuffer: 4 * 1024 * 1024,
        },
        (error, stdout, stderr) => {
          // exec passes `error` on non-zero exit / timeout; the captured streams are still valid.
          const errObj = error as (Error & { code?: number | string; signal?: string; killed?: boolean }) | null;
          resolve({
            command: input.command,
            stdout: String(stdout).slice(0, 200_000),
            stderr: String(stderr).slice(0, 100_000),
            exitCode: typeof errObj?.code === 'number' ? errObj.code : errObj ? 1 : 0,
            signal: errObj?.signal ?? null,
            durationMs: Date.now() - started,
            cwd,
            killed: errObj?.killed === true || errObj?.signal === 'SIGTERM',
          });
        },
      );
    });
  }
}
