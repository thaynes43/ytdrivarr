"""Shared test harness: a scriptable fake Selenium WebDriver + helpers.

The fake driver is deliberately compatible with selenium's ``WebDriverWait`` /
``expected_conditions``: ``find_element`` raises ``NoSuchElementException`` when
absent (EC catches it) and ``find_elements`` returns ``[]``. Tests drive real
``WebDriverWait``s with tiny timeouts so timeout paths resolve in milliseconds
while still exercising the polling machinery — no wall-clock sleeps.
"""

from __future__ import annotations

import pytest
from selenium.common.exceptions import (
    NoSuchElementException,
    StaleElementReferenceException,
)
from selenium.webdriver.common.by import By

from ytdrivarr_peloton_worker.scraper import (
    SUBTITLE_SELECTOR,
    TITLE_SELECTOR,
)


class FakeElement:
    def __init__(self, *, attributes=None, text="", children=None, on_click=None, stale=False):
        self._attrs = attributes or {}
        self.text = text
        self._children = children or {}
        self._on_click = on_click
        self.stale = stale
        self.sent_keys: list[str] = []
        self.cleared = False

    def get_attribute(self, name):
        if self.stale:
            raise StaleElementReferenceException("stale")
        return self._attrs.get(name)

    def find_element(self, by, value):
        if self.stale:
            raise StaleElementReferenceException("stale")
        kids = self._children.get((by, value))
        if not kids:
            raise NoSuchElementException(f"{by}={value}")
        return kids[0] if isinstance(kids, list) else kids

    def find_elements(self, by, value):
        kids = self._children.get((by, value), [])
        return list(kids) if isinstance(kids, list) else [kids]

    def send_keys(self, keys):
        self.sent_keys.append(keys)

    def clear(self):
        self.cleared = True

    def click(self):
        if self._on_click:
            self._on_click()


class FakeDriver:
    """Programmable fake WebDriver. Configure the handler attributes per test."""

    def __init__(self):
        self.current_url = ""
        self.get_calls: list[str] = []
        self.cdp_calls: list[tuple] = []
        self.script_calls: list[str] = []
        self.quit_called = False
        self.scroll_count = 0
        # Handlers (set by tests):
        self.find_elements_handler = None  # (by, value) -> list
        self.find_element_handler = None   # (by, value) -> FakeElement | None
        self.script_handler = None         # callable(script,*args) | dict[substr]->val
        self.perf_logs = []                # list | callable(driver)->list
        self.cookies: list[dict] = []
        self.on_get = None                 # callable(driver, url)
        self.on_scroll = None              # callable(driver)

    def get(self, url):
        self.get_calls.append(url)
        if self.on_get:
            self.on_get(self, url)

    def find_elements(self, by, value):
        if self.find_elements_handler:
            return self.find_elements_handler(by, value)
        return []

    def find_element(self, by, value):
        if self.find_element_handler:
            el = self.find_element_handler(by, value)
            if el is None:
                raise NoSuchElementException(f"{by}={value}")
            return el
        els = self.find_elements(by, value)
        if els:
            return els[0]
        raise NoSuchElementException(f"{by}={value}")

    def execute_script(self, script, *args):
        self.script_calls.append(script)
        handler = self.script_handler
        if callable(handler):
            return handler(script, *args)
        if isinstance(handler, dict):
            for key, val in handler.items():
                if key in script:
                    return val
            return None
        if "scrollTo" in script:
            self.scroll_count += 1
            if self.on_scroll:
                self.on_scroll(self)
            return None
        return None

    def execute_cdp_cmd(self, cmd, params):
        self.cdp_calls.append((cmd, params))
        return {}

    def get_log(self, name):
        logs = self.perf_logs
        return logs(self) if callable(logs) else list(logs)

    def get_cookies(self):
        return list(self.cookies)

    def quit(self):
        self.quit_called = True


def make_class_link(class_id, title, instructor, activity="Cycling", stale=False):
    """Build a fake ``a[href*=classId]`` listing link with title/subtitle kids."""
    href = f"https://members.onepeloton.com/classes/cycling?classId={class_id}"
    children = {
        (By.CSS_SELECTOR, TITLE_SELECTOR): [FakeElement(text=title)],
        (By.CSS_SELECTOR, SUBTITLE_SELECTOR): [FakeElement(text=f"{instructor} · {activity}")],
    }
    return FakeElement(attributes={"href": href}, children=children, stale=stale)


@pytest.fixture
def fake_driver():
    return FakeDriver()


@pytest.fixture
def no_sleep():
    """A sleep spy that never actually sleeps; records durations."""
    calls: list[float] = []

    def _sleep(seconds):
        calls.append(seconds)

    _sleep.calls = calls
    return _sleep
