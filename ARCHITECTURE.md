# WTE Platform — Architecture (Phase 1)

```
                         ┌────────────────────────────────────────────┐
                         │              INTERFACES                    │
                         │  CLI (terminal)   Dashboard (GUI/SSE)      │
                         │  JSON API                                  │
                         └───────────────┬────────────────────────────┘
                                         │
                              ┌──────────▼──────────┐
                              │    ORCHESTRATOR     │  §58/§60 unified loop
                              │  intent → auth →    │  plan → execute → analyze
                              │  score → gate →     │  report → memory
                              └──────┬───────┬──────┘
              ┌──────────────────────┘       └───────────────────────┐
   ┌──────────▼───────────┐                               ┌──────────▼──────────┐
   │   DECISION ENGINE    │  §4                           │  EXECUTION ENGINE   │  §48
   │ mode GUI/TERMINAL/   │  TARGET→TYPE→INTERFACE        │ steps, retries,     │
   │ HYBRID, roles, tools │  →ROLE→TOOL→LANG→EVIDENCE     │ timeouts, cancel,   │
   └──────────────────────┘                               │ healing-in-loop     │
                                                        └──────────┬──────────┘
                                            ┌──────────────────────┼───────────────────┐
                                    ┌───────▼────────┐   ┌─────────▼────────┐  ┌───────▼─────────┐
                                    │ AGENT LAYER    │   │ CONTROLLED TOOLS │  │ INTELLIGENCE    │
                                    │ §58            │   │ §59              │  │ RCA §42         │
                                    │ discovery      │──▶│ terminal.execute │  │ healing §43     │
                                    │ security       │   │ http.probe       │  │ scoring §46     │
                                    │ accessibility  │   │ api.request      │  │ release §47     │
                                    │ seo / perf     │   │ filesystem.r/w   │  │ dedup §45       │
                                    │ api / reporting│   │ (schema, perms,  │  │                 │
                                    └───────┬────────┘   │  timeout, audit) │  └─────────────────┘
                                            │            └─────────┬────────┘
                                    ┌───────▼──────────────────────▼────────┐
                                    │        MEMORY / KNOWLEDGE §61          │
                                    │ app models, runs, baselines, findings  │
                                    │ index, healing history (secret-proof)  │
                                    └───────────────────────────────────────┘
                          Cross-cutting: EventBus + AuditLog + EXEC-ID correlation §51/§62
```

## Design principles

1. **Authorization precedes everything.** The orchestrator validates scope before any planning (§60).
   Tools independently re-check scope — defense in depth, so a compromised/buggy agent still cannot
   leave the authorized envelope. Denials are audited with the execution ID.
2. **Agents never touch the world directly.** All effect goes through registered tools carrying
   schema, permissions, timeouts and audit hooks (§59). New capabilities = new tools, not new shortcuts.
3. **Honest degradation over fake capability.** Mode selection records *why* a mode was chosen.
   When a GUI runtime is unavailable, scans degrade to TERMINAL and the degradation note travels
   into the report — never silently pretending browser coverage exists.
4. **Determinism in decision paths.** Release readiness and scoring are pure functions (§46/§47).
   Heuristics (RCA, healing) carry explicit confidence and must say `unknown` when evidence is thin.
5. **One correlation ID everywhere.** `EXEC-YYYY-NNNNNN` links steps, tool calls, audit records,
   findings, reports, dashboard events and memory entries (§51).

## Data flow for one scan

```
POST /api/scans (target + allowlist)
  1. ScopeGuard.assertUrlAllowed              → 403 before planning if out of scope
  2. planExecution → mode, roles, agents      → logged as plan rules (auditable)
  3. engine.execute (sequential, §48)         → agents share the discovery model
     each step: state machine QUEUED→RUNNING→(HEALING)→COMPLETED/FAILED/TIMEOUT
  4. dedupe findings + recurrence vs memory
  5. computeQualityScore (§46)                → per-domain, evidence-only
  6. decideRelease (§47)                      → gate list + reasons
  7. ReportingAgent → artifacts/<EXEC>/report.{html,json,md}
  8. MemoryStore.persist                      → models, run, indexes, baselines
  9. engine.settle → terminal state emission  → dashboard via SSE
```

## Tool contract (§59)

```ts
interface Tool<I, O> {
  id: string;                 // e.g. "terminal.execute"
  version: string;
  permissions: string[];      // e.g. ["network:outbound"]
  timeoutMs: number;
  validate(input: I): string[];
  run(input: I, ctx: ToolContext): Promise<ToolResult<O>>;
}
```
`ToolContext` carries execution/step/agent/worker identity, the authorization scope and the
audit sink. Every call is audited (input secret-redacted), timed, and emitted on the bus.

## Phase roadmap

| Phase | Scope |
|---|---|
| **1 — Foundation (this)** | Core loop, static/passive web & API testing, scoring, gates, dashboard, CLI, reports, memory, healing v1, auth/audit, self-test suite (67 tests) |
| 2 — GUI | Playwright browser runtime: real-DOM discovery, screenshots/video/trace, interaction workflows, forms, keyboard a11y, rendered contrast, visual regression, mobile emulation |
| 3 — Intelligence | Python evaluation worker (LLM/RAG/agent evaluation), smarter RCA, test generation from discovery models, flaky-test analytics |
| 4 — Scale | Java load workers, distributed queue, sharding, scheduling, database/API contract testing, cloud & CI/CD integrations |
| 5 — Enterprise | RBAC/multi-tenancy, plugin marketplace, compliance packs, DR testing, monitoring agents |

## Security posture of the platform itself (§63)

- No external runtime dependencies (supply-chain surface: zero).
- Terminal tool: destructive-pattern denylist, workspace-confined cwd, captured streams, exit codes, auditing.
- Filesystem tools: sandboxed to repo root; credential paths read-denied.
- Memory store refuses to persist secret-shaped keys.
- Audit log is append-only JSONL with secret redaction.
- API: JSON bodies size-capped; artifact route traversal-blocked; `nosniff` + `no-store` headers.
- Outbound HTTP user-agent openly identifies WTE and its authorized-testing-only posture.
