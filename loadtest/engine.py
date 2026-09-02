"""The load generator: worker threads, rate control, and HTTP execution."""

from __future__ import annotations

import http.client
import ssl
import threading
import time
from dataclasses import dataclass, field
from .safety import Target
from .stats import Snapshot, Stats

DEFAULT_UA = "loadtest/1.0 (authorized load testing)"


class RateLimiter:
    """Thread-safe token bucket. rps <= 0 means 'unlimited'."""

    def __init__(self, rps: float) -> None:
        self.rps = float(rps)
        self.capacity = max(1.0, self.rps)
        # Start empty: an opening burst would make short runs look faster than
        # the rate they were actually configured for.
        self._tokens = 0.0
        self._ts = time.monotonic()
        self._lock = threading.Lock()

    def set_rps(self, rps: float) -> None:
        with self._lock:
            now = time.monotonic()
            self._tokens = min(self.capacity, self._tokens + (now - self._ts) * self.rps)
            self._ts = now
            self.rps = float(rps)
            self.capacity = max(1.0, self.rps)
            self._tokens = min(self._tokens, self.capacity)

    def acquire(self) -> None:
        if self.rps <= 0:
            return
        while True:
            with self._lock:
                now = time.monotonic()
                self._tokens = min(
                    self.capacity, self._tokens + (now - self._ts) * self.rps
                )
                self._ts = now
                if self._tokens >= 1.0:
                    self._tokens -= 1.0
                    return
                wait = (1.0 - self._tokens) / self.rps
            time.sleep(min(wait, 0.05))


@dataclass
class Config:
    target: Target
    method: str = "GET"
    headers: dict[str, str] = field(default_factory=dict)
    body: bytes | None = None
    concurrency: int = 10
    rps: float = 0.0  # 0 = unlimited
    duration: float = 30.0
    max_requests: int | None = None
    timeout: float = 10.0
    ramp_up: float = 0.0
    keep_alive: bool = True
    insecure: bool = False
    verbose_errors: bool = False

    @property
    def unlimited_rate(self) -> bool:
        return self.rps <= 0


class _Connection:
    """One keep-alive connection per worker thread."""

    def __init__(self, cfg: Config) -> None:
        self._cfg = cfg
        self._conn: http.client.HTTPConnection | None = None
        self._ctx = self._build_context()

    def _build_context(self) -> ssl.SSLContext | None:
        if self._cfg.target.scheme != "https":
            return None
        ctx = ssl.create_default_context()
        if self._cfg.insecure:
            ctx.check_hostname = False
            ctx.verify_mode = ssl.CERT_NONE
        return ctx

    def _new(self) -> http.client.HTTPConnection:
        t = self._cfg.target
        if t.scheme == "https":
            conn: http.client.HTTPConnection = http.client.HTTPSConnection(
                t.host, t.port, timeout=self._cfg.timeout, context=self._ctx
            )
        else:
            conn = http.client.HTTPConnection(t.host, t.port, timeout=self._cfg.timeout)
        conn.connect()
        return conn

    def request(self, method: str, path: str, body: bytes | None, headers: dict[str, str]):
        if self._conn is None:
            self._conn = self._new()
        try:
            self._conn.request(method, path, body=body, headers=headers)
            return self._conn.getresponse()
        except (http.client.HTTPException, OSError):
            # Keep-alive connection went stale: rebuild once, then retry.
            self.close()
            self._conn = self._new()
            self._conn.request(method, path, body=body, headers=headers)
            return self._conn.getresponse()

    def close(self) -> None:
        if self._conn is not None:
            try:
                self._conn.close()
            except Exception:
                pass
            self._conn = None


class Result:
    """Final numbers for a completed run."""

    def __init__(self, cfg: Config, snap: Snapshot, stopped_early: bool = False) -> None:
        self.config = cfg
        self.snapshot = snap
        self.stopped_early = stopped_early

    @property
    def verdict(self) -> str:
        snap = self.snapshot
        if snap.completed == 0:
            return "NO TRAFFIC COMPLETED"
        if snap.error_rate > 0.10:
            return "OVERLOADED (>10% errors)"
        if snap.error_rate > 0.01:
            return "DEGRADED (>1% errors)"
        if snap.percentile_ms(0.95) > 1000:
            return "SLOW (p95 > 1s)"
        return "HEALTHY"


class LoadTest:
    """Runs a load profile against one target and records what happens."""

    def __init__(self, cfg: Config, stats: Stats | None = None) -> None:
        self.cfg = cfg
        self.stats = stats or Stats()
        self._stop = threading.Event()
        self._threads: list[threading.Thread] = []
        self._local = threading.local()
        self._headers = self._build_headers()

    # -- public API ------------------------------------------------------

    def stop(self) -> None:
        self._stop.set()

    @property
    def stopped(self) -> bool:
        return self._stop.is_set()

    def run(self) -> Result:
        cfg = self.cfg
        stats = self.stats
        stats.reset_clock()

        limiter = RateLimiter(cfg.rps if not cfg.unlimited_rate else 0.0)
        stats.set_target_rps(cfg.rps)

        ramp_thread = None
        if cfg.ramp_up > 0:
            ramp_thread = threading.Thread(
                target=self._ramp, args=(limiter,), daemon=True
            )

        deadline = time.monotonic() + cfg.duration
        remaining = self._make_counter(cfg.max_requests)

        threads = [
            threading.Thread(
                target=self._worker,
                args=(limiter, deadline, remaining),
                daemon=True,
                name=f"loadtest-{i}",
            )
            for i in range(cfg.concurrency)
        ]

        if ramp_thread:
            ramp_thread.start()
        for t in threads:
            t.start()

        for t in threads:
            t.join()

        return Result(cfg, stats.full_snapshot(), stopped_early=self._stop.is_set())

    # -- internals -------------------------------------------------------

    def _build_headers(self) -> dict[str, str]:
        headers = {
            "User-Agent": DEFAULT_UA,
            "Accept": "*/*",
        }
        if self.cfg.keep_alive:
            headers["Connection"] = "keep-alive"
        else:
            headers["Connection"] = "close"
        if self.cfg.body:
            headers.setdefault(
                "Content-Type", "application/x-www-form-urlencoded"
            )
            headers["Content-Length"] = str(len(self.cfg.body))
        headers.update(self.cfg.headers)
        return headers

    def _make_counter(self, max_requests: int | None):
        """A thread-safe countdown; None means 'no request cap'."""
        if max_requests is None:
            return None
        lock = threading.Lock()
        box = {"left": max_requests}

        def next_slot() -> bool:
            with lock:
                if box["left"] <= 0:
                    return False
                box["left"] -= 1
                return True

        return next_slot

    def _ramp(self, limiter: RateLimiter) -> None:
        """Linearly ramp the offered rate from 10% to 100% over ramp_up."""
        cfg = self.cfg
        steps = 40
        step_time = cfg.ramp_up / steps
        for i in range(1, steps + 1):
            if self._stop.is_set():
                return
            factor = 0.1 + 0.9 * (i / steps)
            target = cfg.rps * factor if not cfg.unlimited_rate else 0.0
            limiter.set_rps(target)
            self.stats.set_target_rps(target)
            time.sleep(step_time)
        limiter.set_rps(cfg.rps if not cfg.unlimited_rate else 0.0)
        self.stats.set_target_rps(cfg.rps)

    def _worker(
        self,
        limiter: RateLimiter,
        deadline: float,
        remaining,
    ) -> None:
        cfg = self.cfg
        stats = self.stats
        conn = _Connection(cfg)

        try:
            while not self._stop.is_set():
                if time.monotonic() >= deadline:
                    return
                if remaining is not None and not remaining():
                    return

                limiter.acquire()
                if self._stop.is_set():
                    return

                stats.mark_sent()
                started = time.monotonic()
                try:
                    if not cfg.keep_alive:
                        conn.close()
                    resp = conn.request(
                        cfg.method, cfg.target.path, cfg.body, self._headers
                    )
                    payload = resp.read()
                    status = resp.status
                    # Body is drained so the keep-alive connection is reusable,
                    # then discarded - holding every response would be a
                    # memory leak disguised as a metric.
                    nbytes = len(payload)
                    del payload
                    elapsed = time.monotonic() - started
                    stats.mark_done(elapsed, status, nbytes)
                except Exception as exc:  # noqa: BLE001 - classified below
                    elapsed = time.monotonic() - started
                    stats.mark_error(classify_error(exc), elapsed)
                    if cfg.verbose_errors:
                        print(f"  ! {type(exc).__name__}: {exc}")
                    conn.close()
        finally:
            conn.close()

    def snapshot(self) -> Snapshot:
        return self.stats.full_snapshot()


def classify_error(exc: BaseException) -> str:
    """Map an exception to a short, stable bucket name for reporting."""
    import socket
    import ssl as _ssl

    if isinstance(exc, socket.timeout) or isinstance(exc, TimeoutError):
        return "timeout"
    if isinstance(exc, _ssl.SSLError):
        return "tls"
    if isinstance(exc, ConnectionRefusedError):
        return "refused"
    if isinstance(exc, (ConnectionResetError, BrokenPipeError)):
        return "reset"
    if isinstance(exc, (socket.gaierror,)):
        return "dns"
    if isinstance(exc, http.client.RemoteDisconnected):
        return "closed"
    if isinstance(exc, http.client.HTTPException):
        return "http"
    return type(exc).__name__.lower()
