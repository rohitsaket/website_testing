# WTE — Enterprise Autonomous Quality Engineering Platform

WTE is an autonomous testing platform: give it a high-level objective like *"test this application completely"* and it autonomously decides **what** to test, **which roles** to activate, **which tools** to use, **GUI vs TERMINAL** execution, **what evidence** to collect, **how** to analyze failures, **whether** healing applies, **how severe** each finding is, and **whether the release is ready** — with full observability and an audit trail.

**Phase status: Phase 1 — Foundation (complete).** See [ARCHITECTURE.md](./ARCHITECTURE.md) for design and the phased roadmap.

## Quick start

```bash
npm install
npm run build
npm test            # 67 tests, full self-validation of the platform

# Run the autonomous scan loop against the bundled demo app (a deliberately flawed site):
node examples/demo-app/server.mjs 9090 &
node dist/src/cli.js scan http://localhost:9090 --allow localhost,127.0.0.1 --endpoints /api/health,/api/broken
# → findings, RCA, quality score, release decision, HTML/JSON/MD reports in artifacts/<EXEC-ID>/

# Or run the dashboard + API server:
node dist/src/cli.js serve --port 8080
# → open http://localhost:8080 for the real-time dashboard
```

## Authorization model — read this first

WTE **never** tests a target without an explicit scope declaration:

- Every scan requires an **allowlist of hosts** you are authorized to test (`--allow` / API `allow`).
- Passive testing (GET/HEAD probes) is the default. Active testing (state-changing requests, mutating terminal commands) requires `allowActive`.
- Destructive terminal patterns are blocked unconditionally — there is no authorization level that permits `rm -rf /`, fork bombs, `| sh` remote-script execution, force pushes, etc.
- Denied operations are recorded in the audit trail with the execution ID.

## What Phase 1 includes

| Capability | Status | Where |
|---|---|---|
| Orchestrator + AI decision loop (§60) | ✅ | `src/orchestrator/` |
| Execution mode decision engine GUI/TERMINAL/HYBRID (§4) | ✅ with honest GUI-unavailable degradation | `src/core/decision-engine.ts` |
| Minimum role selection from role catalog (§71) | ✅ 12-role Phase 1 catalog | `src/core/roles.ts` |
| Controlled tool registry with per-tool schema/permissions/timeout/audit (§59) | ✅ `terminal.execute`, `http.probe`, `api.request`, `filesystem.read/write` | `src/tools/` |
| Execution engine: retries, timeouts, cancellation, parallel, healing-in-loop, EXEC-YYYY-NNNNNN IDs (§48/51/52) | ✅ | `src/execution/` |
| Agents: discovery, security (passive), accessibility (static WCAG), SEO, performance sampling, API, reporting (§58) | ✅ | `src/agents/` |
| Self-healing for automation reliability only: timeout escalation, retry widening — explainable, scored, logged, reversible (§43) | ✅ | `src/healing/` |
| Root-cause analysis with confidence + "unknown when evidence insufficient" (§42) | ✅ | `src/analysis/rca.ts` |
| Findings with dedup by fingerprint + recurrence across runs (§45) | ✅ | `src/findings/`, `src/memory/` |
| Evidence-driven quality scoring (§46) | ✅ | `src/scoring/quality.ts` |
| Deterministic release gates READY / CONDITIONALLY_READY / NOT_READY (§47) | ✅ | `src/scoring/release.ts` |
| Reports HTML + JSON + Markdown (§53) | ✅ | `src/reporting/`, `src/agents/reporting.ts` |
| Dashboard with SSE real-time execution feed (§52/54) | ✅ zero-dependency | `src/server/` |
| Memory: application model, runs, baselines, healing history, secret-write refusal (§61) | ✅ | `src/memory/` |
| CLI | ✅ `scan` / `serve` / `tools` / `executions` | `src/cli.ts` |
| Observability: structured events + append-only JSONL audit with secret redaction (§62/63) | ✅ | `src/core/observability.ts` |

## What Phase 1 deliberately does NOT do (honest scope)

- **No real browser yet.** GUI mode is an explicit code path; without a browser runtime, web scans degrade to HTTP/DOM-static analysis and the scan output says so. Playwright-powered GUI agents (screenshots, video, keyboard a11y, real contrast, interaction workflows, visual regression) are Phase 2.
- **No active security testing.** The security agent is passive (headers/cookies/transport/disclosure). No exploitation, ever, in the default path.
- **Python/Java workers** are designed-for but not yet built (Phase 3+): Java for load testing, Python for AI/LLM evaluation.
- **No database/cloud/CI integrations** yet (later phases). CI workflow for the platform itself is included.

## CLI reference

```
node dist/src/cli.js scan <url> --allow host[,host] [--endpoints /a,/b] [--perf n]
    Runs the full loop: auth check → plan → execute → findings/RCA → score →
    release decision → reports → memory. Exit code 1 when NOT_READY (CI-friendly gate).
node dist/src/cli.js serve [--port 8080]   Dashboard + JSON API + SSE event stream
node dist/src/cli.js tools                 Manifest of the controlled tool surface
node dist/src/cli.js executions            Executions stored in memory
```

## API (selected)

```
GET  /api/health               liveness + worker id
GET  /api/tools                tool manifest
GET  /api/executions           execution list (summary)
GET  /api/executions/:id       full execution record with findings/score/gates
GET  /api/quality              latest score + release decision
POST /api/scans                { "target": "https://...", "allow": ["host"], "endpoints": [...] }
GET  /api/events               SSE real-time execution stream
GET  /artifacts/:exec/report.html
```

## Development

```bash
npm run build        # strict TypeScript
npm test             # unit + integration (fixture app, full loop, API server)
npm run typecheck
```
