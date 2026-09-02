"""Terminal rendering: live dashboard, final report, CSV/JSON export."""

from __future__ import annotations

import json
import shutil
import time
from typing import TextIO

from .engine import Config, Result
from .stats import Snapshot, histogram

RESET = "\033[0m"
BOLD = "\033[1m"
DIM = "\033[2m"
CYAN = "\033[36m"
GREEN = "\033[32m"
YELLOW = "\033[33m"
RED = "\033[31m"
BLUE = "\033[34m"

BAR_FULL = "█"
BAR_EMPTY = "░"


class Palette:
    """Colour codes, or empty strings when colour is off."""

    def __init__(self, enabled: bool) -> None:
        self.enabled = enabled
        self.reset = RESET if enabled else ""
        self.bold = BOLD if enabled else ""
        self.dim = DIM if enabled else ""
        self.cyan = CYAN if enabled else ""
        self.green = GREEN if enabled else ""
        self.yellow = YELLOW if enabled else ""
        self.red = RED if enabled else ""
        self.blue = BLUE if enabled else ""

    @classmethod
    def for_stream(cls, stream: TextIO, no_color: bool = False) -> "Palette":
        enabled = not no_color and hasattr(stream, "isatty") and stream.isatty()
        return cls(enabled)


def fmt_duration(seconds: float) -> str:
    if seconds < 60:
        return f"{seconds:.1f}s"
    minutes, secs = divmod(int(seconds), 60)
    if minutes < 60:
        return f"{minutes}m{secs:02d}s"
    hours, minutes = divmod(minutes, 60)
    return f"{hours}h{minutes:02d}m"


def fmt_bytes(num: float) -> str:
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(num) < 1024.0 or unit == "TB":
            return f"{num:3.1f} {unit}" if unit != "B" else f"{int(num)} B"
        num /= 1024.0
    return f"{num:.1f} TB"


def fmt_ms(value_ms: float) -> str:
    if value_ms >= 10_000:
        return f"{value_ms / 1000:.1f}s"
    if value_ms >= 100:
        return f"{value_ms:.0f}"
    if value_ms >= 10:
        return f"{value_ms:.1f}"
    return f"{value_ms:.2f}"


def progress_bar(fraction: float, width: int = 28) -> str:
    fraction = min(max(fraction, 0.0), 1.0)
    filled = int(round(fraction * width))
    return BAR_FULL * filled + BAR_EMPTY * (width - filled)


def _term_width(default: int = 80) -> int:
    try:
        return max(40, shutil.get_terminal_size().columns)
    except Exception:
        return default


class Dashboard:
    """Redraws a multi-line status frame in place on a TTY."""

    def __init__(self, stream: TextIO, palette: Palette, quiet: bool = False) -> None:
        self.stream = stream
        self.pal = palette
        self.quiet = quiet
        self._lines = 0
        self._last_plain = 0.0

    def _clear(self) -> None:
        p = self.pal
        if not p.enabled or self._lines == 0:
            return
        # Move up to the frame start, then erase each line we drew.
        self.stream.write(f"\033[{self._lines}A")
        for _ in range(self._lines):
            self.stream.write("\033[2K\033[1B")
        self.stream.write(f"\033[{self._lines}A")
        self.stream.flush()

    def render(self, snap: Snapshot, cfg: Config, label: str = "running") -> None:
        if self.quiet:
            return
        if not self.pal.enabled:
            self._render_plain(snap, cfg)
            return

        self._clear()
        lines = build_frame(snap, cfg, self.pal, _term_width(), label)
        self._lines = len(lines)
        self.stream.write("\n".join(lines) + "\n")
        self.stream.flush()

    def _render_plain(self, snap: Snapshot, cfg: Config) -> None:
        now = time.monotonic()
        if now - self._last_plain < 1.0:
            return
        self._last_plain = now
        self.stream.write(
            f"  t={snap.elapsed:5.1f}s  reqs={snap.completed:<7d} "
            f"rps={snap.rps:8.1f}  err={snap.failed:<5d} "
            f"p50={fmt_ms(snap.percentile_ms(0.50)):>7s}ms "
            f"p95={fmt_ms(snap.percentile_ms(0.95)):>7s}ms\n"
        )
        self.stream.flush()

    def finish(self) -> None:
        if self.pal.enabled and self._lines:
            # Leave the last frame on screen instead of wiping it.
            self._lines = 0
            self.stream.flush()


def build_frame(
    snap: Snapshot, cfg: Config, pal: Palette, width: int, label: str = "running"
) -> list[str]:
    p = pal
    bar_width = max(10, min(30, width - 34))
    frac = snap.elapsed / cfg.duration if cfg.duration else 0.0
    pct = int(min(frac, 1.0) * 100)

    err_frac = snap.error_rate
    err_color = p.green if err_frac == 0 else (p.yellow if err_frac < 0.05 else p.red)
    rate_color = p.green if snap.rps >= snap.target_rps * 0.9 else p.yellow

    head = (
        f"{p.bold}{p.cyan}loadtest{p.reset} ▸ {cfg.target.origin}{cfg.target.path}  "
        f"{p.dim}{cfg.method}{p.reset}"
    )
    rate_txt = "max" if cfg.unlimited_rate else f"{cfg.rps:g}/s"
    sub = (
        f"{p.dim}workers {cfg.concurrency} · target rate {rate_txt} · "
        f"timeout {cfg.timeout:g}s · keep-alive {'on' if cfg.keep_alive else 'off'}{p.reset}"
    )

    bar = (
        f" {fmt_duration(snap.elapsed):>7s} / {fmt_duration(cfg.duration):<7s}"
        f" {p.cyan}{progress_bar(frac, bar_width)}{p.reset} {pct:3d}%"
    )

    counters = (
        f" {p.dim}reqs{p.reset} {snap.completed:<8d} "
        f"{p.dim}ok{p.reset} {snap.ok:<8d} "
        f"{p.dim}err{p.reset} {err_color}{snap.failed:<6d}{p.reset}"
        f"({err_color}{err_frac * 100:.2f}%{p.reset})  "
        f"{p.dim}in-flight{p.reset} {snap.in_flight}"
    )

    throughput = (
        f" {p.dim}rps{p.reset} {rate_color}{snap.rps:8.1f}{p.reset}"
        f" {p.dim}actual /{p.reset} "
        f"{'∞' if cfg.unlimited_rate else format(snap.target_rps, '.1f')} target  "
        f"{p.dim}read{p.reset} {fmt_bytes(snap.bytes_read)} "
        f"{p.dim}({fmt_bytes(snap.throughput_bps)}/s){p.reset}"
    )

    latency = (
        f" {p.dim}latency (ms){p.reset}\n"
        f"   avg {fmt_ms(snap.mean_latency_ms):>8s}   "
        f"p50 {fmt_ms(snap.percentile_ms(0.50)):>8s}   "
        f"p90 {fmt_ms(snap.percentile_ms(0.90)):>8s}\n"
        f"   p95 {fmt_ms(snap.percentile_ms(0.95)):>8s}   "
        f"p99 {fmt_ms(snap.percentile_ms(0.99)):>8s}   "
        f"max {fmt_ms(snap.latency_max * 1000):>8s}"
    )

    statuses = sorted(snap.status_counts.items())
    if statuses:
        status_bits = "  ".join(
            f"{_status_color(code, p)}{code}{p.reset}:{count}"
            for code, count in statuses[:8]
        )
        if len(statuses) > 8:
            status_bits += f"  {p.dim}+{len(statuses) - 8} more{p.reset}"
    else:
        status_bits = f"{p.dim}none{p.reset}"
    status_line = f" {p.dim}status{p.reset}  {status_bits}"

    lines = [head, sub, bar, counters, throughput, latency, status_line]

    if snap.error_counts:
        err_bits = "  ".join(
            f"{kind}:{count}" for kind, count in sorted(snap.error_counts.items())[:5]
        )
        lines.append(f" {p.dim}errors{p.reset}  {p.red}{err_bits}{p.reset}")

    lines.append(f" {p.dim}{label} · ctrl-c to stop{p.reset}")
    return lines


def _status_color(code: int, p: Palette) -> str:
    if code < 300:
        return p.green
    if code < 400:
        return p.cyan
    if code < 500:
        return p.yellow
    return p.red


def print_report(result: Result, stream: TextIO, pal: Palette) -> None:
    p = pal
    snap = result.snapshot
    cfg = result.config
    width = min(_term_width(), 92)

    rule = "─" * width
    print(f"\n{p.bold}{rule}{p.reset}", file=stream)
    print(
        f"{p.bold} load test report{p.reset}   {cfg.method} {cfg.target.url}"
        f"{p.dim}   (loadtest {__import__('loadtest').__version__}){p.reset}",
        file=stream,
    )
    print(f"{p.dim}{rule}{p.reset}", file=stream)

    verdict_color = {
        "HEALTHY": p.green,
        "SLOW (p95 > 1s)": p.yellow,
        "DEGRADED (>1% errors)": p.yellow,
        "OVERLOADED (>10% errors)": p.red,
    }.get(result.verdict, p.red)
    print(f" verdict      {verdict_color}{p.bold}{result.verdict}{p.reset}", file=stream)
    if result.stopped_early:
        print(f" {p.yellow}(stopped early by operator){p.reset}", file=stream)

    print(
        f" duration     {fmt_duration(snap.elapsed)}  "
        f"{p.dim}({fmt_duration(cfg.duration)} planned){p.reset}",
        file=stream,
    )
    print(
        f" completed    {snap.completed} requests  "
        f"{p.green}{snap.ok} ok{p.reset}  "
        f"{p.red if snap.failed else p.dim}{snap.failed} failed{p.reset}  "
        f"({snap.error_rate * 100:.2f}% errors)",
        file=stream,
    )
    print(
        f" throughput   {p.bold}{snap.rps:.1f} req/s{p.reset}  "
        f"{p.dim}avg over run; offered "
        f"{'unlimited' if cfg.unlimited_rate else format(cfg.rps, '.0f') + ' req/s'}{p.reset}",
        file=stream,
    )
    print(f" transferred  {fmt_bytes(snap.bytes_read)} ({fmt_bytes(snap.throughput_bps)}/s)", file=stream)

    print(f" {p.dim}{rule}{p.reset}", file=stream)
    print(f" {p.bold}latency (ms){p.reset}", file=stream)
    rows = [
        ("min", snap.latency_min * 1000),
        ("mean", snap.mean_latency_ms),
        ("p50", snap.percentile_ms(0.50)),
        ("p75", snap.percentile_ms(0.75)),
        ("p90", snap.percentile_ms(0.90)),
        ("p95", snap.percentile_ms(0.95)),
        ("p99", snap.percentile_ms(0.99)),
        ("p99.9", snap.percentile_ms(0.999)),
        ("max", snap.latency_max * 1000),
    ]
    for name, value in rows:
        bar = _spark(snap, value)
        print(f"   {name:<6s} {fmt_ms(value):>9s}  {p.dim}{bar}{p.reset}", file=stream)

    if snap.samples:
        print(f" {p.dim}{'─' * width}{p.reset}", file=stream)
        print(f" {p.bold}latency distribution{p.reset} {p.dim}(n={snap.sampled_from} sampled){p.reset}", file=stream)
        buckets = histogram(snap.samples, buckets=min(16, max(4, width // 10)))
        top = max(count for _, _, count in buckets) or 1
        for lo, hi, count in buckets:
            scaled = int(round((count / top) * min(38, width - 34)))
            print(
                f"   {fmt_ms(lo * 1000):>8s} – {fmt_ms(hi * 1000):<8s} "
                f"{p.cyan}{BAR_FULL * scaled}{p.reset}{p.dim}{BAR_EMPTY * (min(38, width - 34) - scaled)}{p.reset} {count}",
                file=stream,
            )

    if snap.status_counts:
        print(f" {p.dim}{'─' * width}{p.reset}", file=stream)
        print(f" {p.bold}status codes{p.reset}", file=stream)
        for code, count in sorted(snap.status_counts.items()):
            share = count / snap.completed * 100 if snap.completed else 0
            print(
                f"   {_status_color(code, p)}{code}{p.reset}  {count:<8d} {p.dim}{share:5.1f}%{p.reset}",
                file=stream,
            )

    if snap.error_counts:
        print(f" {p.dim}{'─' * width}{p.reset}", file=stream)
        print(f" {p.bold}errors{p.reset}", file=stream)
        for kind, count in sorted(snap.error_counts.items(), key=lambda kv: -kv[1]):
            print(f"   {p.red}{kind}{p.reset}  {count}", file=stream)
        print(
            f"   {p.dim}errors usually mean the target (or a proxy in front of it) "
            f"is shedding load{p.reset}",
            file=stream,
        )

    print(f"{p.bold}{rule}{p.reset}\n", file=stream)


def _spark(snap: Snapshot, value_ms: float) -> str:
    """A tiny inline bar so the latency table reads at a glance."""
    worst = max(snap.latency_max * 1000, 1e-6)
    filled = int(round(min(value_ms / worst, 1.0) * 20))
    return BAR_FULL * filled + BAR_EMPTY * (20 - filled)


def write_json(result: Result, path: str) -> None:
    snap = result.snapshot
    cfg = result.config
    payload = {
        "target": cfg.target.url,
        "method": cfg.method,
        "concurrency": cfg.concurrency,
        "offered_rps": None if cfg.unlimited_rate else cfg.rps,
        "duration_seconds": cfg.duration,
        "elapsed_seconds": snap.elapsed,
        "completed": snap.completed,
        "ok": snap.ok,
        "failed": snap.failed,
        "error_rate": snap.error_rate,
        "actual_rps": snap.rps,
        "bytes_read": snap.bytes_read,
        "verdict": result.verdict,
        "latency_ms": {
            "min": snap.latency_min * 1000,
            "mean": snap.mean_latency_ms,
            "p50": snap.percentile_ms(0.50),
            "p75": snap.percentile_ms(0.75),
            "p90": snap.percentile_ms(0.90),
            "p95": snap.percentile_ms(0.95),
            "p99": snap.percentile_ms(0.99),
            "p999": snap.percentile_ms(0.999),
            "max": snap.latency_max * 1000,
        },
        "status_counts": {str(k): v for k, v in sorted(snap.status_counts.items())},
        "error_counts": dict(sorted(snap.error_counts.items())),
        "samples": sorted(snap.samples),
    }
    with open(path, "w", encoding="utf-8") as fh:
        json.dump(payload, fh, indent=2)


def write_csv(result: Result, path: str) -> None:
    import csv

    snap = result.snapshot
    with open(path, "w", newline="", encoding="utf-8") as fh:
        writer = csv.writer(fh)
        writer.writerow(["metric", "value"])
        writer.writerow(["target", result.config.target.url])
        writer.writerow(["method", result.config.method])
        writer.writerow(["concurrency", result.config.concurrency])
        writer.writerow(["elapsed_seconds", f"{snap.elapsed:.3f}"])
        writer.writerow(["completed", snap.completed])
        writer.writerow(["ok", snap.ok])
        writer.writerow(["failed", snap.failed])
        writer.writerow(["actual_rps", f"{snap.rps:.2f}"])
        writer.writerow(["verdict", result.verdict])
        for name, q in (
            ("p50", 0.50),
            ("p90", 0.90),
            ("p95", 0.95),
            ("p99", 0.99),
        ):
            writer.writerow([f"latency_ms_{name}", f"{snap.percentile_ms(q):.3f}"])
        for code, count in sorted(snap.status_counts.items()):
            writer.writerow([f"status_{code}", count])
        for kind, count in sorted(snap.error_counts.items()):
            writer.writerow([f"error_{kind}", count])
