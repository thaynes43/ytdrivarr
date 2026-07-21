"""Session option-building (pure; no browser launch) + CDP enable."""

from __future__ import annotations

from ytdrivarr_peloton_worker.session import (
    BrowserSession,
    SessionConfig,
    build_options,
)


def test_build_options_container_flags():
    opts = build_options(SessionConfig(headless=True, container_mode=True,
                                       chromium_binary="/usr/bin/chromium"))
    args = opts.arguments
    assert "--no-sandbox" in args
    assert "--disable-dev-shm-usage" in args
    assert any(a.startswith("--headless") for a in args)
    assert any(a.startswith("--user-data-dir=") for a in args)
    assert opts.binary_location == "/usr/bin/chromium"


def test_build_options_perf_logging_capability():
    opts = build_options(SessionConfig())
    caps = opts.to_capabilities()
    assert caps.get("goog:loggingPrefs") == {"performance": "ALL"}


def test_build_options_non_headless_non_container():
    opts = build_options(SessionConfig(headless=False, container_mode=False))
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
