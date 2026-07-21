"""Activity -> folder mapping + bootcamp collapse, ported EXACTLY from the donor.

Ports ``ScrapedClass._get_activity_folder_name`` /
``activity_based_path_strategy`` so ``tv_show_directory`` and the ``= {Activity}
(N min)`` chip agree with the live file.
"""

from __future__ import annotations

from .metadata import sanitize_for_filesystem

# Bootcamp variants collapse to their canonical folder names (donor parity).
BOOTCAMP_MAPPINGS = {
    "bootcamp": "Tread Bootcamp",
    "bike_bootcamp": "Bike Bootcamp",
    "row_bootcamp": "Row Bootcamp",
}


def activity_folder_name(activity: str) -> str:
    """Canonical folder/chip name for an activity token.

    ``bootcamp`` -> ``Tread Bootcamp``, ``bike_bootcamp`` -> ``Bike Bootcamp``,
    ``row_bootcamp`` -> ``Row Bootcamp``; everything else is title-cased with
    underscores turned into spaces (``cycling`` -> ``Cycling``).
    """
    key = (activity or "").lower()
    if key in BOOTCAMP_MAPPINGS:
        return BOOTCAMP_MAPPINGS[key]
    return (activity or "").replace("_", " ").title()


def tv_show_directory(media_root: str, activity: str, instructor: str) -> str:
    """``{mediaRoot}/{Activity}/{Instructor}`` with fs-safe segments.

    ``activity`` here is the raw activity token (e.g. ``bike_bootcamp``); it is
    run through the folder mapping. ``media_root`` trailing separators trimmed.
    """
    root = (media_root or "").rstrip("/\\")
    safe_activity = sanitize_for_filesystem(activity)
    folder = activity_folder_name(safe_activity)
    safe_instructor = sanitize_for_filesystem(instructor)
    return f"{root}/{folder}/{safe_instructor}"


def chip_for(activity: str, duration_minutes: int) -> str:
    """The ``{Activity} (N min)`` chip label (no ``=`` prefix; emit adds it)."""
    folder = activity_folder_name(sanitize_for_filesystem(activity))
    return f"{folder} ({duration_minutes} min)"
