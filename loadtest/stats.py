"""Live statistics collection: counters plus a bounded latency reservoir."""

from __future__ import annotations

import threading
import time
from collections import Counter
from dataclasses import dataclass, field
from typing import Iterable, Sequence

# How many latency samples we keep per run. Enough for stable p99s, small
# enough that a 15-minute run does not eat the box's memory.
DEFAULT_RESERVOIR = 50_000


class Reservoir:
    """Fixed-size uniform random sample of an unbounded stream (Algorithm R).

    Every sample has an equal chance of ending up in the reservoir, so
    percentiles stay representative no matter how long the run goes.
    """

    def __init__(self, capacity: int = DEFAULT_RESERVOIR, rng=None) -> None:
        self.capacity = max(1, capacity)
        self._rng = rng
        self._samples: list[float] = []
        self._seen = 0
        self._lock = threading.Lock()

    def add(self, value: float) -> None:
        with self._lock:
            self._seen += 1
            if len(self._samples) < self.capacity:
                self._samples.append(value)
                return
            j = self._randbelow(self._seen)
            if j < self.capacity:
                self._samples[j] = value

    def _randbelow(self, n: int) -> int:
        import random

        rng = self._rng or random
        return rng.randrange(n)

    @property
    def seen(self) -> int:
        with self._lock:
            return self._seen

    def snapshot(self) -> list[float]:
        with self._lock:
            return list(self._samples)

    def clear(self) -> None:
        with self._lock:
            self._samples.clear()
            self._seen = 0


@dataclass
class Snapshot:
    """Immutable view of the counters at one instant."""

    elapsed: float = 0.0
    sent: int = 0
    completed: int = 0
    bytes_read: int = 0
    status_counts: dict[int, int] = field(default_factory=dict)
    error_counts: dict[str, int] = field(default_factory=dict)
    latency_sum: float = 0.0
    latency_min: float = 0.0
    latency_max: float = 0.0
    samples: list[float] = field(default_factory=list)
    _sorted: list[float] | None = field(default=None, repr=False, compare=False)
    sample_count: int = 0
    sampled_from: int = 0
    in_flight: int = 0
    target_rps: float = 0.0

    @property
    def transport_errors(self) -> int:
        return sum(self.error_counts.values())

    @property
    def server_errors(self) -> int:
        """5xx responses: the target saying 'I am not coping'."""
        return sum(count for code, count in self.status_counts.items() if code >= 500)

    @property
    def failed(self) -> int:
        """Transport failures plus 5xx responses.

        4xx is deliberately excluded: a 401 or 404 usually means the request
        was wrong, not that the server is struggling.
        """
        return self.transport_errors + self.server_errors

    @property
    def ok(self) -> int:
        return self.completed - self.failed

    @property
    def rps(self) -> float:
        return self.completed / self.elapsed if self.elapsed > 0 else 0.0

    @property
    def throughput_bps(self) -> float:
        return self.bytes_read / self.elapsed if self.elapsed > 0 else 0.0

    @property
    def mean_latency_ms(self) -> float:
        if not self.sample_count:
            return 0.0
        return (self.latency_sum / self.sample_count) * 1000.0

    @property
    def error_rate(self) -> float:
        if not self.completed:
            return 0.0
        return self.failed / self.completed

    def percentile_ms(self, q: float) -> float:
        """Nearest-rank percentile of the sampled latencies, in ms."""
        if not self.samples:
            return 0.0
        if self._sorted is None:
            self._sorted = sorted(self.samples)
        return percentile(self._sorted, q) * 1000.0


class Stats:
    """Thread-safe accumulator written by every worker, read by the UI."""

    def __init__(self, reservoir_capacity: int = DEFAULT_RESERVOIR) -> None:
        self._lock = threading.Lock()
        self._started = time.monotonic()
        self._sent = 0
        self._completed = 0
        self._bytes = 0
        self._status: Counter[int] = Counter()
        self._errors: Counter[str] = Counter()
        self._latency_sum = 0.0
        self._latency_min = float("inf")
        self._latency_max = 0.0
        self._in_flight = 0
        self._reservoir = Reservoir(reservoir_capacity)
        self._target_rps = 0.0

    # -- writers ---------------------------------------------------------

    def mark_sent(self) -> None:
        with self._lock:
            self._sent += 1
            self._in_flight += 1

    def mark_done(self, latency: float, status: int | None, nbytes: int) -> None:
        with self._lock:
            self._completed += 1
            self._in_flight -= 1
            self._bytes += nbytes
            self._latency_sum += latency
            self._latency_min = min(self._latency_min, latency)
            self._latency_max = max(self._latency_max, latency)
            if status is not None:
                self._status[status] += 1
        self._reservoir.add(latency)

    def mark_error(self, kind: str, latency: float) -> None:
        with self._lock:
            self._completed += 1
            self._in_flight -= 1
            self._errors[kind] += 1
            if latency > 0:
                self._latency_sum += latency
                self._latency_min = min(self._latency_min, latency)
                self._latency_max = max(self._latency_max, latency)
        self._reservoir.add(latency)

    def set_target_rps(self, rps: float) -> None:
        with self._lock:
            self._target_rps = rps

    def reset_clock(self) -> None:
        with self._lock:
            self._started = time.monotonic()

    # -- readers ---------------------------------------------------------

    def snapshot(self, now: float | None = None) -> Snapshot:
        with self._lock:
            elapsed = (now or time.monotonic()) - self._started
            return Snapshot(
                elapsed=max(elapsed, 0.0),
                sent=self._sent,
                completed=self._completed,
                bytes_read=self._bytes,
                status_counts=dict(self._status),
                error_counts=dict(self._errors),
                latency_sum=self._latency_sum,
                latency_min=self._latency_min if self._latency_min != float("inf") else 0.0,
                latency_max=self._latency_max,
                sample_count=self._completed,
                in_flight=self._in_flight,
                target_rps=self._target_rps,
            )

    def latency_samples(self) -> tuple[list[float], int]:
        """Return (samples, total observations the samples were drawn from)."""
        return self._reservoir.snapshot(), self._reservoir.seen

    def full_snapshot(self, now: float | None = None) -> Snapshot:
        snap = self.snapshot(now)
        samples, seen = self.latency_samples()
        snap.samples = samples
        snap.sampled_from = seen
        # Sorting once here keeps the live dashboard cheap: it asks for five
        # percentiles ten times a second.
        snap._sorted = sorted(samples)
        return snap


# -- pure helpers --------------------------------------------------------


def percentile(sorted_values: Sequence[float], q: float) -> float:
    """Nearest-rank percentile of an already-sorted sequence (0 < q < 1)."""
    if not sorted_values:
        return 0.0
    import math

    rank = max(1, math.ceil(q * len(sorted_values)))
    idx = min(len(sorted_values) - 1, rank - 1)
    return float(sorted_values[idx])


def histogram(values: Iterable[float], buckets: int = 12) -> list[tuple[float, float, int]]:
    """Bucket values into (lo, hi, count) triples spanning [min, max]."""
    vals = sorted(values)
    if not vals:
        return []
    lo, hi = vals[0], vals[-1]
    if hi == lo:
        return [(lo, hi, len(vals))]
    width = (hi - lo) / buckets
    out: list[tuple[float, float, int]] = []
    for i in range(buckets):
        b_lo = lo + i * width
        b_hi = lo + (i + 1) * width if i < buckets - 1 else hi + 1e-12
        count = sum(1 for v in vals if b_lo <= v < b_hi)
        out.append((b_lo, b_hi, count))
    return out
