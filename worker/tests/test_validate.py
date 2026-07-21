"""Validation / dry-run mode: emits to scratch only, valid shape, zero live writes."""

from __future__ import annotations

import os

import yaml

from conftest import FakeDriver, make_class_link
from ytdrivarr_peloton_worker.bearer import MintedSession
from ytdrivarr_peloton_worker.login import LoginOutcome, LoginResult
from ytdrivarr_peloton_worker.scraper import LINK_SELECTOR, PelotonScraper, ScrapeConfig
from ytdrivarr_peloton_worker.validate import ValidationDeps, run_validation


class _Session:
    def __init__(self, driver):
        self._driver = driver
        self.closed = False

    def start(self):
        return self._driver

    def close(self):
        self.closed = True


class _Login:
    def __init__(self, result):
        self.result = result

    def login(self, driver, username, password):
        return self.result


class _Minter:
    def __init__(self, minted):
        self.minted = minted

    def mint(self, driver, url):
        return self.minted


def _fixture_driver(links):
    d = FakeDriver()
    d.find_elements_handler = lambda by, value: list(links) if value == LINK_SELECTOR else []
    d.cookies = [{"name": "s", "value": "v", "domain": ".onepeloton.com", "path": "/",
                  "secure": True, "expiry": 123}]
    return d


def _deps(links, *, login_outcome=LoginOutcome.OK):
    driver = _fixture_driver(links)
    return ValidationDeps(
        session_factory=lambda: _Session(driver),
        login=_Login(LoginResult(login_outcome, "detail")),
        minter=_Minter(MintedSession(bearer="Bearer tok", cookies=driver.cookies)),
        scraper=PelotonScraper(ScrapeConfig(
            max_classes=5, dynamic_scrolling=True, max_scrolls=2,
            scroll_pause_sec=0.03, page_load_wait_sec=0.05, poll=0.01)),
        username="u", password="p",
    )


def test_validation_emits_to_scratch_only(tmp_path):
    links = [
        make_class_link("v1", "30 min Ride", "Cody Rigsby"),
        make_class_link("v2", "45 min Climb", "Ally Love"),
    ]
    scratch = tmp_path / "pelo-out"
    report = run_validation(
        activities=["cycling"], scratch=str(scratch),
        media_root="/media/peloton", deps=_deps(links),
    )
    assert report["ok"] is True
    assert report["entries"] == 2
    assert report["shapeVerdict"]["ok"] is True

    # Files written are exactly the two scratch artifacts, both under scratch.
    written = report["filesWritten"]
    assert len(written) == 2
    for path in written:
        assert str(scratch) in path
    # ZERO live/NFS writes: scratch contains ONLY these two files (no bearer.txt/cookies.txt).
    assert set(os.listdir(scratch)) == {"subscriptions.yaml", "summary.json"}


def test_validation_yaml_is_live_shape(tmp_path):
    links = [make_class_link("v1", "30 min Ride", "Cody Rigsby")]
    scratch = tmp_path / "out"
    run_validation(activities=["cycling"], scratch=str(scratch),
                   media_root="/media/peloton", deps=_deps(links))
    data = yaml.safe_load((scratch / "subscriptions.yaml").read_text())
    assert set(data) == {"__preset__", "Plex TV Show by Date"}
    assert "= Cycling (30 min)" in data["Plex TV Show by Date"]


def test_validation_telemetry_high_water_is_per_activity(tmp_path):
    # The validate seam mirrors the worker: numbering telemetry is keyed by
    # activity ({slug: {durationString: max}}). Dry-run seeds empty -> starts at 1.
    links = [make_class_link("v1", "30 min Ride", "Cody Rigsby")]
    report = run_validation(
        activities=["cycling"], scratch=str(tmp_path / "out"),
        media_root="/media/peloton", deps=_deps(links),
    )
    assert report["telemetry"]["episodeHighWater"] == {"cycling": {"30": 1}}


def test_validation_login_failure_writes_nothing(tmp_path):
    scratch = tmp_path / "out"
    report = run_validation(
        activities=["cycling"], scratch=str(scratch), media_root="/media/peloton",
        deps=_deps([], login_outcome=LoginOutcome.MFA_REQUIRED),
    )
    assert report["ok"] is False
    assert report["stage"] == "login"
    assert report["filesWritten"] == []
    # Scratch dir was created but nothing was written into it.
    assert os.listdir(scratch) == []


def test_validation_closes_session(tmp_path):
    links = [make_class_link("v1", "30 min Ride", "Cody Rigsby")]
    driver = _fixture_driver(links)
    session = _Session(driver)
    deps = ValidationDeps(
        session_factory=lambda: session,
        login=_Login(LoginResult(LoginOutcome.OK)),
        minter=_Minter(MintedSession(bearer="Bearer tok", cookies=[])),
        scraper=PelotonScraper(ScrapeConfig(max_classes=5, max_scrolls=1,
                                            scroll_pause_sec=0.02, page_load_wait_sec=0.03,
                                            poll=0.01)),
        username="u", password="p",
    )
    run_validation(activities=["cycling"], scratch=str(tmp_path / "o"),
                   media_root="/media/peloton", deps=deps)
    assert session.closed is True
