/**
 * WTE — Observability: structured event bus + append-only audit log (Section 62/63).
 * Every tool call, state transition, and decision is recorded with the
 * shared EXECUTION_ID so terminal ↔ GUI ↔ API evidence correlates (Section 51).
 */
import { appendFile, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import type { ExecutionState } from './types.js';

export type WteEventType =
  | 'execution.state'
  | 'step.state'
  | 'tool.call'
  | 'tool.result'
  | 'finding.created'
  | 'healing.applied'
  | 'agent.start'
  | 'agent.end'
  | 'score.computed'
  | 'report.generated'
  | 'authorization.denied'
  | 'log';

export interface WteEvent {
  id: string;
  type: WteEventType;
  executionId: string;
  at: string;
  data: Record<string, unknown>;
}

type Listener = (event: WteEvent) => void;

export class EventBus {
  private listeners: Listener[] = [];
  private seq = 0;
  private recent: WteEvent[] = [];
  private readonly keep = 500;

  emit(type: WteEventType, executionId: string, data: Record<string, unknown>): WteEvent {
    this.seq += 1;
    const event: WteEvent = {
      id: `EVT-${this.seq.toString().padStart(6, '0')}`,
      type,
      executionId,
      at: new Date().toISOString(),
      data,
    };
    this.recent.push(event);
    if (this.recent.length > this.keep) this.recent.splice(0, this.recent.length - this.keep);
    for (const l of this.listeners) {
      try {
        l(event);
      } catch {
        /* listener faults must never break the engine */
      }
    }
    return event;
  }

  on(listener: Listener): () => void {
    this.listeners.push(listener);
    return () => {
      this.listeners = this.listeners.filter((l) => l !== listener);
    };
  }

  /** Recent events for late-joining dashboard clients (SSE backfill). */
  history(executionId?: string): WteEvent[] {
    return executionId ? this.recent.filter((e) => e.executionId === executionId) : [...this.recent];
  }
}

export interface AuditRecord {
  at: string;
  executionId: string;
  workerId: string;
  actor: string;
  action: string;
  toolId?: string;
  target?: string;
  inputSummary?: string;
  outcome: 'ok' | 'error' | 'denied';
  durationMs?: number;
  detail?: string;
}

const SECRET_PATTERN = /(password|passwd|secret|token|api[_-]?key|authorization|bearer)\s*[:=]\s*\S+/gi;

export function redactSecrets(text: string): string {
  return text.replace(SECRET_PATTERN, (m) => m.split(/[:=]/)[0] + '=<REDACTED>');
}

/** Append-only JSONL audit trail; nothing ever mutates prior records. */
export class AuditLog {
  private buffer: AuditRecord[] = [];
  private queue: Promise<void> = Promise.resolve();

  constructor(private readonly filePath: string) {}

  async init(): Promise<void> {
    await mkdir(join(this.filePath, '..'), { recursive: true });
  }

  record(rec: AuditRecord): void {
    const safe: AuditRecord = {
      ...rec,
      inputSummary: rec.inputSummary ? redactSecrets(rec.inputSummary).slice(0, 500) : undefined,
      detail: rec.detail ? redactSecrets(rec.detail).slice(0, 500) : undefined,
    };
    this.buffer.push(safe);
    if (this.buffer.length > 1000) this.buffer.splice(0, this.buffer.length - 1000);
    this.queue = this.queue.then(() => appendFile(this.filePath, JSON.stringify(safe) + '\n', 'utf8')).catch(() => undefined);
  }

  async flush(): Promise<void> {
    await this.queue;
  }

  records(): AuditRecord[] {
    return [...this.buffer];
  }
}

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';

export class Logger {
  constructor(
    private readonly bus: EventBus,
    private readonly scope: string,
  ) {}

  private log(level: LogLevel, executionId: string, message: string, data: Record<string, unknown> = {}): void {
    const line = `[${new Date().toISOString()}] [${level.toUpperCase()}] [${this.scope}] [${executionId}] ${message}`;
    if (level === 'error') console.error(line);
    else console.log(line);
    this.bus.emit('log', executionId, { level, scope: this.scope, message, ...data });
  }

  debug(exec: string, msg: string, data?: Record<string, unknown>): void {
    this.log('debug', exec, msg, data);
  }
  info(exec: string, msg: string, data?: Record<string, unknown>): void {
    this.log('info', exec, msg, data);
  }
  warn(exec: string, msg: string, data?: Record<string, unknown>): void {
    this.log('warn', exec, msg, data);
  }
  error(exec: string, msg: string, data?: Record<string, unknown>): void {
    this.log('error', exec, msg, data);
  }
}

export function describeStateTransition(from: ExecutionState | 'NONE', to: ExecutionState): string {
  return `${from} → ${to}`;
}
