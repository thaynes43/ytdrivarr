"""Per-duration episode numbering: continue-from-max, sequential, immutable."""

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


def test_unseeded_duration_starts_at_one():
    n = EpisodeNumberer({})
    assert n.next(20) == 1
    assert n.next(20) == 2
    assert n.next(10) == 1


def test_string_keys_in_seed_are_coerced():
    # Payload JSON keys arrive as strings; numberer coerces to int.
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
