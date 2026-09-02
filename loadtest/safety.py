"""Guard rails: keep the tool aimed at systems you are allowed to test.

These checks are deliberately conservative. They are not a substitute for
permission from the owner of the target - they just make it hard to fire this
thing at a third party by accident (or on a whim).
"""

from __future__ import annotations

import ipaddress
import socket
from dataclasses import dataclass
from urllib.parse import urlparse

# Hard ceilings. Hitting these means "run a real distributed load generator",
# not "raise the flag".
MAX_CONCURRENCY = 1_000
MAX_RPS = 5_000
MAX_DURATION = 900.0  # 15 minutes

LOCAL_NAMES = {"localhost", "127.0.0.1", "::1", "0.0.0.0", "[::1]"}


class SafetyError(Exception):
    """Raised when a run is refused before a single request is sent."""


@dataclass(frozen=True)
class Target:
    """A validated, normalised target URL."""

    url: str
    scheme: str
    host: str  # hostname as typed (may be an IP literal)
    port: int
    path: str
    netloc: str

    @property
    def is_local(self) -> bool:
        if self.host.lower() in LOCAL_NAMES:
            return True
        try:
            addr = ipaddress.ip_address(self.host)
        except ValueError:
            return False
        return addr.is_loopback

    @property
    def origin(self) -> str:
        return f"{self.scheme}://{self.netloc}"


def parse_target(url: str) -> Target:
    """Validate *url* and break it into the pieces the engine needs."""
    if not url:
        raise SafetyError("no target URL given")

    if "://" not in url:
        url = "http://" + url

    parsed = urlparse(url)

    if parsed.scheme not in ("http", "https"):
        raise SafetyError(
            f"unsupported scheme {parsed.scheme!r} - only http and https are supported"
        )
    if not parsed.hostname:
        raise SafetyError(f"could not read a hostname out of {url!r}")
    if parsed.params or parsed.fragment:
        raise SafetyError("URL params/fragments are not supported")

    host = parsed.hostname
    # Reject embedded credentials: they are a sign of a copy-pasted URL that
    # points somewhere the operator did not intend, and http.client handles
    # auth badly anyway.
    if parsed.username or parsed.password:
        raise SafetyError(
            "remove embedded credentials from the URL and pass an "
            "Authorization header with -H instead"
        )

    try:
        ipaddress.ip_address(host)
    except ValueError:
        pass

    port = parsed.port or (443 if parsed.scheme == "https" else 80)
    path = parsed.path or "/"
    if parsed.query:
        path = f"{path}?{parsed.query}"

    return Target(
        url=url,
        scheme=parsed.scheme,
        host=host,
        port=port,
        path=path,
        netloc=parsed.netloc,
    )


def check_limits(concurrency: int, rps: float, duration: float) -> None:
    """Refuse runs that are large enough to be someone else's problem."""
    if concurrency < 1:
        raise SafetyError("concurrency must be at least 1")
    if concurrency > MAX_CONCURRENCY:
        raise SafetyError(
            f"concurrency {concurrency} exceeds the built-in ceiling of "
            f"{MAX_CONCURRENCY}; use a distributed load generator for more"
        )
    if rps < 0:
        raise SafetyError("rate cannot be negative")
    if rps > MAX_RPS:
        raise SafetyError(
            f"rate {rps:g} req/s exceeds the built-in ceiling of {MAX_RPS} req/s"
        )
    if duration <= 0:
        raise SafetyError("duration must be positive")
    if duration > MAX_DURATION:
        raise SafetyError(
            f"duration {duration:g}s exceeds the built-in ceiling of {MAX_DURATION:g}s"
        )


def resolves_to_private(target: Target) -> bool:
    """True if the hostname resolves only to non-public address space.

    Used to print a heads-up, not to block: plenty of legitimate targets sit
    behind a VPN or on a staging box.
    """
    try:
        infos = socket.getaddrinfo(target.host, target.port, proto=socket.IPPROTO_TCP)
    except OSError:
        return False
    addrs = [info[4][0] for info in infos]
    if not addrs:
        return False
    return all(_is_private(a) for a in addrs)


def _is_private(addr: str) -> bool:
    try:
        ip = ipaddress.ip_address(addr)
    except ValueError:
        return False
    return (
        ip.is_private
        or ip.is_loopback
        or ip.is_link_local
        or ip.is_reserved
        or ip.is_multicast
    )


def authorization_required(target: Target, authorize: bool) -> None:
    """Block non-local targets unless the operator passed --authorize."""
    if target.is_local:
        return
    if not authorize:
        raise SafetyError(
            f"{target.origin} is not a loopback address.\n"
            "  This tool sends sustained traffic and can take a site offline.\n"
            "  Only test it against infrastructure you own, or have written\n"
            "  permission to test. Re-run with --authorize to confirm that."
        )


CONSENT_LINE = (
    "You are about to send load to {origin}.\n"
    "Confirm you own this host or have written permission to test it."
)


def confirm_interactively(target: Target, stream_in=None, stream_out=None) -> bool:
    """Ask the operator to type the hostname as an explicit confirmation.

    Returns True if confirmed. Returns False for non-local targets when the
    session is not interactive (no way to ask), which callers treat as a
    refusal.
    """
    import sys

    stream_in = stream_in or sys.stdin
    stream_out = stream_out or sys.stderr

    print(CONSENT_LINE.format(origin=target.origin), file=stream_out)
    print(f"  Type the hostname to continue: {target.host}", file=stream_out)

    if not (hasattr(stream_in, "isatty") and stream_in.isatty()):
        print("  (non-interactive session: pass --yes to confirm)", file=stream_out)
        return False

    try:
        answer = input("  > ").strip()
    except (EOFError, KeyboardInterrupt):
        print(file=stream_out)
        return False

    return answer.lower() == target.host.lower()
