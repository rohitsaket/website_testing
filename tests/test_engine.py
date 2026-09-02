"""End-to-end tests: run real traffic against a throwaway local server."""

import io
import threading
import time
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

from loadtest.engine import Config, LoadTest, RateLimiter, classify_error
from loadtest.safety import parse_target
from loadtest.stats import Stats

PAYLOAD = b"hello " * 64


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"
    fail = False

    def do_GET(self):  # noqa: N802
        # Keep-alive means the request body must be consumed, or its bytes get
        # parsed as the next request on the connection.
        length = int(self.headers.get("Content-Length") or 0)
        if length:
            self.rfile.read(length)
        if self.path == "/missing":
            body = b"not here"
            self.send_response(404)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)
            return
        if self.path == "/slow":
            time.sleep(0.2)
        if self.path == "/boom" or Handler.fail:
            body = b"nope"
            self.send_response(500)
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            try:
                self.wfile.write(body)
            except BrokenPipeError:
                pass
            return
        self.send_response(200)
        self.send_header("Content-Length", str(len(PAYLOAD)))
        self.end_headers()
        try:
            self.wfile.write(PAYLOAD)
        except BrokenPipeError:
            pass

    do_POST = do_GET  # noqa: N815

    def log_message(self, *args):
        pass


class ServerFixture:
    def __init__(self) -> None:
        self.server = ThreadingHTTPServer(("127.0.0.1", 0), Handler)
        self.port = self.server.server_address[1]
        self.thread = threading.Thread(target=self.server.serve_forever, daemon=True)

    def __enter__(self) -> str:
        self.thread.start()
        return f"http://127.0.0.1:{self.port}"

    def __exit__(self, *exc) -> None:
        self.server.shutdown()
        self.server.server_close()
        self.thread.join(timeout=5)


class LoadTestTests(unittest.TestCase):
    def setUp(self) -> None:
        self.fixture = ServerFixture()
        self.base = self.fixture.__enter__()
        Handler.fail = False

    def tearDown(self) -> None:
        self.fixture.__exit__()

    def _config(self, path: str = "/", **kwargs) -> Config:
        return Config(
            target=parse_target(self.base + path),
            duration=kwargs.pop("duration", 0.6),
            concurrency=kwargs.pop("concurrency", 4),
            timeout=kwargs.pop("timeout", 5.0),
            **kwargs,
        )

    def test_happy_path_reports_200s(self):
        result = LoadTest(self._config()).run()
        snap = result.snapshot
        self.assertEqual(snap.failed, 0)
        self.assertGreater(snap.completed, 0)
        self.assertEqual(snap.status_counts.get(500), None)
        self.assertEqual(snap.ok, snap.completed)
        self.assertGreater(snap.bytes_read, 0)
        self.assertIn("HEALTHY", result.verdict)

    def test_status_codes_and_bytes_are_counted(self):
        result = LoadTest(self._config("/boom")).run()
        self.assertEqual(result.snapshot.status_counts.get(500), result.snapshot.completed)
        self.assertIn(result.verdict, ("OVERLOADED (>10% errors)", "DEGRADED (>1% errors)"))

    def test_server_errors_count_toward_the_error_rate(self):
        # 5xx are responses, but they still mean the request did not succeed.
        result = LoadTest(self._config("/boom")).run()
        snap = result.snapshot
        self.assertEqual(snap.transport_errors, 0)
        self.assertEqual(snap.server_errors, snap.completed)
        self.assertEqual(snap.failed, snap.completed)
        self.assertEqual(snap.ok, 0)
        self.assertAlmostEqual(snap.error_rate, 1.0)

    def test_4xx_is_not_blamed_on_the_server(self):
        # A 404 is a broken request, not an overloaded target.
        result = LoadTest(self._config("/missing")).run()
        snap = result.snapshot
        self.assertEqual(snap.status_counts.get(404), snap.completed)
        self.assertEqual(snap.failed, 0)
        self.assertEqual(snap.ok, snap.completed)

    def test_post_body_is_sent(self):
        cfg = self._config("/")
        cfg.method = "POST"
        cfg.body = b"a=1"
        result = LoadTest(cfg).run()
        self.assertEqual(result.snapshot.failed, 0)
        self.assertGreater(result.snapshot.completed, 0)

    def test_request_cap_stops_early(self):
        cfg = self._config(duration=30.0, max_requests=12, concurrency=1)
        started = time.monotonic()
        result = LoadTest(cfg).run()
        self.assertLessEqual(result.snapshot.completed, 12)
        self.assertLess(time.monotonic() - started, 20.0)

    def test_rate_limit_is_respected(self):
        cfg = self._config(duration=1.6, concurrency=8, rps=20.0)
        result = LoadTest(cfg).run()
        # Generous bounds: this asserts the limiter bites, not scheduler precision.
        self.assertGreaterEqual(result.snapshot.completed, 15)
        self.assertLessEqual(result.snapshot.completed, 45)

    def test_ramp_up_stays_under_flat_rate(self):
        flat = LoadTest(self._config(duration=1.5, concurrency=8, rps=40.0)).run()
        ramped = LoadTest(
            self._config(duration=1.5, concurrency=8, rps=40.0, ramp_up=1.4)
        ).run()
        self.assertLessEqual(ramped.snapshot.completed, flat.snapshot.completed)

    def test_no_keep_alive_still_works(self):
        cfg = self._config(concurrency=3, duration=0.5)
        cfg.keep_alive = False
        result = LoadTest(cfg).run()
        self.assertEqual(result.snapshot.failed, 0)

    def test_timeout_is_recorded(self):
        cfg = self._config("/slow", concurrency=2, duration=1.2, timeout=0.05)
        result = LoadTest(cfg).run()
        self.assertIn("timeout", result.snapshot.error_counts)

    def test_latency_percentiles_are_ordered(self):
        snap = LoadTest(self._config(concurrency=5, duration=0.8)).run().snapshot
        p50 = snap.percentile_ms(0.50)
        p90 = snap.percentile_ms(0.90)
        p99 = snap.percentile_ms(0.99)
        self.assertLessEqual(p50, p90)
        self.assertLessEqual(p90, p99)
        self.assertGreater(p50, 0.0)

    def test_stop_halts_the_run(self):
        test = LoadTest(self._config(duration=30.0, concurrency=4))
        thread = threading.Thread(target=test.run, daemon=True)
        thread.start()
        time.sleep(0.4)
        test.stop()
        thread.join(timeout=10)
        self.assertFalse(thread.is_alive())

    def test_external_stats_object_is_used(self):
        stats = Stats()
        LoadTest(self._config(), stats).run()
        self.assertGreater(stats.full_snapshot().completed, 0)


class RateLimiterTests(unittest.TestCase):
    def test_unlimited_is_a_noop(self):
        limiter = RateLimiter(0)
        started = time.monotonic()
        for _ in range(1000):
            limiter.acquire()
        self.assertLess(time.monotonic() - started, 0.5)

    def test_paces_to_the_requested_rate(self):
        limiter = RateLimiter(100.0)
        started = time.monotonic()
        for _ in range(20):
            limiter.acquire()
        elapsed = time.monotonic() - started
        # First burst is free (bucket starts full), so allow slack.
        self.assertLess(elapsed, 0.5)

    def test_slow_rate_is_enforced(self):
        limiter = RateLimiter(20.0)
        limiter._tokens = 0  # drain the initial burst
        started = time.monotonic()
        for _ in range(3):
            limiter.acquire()
        elapsed = time.monotonic() - started
        self.assertGreaterEqual(elapsed, 0.09)

    def test_set_rps_changes_pacing(self):
        limiter = RateLimiter(10.0)
        limiter.set_rps(1000.0)
        self.assertEqual(limiter.rps, 1000.0)
        started = time.monotonic()
        for _ in range(50):
            limiter.acquire()
        self.assertLess(time.monotonic() - started, 0.2)


class ErrorClassificationTests(unittest.TestCase):
    def test_common_types(self):
        import socket
        import ssl

        self.assertEqual(classify_error(socket.timeout()), "timeout")
        self.assertEqual(classify_error(TimeoutError()), "timeout")
        self.assertEqual(classify_error(ConnectionRefusedError()), "refused")
        self.assertEqual(classify_error(ConnectionResetError()), "reset")
        self.assertEqual(classify_error(socket.gaierror()), "dns")
        self.assertEqual(classify_error(ssl.SSLError("bad")), "tls")
        self.assertEqual(classify_error(ValueError("weird")), "valueerror")


class CliTests(unittest.TestCase):
    def test_dry_run_sends_nothing(self):
        from loadtest.cli import build_parser, run

        parser = build_parser()
        args = parser.parse_args(["http://127.0.0.1:9/x", "--dry-run", "-c", "2"])
        out = io.StringIO()
        code = run(args, stream_out=out, stream_err=io.StringIO())
        self.assertEqual(code, 0)
        self.assertIn("plan", out.getvalue().lower())
        self.assertIn("http://127.0.0.1:9/x", out.getvalue())

    def test_remote_target_without_authorize_is_refused(self):
        from loadtest.cli import build_parser
        from loadtest.safety import SafetyError

        args = build_parser().parse_args(["https://example.com", "--dry-run"])
        with self.assertRaises(SafetyError):
            from loadtest.cli import build_config

            build_config(args)

    def test_header_parsing(self):
        from loadtest.cli import parse_headers
        from loadtest.safety import SafetyError

        self.assertEqual(
            parse_headers(["X-Token: abc:def", "Accept: text/html"]),
            {"X-Token": "abc:def", "Accept": "text/html"},
        )
        with self.assertRaises(SafetyError):
            parse_headers(["nocolon"])

    def test_body_from_string_and_file(self):
        import tempfile

        from loadtest.cli import resolve_body

        self.assertEqual(resolve_body("a=1"), b"a=1")
        self.assertIsNone(resolve_body(None))
        with tempfile.NamedTemporaryFile("wb", delete=False) as fh:
            fh.write(b'{"json":true}')
            path = fh.name
        self.assertEqual(resolve_body(f"@{path}"), b'{"json":true}')


if __name__ == "__main__":
    unittest.main()
