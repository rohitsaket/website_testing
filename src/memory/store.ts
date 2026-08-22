/**
 * WTE — Memory / knowledge store (Section 61, 38).
 * Durable JSON-backed store of application models, executions, findings,
 * baselines and healing history. Secrets are rejected on write (spec §61).
 */
import { readFile, writeFile, mkdir, rename } from 'node:fs/promises';
import { dirname } from 'node:path';
import type { ApplicationModel, Execution, Finding, HealingEvent } from '../core/types.js';

export interface MemoryData {
  version: number;
  applications: Record<string, ApplicationModel>; // key: url origin
  executions: Record<string, Execution>;
  findingsIndex: Record<string, { fingerprint: string; execIds: string[]; lastSeen: string }>;
  baselines: Record<string, Record<string, number>>; // key: url → metric→value
  healingHistory: HealingEvent[];
  sequences: { executionCounter: number };
}

const EMPTY: MemoryData = {
  version: 1,
  applications: {},
  executions: {},
  findingsIndex: {},
  baselines: {},
  healingHistory: [],
  sequences: { executionCounter: 0 },
};

const SECRET_KEY_PATTERN = /(password|secret|api[_-]?key|private[_-]?key|access[_-]?token)/i;

export class MemoryStore {
  private data: MemoryData = structuredClone(EMPTY);
  private dirty = false;

  constructor(private readonly filePath: string) {}

  async load(): Promise<void> {
    try {
      const raw = await readFile(this.filePath, 'utf8');
      const parsed = JSON.parse(raw) as MemoryData;
      if (parsed && typeof parsed === 'object' && parsed.version === 1) {
        this.data = { ...structuredClone(EMPTY), ...parsed };
      }
    } catch {
      /* first run — start empty */
    }
  }

  /** Atomic-ish persist: write to temp file then rename. */
  async persist(): Promise<void> {
    if (!this.dirty) return;
    const serialized = JSON.stringify(this.data, null, 2);
    if (SECRET_KEY_PATTERN.test(serialized)) {
      // Keys, not values: refuse to persist anything that looks like a stored credential.
      if (/"[^"]*(password|secret|api[_-]?key|private[_-]?key|access[_-]?token)[^"]*"\s*:/i.test(serialized)) {
        throw new Error('memory store refused: object keys look like secrets (spec §61: do not store secrets as ordinary memory)');
      }
    }
    await mkdir(dirname(this.filePath), { recursive: true });
    const tmp = this.filePath + '.tmp';
    await writeFile(tmp, serialized, 'utf8');
    await rename(tmp, this.filePath);
    this.dirty = false;
  }

  saveApplication(url: string, model: ApplicationModel): void {
    this.data.applications[url] = model;
    this.dirty = true;
  }

  getApplication(url: string): ApplicationModel | undefined {
    return this.data.applications[url];
  }

  saveExecution(exec: Execution): void {
    this.data.executions[exec.id] = exec;
    const seq = /^EXEC-\d{4}-(\d{6})$/.exec(exec.id);
    if (seq?.[1]) this.data.sequences.executionCounter = Math.max(this.data.sequences.executionCounter, parseInt(seq[1], 10));
    this.dirty = true;
  }

  getExecution(id: string): Execution | undefined {
    return this.data.executions[id];
  }

  listExecutions(limit = 50): Execution[] {
    return Object.values(this.data.executions).sort((a, b) => (b.createdAt < a.createdAt ? -1 : 1)).slice(0, limit);
  }

  indexFindings(execId: string, findings: Finding[]): void {
    for (const f of findings) {
      const slot = (this.data.findingsIndex[f.fingerprint] ??= { fingerprint: f.fingerprint, execIds: [], lastSeen: f.lastDetected });
      if (!slot.execIds.includes(execId)) slot.execIds.push(execId);
      slot.lastSeen = f.lastDetected > slot.lastSeen ? f.lastDetected : slot.lastSeen;
    }
    this.dirty = true;
  }

  /** Fingerprints seen in earlier executions — used for regression/recurrence detection. */
  knownFingerprints(): Map<string, string[]> {
    const m = new Map<string, string[]>();
    for (const [fp, slot] of Object.entries(this.data.findingsIndex)) m.set(fp, slot.execIds);
    return m;
  }

  saveBaseline(url: string, metrics: Record<string, number>): void {
    this.data.baselines[url] = { ...(this.data.baselines[url] ?? {}), ...metrics };
    this.dirty = true;
  }

  getBaseline(url: string): Record<string, number> | undefined {
    return this.data.baselines[url];
  }

  recordHealing(event: HealingEvent): void {
    this.data.healingHistory.push(event);
    this.dirty = true;
  }

  healingHistory(): HealingEvent[] {
    return [...this.data.healingHistory];
  }

  executionCounter(): number {
    return this.data.sequences.executionCounter;
  }
}
