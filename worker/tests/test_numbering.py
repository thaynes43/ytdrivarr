"""Per-(activity, duration) episode numbering: one band per activity —
continue-from-max, sequential, per-duration independent, immutable.

An ``EpisodeNumberer`` models ONE activity's band ({duration: max}); the worker
builds a fresh one per activity, so cross-activity independence is asserted in
``test_worker.py``. These tests pin the within-a-band semantics.
"""

from __future__ import annotations

from ytdrivarr_peloton_worker.numbering import EpisodeNumberer


def test_continue_from_seeded_max():
    n = EpisodeNumberer({30: 730})
    assert n.next(30) == 731
    assert n.next(30) == 732


def test_sequential_per_duration_independent():
    n = EpisodeNumberer({30: 100, 45: 5})
    assert n.next(30) == 101
    assert n.next(45) == 6
    assert n.next(30) == 102
    assert n.next(45) == 7


def test_multiple_durations_within_one_activity_independent():
    # Test #3: within a SINGLE activity (e.g. cycling), 20-min and 30-min
    # seasons advance in independent bands — one duration never bleeds into another.
    cycling = EpisodeNumberer({20: 40, 30: 2150})
    assert cycling.next(30) == 2151
    assert cycling.next(20) == 41
    assert cycling.next(30) == 2152
    assert cycling.next(20) == 42
    assert cycling.snapshot() == {20: 42, 30: 2152}


def test_unseeded_duration_starts_at_one():
    # Test #2: an unseeded (activity,duration) starts at 1 — counters.get(d,0)+1.
    n = EpisodeNumberer({})
    assert n.next(20) == 1
    assert n.next(20) == 2
    assert n.next(10) == 1


def test_raw_duration_is_its_own_band():
    # Test #7 tie-in: numbering keys off the RAW duration. A 35-min class lives in
    # season 35's band — it is never folded into 30 or 40 by rounding.
    n = EpisodeNumberer({35: 10})
    assert n.next(35) == 11
    assert n.next(30) == 1  # 30 is a distinct, unseeded band
    assert n.snapshot() == {35: 11, 30: 1}


def test_string_keys_in_seed_are_coerced():
    # Test #4: payload JSON duration keys arrive as strings; numberer coerces to int.
    n = EpisodeNumberer({"30": 730})
    assert n.next(30) == 731


def test_snapshot_reflects_high_water():
    n = EpisodeNumberer({30: 730})
    n.next(30)
    n.next(45)
    assert n.snapshot() == {30: 731, 45: 1}


def test_current_max_does_not_advance():
    n = EpisodeNumberer({30: 730})
    assert n.current_max(30) == 730
    assert n.current_max(30) == 730  # idempotent read
    assert n.next(30) == 731
