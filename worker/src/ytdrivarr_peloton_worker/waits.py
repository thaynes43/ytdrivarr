"""Explicit-wait helpers — the heart of the hardening.

The donor has ZERO ``WebDriverWait``s: every wait is a fixed ``time.sleep``.
Here every "wait for the page to be in state X" is an explicit
``WebDriverWait`` + expected-condition with a real timeout and poll interval,
so a fast page proceeds immediately and a slow/broken page fails honestly at the
timeout instead of racing a wall clock.

The only remaining deliberate pause is the inter-scroll settle (lazy-loaded
content genuinely needs a beat to attach); it is routed through an *injected*
``sleep`` callable so tests can make it a no-op and still assert it was invoked
with the configured interval.
"""

from __future__ import annotations

from collections.abc import Callable
from typing import Any

from selenium.common.exceptions import TimeoutException
from selenium.webdriver.common.by import By
from selenium.webdriver.support import expected_conditions as EC
from selenium.webdriver.support.ui import WebDriverWait

__all__ = [
    "TimeoutException",
    "By",
    "wait_for_present",
    "wait_for_visible",
    "wait_for_clickable",
    "wait_for_condition",
    "any_present",
    "count_elements",
]


def _wait(driver: Any, timeout: float, poll: float) -> WebDriverWait:
    # poll_frequency is clamped small so timeout tests resolve quickly while
    # still exercising the real WebDriverWait polling machinery.
    return WebDriverWait(driver, timeout, poll_frequency=max(0.001, poll))


def wait_for_present(driver: Any, by: str, value: str, timeout: float, poll: float = 0.5):
    """Wait until an element is present in the DOM; return it. Raises TimeoutException."""
    return _wait(driver, timeout, poll).until(EC.presence_of_element_located((by, value)))


def wait_for_visible(driver: Any, by: str, value: str, timeout: float, poll: float = 0.5):
    return _wait(driver, timeout, poll).until(EC.visibility_of_element_located((by, value)))


def wait_for_clickable(driver: Any, by: str, value: str, timeout: float, poll: float = 0.5):
    return _wait(driver, timeout, poll).until(EC.element_to_be_clickable((by, value)))


def wait_for_condition(
    driver: Any,
    predicate: Callable[[Any], Any],
    timeout: float,
    poll: float = 0.5,
):
    """Wait until ``predicate(driver)`` returns truthy; return its value.

    Used for driver-state conditions the built-in ECs don't cover (navigated
    away from /login, bearer token captured, link count grew). Raises
    TimeoutException on timeout.
    """
    return _wait(driver, timeout, poll).until(lambda d: predicate(d))


def any_present(driver: Any, selectors: list[tuple[str, str]]) -> bool:
    """True if any of the (by, value) selectors currently matches ≥1 element.

    Uses ``find_elements`` (returns ``[]`` when absent) so it never raises —
    the honest way to probe for MFA/captcha/error markers without a wait.
    """
    for by, value in selectors:
        try:
            if driver.find_elements(by, value):
                return True
        except Exception:
            continue
    return False


def count_elements(driver: Any, by: str, value: str) -> int:
    try:
        return len(driver.find_elements(by, value))
    except Exception:
        return 0
