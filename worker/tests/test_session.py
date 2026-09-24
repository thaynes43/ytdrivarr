"""Session option-building (pure; no browser launch) + CDP enable + profile cleanup."""

from __future__ import annotations

import os
import shutil

import pytest

from ytdrivarr_peloton_worker.session import (
    PROFILE_PREFIX,
    BrowserSession,
    SessionConfig,
    build_options,
)


def test_build_options_container_flags(tmp_path):
    opts = build_options(SessionConfig(headless=True, container_mode=True,
                                       chromium_binary="/usr/bin/chromium"),
                         profile_dir=str(tmp_path))
    args = opts.arguments
    assert "--no-sandbox" in args
    assert "--disable-dev-shm-usage" in args
    assert any(a.startswith("--headless") for a in args)
    assert f"--user-data-dir={tmp_path}" in args
    assert opts.binary_location == "/usr/bin/chromium"


def test_build_options_without_profile_dir_creates_one():
    opts = build_options(SessionConfig())
    (arg,) = [a for a in opts.arguments if a.startswith("--user-data-dir=")]
    path = arg.split("=", 1)[1]
    try:
        assert os.path.basename(path).startswith(PROFILE_PREFIX)
        assert os.path.isdir(path)
    finally:
        shutil.rmtree(path, ignore_errors=True)


def test_build_options_perf_logging_capability(tmp_path):
    opts = build_options(SessionConfig(), profile_dir=str(tmp_path))
    caps = opts.to_capabilities()
    assert caps.get("goog:loggingPrefs") == {"performance": "ALL"}


def test_build_options_non_headless_non_container(tmp_path):
    opts = build_options(SessionConfig(headless=False, container_mode=False),
                         profile_dir=str(tmp_path))
    assert not any(a.startswith("--headless") for a in opts.arguments)
    # No binary override in non-container mode.
    assert not opts.binary_location


def test_session_lifecycle_with_injected_factory():
    created = {}

    class _Driver:
        def __init__(self):
            self.quit_called = False
            self.cdp = []

        def execute_cdp_cmd(self, cmd, params):
            self.cdp.append(cmd)

        def quit(self):
            self.quit_called = True

    def factory(options, service):
        created["options"] = options
        created["service"] = service
        return _Driver()

    sess = BrowserSession(SessionConfig(container_mode=False), driver_factory=factory)
    driver = sess.start()
    assert created["service"] is None  # non-container -> no Service
    sess.enable_cdp_capture()
    assert driver.cdp == ["Network.enable", "Performance.enable", "Page.enable"]
    sess.close()
    assert driver.quit_called
    assert sess.driver is None


# -- the throwaway --user-data-dir is owned + removed by the session -----------
class _QuitDriver:
    """Records whether the profile dir still existed when quit() ran."""

    def __init__(self, session, raise_on_quit=False):
        self._session = session
        self._raise = raise_on_quit
        self.profile_present_at_quit = None

    def quit(self):
        self.profile_present_at_quit = os.path.isdir(self._session.profile_dir)
        if self._raise:
            raise RuntimeError("chromedriver already gone")


def _started(raise_on_quit=False):
    created = {}

    def factory(options, service):
        created["options"] = options
        created["driver"] = _QuitDriver(sess, raise_on_quit)
        return created["driver"]

    sess = BrowserSession(SessionConfig(container_mode=False), driver_factory=factory)
    sess.start()
    return sess, created


def test_user_data_dir_is_the_tracked_profile():
    sess, created = _started()
    try:
        profile = sess.profile_dir
        assert profile and os.path.isdir(profile)
        assert os.path.basename(profile).startswith(PROFILE_PREFIX)
        assert f"--user-data-dir={profile}" in created["options"].arguments
    finally:
        sess.close()


def test_close_removes_profile_after_quit():
    sess, created = _started()
    profile = sess.profile_dir
    sess.close()
    assert created["driver"].profile_present_at_quit is True  # quit ran FIRST
    assert not os.path.exists(profile)
    assert sess.profile_dir is None
    sess.close()  # idempotent


def test_close_removes_profile_even_if_quit_raises():
    sess, created = _started(raise_on_quit=True)
    profile = sess.profile_dir
    sess.close()  # quit's error is swallowed (best-effort teardown)
    assert created["driver"].profile_present_at_quit is True
    assert not os.path.exists(profile)
    assert sess.driver is None


def test_failed_start_does_not_leak_profile():
    seen = {}

    def boom(options, service):
        (arg,) = [a for a in options.arguments if a.startswith("--user-data-dir=")]
        seen["profile"] = arg.split("=", 1)[1]
        assert os.path.isdir(seen["profile"])
        raise RuntimeError("chromium failed to launch")

    sess = BrowserSession(SessionConfig(container_mode=False), driver_factory=boom)
    with pytest.raises(RuntimeError):
        sess.start()
    assert not os.path.exists(seen["profile"])
    sess.close()  # what the worker's finally does after a failed start: still safe
    assert sess.profile_dir is None
