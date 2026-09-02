import random
import unittest

from loadtest.stats import Reservoir, Stats, histogram, percentile


class ReservoirTests(unittest.TestCase):
    def test_keeps_everything_under_capacity(self):
        r = Reservoir(capacity=10)
        for i in range(5):
            r.add(float(i))
        self.assertEqual(sorted(r.snapshot()), [0.0, 1.0, 2.0, 3.0, 4.0])
        self.assertEqual(r.seen, 5)

    def test_bounded_but_representative(self):
        rng = random.Random(7)
        r = Reservoir(capacity=100, rng=rng)
        for i in range(10_000):
            r.add(float(i))
        samples = r.snapshot()
        self.assertEqual(len(samples), 100)
        self.assertEqual(r.seen, 10_000)
        # A uniform sample of 0..9999 should land near the middle on average.
        mean = sum(samples) / len(samples)
        self.assertLess(abs(mean - 5000) / 5000, 0.25)

    def test_clear(self):
        r = Reservoir(capacity=4)
        r.add(1.0)
        r.clear()
        self.assertEqual(r.seen, 0)
        self.assertEqual(r.snapshot(), [])


class StatsTests(unittest.TestCase):
    def test_counters_and_latency(self):
        s = Stats()
        s.mark_sent()
        s.mark_done(0.010, 200, 512)
        s.mark_sent()
        s.mark_error("timeout", 1.0)
        snap = s.full_snapshot()
        self.assertEqual(snap.completed, 2)
        self.assertEqual(snap.ok, 1)
        self.assertEqual(snap.failed, 1)
        self.assertEqual(snap.status_counts, {200: 1})
        self.assertEqual(snap.error_counts, {"timeout": 1})
        self.assertEqual(snap.bytes_read, 512)
        self.assertAlmostEqual(snap.error_rate, 0.5)
        self.assertAlmostEqual(snap.latency_max, 1.0)
        self.assertAlmostEqual(snap.latency_min, 0.010)
        self.assertGreaterEqual(snap.percentile_ms(0.95), 100.0)

    def test_percentiles_ordered(self):
        s = Stats()
        for i in range(1, 101):
            s.mark_done(i / 1000.0, 200, 0)
        snap = s.full_snapshot()
        p50 = snap.percentile_ms(0.50)
        p95 = snap.percentile_ms(0.95)
        p99 = snap.percentile_ms(0.99)
        self.assertLess(p50, p95)
        self.assertLessEqual(p95, p99)
        self.assertLessEqual(p99, snap.latency_max * 1000 + 0.001)

    def test_empty_snapshot_is_safe(self):
        snap = Stats().full_snapshot()
        self.assertEqual(snap.rps, 0.0)
        self.assertEqual(snap.percentile_ms(0.99), 0.0)
        self.assertEqual(snap.error_rate, 0.0)

    def test_thread_safety(self):
        import threading

        s = Stats()
        threads = [
            threading.Thread(target=lambda: [s.mark_done(0.001, 200, 1) for _ in range(500)])
            for _ in range(8)
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()
        self.assertEqual(s.full_snapshot().completed, 4000)


class HelperTests(unittest.TestCase):
    def test_percentile_nearest_rank(self):
        values = [float(i) for i in range(1, 101)]
        self.assertEqual(percentile(values, 0.5), 50.0)
        self.assertEqual(percentile(values, 0.99), 99.0)
        self.assertEqual(percentile([], 0.5), 0.0)

    def test_histogram_covers_all_values(self):
        buckets = histogram([i / 1000.0 for i in range(1, 51)], buckets=5)
        self.assertEqual(sum(count for _, _, count in buckets), 50)
        self.assertEqual(buckets[0][0], 0.001)
        self.assertGreaterEqual(buckets[-1][1], 0.05)

    def test_histogram_handles_flat_input(self):
        buckets = histogram([0.5, 0.5, 0.5], buckets=4)
        self.assertEqual(sum(count for _, _, count in buckets), 3)


if __name__ == "__main__":
    unittest.main()
