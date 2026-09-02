# website_testing

A terminal-based HTTP load and stress tester, built to answer one question
honestly: **how much traffic can this server take before it breaks?**

```
loadtest ▸ http://127.0.0.1:8000/  GET
workers 20 · target rate 150/s · timeout 10s · keep-alive on
    4.1s / 30.0s   █████░░░░░░░░░░░░░░░░░░░░░░░░  14%
 reqs 612      ok 600      err 12    (1.96%)  in-flight 1
 rps    148.6 actual / 150.0 target  read 313.1 KB (76.0 KB/s)
 latency (ms)
   avg     40.4   p50     33.7   p90     73.3
   p95     78.7   p99     81.6   max     85.7
 status  200:600  500:12
 running · ctrl-c to stop
```

---

## Read this before you run it

This tool sends sustained, concurrent HTTP traffic. Pointed at a system you do
not own, that traffic **is** a denial-of-service attack — not a "test". It is
illegal in most of the world (US: Computer Fraud and Abuse Act; UK: Computer
Misuse Act 1990 s.3; India: IT Act s.66F; similar elsewhere), it can take down
services other people depend on, and it is trivially traceable back to you.

So:

- **Only test infrastructure you own, or have written permission to test.**
- Never aim it at a third party, "just to see", even for a few seconds.
- Tell whoever runs the network / hosting / CDN before a big run.
- Prefer staging. Staging should be sized and shaped like production.

There is no `--please-let-me-attack-someone` flag, and I'm not going to add
one. If you want to take a site offline, this is not the tool and I am not the
person to help. What follows is the legitimate version: measuring **your own**
capacity so you can fix it before your users find the ceiling for you.

## Install

```bash
git clone https://github.com/rohitsaket/website_testing.git
cd website_testing
pip install -e .          # gives you the `loadtest` command
# or just run it in place, no install:
python3 -m loadtest --help
```

Zero dependencies. Python 3.9+. Standard library only.

## Quickstart

There's a deliberately imperfect demo server included so you can practise
without touching anything real:

```bash
# terminal 1 - a target that takes 15-40ms and fails 2% of requests
python3 examples/demo_server.py --port 8000 --latency 15 --jitter 25 --error-rate 0.02

# terminal 2
python3 -m loadtest http://127.0.0.1:8000/          # 10 workers, 30s, full tilt
python3 -m loadtest http://127.0.0.1:8000/ -c 50 -t 60
python3 -m loadtest http://127.0.0.1:8000/ -c 20 -r 200 -t 30 --ramp-up 10
```

Against anything that isn't loopback you must pass `--authorize` (and confirm
the hostname, or pass `--yes` for scripts):

```bash
loadtest https://staging.example.com/api -c 40 -r 500 -t 60 --authorize
```

## What it measures

| Metric | Why you care |
| --- | --- |
| **rps (actual)** | Throughput the target really delivered, vs. what you offered. When actual < offered, you found the ceiling. |
| **p50 / p90 / p95 / p99** | Latency percentiles, not averages. p99 is where users start leaving. |
| **latency distribution** | A histogram. Bimodal? You have two code paths and one is slow. |
| **status codes** | 5xx means the server is failing; 429/503 means it is deliberately shedding load. |
| **errors** | Classified: `timeout`, `reset`, `refused`, `tls`, `dns`, `closed`. Timeouts at high concurrency = saturation. |
| **verdict** | `HEALTHY` / `SLOW` / `DEGRADED` / `OVERLOADED`, based on error rate and p95. |

Latency is sampled through a bounded reservoir (50k samples), so a 15-minute
run gives the same statistical quality as a 10-second one without eating RAM.

## Finding the breaking point

The useful workflow is a staircase, not one big number:

```bash
for c in 10 25 50 100 200; do
  loadtest https://staging.example.com/ -c $c -t 60 --authorize --yes \
    --json "run-c$c.json" -q
done
```

Then compare the JSON runs. The concurrency where **actual rps stops rising
while p95 keeps climbing** is your real capacity. Everything past that is
queueing, not throughput. Fix the bottleneck you find there, then re-run.

Useful knobs while hunting:

- `--ramp-up 15` — ease in from 10% to 100% rate, so you see the curve instead
  of slamming into a cold cache and a sleeping autoscaler.
- `-r 200` — cap the offered rate. Without it, N workers go as fast as they
  can, which tests *your* machine's ability to open sockets as much as the
  target's ability to serve.
- `--no-keep-alive` — new connection per request. Much harder on the target;
  closer to what a real traffic spike with cold clients looks like.
- `--timeout 2` — shorter timeouts surface saturation faster and stop a slow
  run from dragging on.

## Options

```
loadtest URL [options]

  -X, --method METHOD     HTTP method (default GET)
  -H, --header "K: V"     extra header, repeatable
  -D, --data BODY         request body; @file.txt reads it from a file
  -c, --concurrency N     concurrent workers (default 10, max 1000)
  -r, --rate N            target req/s across all workers; 0 = unlimited (default 0, max 5000)
  -t, --duration SECONDS  how long to run (default 30, max 900)
  -n, --requests N        stop after N requests as well
      --ramp-up SECONDS   ramp offered rate from 10% to 100%
      --timeout SECONDS   per-request timeout (default 10)
      --no-keep-alive     new connection per request
  -k, --insecure          skip TLS verification (staging only)
      --authorize         confirm you may test a non-loopback target
      --yes               skip the interactive hostname confirmation
      --json FILE         write full results (incl. raw latency samples)
      --csv FILE          write summary metrics
      --dry-run           print the plan, send nothing
  -q, --quiet             no live dashboard
      --no-color          plain text output
  -v, --verbose-errors    print every error inline
```

### Exit codes

| Code | Meaning |
| --- | --- |
| `0` | run completed, error rate ≤ 10% |
| `2` | refused by a safety check, **or** error rate > 10% (CI gate) |
| `130` | aborted with ctrl-c |

That makes it usable as a CI performance gate:

```bash
loadtest https://staging.example.com/ -c 50 -t 30 --authorize --yes -q || echo "perf gate failed"
```

## Built-in limits

Deliberately conservative, because this tool is one bad argument away from
being someone else's outage:

- concurrency ≤ 1000, rate ≤ 5000 req/s, duration ≤ 900s
- http/https only, one target per run
- no credentials in the URL (pass an `Authorization` header with `-H`)
- non-loopback targets require `--authorize` plus confirmation

Need more than that? You want a distributed load generator (k6, Locust,
vegeta, Grafana Cloud k6) with several machines behind it. A single box at
1000 concurrent requests is a measurement of your network card as much as of
their server.

## Layout

```
loadtest/
  cli.py       argument parsing, safety gate, run orchestration
  engine.py    worker threads, token-bucket rate limiter, HTTP execution
  stats.py     lock-protected counters + reservoir-sampled latencies
  safety.py    target validation, consent checks, hard ceilings
  ui.py        live dashboard, final report, JSON/CSV export
examples/
  demo_server.py   a slow, occasionally-broken server to practise on
tests/            unit + end-to-end tests against a throwaway local server
```

## Tests

```bash
python3 -m unittest discover -s tests -v
```

66 tests: reservoir sampling and percentiles, rate-limiter pacing, error
classification, safety rules and consent prompts, report/export formatting,
and end-to-end runs (status counting, request caps, rate limiting, ramp-up,
timeouts, stop) against a local server started on an ephemeral port.

## Roadmap

Ideas, if they're useful to you:

- multiple URLs / weighted traffic mix
- HTTP/2
- percentile time series + HTML report
- `--max-latency` gate: stop the run when p99 crosses a line
- think-time distributions instead of a flat rate

## Licence

MIT. Use it responsibly — see the top of this file.
