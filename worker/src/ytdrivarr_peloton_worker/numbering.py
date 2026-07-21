"""Per-(activity, duration) episode numbering — donor parity with the
per-activity ``ScrapingConfig.episode_numbering_data`` in
``webscraper/peloton/scraper_strategy.py``.

Season = raw duration minutes. Episode = a per-DURATION counter that is scoped
to ONE activity: the worker builds a *fresh* ``EpisodeNumberer`` for each
activity, seeded from that activity's own band —
``payload.peloton.episodeNumbering[activitySlug]`` (``{duration: currentMax}``,
the high-water mark the CORE computed across disk + subscriptions for THAT
activity). Counters are never shared across activities, so Cardio E223 and
Cycling E2151 advance in disjoint bands even for the same 30-min season.

New classes get sequential episode numbers above that per-activity max;
already-known class ids are skipped upstream so published numbers stay
immutable (D-06).
"""

from __future__ import annotations


class EpisodeNumberer:
    """Hands out the next episode number for a given duration (season), within a
    SINGLE activity's band.

    Seeded with that activity's ``{duration: currentMaxEpisode}`` band (donor:
    ``dict(activity_data.max_episode)``). The first ``next(d)`` returns
    ``max + 1``; subsequent calls keep incrementing per duration. Durations not
    in the seed start at 1 (``counters.get(d, 0) + 1``). One instance per
    activity — the worker never shares a numberer across activities.
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
