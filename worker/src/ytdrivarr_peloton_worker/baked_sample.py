"""A small baked sample of the live subscriptions-file shape.

Used only by validation/dry-run mode to (a) render a faithful ``__preset__``
block and (b) produce a shape-diff verdict WITHOUT reaching the live file. Taken
verbatim from ``/tmp/spec/live-peloton-subscriptions.yaml`` (the 1,454-line
production file). ``{media_root}`` is the only parameterised value.
"""

from __future__ import annotations

PRESET_NAME = "Plex TV Show by Date"


def preset_block(media_root: str = "/media/peloton") -> dict:
    """The live ``__preset__`` block, with the media root parameterised."""
    root = (media_root or "/media/peloton").rstrip("/\\")
    return {
        "overrides": {
            "tv_show_directory": root,
            "only_recent_date_range": "24months",
            "only_recent_max_files": 300,
        },
        "output_options": {
            "output_directory": "{tv_show_directory}",
            "file_name": (
                "S{season_number}E{episode_number} - {upload_date} - {title}/"
                "S{season_number}E{episode_number} - {upload_date} - {title}.{ext}"
            ),
            "thumbnail_name": (
                "S{season_number}E{episode_number} - {upload_date} - {title}/"
                "S{season_number}E{episode_number} - {upload_date} - {title}-thumb.jpg"
            ),
            "info_json_name": (
                "S{season_number}E{episode_number} - {upload_date} - {title}/"
                "S{season_number}E{episode_number} - {upload_date} - {title}.info.json"
            ),
        },
        "throttle_protection": {
            "sleep_per_download_s": {"min": 120, "max": 270},
            "sleep_per_subscription_s": {"min": 60, "max": 90},
            "max_downloads_per_subscription": {"min": 25, "max": 75},
            "subscription_download_probability": 1,
        },
        "ytdl_options": {
            "format": "bestvideo+bestaudio/bestaudio",
            "merge_output_format": "mp4",
            "writethumbnail": False,
            "break_on_existing": False,
            "cookiefile": f"{root}/cookies.txt",
            "http_headers": {
                "Authorization": "${PELOTON_BEARER}",
                "Origin": "https://members.onepeloton.com",
                "Referer": "https://members.onepeloton.com/",
            },
        },
    }


# A couple of representative entries, verbatim, for the shape-diff baseline.
SAMPLE_ENTRIES = {
    "= Bike Bootcamp (30 min)": {
        "30 min Bootcamp: 50-50 with Tunde Oyeneyin": {
            "download": "https://members.onepeloton.com/classes/player/c7fee9be57994db3808cf318d00cb732",
            "overrides": {
                "tv_show_directory": "/media/peloton/Bike Bootcamp/Tunde Oyeneyin",
                "season_number": 30,
                "episode_number": 730,
            },
        },
    },
    "= Meditation (10 min)": {
        "10 min Kindness Meditation with Ross Rayburn": {
            "download": "https://members.onepeloton.com/classes/player/79428523b98e430282f40c91e995e1e5",
            "overrides": {
                "tv_show_directory": "/media/peloton/Meditation/Ross Rayburn",
                "season_number": 10,
                "episode_number": 1051,
            },
        },
    },
}

#: Required top-level keys of the file.
REQUIRED_TOP_LEVEL = ("__preset__", PRESET_NAME)
#: Required keys inside each entry's body / overrides.
REQUIRED_ENTRY_KEYS = ("download", "overrides")
REQUIRED_OVERRIDE_KEYS = ("tv_show_directory", "season_number", "episode_number")
