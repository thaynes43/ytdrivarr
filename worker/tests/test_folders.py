"""Activity -> folder mapping + bootcamp collapse (donor parity)."""

from __future__ import annotations

import pytest

from ytdrivarr_peloton_worker import folders


@pytest.mark.parametrize(
    "activity,expected",
    [
        ("cycling", "Cycling"),
        ("yoga", "Yoga"),
        ("bootcamp", "Tread Bootcamp"),
        ("bike_bootcamp", "Bike Bootcamp"),
        ("row_bootcamp", "Row Bootcamp"),
        ("strength", "Strength"),
        ("BIKE_BOOTCAMP", "Bike Bootcamp"),  # case-insensitive
    ],
)
def test_activity_folder_name(activity, expected):
    assert folders.activity_folder_name(activity) == expected


def test_tv_show_directory_shape():
    d = folders.tv_show_directory("/media/peloton", "cycling", "Ally Love")
    assert d == "/media/peloton/Cycling/Ally Love"


def test_tv_show_directory_bootcamp_collapse():
    d = folders.tv_show_directory("/media/peloton", "bike_bootcamp", "Tunde Oyeneyin")
    assert d == "/media/peloton/Bike Bootcamp/Tunde Oyeneyin"


def test_tv_show_directory_trims_trailing_sep_and_sanitizes():
    d = folders.tv_show_directory("/media/peloton/", "cycling", "A/B")
    assert d == "/media/peloton/Cycling/A-B"


def test_chip_for():
    assert folders.chip_for("cycling", 30) == "Cycling (30 min)"
    assert folders.chip_for("bike_bootcamp", 45) == "Bike Bootcamp (45 min)"
