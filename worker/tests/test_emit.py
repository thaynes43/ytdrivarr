"""Entry building, transport serialization, YAML render + shape-diff."""

from __future__ import annotations

import yaml

from ytdrivarr_peloton_worker.emit import (
    ScrapedClass,
    build_entry,
    build_telemetry,
    render_subscriptions_yaml,
    shape_diff,
)
from ytdrivarr_peloton_worker.scraper import ActivityScrapeResult


def _sc(class_id="c1", title="30 min Ride", instructor="Cody Rigsby",
        activity="cycling", duration=30, episode=101):
    return ScrapedClass(
        class_id=class_id, title=title, instructor=instructor, activity=activity,
        duration=duration, season=duration, episode=episode,
    )


def test_build_entry_shape():
    e = build_entry(_sc(), "/media/peloton")
    assert e.entry_key == "c1"
    assert e.display_name == "30 min Ride with Cody Rigsby"
    assert e.download_ref == "https://members.onepeloton.com/classes/player/c1"
    assert e.preset == "Plex TV Show by Date"
    assert e.chip == "Cycling (30 min)"
    assert e.overrides == {
        "tv_show_directory": "/media/peloton/Cycling/Cody Rigsby",
        "season_number": 30,
        "episode_number": 101,
    }


def test_to_transport_contract_keys():
    t = build_entry(_sc(), "/media/peloton").to_transport()
    assert set(t) == {"entryKey", "displayName", "downloadRef", "preset", "chip", "overrides"}
    assert t["entryKey"] == "c1"
    assert t["overrides"]["season_number"] == 30


def test_build_telemetry_episode_high_water_is_per_activity():
    # The high-water snapshot is now nested per activity: {slug: {durationStr: max}}.
    results = [
        ActivityScrapeResult(activity="cardio", entries=[build_entry(_sc("ca1"), "/m")],
                             links_found=1, new_candidates=1),
        ActivityScrapeResult(activity="cycling", entries=[build_entry(_sc("cy1"), "/m")],
                             links_found=1, new_candidates=1),
    ]
    telemetry = build_telemetry(
        activity_results=results,
        numbering_snapshot={"cardio": {30: 224}, "cycling": {20: 41, 30: 2152}},
        alarms=[],
    )
    assert telemetry["episodeHighWater"] == {
        "cardio": {"30": 224},
        "cycling": {"20": 41, "30": 2152},
    }


def test_build_telemetry_carries_run_level_scrape_health():
    # The CORE reads these run-level aggregates into the run summary + the
    # ytdrivarr_last_run_scrolls / _selector_drift_hits gauges. A cycling activity
    # that scrolled 4×, plus a cardio activity that found links but parsed none
    # (selector drift), must surface as scrollsPerformed=6 and one drift hit.
    results = [
        ActivityScrapeResult(activity="cycling", entries=[build_entry(_sc("cy1"), "/m")],
                             links_found=1, new_candidates=1, scrolls_performed=4),
        ActivityScrapeResult(activity="cardio", entries=[], links_found=3,
                             new_candidates=3, scrolls_performed=2),  # drift: links, 0 parsed
    ]
    assert results[1].selector_drift is True
    telemetry = build_telemetry(
        activity_results=results,
        numbering_snapshot={},
        login_attempts=2,
        bearer_attempts=1,
        alarms=[],
    )
    assert telemetry["scrollsPerformed"] == 6
    assert telemetry["selectorDriftHits"] == 1
    assert telemetry["selectorDriftActivities"] == ["cardio"]
    assert telemetry["loginAttempts"] == 2
    assert telemetry["bearerAttempts"] == 1
    # build_telemetry only runs post-successful-login -> auth/login recorded ok.
    assert telemetry["authOk"] is True and telemetry["loginOk"] is True


def test_render_yaml_live_shape_and_grouping():
    entries = [
        build_entry(_sc("a", "30 min Ride", "Cody Rigsby", duration=30, episode=1), "/media/peloton"),
        build_entry(_sc("b", "45 min Climb", "Ally Love", duration=45, episode=2), "/media/peloton"),
    ]
    text = render_subscriptions_yaml(entries, "/media/peloton")
    data = yaml.safe_load(text)
    assert set(data) == {"__preset__", "Plex TV Show by Date"}
    assert data["__preset__"]["ytdl_options"]["http_headers"]["Authorization"] == "${PELOTON_BEARER}"
    shows = data["Plex TV Show by Date"]
    assert "= Cycling (30 min)" in shows
    assert "= Cycling (45 min)" in shows
    entry = shows["= Cycling (30 min)"]["30 min Ride with Cody Rigsby"]
    assert entry["download"] == "https://members.onepeloton.com/classes/player/a"
    assert entry["overrides"]["season_number"] == 30


def test_render_yaml_dedup_colliding_names():
    entries = [
        build_entry(_sc("a", "30 min Ride", "Cody Rigsby", episode=1), "/media/peloton"),
        build_entry(_sc("b", "30 min Ride", "Cody Rigsby", episode=2), "/media/peloton"),
    ]
    data = yaml.safe_load(render_subscriptions_yaml(entries, "/media/peloton"))
    group = data["Plex TV Show by Date"]["= Cycling (30 min)"]
    assert "30 min Ride with Cody Rigsby" in group
    assert "30 min Ride with Cody Rigsby (1)" in group
    assert len(group) == 2


def test_shape_diff_passes_on_rendered_output():
    entries = [build_entry(_sc(), "/media/peloton")]
    verdict = shape_diff(render_subscriptions_yaml(entries, "/media/peloton"))
    assert verdict.ok is True
    assert verdict.mismatches == []
    assert any("validated" in c for c in verdict.checks)


def test_shape_diff_flags_season_chip_mismatch():
    broken = """
__preset__:
  overrides: {}
  output_options: {}
  throttle_protection: {}
  ytdl_options: {}
Plex TV Show by Date:
  = Cycling (30 min):
    Bad Entry:
      download: https://members.onepeloton.com/classes/player/x
      overrides:
        tv_show_directory: /media/peloton/Cycling/Cody Rigsby
        season_number: 45
        episode_number: 3
"""
    verdict = shape_diff(broken)
    assert verdict.ok is False
    assert any("season_number 45 != chip 30" in m for m in verdict.mismatches)


def test_shape_diff_flags_bad_chip():
    broken = """
__preset__:
  overrides: {}
  output_options: {}
  throttle_protection: {}
  ytdl_options: {}
Plex TV Show by Date:
  Not A Chip:
    E:
      download: https://members.onepeloton.com/classes/player/x
      overrides:
        tv_show_directory: /media/peloton/Cycling/X
        season_number: 30
        episode_number: 1
"""
    verdict = shape_diff(broken)
    assert verdict.ok is False
    assert any("chip does not match" in m for m in verdict.mismatches)


def test_shape_diff_flags_bad_download_and_missing_overrides():
    broken = """
__preset__:
  overrides: {}
  output_options: {}
  throttle_protection: {}
  ytdl_options: {}
Plex TV Show by Date:
  = Cycling (30 min):
    E:
      download: not-a-player-url
      overrides: {}
"""
    verdict = shape_diff(broken)
    assert verdict.ok is False
    assert any("not a player URL" in m for m in verdict.mismatches)
    assert any("overrides missing" in m for m in verdict.mismatches)
