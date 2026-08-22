/**
 * WTE — Execution identity (Section 51).
 * EXEC-YYYY-NNNNNN — one ID correlates GUI, terminal, API, logs and reports.
 */
export class ExecutionIdSeq {
  private counter: number;
  constructor(startAt = 0) {
    this.counter = startAt;
  }
  next(now = new Date()): string {
    this.counter += 1;
    return `EXEC-${now.getFullYear()}-${this.counter.toString().padStart(6, '0')}`;
  }
  /** The ID that next() will produce, without consuming it. */
  peek(now = new Date()): string {
    return `EXEC-${now.getFullYear()}-${(this.counter + 1).toString().padStart(6, '0')}`;
  }
}

/** Restore the sequence from prior executions so IDs never collide across restarts. */
export function resumeSequenceFromIds(ids: string[]): ExecutionIdSeq {
  let max = 0;
  for (const id of ids) {
    const m = /^EXEC-\d{4}-(\d{6})$/.exec(id);
    if (m && m[1]) max = Math.max(max, parseInt(m[1], 10));
  }
  return new ExecutionIdSeq(max);
}
