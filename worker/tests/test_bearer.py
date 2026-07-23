"""Hardened bearer + cookie mint (the most fragile leg)."""

from __future__ import annotations

import base64
import json
import time

import pytest

from conftest import FakeDriver
from ytdrivarr_peloton_worker.bearer import (
    BearerCaptureError,
    BearerMinter,
    render_netscape_cookies,
)

PLAYER_URL = "https://members.onepeloton.com/classes/player/abc123"
FAST = dict(capture_timeout=0.08, poll=0.01, retries=2, backoff=0.5)


def _perf_entry(token="Bearer perf.tok"):
    message = json.dumps(
        {
            "message": {
                "method": "Network.requestWillBeSent",
                "params": {
                    "request": {
                        "url": "https://api.onepeloton.com/api/metrics/v2/video",
                        "headers": {"Authorization": token},
                    }
                },
            }
        }
    )
    return {"message": message}


def test_bearer_captured_via_js_hook(no_sleep):
    d = FakeDriver()
    d.script_handler = {"_capturedBearerToken": "Bearer js.tok.value"}
    d.cookies = [{"name": "peloton_session", "value": "xyz", "domain": ".onepeloton.com",
                  "path": "/", "secure": True, "expiry": 9999999999}]
    minter = BearerMinter(sleep=no_sleep, **FAST)
    minted = minter.mint(d, PLAYER_URL)
    assert minted.bearer == "Bearer js.tok.value"
    assert len(minted.cookies) == 1
    assert minted.attempts == 1  # captured first try (the bearerAttempts telemetry)
    # CDP was primed with the interceptor + domains enabled.
    cdp = [c[0] for c in d.cdp_calls]
    assert "Network.enable" in cdp
    assert "Page.addScriptToEvaluateOnNewDocument" in cdp
    assert "Network.disable" in cdp  # cleaned up in finally
    assert no_sleep.calls == []  # captured on first attempt


def test_bearer_captured_via_perf_log(no_sleep):
    d = FakeDriver()
    # JS hook stays empty; the token only shows up in the performance log.
    d.script_handler = lambda script, *a: None
    d.perf_logs = [_perf_entry("Bearer perf.tok.value")]
    minter = BearerMinter(sleep=no_sleep, **FAST)
    minted = minter.mint(d, PLAYER_URL)
    assert minted.bearer == "Bearer perf.tok.value"


def test_bearer_capture_timeout_raises(no_sleep):
    d = FakeDriver()
    d.script_handler = lambda script, *a: [] if "_interceptionLog" in script else None
    d.perf_logs = []
    minter = BearerMinter(sleep=no_sleep, **FAST)
    with pytest.raises(BearerCaptureError):
        minter.mint(d, PLAYER_URL)
    # Retried the configured number of times (backoff between attempts).
    assert len(no_sleep.calls) == 2
    # Never returns a stale/empty token silently -> it raised.


def test_bearer_retry_then_succeed(no_sleep):
    d = FakeDriver()
    state = {"gets": 0}

    def on_get(drv, url):
        state["gets"] += 1

    d.on_get = on_get

    def script_handler(script, *a):
        if "_capturedBearerToken" in script:
            return "Bearer late.tok" if state["gets"] >= 2 else None
        if "_interceptionLog" in script:
            return []
        return None

    d.script_handler = script_handler
    minter = BearerMinter(sleep=no_sleep, **FAST)
    minted = minter.mint(d, PLAYER_URL)
    assert minted.bearer == "Bearer late.tok"
    assert len(no_sleep.calls) == 1  # one backoff before the 2nd attempt succeeded
    assert minted.attempts == 2  # succeeded on the 2nd attempt


def test_render_netscape_cookies_format():
    cookies = [
        {"name": "sess", "value": "v1", "domain": ".onepeloton.com", "path": "/",
         "secure": True, "expiry": 111},
        {"name": "csrf", "value": "v2", "domain": "members.onepeloton.com", "path": "/x",
         "secure": False},
    ]
    txt = render_netscape_cookies(cookies)
    lines = txt.strip().splitlines()
    assert lines[0].startswith("# Netscape HTTP Cookie File")
    # include_subdomains TRUE when domain starts with a dot.
    assert ".onepeloton.com\tTRUE\t/\tTRUE\t111\tsess\tv1" in txt
    assert "members.onepeloton.com\tFALSE\t/x\tFALSE\t0\tcsrf\tv2" in txt


def test_bearer_jwt_expiry_decoded():
    exp = int(time.time()) + 3600
    header = base64.urlsafe_b64encode(b'{"alg":"HS256"}').decode().rstrip("=")
    payload = base64.urlsafe_b64encode(
        json.dumps({"exp": exp}).encode()
    ).decode().rstrip("=")
    jwt = f"Bearer {header}.{payload}.sig"

    d = FakeDriver()
    d.script_handler = {"_capturedBearerToken": jwt}
    minter = BearerMinter(capture_timeout=0.05, poll=0.01, retries=0)
    minted = minter.mint(d, PLAYER_URL)
    assert minted.expires_at is not None
    assert abs(minted.expires_at.timestamp() - exp) < 2
    payload_out = minted.to_session_payload()
    assert "expiresAt" in payload_out
    assert payload_out["bearer"] == jwt


def test_bearer_non_jwt_has_no_expiry():
    d = FakeDriver()
    d.script_handler = {"_capturedBearerToken": "Bearer opaque-not-a-jwt"}
    minter = BearerMinter(capture_timeout=0.05, poll=0.01, retries=0)
    minted = minter.mint(d, PLAYER_URL)
    assert minted.expires_at is None
    assert "expiresAt" not in minted.to_session_payload()
