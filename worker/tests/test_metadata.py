"""Metadata/text helper tests (deep, per the port-parity mandate)."""

from __future__ import annotations

import pytest

from ytdrivarr_peloton_worker import metadata as m


@pytest.mark.parametrize(
    "title,expected",
    [
        ("45 min HIIT Ride", 45),
        ("30 min Bootcamp: 50-50", 30),
        ("5 min Cool Down", 5),
        ("  20 min Yoga Flow", 20),
        ("35 min Tabata Ride", 35),  # raw, NOT rounded to 30/40
        ("60min Power Zone", 60),  # no space
        ("Encore: 75 min Ride", 75),  # fallback to any int
        ("No Duration Here", 0),
    ],
)
def test_extract_duration_raw(title, expected):
    assert m.extract_duration_from_title(title) == expected


def test_duration_is_raw_not_rounded():
    # The donor's latent "round to nearest 5" is discarded: 22 stays 22.
    assert m.extract_duration_from_title("22 min Ride") == 22
    assert m.extract_duration_from_title("43 min Run") == 43


def test_parse_subtitle_dot_split():
    instructor, activity = m.parse_subtitle("Cody Rigsby · Cycling")
    assert instructor == "Cody Rigsby"
    assert activity == "Cycling"


def test_parse_subtitle_titlecases():
    instructor, activity = m.parse_subtitle("tunde oyeneyin · bike bootcamp")
    assert instructor == "Tunde Oyeneyin"
    assert activity == "Bike Bootcamp"


def test_parse_subtitle_unexpected_shape():
    assert m.parse_subtitle("just one part") == ("Unknown", "Unknown")


def test_extract_class_id_from_href():
    href = "https://members.onepeloton.com/classes/cycling?foo=1&classId=abc123def"
    assert m.extract_class_id_from_href(href) == "abc123def"


def test_extract_class_id_from_href_missing():
    assert m.extract_class_id_from_href("https://x/classes/cycling") == ""
    assert m.extract_class_id_from_href("") == ""
    assert m.extract_class_id_from_href(None) == ""


def test_extract_class_id_from_player_url():
    url = "https://members.onepeloton.com/classes/player/c7fee9be57994db3808cf318d00cb732"
    assert m.extract_class_id_from_player_url(url) == "c7fee9be57994db3808cf318d00cb732"


def test_player_url_for():
    assert m.player_url_for("abc") == "https://members.onepeloton.com/classes/player/abc"


def test_normalize_text_strips_and_nfc():
    assert m.normalize_text("  Café  ") == "Café"
    assert m.normalize_text("") == ""
    assert m.normalize_text(None) == ""


def test_sanitize_for_filesystem_replaces_unsafe():
    # NB: colon is deliberately NOT replaced (donor parity) — live titles like
    # "30 min Bootcamp: 50-50" keep the colon (YAML single-quotes them).
    assert m.sanitize_for_filesystem("50/50: Ride?") == "50-50: Ride-"
    assert m.sanitize_for_filesystem('A "quote" | pipe') == "A 'quote' - pipe"


def test_sanitize_collapses_whitespace_and_trims_dots():
    assert m.sanitize_for_filesystem("  a   b  .") == "a b"


def test_get_short_hash_deterministic():
    h1 = m.get_short_hash("Cody Rigsby")
    h2 = m.get_short_hash("Cody Rigsby")
    assert h1 == h2 and len(h1) == 7
    assert m.get_short_hash("") == ""
