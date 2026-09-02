"""Command line entry point for loadtest."""

from __future__ import annotations

import argparse
import sys
import threading
import time
from typing import Sequence

from . import __version__
from .engine import Config, LoadTest
from .safety import (
    MAX_CONCURRENCY,
    MAX_DURATION,
    MAX_RPS,
    SafetyError,
    confirm_interactively,
    authorization_required,
    check_limits,
    parse_target,
    resolves_to_private,
)
from .stats import Stats
from .ui import Dashboard, Palette, print_report, write_csv, write_json

BANNER = """\
loadtest {v} - HTTP load and stress testing

  Send load only to systems you own or have written permission to test.
  Sustained traffic against third-party infrastructure is a denial of
  service attack, and is illegal where you probably live.
"""


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="loadtest",
        description=(
            "Terminal-based HTTP load and stress tester for servers you are "
            "authorised to test."
        ),
        formatter_class=argparse.RawDescriptionHelpFormatter,
        epilog=(
            "examples:\n"
            "  loadtest http://127.0.0.1:8000/\n"
            "  loadtest https://staging.example.com/api -c 50 -t 60\n"
            "  loadtest https://staging.example.com/api -c 20 -r 200 --ramp-up 15\n"
            "  loadtest https://staging.example.com/api -X POST -D 'a=1' -n 5000\n"
            "  loadtest https://staging.example.com/ -c 100 -t 30 --json run.json\n"
        ),
    )
    parser.add_argument("url", help="target URL (http or https)")
    parser.add_argument(
        "-X", "--method", default="GET", help="HTTP method (default: GET)"
    )
    parser.add_argument(
        "-H",
        "--header",
        action="append",
        default=[],
        metavar="NAME: VALUE",
        help="extra request header, repeatable",
    )
    parser.add_argument(
        "-D",
        "--data",
        default=None,
        help="request body; use @file.txt to read it from a file",
    )
    parser.add_argument(
        "-c",
        "--concurrency",
        type=int,
        default=10,
        help=f"number of concurrent workers (default: 10, max: {MAX_CONCURRENCY})",
    )
    parser.add_argument(
        "-r",
        "--rate",
        type=float,
        default=0.0,
        help="target requests/second across all workers; 0 = as fast as "
        f"possible (default: 0, max: {MAX_RPS:g})",
    )
    parser.add_argument(
        "-t",
        "--duration",
        type=float,
        default=30.0,
        help=f"how long to run, in seconds (default: 30, max: {MAX_DURATION:g})",
    )
    parser.add_argument(
        "-n",
        "--requests",
        type=int,
        default=None,
        help="stop after this many requests (duration still applies)",
    )
    parser.add_argument(
        "--ramp-up",
        type=float,
        default=0.0,
        help="ease the offered rate from 10%% to 100%% over this many seconds",
    )
    parser.add_argument(
        "--timeout",
        type=float,
        default=10.0,
        help="per-request socket timeout in seconds (default: 10)",
    )
    parser.add_argument(
        "--no-keep-alive",
        action="store_true",
        help="open a fresh connection for every request (slower, harder on the target)",
    )
    parser.add_argument(
        "-k",
        "--insecure",
        action="store_true",
        help="skip TLS certificate verification (staging boxes only)",
    )
    parser.add_argument(
        "--authorize",
        action="store_true",
        help="confirm you own the target or have written permission to test it "
        "(required for anything that is not localhost)",
    )
    parser.add_argument(
        "--yes",
        action="store_true",
        help="skip the interactive hostname confirmation",
    )
    parser.add_argument(
        "--json", dest="json_out", metavar="FILE", help="write machine-readable results"
    )
    parser.add_argument(
        "--csv", dest="csv_out", metavar="FILE", help="write summary metrics as CSV"
    )
    parser.add_argument(
        "--dry-run",
        action="store_true",
        help="print the resolved plan and exit without sending anything",
    )
    parser.add_argument("-q", "--quiet", action="store_true", help="suppress live output")
    parser.add_argument("--no-color", action="store_true", help="disable ANSI colour")
    parser.add_argument(
        "-v", "--verbose-errors", action="store_true", help="print every error inline"
    )
    parser.add_argument("--version", action="version", version=f"loadtest {__version__}")
    return parser


def parse_headers(raw: Sequence[str]) -> dict[str, str]:
    headers: dict[str, str] = {}
    for item in raw:
        if ":" not in item:
            raise SafetyError(f"header {item!r} is not in NAME: VALUE form")
        name, value = item.split(":", 1)
        headers[name.strip()] = value.strip()
    return headers


def resolve_body(spec: str | None) -> bytes | None:
    if spec is None:
        return None
    if spec.startswith("@"):
        path = spec[1:]
        with open(path, "rb") as fh:
            return fh.read()
    return spec.encode("utf-8")


def build_config(args: argparse.Namespace) -> Config:
    target = parse_target(args.url)
    check_limits(args.concurrency, args.rate, args.duration)
    if args.requests is not None and args.requests < 1:
        raise SafetyError("--requests must be at least 1")
    if args.ramp_up < 0:
        raise SafetyError("--ramp-up cannot be negative")
    if args.ramp_up >= args.duration:
        raise SafetyError("--ramp-up must be shorter than --duration")
    if args.timeout <= 0:
        raise SafetyError("--timeout must be positive")

    authorization_required(target, args.authorize)
    if not target.is_local and not args.yes:
        if not confirm_interactively(target):
            raise SafetyError("authorisation not confirmed - nothing was sent")

    if resolves_to_private(target) and not target.is_local:
        print(
            f"note: {target.host} resolves to private address space "
            "(staging/VPN target?)",
            file=sys.stderr,
        )

    return Config(
        target=target,
        method=args.method.upper(),
        headers=parse_headers(args.header),
        body=resolve_body(args.data),
        concurrency=args.concurrency,
        rps=args.rate,
        duration=args.duration,
        max_requests=args.requests,
        timeout=args.timeout,
        ramp_up=args.ramp_up,
        keep_alive=not args.no_keep_alive,
        insecure=args.insecure,
        verbose_errors=args.verbose_errors,
    )


def describe_plan(cfg: Config) -> str:
    rate = "unlimited" if cfg.unlimited_rate else f"{cfg.rps:g} req/s"
    stop = f"{cfg.duration:g}s"
    if cfg.max_requests:
        stop += f" or {cfg.max_requests} requests"
    return (
        f"  target      {cfg.target.url}\n"
        f"  method      {cfg.method}\n"
        f"  workers     {cfg.concurrency}\n"
        f"  offered     {rate}\n"
        f"  stop after  {stop}\n"
        f"  keep-alive  {'on' if cfg.keep_alive else 'off'}\n"
        f"  timeout     {cfg.timeout:g}s\n"
    )


def run(args: argparse.Namespace, stream_out=None, stream_err=None) -> int:
    stream_out = stream_out or sys.stdout
    stream_err = stream_err or sys.stderr
    pal = Palette.for_stream(stream_out, no_color=args.no_color)

    cfg = build_config(args)

    if args.dry_run:
        print(f"{pal.bold}plan{pal.reset}\n{describe_plan(cfg)}", file=stream_out)
        return 0

    stats = Stats()
    test = LoadTest(cfg, stats)
    dashboard = Dashboard(stream_out, pal, quiet=args.quiet)

    if not args.quiet:
        print(f"{pal.dim}starting in 1s... (ctrl-c to abort){pal.reset}", file=stream_out)
        time.sleep(1.0)

    result_box: dict[str, object] = {}
    done = threading.Event()

    def worker() -> None:
        result_box["result"] = test.run()
        done.set()

    thread = threading.Thread(target=worker, daemon=True)
    thread.start()

    try:
        while not done.is_set():
            dashboard.render(stats.full_snapshot(), cfg, label="running")
            done.wait(0.1)
    except KeyboardInterrupt:
        print(f"\n{pal.yellow}stopping...{pal.reset}", file=stream_out)
        test.stop()
        done.wait(timeout=cfg.timeout + 5)

    thread.join(timeout=cfg.timeout + 5)
    dashboard.finish()

    result = result_box.get("result")
    if result is None:  # defensive: run() always sets it unless it raised
        print("run produced no results", file=stream_err)
        return 1

    print_report(result, stream_out, pal)

    if args.json_out:
        write_json(result, args.json_out)
        print(f"wrote {args.json_out}", file=stream_out)
    if args.csv_out:
        write_csv(result, args.csv_out)
        print(f"wrote {args.csv_out}", file=stream_out)

    # Non-zero exit makes this usable in CI as a performance gate.
    if result.snapshot.error_rate > 0.10:
        return 2
    return 0


def main(argv: Sequence[str] | None = None) -> int:
    parser = build_parser()
    args = parser.parse_args(argv)

    pal = Palette.for_stream(sys.stderr, no_color=args.no_color)
    if not args.quiet:
        print(BANNER.format(v=__version__), file=sys.stderr)

    try:
        return run(args)
    except SafetyError as exc:
        print(f"{pal.red}refused:{pal.reset} {exc}", file=sys.stderr)
        return 2
    except FileNotFoundError as exc:
        print(f"{pal.red}error:{pal.reset} {exc}", file=sys.stderr)
        return 2
    except KeyboardInterrupt:
        print("\naborted before traffic started", file=sys.stderr)
        return 130


if __name__ == "__main__":
    raise SystemExit(main())
