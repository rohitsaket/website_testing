import io
import unittest

from loadtest.safety import (
    MAX_CONCURRENCY,
    MAX_DURATION,
    MAX_RPS,
    SafetyError,
    authorization_required,
    check_limits,
    parse_target,
)


class ParseTargetTests(unittest.TestCase):
    def test_defaults_http_and_root_path(self):
        t = parse_target("127.0.0.1:8000/health")
        self.assertEqual(t.scheme, "http")
        self.assertEqual(t.host, "127.0.0.1")
        self.assertEqual(t.port, 8000)
        self.assertEqual(t.path, "/health")
        self.assertTrue(t.is_local)

    def test_https_defaults_to_443(self):
        t = parse_target("https://example.com")
        self.assertEqual(t.scheme, "https")
        self.assertEqual(t.port, 443)
        self.assertEqual(t.path, "/")
        self.assertFalse(t.is_local)

    def test_query_string_is_preserved(self):
        t = parse_target("http://localhost/api?a=1&b=2")
        self.assertEqual(t.path, "/api?a=1&b=2")

    def test_localhost_is_local(self):
        self.assertTrue(parse_target("http://localhost:3000").is_local)
        self.assertTrue(parse_target("http://[::1]:3000").is_local)

    def test_rejects_non_http_schemes(self):
        with self.assertRaises(SafetyError):
            parse_target("ftp://example.com/file")

    def test_rejects_embedded_credentials(self):
        with self.assertRaises(SafetyError):
            parse_target("https://user:pass@example.com/")

    def test_rejects_hostless_url(self):
        with self.assertRaises(SafetyError):
            parse_target("http:///nope")

    def test_rejects_fragment(self):
        with self.assertRaises(SafetyError):
            parse_target("http://example.com/a#frag")

    def test_rejects_empty(self):
        with self.assertRaises(SafetyError):
            parse_target("")


class LimitTests(unittest.TestCase):
    def test_accepts_sane_values(self):
        check_limits(10, 100.0, 30.0)

    def test_rejects_zero_concurrency(self):
        with self.assertRaises(SafetyError):
            check_limits(0, 10.0, 30.0)

    def test_rejects_absurd_concurrency(self):
        with self.assertRaises(SafetyError):
            check_limits(MAX_CONCURRENCY + 1, 10.0, 30.0)

    def test_rejects_absurd_rate(self):
        with self.assertRaises(SafetyError):
            check_limits(10, MAX_RPS + 1, 30.0)

    def test_rejects_absurd_duration(self):
        with self.assertRaises(SafetyError):
            check_limits(10, 10.0, MAX_DURATION + 1)

    def test_rejects_negative_rate(self):
        with self.assertRaises(SafetyError):
            check_limits(10, -1, 30.0)

    def test_rejects_zero_duration(self):
        with self.assertRaises(SafetyError):
            check_limits(10, 10.0, 0)


class AuthorizationTests(unittest.TestCase):
    def test_loopback_never_needs_authorization(self):
        authorization_required(parse_target("http://127.0.0.1:8000"), authorize=False)

    def test_remote_blocked_without_flag(self):
        with self.assertRaises(SafetyError) as ctx:
            authorization_required(parse_target("https://example.com"), authorize=False)
        self.assertIn("--authorize", str(ctx.exception))

    def test_remote_allowed_with_flag(self):
        authorization_required(parse_target("https://example.com"), authorize=True)


if __name__ == "__main__":
    unittest.main()


class ConfirmationTests(unittest.TestCase):
    def test_non_interactive_session_is_refused(self):
        from loadtest.safety import confirm_interactively

        class FakeIn:
            def isatty(self):
                return False

        out = io.StringIO()
        self.assertFalse(
            confirm_interactively(parse_target("https://example.com"), FakeIn(), out)
        )
        self.assertIn("example.com", out.getvalue())

    def test_matching_hostname_confirms(self):
        import builtins
        from loadtest.safety import confirm_interactively

        class FakeIn:
            def isatty(self):
                return True

        real_input = builtins.input
        builtins.input = lambda _prompt="": "example.com"
        try:
            self.assertTrue(
                confirm_interactively(
                    parse_target("https://example.com"), FakeIn(), io.StringIO()
                )
            )
            builtins.input = lambda _prompt="": "something-else"
            self.assertFalse(
                confirm_interactively(
                    parse_target("https://example.com"), FakeIn(), io.StringIO()
                )
            )
        finally:
            builtins.input = real_input

    def test_eof_is_refused(self):
        import builtins
        from loadtest.safety import confirm_interactively

        class FakeIn:
            def isatty(self):
                return True

        real_input = builtins.input
        builtins.input = lambda _prompt="": (_ for _ in ()).throw(EOFError())
        try:
            self.assertFalse(
                confirm_interactively(
                    parse_target("https://example.com"), FakeIn(), io.StringIO()
                )
            )
        finally:
            builtins.input = real_input
