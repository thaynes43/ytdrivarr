"""Chromium session management — ported from the donor ``session_manager.py``.

Same container binary paths and hardening flags (``--no-sandbox``,
``--disable-dev-shm-usage``, headless, perf-logging capability for CDP sniffing)
but the option-building is a pure function so it can be unit-tested without
launching a browser, and CDP capture is enabled through an explicit helper.
"""

from __future__ import annotations

import os
import tempfile
from dataclasses import dataclass, field
from typing import Any

from selenium import webdriver
from selenium.webdriver.chrome.options import Options
from selenium.webdriver.chrome.service import Service

from .logging_setup import get_logger

DEFAULT_CHROMIUM_BINARY = os.environ.get("CHROMIUM_BINARY", "/usr/bin/chromium")
DEFAULT_CHROMEDRIVER = os.environ.get("CHROMEDRIVER_PATH", "/usr/bin/chromedriver")

_LOG = get_logger(__name__)


@dataclass
class SessionConfig:
    headless: bool = True
    container_mode: bool = True
    chromium_binary: str = DEFAULT_CHROMIUM_BINARY
    chromedriver_path: str = DEFAULT_CHROMEDRIVER
    window_size: str = "1920,1080"
    user_agent: str | None = None
    extra_args: list[str] = field(default_factory=list)


def build_options(config: SessionConfig) -> Options:
    """Build Chrome/Chromium options (pure; no driver launch).

    Testable seam: asserts on ``--no-sandbox``, ``--disable-dev-shm-usage``,
    headless, the ``goog:loggingPrefs`` perf capability, and the container
    binary path without needing Chromium installed.
    """
    options = Options()
    if config.headless:
        # ``--headless=new`` is the modern Chromium headless; keep legacy string
        # fallback compatibility by also being accepted by old drivers.
        options.add_argument("--headless=new")
    options.add_argument("--no-sandbox")
    options.add_argument("--disable-dev-shm-usage")
    options.add_argument("--disable-gpu")
    options.add_argument(f"--window-size={config.window_size}")
    options.add_argument("--disable-blink-features=AutomationControlled")
    if config.user_agent:
        options.add_argument(f"--user-agent={config.user_agent}")
    for arg in config.extra_args:
        options.add_argument(arg)

    # Performance logging captures network requests for the CDP bearer sniff.
    options.set_capability("goog:loggingPrefs", {"performance": "ALL"})

    if config.container_mode:
        options.binary_location = config.chromium_binary

    tmp_profile = tempfile.mkdtemp(prefix="pelo-profile-")
    options.add_argument(f"--user-data-dir={tmp_profile}")
    return options


class BrowserSession:
    """Owns a Chromium ``webdriver`` lifecycle (create, CDP enable, close)."""

    def __init__(self, config: SessionConfig | None = None,
                 driver_factory=None) -> None:
        self.config = config or SessionConfig()
        # Injectable for tests: a callable ``(options, service) -> WebDriver``.
        self._driver_factory = driver_factory or _default_driver_factory
        self.driver: Any | None = None
        self.logger = get_logger(f"{__name__}.BrowserSession")

    def start(self) -> Any:
        options = build_options(self.config)
        service = (
            Service(self.config.chromedriver_path)
            if self.config.container_mode
            else None
        )
        self.logger.info("Creating Chromium session (headless=%s container=%s)",
                         self.config.headless, self.config.container_mode)
        self.driver = self._driver_factory(options, service)
        return self.driver

    def enable_cdp_capture(self) -> None:
        """Enable the CDP domains the bearer sniff needs (Network/Performance/Page)."""
        if not self.driver:
            raise RuntimeError("session not started")
        for domain in ("Network", "Performance", "Page"):
            self.driver.execute_cdp_cmd(f"{domain}.enable", {})
        self.logger.debug("CDP Network/Performance/Page domains enabled")

    def close(self) -> None:
        if self.driver is not None:
            try:
                self.driver.quit()
                self.logger.info("Chromium session closed")
            except Exception as exc:  # noqa: BLE001 - best-effort teardown
                self.logger.warning("Error closing session: %s", exc)
            finally:
                self.driver = None

    def __enter__(self) -> Any:
        return self.start()

    def __exit__(self, exc_type, exc, tb) -> None:
        self.close()


def _default_driver_factory(options: Options, service: Service | None):
    if service is not None:
        return webdriver.Chrome(service=service, options=options)
    return webdriver.Chrome(options=options)
