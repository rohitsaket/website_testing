#!/usr/bin/env python3
"""A deliberately imperfect local web server to practise load testing on.

It answers on every path, sleeps for a configurable (jittery) amount of time,
and fails a configurable share of requests - everything you need to see the
dashboard move without touching a real system.

    python3 examples/demo_server.py --port 8000 --latency 20 --error-rate 0.02
    python3 -m loadtest http://127.0.0.1:8000 -c 20 -t 15
"""

from __future__ import annotations

import argparse
import random
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    base_latency = 0.02
    jitter = 0.03
    error_rate = 0.0

    def _respond(self) -> None:
        body = self.body
        time.sleep(max(0.0, self.base_latency + random.uniform(0, self.jitter)))
        if self.error_rate and random.random() < self.error_rate:
            payload = b'{"error":"injected failure"}'
            self.send_response(500)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(payload)))
            self.end_headers()
            self.wfile.write(payload)
            return
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    @property
    def body(self) -> bytes:
        return (
            b"ok "
            + str(time.time()).encode()
            + b" "
            + (b"x" * 512)
        )

    def do_HEAD(self) -> None:  # HEAD must not carry a body
        time.sleep(max(0.0, self.base_latency + random.uniform(0, self.jitter)))
        self.send_response(200)
        self.send_header("Content-Type", "text/plain")
        self.send_header("Content-Length", str(len(self.body)))
        self.end_headers()

    # Every other method goes through the same slow path.
    do_GET = do_POST = do_PUT = do_DELETE = _respond  # type: ignore[assignment]

    def log_message(self, fmt: str, *args) -> None:  # silence the default chatter
        pass


def main() -> int:
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--host", default="0.0.0.0")
    parser.add_argument("--port", type=int, default=8000)
    parser.add_argument("--latency", type=float, default=20.0, help="base latency in ms")
    parser.add_argument("--jitter", type=float, default=30.0, help="extra random ms")
    parser.add_argument("--error-rate", type=float, default=0.0, help="0.0 - 1.0")
    args = parser.parse_args()

    Handler.base_latency = args.latency / 1000.0
    Handler.jitter = args.jitter / 1000.0
    Handler.error_rate = args.error_rate

    server = ThreadingHTTPServer((args.host, args.port), Handler)
    print(f"demo server on http://{args.host}:{args.port} "
          f"(latency {args.latency:g}ms +{args.jitter:g}ms, "
          f"error rate {args.error_rate:.1%})")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        print("\nbye")
    finally:
        server.server_close()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
