import io
import json
import tempfile
import unittest
from pathlib import Path

from loadtest.engine import Config, Result
from loadtest.safety import parse_target
from loadtest.stats import Snapshot
from loadtest.ui import (
    Dashboard,
    Palette,
    build_frame,
    fmt_bytes,
    fmt_duration,
    fmt_ms,
    print_report,
    progress_bar,
    write_csv,
    write_json,
)


def make_result(**snap_kwargs) -> Result:
    cfg = Config(target=parse_target("http://127.0.0.1:8000/health"), concurrency=8)
    snap = Snapshot(
        elapsed=5.0,
        completed=1000,
        bytes_read=64_000,
        status_counts={200: 980, 500: 20},
        error_counts={"timeout": 3},
        latency_sum=12.0,
        latency_min=0.004,
        latency_max=0.250,
        sample_count=1000,
        samples=[0.01 * (i % 25 + 1) for i in range(1000)],
        sampled_from=1000,
        in_flight=8,
        target_rps=200.0,
    )
    for key, value in snap_kwargs.items():
        setattr(snap, key, value)
    snap._sorted = sorted(snap.samples)
    return Result(cfg, snap)


class FormatTests(unittest.TestCase):
    def test_duration(self):
        self.assertEqual(fmt_duration(4.5), "4.5s")
        self.assertEqual(fmt_duration(65), "1m05s")
        self.assertEqual(fmt_duration(3725), "1h02m")

    def test_bytes(self):
        self.assertEqual(fmt_bytes(512), "512 B")
        self.assertEqual(fmt_bytes(2048), "2.0 KB")
        self.assertTrue(fmt_bytes(5 * 1024**3).endswith("GB"))

    def test_ms(self):
        self.assertEqual(fmt_ms(0.5), "0.50")
        self.assertEqual(fmt_ms(12.34), "12.3")
        self.assertEqual(fmt_ms(250.6), "251")
        self.assertEqual(fmt_ms(12_345), "12.3s")

    def test_progress_bar(self):
        self.assertEqual(progress_bar(0.0, 4), "░░░░")
        self.assertEqual(progress_bar(1.0, 4), "████")
        self.assertEqual(progress_bar(0.5, 4), "██░░")
        self.assertEqual(progress_bar(5.0, 4), "████")  # clamped
        self.assertEqual(progress_bar(-1.0, 4), "░░░░")  # clamped


class FrameTests(unittest.TestCase):
    def test_frame_contains_the_essentials(self):
        result = make_result()
        pal = Palette(enabled=False)
        lines = build_frame(result.snapshot, result.config, pal, 100)
        text = "\n".join(lines)
        self.assertIn("http://127.0.0.1:8000/health", text)
        self.assertIn("workers 8", text)
        self.assertIn("500:20", text)
        self.assertIn("timeout:3", text)
        self.assertGreaterEqual(len(lines), 8)

    def test_frame_without_errors_or_statuses(self):
        result = make_result(status_counts={}, error_counts={})
        lines = build_frame(result.snapshot, result.config, Palette(enabled=False), 80)
        text = "\n".join(lines)
        self.assertIn("none", text)
        self.assertNotIn("errors", text)

    def test_dashboard_quiet_writes_nothing(self):
        out = io.StringIO()
        dash = Dashboard(out, Palette(enabled=False), quiet=True)
        dash.render(make_result().snapshot, make_result().config)
        dash.finish()
        self.assertEqual(out.getvalue(), "")

    def test_dashboard_plain_output_is_rate_limited(self):
        out = io.StringIO()
        dash = Dashboard(out, Palette(enabled=False))
        snap = make_result().snapshot
        cfg = make_result().config
        dash.render(snap, cfg)
        first = out.getvalue()
        dash.render(snap, cfg)  # same instant: suppressed
        self.assertEqual(out.getvalue(), first)
        self.assertIn("rps=", first)

    def test_report_renders(self):
        out = io.StringIO()
        print_report(make_result(), out, Palette(enabled=False))
        text = out.getvalue()
        self.assertIn("load test report", text)
        self.assertIn("DEGRADED", text)  # 2% errors + 20 5xx
        self.assertIn("p99", text)
        self.assertIn("latency distribution", text)
        self.assertIn("status codes", text)
        self.assertIn("errors", text)

    def test_report_handles_an_empty_run(self):
        out = io.StringIO()
        result = make_result(
            completed=0, status_counts={}, error_counts={}, samples=[], sampled_from=0
        )
        print_report(result, out, Palette(enabled=False))
        self.assertIn("NO TRAFFIC COMPLETED", out.getvalue())


class ExportTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.TemporaryDirectory()
        self.dir = Path(self.tmp.name)

    def tearDown(self) -> None:
        self.tmp.cleanup()

    def test_json_roundtrip(self):
        path = self.dir / "run.json"
        write_json(make_result(), str(path))
        data = json.loads(path.read_text())
        self.assertEqual(data["completed"], 1000)
        self.assertEqual(data["failed"], 23)  # 3 timeouts + 20 5xx
        self.assertEqual(data["status_counts"]["500"], 20)
        self.assertEqual(data["error_counts"]["timeout"], 3)
        self.assertEqual(len(data["samples"]), 1000)
        self.assertIn("p99", data["latency_ms"])

    def test_csv_shape(self):
        import csv

        path = self.dir / "run.csv"
        write_csv(make_result(), str(path))
        rows = list(csv.reader(path.read_text().splitlines()))
        header, *body = rows
        self.assertEqual(header, ["metric", "value"])
        metrics = {row[0] for row in body}
        self.assertIn("completed", metrics)
        self.assertIn("latency_ms_p95", metrics)
        self.assertIn("status_500", metrics)
        self.assertIn("error_timeout", metrics)


if __name__ == "__main__":
    unittest.main()
