"""
One source of time for the whole twin.

Every module that ages a track, expires a lease or stamps an event reads the
clock through here rather than calling time.time() directly. That single seam
is what lets scripts/experiment.py run a forty-minute shift in a couple of
seconds: it installs a virtual clock and steps it, and the token allocator,
the staleness logic and the loading dwells all follow without knowing.

It also means the interlocking can be tested against contrived timing —
"expire this lease at exactly T+15" — instead of by sleeping.
"""

from __future__ import annotations

import time
from typing import Callable

_source: Callable[[], float] = time.time


def now() -> float:
    """Current time in seconds. Wall clock unless a virtual one is installed."""
    return _source()


def set_source(fn: Callable[[], float]) -> None:
    global _source
    _source = fn


def use_wall_clock() -> None:
    global _source
    _source = time.time


class VirtualClock:
    """A clock the caller advances by hand."""

    def __init__(self, start: float = 1_700_000_000.0) -> None:
        self.t = start

    def __call__(self) -> float:
        return self.t

    def advance(self, dt: float) -> float:
        self.t += dt
        return self.t

    def install(self) -> "VirtualClock":
        set_source(self)
        return self
