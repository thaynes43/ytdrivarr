"""Per-duration episode numbering, ported from ``episodes_from_subscriptions``.

Season = raw duration minutes. Episode = a per-DURATION global counter that
*continues from* ``payload.peloton.episodeNumbering[duration]`` (the current
high-water mark the CORE computed across disk + the existing subscriptions
YAML). New classes get sequential episode numbers above that max; already-known
class ids are skipped upstream so published numbers stay immutable (D-06).
"""

from __future__ import annotations


class EpisodeNumberer:
    """Hands out the next episode number for a given duration (season).

    Seeded with ``{duration: currentMaxEpisode}``. The first ``next(d)`` returns
    ``max + 1``; subsequent calls keep incrementing per duration. Durations not
    in the seed start at 1.
    """

    def __init__(self, seed: dict | None = None) -> None:
        self._counters: dict[int, int] = {}
        for duration, current_max in (seed or {}).items():
            self._counters[int(duration)] = int(current_max)

    def current_max(self, duration: int) -> int:
        return self._counters.get(int(duration), 0)

    def next(self, duration: int) -> int:
        duration = int(duration)
        nxt = self._counters.get(duration, 0) + 1
        self._counters[duration] = nxt
        return nxt

    def snapshot(self) -> dict[int, int]:
        """Current high-water marks per duration (for telemetry/report)."""
        return dict(self._counters)
