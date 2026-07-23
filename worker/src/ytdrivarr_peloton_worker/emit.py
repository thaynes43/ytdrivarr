"""Build the SubscriptionEntry list + telemetry/summary, and render the YAML.

``SubscriptionEntry`` is the transport shape the worker REPORTS to the CORE (the
CORE owns the final file). ``render_subscriptions_yaml`` reproduces the live-file
shape and is used ONLY by validation/dry-run mode to emit to a scratch path and
diff against the baked sample.
"""

from __future__ import annotations

import re
from dataclasses import dataclass, field

import yaml

from . import baked_sample
from .folders import chip_for, tv_show_directory
from .metadata import player_url_for, sanitize_for_filesystem

PRESET_NAME = baked_sample.PRESET_NAME
CHIP_RE = re.compile(r"^=\s*(.+?)\s*\((\d+)\s*min\)\s*$")


@dataclass
class ScrapedClass:
    """One scraped Peloton class, fully numbered and ready to become an entry."""

    class_id: str
    title: str
    instructor: str
    activity: str  # the raw activity token (e.g. "bike_bootcamp")
    duration: int
    season: int
    episode: int


@dataclass
class SubscriptionEntry:
    entry_key: str
    display_name: str
    download_ref: str
    preset: str
    chip: str
    overrides: dict

    def to_transport(self) -> dict:
        return {
            "entryKey": self.entry_key,
            "displayName": self.display_name,
            "downloadRef": self.download_ref,
            "preset": self.preset,
            "chip": self.chip,
            "overrides": dict(self.overrides),
        }


def build_entry(sc: ScrapedClass, media_root: str) -> SubscriptionEntry:
    """Turn a ScrapedClass into the contract SubscriptionEntry."""
    safe_title = sanitize_for_filesystem(sc.title)
    safe_instructor = sanitize_for_filesystem(sc.instructor)
    display_name = f"{safe_title} with {safe_instructor}"
    return SubscriptionEntry(
        entry_key=sc.class_id,
        display_name=display_name,
        download_ref=player_url_for(sc.class_id),
        preset=PRESET_NAME,
        chip=chip_for(sc.activity, sc.duration),
        overrides={
            "tv_show_directory": tv_show_directory(media_root, sc.activity, sc.instructor),
            "season_number": sc.season,
            "episode_number": sc.episode,
        },
    )


def build_telemetry(
    *,
    activity_results: list,
    numbering_snapshot: dict,
    login_attempts: int = 0,
    bearer_attempts: int = 0,
    duration_ms: int | None = None,
    alarms: list | None = None,
    extra: dict | None = None,
) -> dict:
    """Structured telemetry (replaces the donor's text-summaries-into-logs)."""
    per_activity = []
    total_links = total_new = total_skipped = total_malformed = total_scrolls = 0
    drift_activities: list[str] = []
    for r in activity_results:
        total_links += r.links_found
        total_new += len(r.entries)
        total_skipped += r.skipped_existing
        total_malformed += r.malformed
        total_scrolls += r.scrolls_performed
        if r.selector_drift:
            drift_activities.append(r.activity)
        per_activity.append(
            {
                "activity": r.activity,
                "linksFound": r.links_found,
                "newEntries": len(r.entries),
                "skippedExisting": r.skipped_existing,
                "malformed": r.malformed,
                "scrollsPerformed": r.scrolls_performed,
                "scrollCapped": r.scroll_capped,
                "selectorDrift": r.selector_drift,
                "zeroLinks": r.zero_links,
            }
        )
    telemetry = {
        "activitiesScraped": len(activity_results),
        "linksFound": total_links,
        "entriesBuilt": total_new,
        "skippedExisting": total_skipped,
        "malformed": total_malformed,
        # Run-level scrape-health aggregates the CORE reads into the run summary + the
        # `ytdrivarr_last_run_scrolls` / `_selector_drift_hits` gauges. Previously absent,
        # so both metrics read a structural 0 even when the scraper scrolled / drifted.
        "scrollsPerformed": total_scrolls,
        "selectorDriftHits": len(drift_activities),
        "selectorDriftActivities": drift_activities,
        # build_telemetry runs only after a successful login (worker._handle raises before
        # here on any non-ok login), so auth/login are definitively ok on this leg — record
        # it so the owner's daily-review Health section reads "ok / ok", not "n/a".
        "authOk": True,
        "loginOk": True,
        "loginAttempts": login_attempts,
        "bearerAttempts": bearer_attempts,
        # Per-activity high-water marks: {activitySlug: {durationString: max}} —
        # mirrors the new per-(activity, duration) numbering contract.
        "episodeHighWater": {
            slug: {str(d): m for d, m in (band or {}).items()}
            for slug, band in (numbering_snapshot or {}).items()
        },
        "perActivity": per_activity,
        "alarms": list(alarms or []),
    }
    if duration_ms is not None:
        telemetry["durationMs"] = duration_ms
    if extra:
        telemetry.update(extra)
    return telemetry


def build_summary(entries: list, activity_results: list) -> dict:
    """A compact, human-oriented summary of the run."""
    by_activity: dict[str, int] = {}
    by_duration: dict[str, int] = {}
    for e in entries:
        # chip is "{Activity} (N min)"
        m = re.match(r"^(.*)\s*\((\d+)\s*min\)$", e.chip)
        if m:
            by_activity[m.group(1).strip()] = by_activity.get(m.group(1).strip(), 0) + 1
            by_duration[m.group(2)] = by_duration.get(m.group(2), 0) + 1
    return {
        "totalNew": len(entries),
        "activities": len(activity_results),
        "byActivity": by_activity,
        "byDuration": by_duration,
    }


def render_subscriptions_yaml(
    entries: list,
    media_root: str = "/media/peloton",
    include_preset: bool = True,
) -> str:
    """Render entries to the live subscriptions-file YAML shape.

    Groups entries under ``= {chip}`` in insertion order; disambiguates
    colliding display names with a ``(N)`` suffix (donor parity). Emits the
    baked ``__preset__`` block first.
    """
    data: dict = {}
    if include_preset:
        data["__preset__"] = baked_sample.preset_block(media_root)

    groups: dict[str, dict] = {}
    dupes: dict[str, int] = {}
    for e in entries:
        group_key = f"= {e.chip}"
        groups.setdefault(group_key, {})
        name = e.display_name
        if name in groups[group_key]:
            dupes[name] = dupes.get(name, 1)
            name = f"{e.display_name} ({dupes[name]})"
            dupes[e.display_name] += 1
        groups[group_key][name] = {
            "download": e.download_ref,
            "overrides": dict(e.overrides),
        }
    data[PRESET_NAME] = groups
    return yaml.dump(
        data,
        sort_keys=False,
        allow_unicode=True,
        default_flow_style=False,
        indent=2,
        width=4096,
    )


@dataclass
class ShapeVerdict:
    ok: bool
    checks: list = field(default_factory=list)
    mismatches: list = field(default_factory=list)

    def as_dict(self) -> dict:
        return {"ok": self.ok, "checks": self.checks, "mismatches": self.mismatches}


def shape_diff(rendered_yaml: str) -> ShapeVerdict:
    """Verify rendered YAML matches the baked live-file shape. No live access."""
    checks: list[str] = []
    mismatches: list[str] = []
    try:
        data = yaml.safe_load(rendered_yaml)
    except yaml.YAMLError as exc:
        return ShapeVerdict(False, checks, [f"invalid YAML: {exc}"])

    if not isinstance(data, dict):
        return ShapeVerdict(False, checks, ["top level is not a mapping"])

    for key in baked_sample.REQUIRED_TOP_LEVEL:
        if key in data:
            checks.append(f"top-level key present: {key}")
        else:
            mismatches.append(f"missing top-level key: {key}")

    preset = data.get("__preset__", {})
    for key in ("overrides", "output_options", "throttle_protection", "ytdl_options"):
        if key in preset:
            checks.append(f"__preset__.{key} present")
        else:
            mismatches.append(f"__preset__ missing {key}")

    shows = data.get(baked_sample.PRESET_NAME, {})
    if not isinstance(shows, dict):
        mismatches.append(f"'{baked_sample.PRESET_NAME}' is not a mapping")
        return ShapeVerdict(not mismatches, checks, mismatches)

    entries_checked = 0
    for chip, group in shows.items():
        m = CHIP_RE.match(chip)
        if not m:
            mismatches.append(f"chip does not match '= Activity (N min)': {chip!r}")
            continue
        chip_minutes = int(m.group(2))
        if not isinstance(group, dict):
            mismatches.append(f"group {chip!r} is not a mapping")
            continue
        for name, body in group.items():
            entries_checked += 1
            for k in baked_sample.REQUIRED_ENTRY_KEYS:
                if k not in body:
                    mismatches.append(f"entry {name!r} missing {k}")
            download = body.get("download", "")
            if "/classes/player/" not in download:
                mismatches.append(f"entry {name!r} download not a player URL: {download!r}")
            ov = body.get("overrides", {})
            for k in baked_sample.REQUIRED_OVERRIDE_KEYS:
                if k not in ov:
                    mismatches.append(f"entry {name!r} overrides missing {k}")
            if ov.get("season_number") != chip_minutes:
                mismatches.append(
                    f"entry {name!r} season_number {ov.get('season_number')} != chip {chip_minutes}"
                )
            if not isinstance(ov.get("episode_number"), int):
                mismatches.append(f"entry {name!r} episode_number is not an int")
    if entries_checked:
        checks.append(f"validated {entries_checked} entries against live shape")
    return ShapeVerdict(not mismatches, checks, mismatches)
