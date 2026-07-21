"""Hardened login: typed outcomes, retries, honest MFA/captcha/redirect states.

Every test injects ``sleep=no_sleep`` and uses tiny WebDriverWait timeouts, so a
non-empty ``no_sleep.calls`` means *backoff between retries* only — never a fixed
wait-for-the-page sleep. The success path asserts ``no_sleep.calls == []``,
proving the donor's fixed ``time.sleep(10)`` / ``time.sleep(15)`` are gone.
"""

from __future__ import annotations

from selenium.webdriver.common.by import By

from conftest import FakeDriver, FakeElement
from ytdrivarr_peloton_worker.login import LOGIN_URL, LoginOutcome, PelotonLogin

SUBMIT = 'button[type="submit"]'
FAST = dict(field_timeout=0.2, nav_timeout=0.15, poll=0.01, retries=2, backoff=0.5)


def make_login_driver(
    *,
    post_login_url="https://members.onepeloton.com/home",
    username_present=True,
    password_present=True,
    submit_present=True,
    page_text="",
    extra_elements=None,
    click_changes_url=True,
):
    d = FakeDriver()

    def on_get(drv, url):
        drv.current_url = LOGIN_URL

    d.on_get = on_get
    user_field = FakeElement()
    pw_field = FakeElement()

    def on_click():
        if click_changes_url:
            d.current_url = post_login_url

    submit_btn = FakeElement(on_click=on_click)
    elements = {
        (By.NAME, "usernameOrEmail"): user_field if username_present else None,
        (By.NAME, "password"): pw_field if password_present else None,
        (By.CSS_SELECTOR, SUBMIT): submit_btn if submit_present else None,
    }
    extra = extra_elements or {}

    d.find_element_handler = lambda by, value: elements.get((by, value))

    def find_elements_handler(by, value):
        if (by, value) in extra:
            return extra[(by, value)]
        el = elements.get((by, value))
        return [el] if el else []

    d.find_elements_handler = find_elements_handler
    d.script_handler = {"innerText": page_text}
    d._fields = {"user": user_field, "pw": pw_field, "submit": submit_btn}
    return d


def test_login_success(no_sleep):
    d = make_login_driver()
    login = PelotonLogin(sleep=no_sleep, **FAST)
    result = login.login(d, "alice@example.com", "s3cret")
    assert result.outcome is LoginOutcome.OK
    assert result.ok is True
    assert d._fields["user"].sent_keys == ["alice@example.com"]
    assert d._fields["pw"].sent_keys == ["s3cret"]
    assert d.current_url == "https://members.onepeloton.com/home"
    # No fixed-sleep waiting AND no retries needed.
    assert no_sleep.calls == []


def test_login_bad_credentials_still_on_login(no_sleep):
    d = make_login_driver(click_changes_url=False, page_text="that password is incorrect")
    login = PelotonLogin(sleep=no_sleep, **FAST)
    result = login.login(d, "u", "wrong")
    assert result.outcome is LoginOutcome.BAD_CREDENTIALS
    assert result.retryable is False
    # Terminal outcome -> not retried.
    assert no_sleep.calls == []


def test_login_mfa_detected(no_sleep):
    d = make_login_driver(
        click_changes_url=False,
        extra_elements={(By.CSS_SELECTOR, 'input[name="code"]'): [FakeElement()]},
    )
    login = PelotonLogin(sleep=no_sleep, **FAST)
    result = login.login(d, "u", "p")
    assert result.outcome is LoginOutcome.MFA_REQUIRED
    assert result.retryable is False
    assert no_sleep.calls == []


def test_login_captcha_detected(no_sleep):
    d = make_login_driver(click_changes_url=False, page_text="please verify you are human")
    login = PelotonLogin(sleep=no_sleep, **FAST)
    result = login.login(d, "u", "p")
    assert result.outcome is LoginOutcome.CAPTCHA
    assert result.retryable is False


def test_login_unexpected_redirect_retries(no_sleep):
    d = make_login_driver(post_login_url="https://sso.evil-idp.example.com/continue")
    login = PelotonLogin(sleep=no_sleep, **FAST)
    result = login.login(d, "u", "p")
    assert result.outcome is LoginOutcome.REDIRECT
    assert result.retryable is True
    # REDIRECT is retryable -> backed off once per retry (retries=2).
    assert len(no_sleep.calls) == 2


def test_login_timeout_retried_then_failed(no_sleep):
    # Username field never renders and no captcha/mfa marker -> honest timeout.
    d = make_login_driver(username_present=False)
    login = PelotonLogin(sleep=no_sleep, **FAST)
    result = login.login(d, "u", "p")
    assert result.outcome is LoginOutcome.TIMEOUT
    assert result.retryable is True
    assert len(no_sleep.calls) == 2  # retried twice with backoff


def test_login_polls_for_late_field(no_sleep):
    # The field appears only on the 3rd find_element call -> proves polling, not
    # a single one-shot lookup after a fixed sleep.
    d = make_login_driver()
    real_handler = d.find_element_handler
    calls = {"n": 0}

    def late(by, value):
        if by == By.NAME and value == "usernameOrEmail":
            calls["n"] += 1
            if calls["n"] < 3:
                return None  # not present yet
        return real_handler(by, value)

    d.find_element_handler = late
    login = PelotonLogin(sleep=no_sleep, **FAST)
    result = login.login(d, "u", "p")
    assert result.outcome is LoginOutcome.OK
    assert calls["n"] >= 3  # it polled multiple times
    assert no_sleep.calls == []
