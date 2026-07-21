"""Hardened Peloton login.

Ports the donor ``login_strategy.py`` semantics (nav to /login, fill
``usernameOrEmail`` + ``password``, click ``button[type=submit]``, success =
left the /login page) but replaces every ``time.sleep`` with an explicit
``WebDriverWait`` and returns a TYPED outcome instead of a bare bool, so the
caller raises the right alarm:

  ok | bad_credentials | mfa_required | captcha | redirect | timeout

Retries with backoff on the transient outcomes (timeout/redirect); the
human-blocked outcomes (bad_credentials/mfa/captcha) are terminal.

The MFA/captcha/error selectors + text markers are HEURISTICS (Peloton's login
DOM is not in the donor); they are listed here and in the README as assumptions
for the coordinator to confirm in the live dry-run.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass
from enum import Enum

from selenium.common.exceptions import (
    NoSuchElementException,
    TimeoutException,
    WebDriverException,
)

from .logging_setup import get_logger
from .waits import By, any_present, wait_for_condition, wait_for_present

LOGIN_URL = "https://members.onepeloton.com/login"
EXPECTED_HOSTS = ("members.onepeloton.com", "onepeloton.com")

# --- detection heuristics (assumptions to validate live) --------------------
MFA_SELECTORS = [
    (By.CSS_SELECTOR, 'input[name="code"]'),
    (By.CSS_SELECTOR, 'input[name="otp"]'),
    (By.CSS_SELECTOR, 'input[autocomplete="one-time-code"]'),
    (By.CSS_SELECTOR, '[data-test-id*="mfa"]'),
    (By.CSS_SELECTOR, '[data-test-id*="verification"]'),
]
MFA_TEXT_MARKERS = ("verification code", "two-factor", "two factor",
                    "authentication code", "enter the code", "check your")
CAPTCHA_SELECTORS = [
    (By.CSS_SELECTOR, 'iframe[src*="recaptcha"]'),
    (By.CSS_SELECTOR, 'iframe[src*="hcaptcha"]'),
    (By.CSS_SELECTOR, "#px-captcha"),
    (By.CSS_SELECTOR, '[class*="captcha"]'),
    (By.CSS_SELECTOR, '[data-test-id*="captcha"]'),
]
CAPTCHA_TEXT_MARKERS = ("captcha", "verify you are human", "are you a robot",
                        "press & hold", "press and hold")
ERROR_SELECTORS = [
    (By.CSS_SELECTOR, '[data-test-id="loginFormErrorMessage"]'),
    (By.CSS_SELECTOR, '[role="alert"]'),
    (By.CSS_SELECTOR, '[class*="errorMessage"]'),
    (By.CSS_SELECTOR, '[class*="error-message"]'),
]
BAD_CRED_TEXT_MARKERS = ("incorrect", "wrong password", "does not match",
                         "doesn't match", "invalid", "no account", "try again")


class LoginOutcome(str, Enum):
    OK = "ok"
    BAD_CREDENTIALS = "bad_credentials"
    MFA_REQUIRED = "mfa_required"
    CAPTCHA = "captcha"
    REDIRECT = "redirect"
    TIMEOUT = "timeout"


# Outcomes that a human/config must resolve -> do not retry.
TERMINAL_OUTCOMES = frozenset(
    {LoginOutcome.OK, LoginOutcome.BAD_CREDENTIALS,
     LoginOutcome.MFA_REQUIRED, LoginOutcome.CAPTCHA}
)


@dataclass
class LoginResult:
    outcome: LoginOutcome
    detail: str = ""
    current_url: str = ""

    @property
    def ok(self) -> bool:
        return self.outcome is LoginOutcome.OK

    @property
    def retryable(self) -> bool:
        return self.outcome in (LoginOutcome.TIMEOUT, LoginOutcome.REDIRECT)


def _page_text(driver) -> str:
    try:
        return (driver.execute_script("return document.body.innerText;") or "").lower()
    except WebDriverException:
        return ""


def _on_login_page(url: str) -> bool:
    return "login" in (url or "").lower()


def _host_ok(url: str) -> bool:
    low = (url or "").lower()
    return any(h in low for h in EXPECTED_HOSTS)


class PelotonLogin:
    def __init__(
        self,
        *,
        field_timeout: float = 15.0,
        nav_timeout: float = 15.0,
        poll: float = 0.5,
        retries: int = 2,
        backoff: float = 2.0,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.field_timeout = field_timeout
        self.nav_timeout = nav_timeout
        self.poll = poll
        self.retries = retries
        self.backoff = backoff
        self._sleep = sleep
        self.logger = get_logger(f"{__name__}.PelotonLogin")

    def login(self, driver, username: str, password: str) -> LoginResult:
        """Attempt login with retry/backoff; return a typed result."""
        result = LoginResult(LoginOutcome.TIMEOUT, "no attempt made")
        for attempt in range(self.retries + 1):
            self.logger.info("Login attempt %d/%d", attempt + 1, self.retries + 1)
            result = self._attempt(driver, username, password)
            if result.outcome in TERMINAL_OUTCOMES:
                return result
            if attempt < self.retries:
                delay = self.backoff * (attempt + 1)
                self.logger.warning("Login outcome=%s (retryable), backing off %.1fs",
                                    result.outcome.value, delay)
                self._sleep(delay)
        return result

    def _attempt(self, driver, username: str, password: str) -> LoginResult:
        try:
            driver.get(LOGIN_URL)
        except WebDriverException as exc:
            return LoginResult(LoginOutcome.TIMEOUT, f"navigation failed: {exc}")

        # Wait for the username field instead of sleeping a fixed 10s.
        try:
            user_field = wait_for_present(
                driver, By.NAME, "usernameOrEmail", self.field_timeout, self.poll
            )
        except TimeoutException:
            # Field never rendered — the page may already be a captcha/MFA wall.
            classified = self._classify_block(driver)
            if classified:
                return classified
            return LoginResult(LoginOutcome.TIMEOUT, "username field not found",
                               _current_url(driver))

        try:
            password_field = wait_for_present(
                driver, By.NAME, "password", self.field_timeout, self.poll
            )
            user_field.clear()
            user_field.send_keys(username)
            password_field.clear()
            password_field.send_keys(password)
            submit = wait_for_present(
                driver, By.CSS_SELECTOR, 'button[type="submit"]', self.field_timeout, self.poll
            )
            submit.click()
        except (TimeoutException, NoSuchElementException) as exc:
            return LoginResult(LoginOutcome.TIMEOUT, f"login form interaction failed: {exc}",
                               _current_url(driver))

        # Wait to LEAVE the /login page rather than sleeping a fixed 15s.
        try:
            wait_for_condition(
                driver, lambda d: not _on_login_page(_current_url(d)),
                self.nav_timeout, self.poll,
            )
        except TimeoutException:
            # Still on /login after the timeout — figure out why, honestly.
            return self._classify_stuck(driver)

        url = _current_url(driver)
        if not _host_ok(url):
            return LoginResult(LoginOutcome.REDIRECT, f"unexpected host after login: {url}", url)
        return LoginResult(LoginOutcome.OK, "authenticated", url)

    def _classify_block(self, driver) -> LoginResult | None:
        """Captcha/MFA that appears *before* the form (returns None if neither)."""
        text = _page_text(driver)
        url = _current_url(driver)
        if any_present(driver, CAPTCHA_SELECTORS) or _has_marker(text, CAPTCHA_TEXT_MARKERS):
            return LoginResult(LoginOutcome.CAPTCHA, "captcha challenge detected", url)
        if any_present(driver, MFA_SELECTORS) or _has_marker(text, MFA_TEXT_MARKERS):
            return LoginResult(LoginOutcome.MFA_REQUIRED, "MFA/2FA prompt detected", url)
        return None

    def _classify_stuck(self, driver) -> LoginResult:
        """We're still on /login after submit — distinguish the reasons."""
        text = _page_text(driver)
        url = _current_url(driver)
        if any_present(driver, CAPTCHA_SELECTORS) or _has_marker(text, CAPTCHA_TEXT_MARKERS):
            return LoginResult(LoginOutcome.CAPTCHA, "captcha challenge after submit", url)
        if any_present(driver, MFA_SELECTORS) or _has_marker(text, MFA_TEXT_MARKERS):
            return LoginResult(LoginOutcome.MFA_REQUIRED, "MFA/2FA prompt after submit", url)
        if any_present(driver, ERROR_SELECTORS) or _has_marker(text, BAD_CRED_TEXT_MARKERS):
            return LoginResult(LoginOutcome.BAD_CREDENTIALS, "login error / bad credentials", url)
        # Still on /login, no diagnosable marker -> honest timeout (retryable).
        return LoginResult(LoginOutcome.TIMEOUT, "still on login page, no marker", url)


def _current_url(driver) -> str:
    try:
        return driver.current_url or ""
    except WebDriverException:
        return ""


def _has_marker(text: str, markers) -> bool:
    return any(m in text for m in markers)
