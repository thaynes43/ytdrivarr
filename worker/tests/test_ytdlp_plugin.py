"""The yt-dlp Peloton override plugin ytdrivarr projects to the downloader (#40).

The plugin lives with the Peloton provider (``src/providers/peloton/ytdlp-plugins``)
because the core projects it; it is tested here because this is the Python suite.
yt-dlp is pinned in the dev extras to the version ytdl-sub pins.
"""

from __future__ import annotations

import importlib.util
import os
import subprocess
import sys
from pathlib import Path

import pytest

yt_dlp = pytest.importorskip("yt_dlp")
from yt_dlp.networking.common import Response  # noqa: E402
from yt_dlp.networking.exceptions import HTTPError  # noqa: E402
from yt_dlp.utils import ExtractorError  # noqa: E402

PLUGIN_ROOT = Path(__file__).resolve().parents[2] / "src/providers/peloton/ytdlp-plugins"
PLUGIN_FILE = PLUGIN_ROOT / "yt_dlp_plugins/extractor/ytdrivarr_peloton.py"
CLASS_ID = "0123456789abcdef0123456789abcdef"
PLAYER_URL = f"https://members.onepeloton.com/classes/player/{CLASS_ID}"
SIGNED_URL = "https://cdn.example.test/classes/x/master.m3u8?hdnts=fake-signature&platform=web"


def _load_plugin():
    spec = importlib.util.spec_from_file_location("ytdrivarr_peloton_under_test", PLUGIN_FILE)
    module = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(module)
    return module._YtdrivarrPelotonIE


PLUGIN_IE = _load_plugin()


def _http_error(status: int, body: bytes) -> ExtractorError:
    import io

    response = Response(io.BytesIO(body), url="https://api.onepeloton.com/x", headers={}, status=status)
    return ExtractorError("http error", cause=HTTPError(response))


class Recorder:
    """Stands in for the network: answers by URL and records every request."""

    def __init__(self, ride: dict, stream: dict | Exception | None = None) -> None:
        self.ride = ride
        self.stream = {"url": SIGNED_URL} if stream is None else stream
        self.json_calls: list[tuple[str, bytes | None]] = []
        self.m3u8_urls: list[str] = []

    def install(self, ie, monkeypatch) -> None:
        monkeypatch.setattr(ie, "_download_webpage", lambda *a, **k: "")
        monkeypatch.setattr(ie, "_download_json", self.download_json)
        monkeypatch.setattr(ie, "_extract_m3u8_formats_and_subtitles", self.m3u8)

    def download_json(self, url, video_id, note=None, data=None, headers=None, **kwargs):
        self.json_calls.append((url, data))
        if "/details" in url:
            return {"ride": self.ride, "segments": {"segment_list": []}}
        if "/stream?content_type=on_demand" in url:
            if isinstance(self.stream, Exception):
                raise self.stream
            return self.stream
        raise AssertionError(f"unexpected JSON request: {url}")

    def m3u8(self, url, video_id, ext=None, **kwargs):
        self.m3u8_urls.append(url)
        return [{"format_id": "401", "url": url, "ext": "mp4"}], {}


def _ie():
    return PLUGIN_IE(yt_dlp.YoutubeDL({"quiet": True, "no_warnings": True}))


VOD_RIDE = {
    "title": "20 min Pop Ride",
    "vod_stream_url": "https://cdn.example.test/classes/x/master.m3u8?platform=web",
    "length": 1260,
    "original_air_time": 1_790_000_000,
    "fitness_discipline_display_name": "Cycling",
    "instructor": {"name": "Some Instructor"},
    "captions": ["en-US"],
}


def test_overrides_the_builtin_peloton_extractor():
    assert PLUGIN_IE.IE_NAME == "peloton+ytdrivarr"
    assert PLUGIN_IE.ie_key() == "Peloton"
    assert PLUGIN_IE.suitable(PLAYER_URL)


def test_manifest_comes_from_the_signed_stream_url(monkeypatch):
    ie, net = _ie(), Recorder(VOD_RIDE)
    net.install(ie, monkeypatch)

    info = ie._real_extract(PLAYER_URL)

    assert net.m3u8_urls == [SIGNED_URL]
    stream_calls = [(u, d) for u, d in net.json_calls if "/stream" in u]
    assert stream_calls == [(f"https://api.onepeloton.com/api/ride/{CLASS_ID}/stream?content_type=on_demand", b"")]
    # the legacy token leg (subscription/stream + ?hdnea=) is never used for a VOD class
    assert not any("subscription/stream" in u for u, _ in net.json_calls)
    assert not any("hdnea" in u for u in net.m3u8_urls)
    assert info["id"] == CLASS_ID
    assert info["title"] == "20 min Pop Ride"
    assert info["creator"] == "Some Instructor"
    assert info["categories"] == ["Cycling"]
    assert info["is_live"] is False


def test_audio_class_uses_the_signed_url_directly(monkeypatch):
    ie, net = _ie(), Recorder({**VOD_RIDE, "content_format": "audio"})
    net.install(ie, monkeypatch)

    info = ie._real_extract(PLAYER_URL)

    assert net.m3u8_urls == []
    assert info["formats"] == [{"url": SIGNED_URL, "ext": "m4a", "format_id": "audio", "vcodec": "none"}]


def test_missing_signed_url_is_an_error(monkeypatch):
    ie, net = _ie(), Recorder(VOD_RIDE, stream={"stream_history_id": "x"})
    net.install(ie, monkeypatch)

    with pytest.raises(ExtractorError, match="no signed stream URL"):
        ie._real_extract(PLAYER_URL)


def test_stream_limit_is_an_expected_error(monkeypatch):
    err = _http_error(403, b'{"message": "Stream limit reached"}')
    ie, net = _ie(), Recorder(VOD_RIDE, stream=err)
    net.install(ie, monkeypatch)

    with pytest.raises(ExtractorError, match="Stream limit reached") as exc:
        ie._real_extract(PLAYER_URL)
    assert exc.value.expected


def test_other_stream_errors_propagate(monkeypatch):
    err = _http_error(500, b"oops")
    ie, net = _ie(), Recorder(VOD_RIDE, stream=err)
    net.install(ie, monkeypatch)

    with pytest.raises(ExtractorError) as exc:
        ie._real_extract(PLAYER_URL)
    assert exc.value is err


def test_live_class_falls_back_to_upstream(monkeypatch):
    ride = {k: v for k, v in VOD_RIDE.items() if k != "vod_stream_url"}
    ie, net = _ie(), Recorder({**ride, "live_stream_url": "https://live.example.test/x.m3u8"})
    net.install(ie, monkeypatch)
    upstream = []
    upstream_ie = PLUGIN_IE.__mro__[1]  # the built-in PelotonIE the plugin wraps
    monkeypatch.setattr(upstream_ie, "_real_extract", lambda self, url: upstream.append(url) or {"id": "live"})

    assert ie._real_extract(PLAYER_URL) == {"id": "live"}
    assert upstream == [PLAYER_URL]


def test_pythonpath_contract_loads_the_override():
    """The deploy contract: PYTHONPATH=<projected plugin root> is all yt-dlp needs."""
    code = (
        "import yt_dlp\n"
        "ie = yt_dlp.YoutubeDL({'quiet': True}).get_info_extractor('Peloton')\n"
        "print(ie.IE_NAME)\n"
    )
    env = {**os.environ, "PYTHONPATH": str(PLUGIN_ROOT)}
    env.pop("YTDLP_NO_PLUGINS", None)
    out = subprocess.run([sys.executable, "-c", code], env=env, capture_output=True, text=True, timeout=60)
    assert out.returncode == 0, out.stderr
    assert out.stdout.strip() == "peloton+ytdrivarr"
