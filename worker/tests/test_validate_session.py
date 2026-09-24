"""Session validation: /api/me with exactly the minted bearer + cookies (#40)."""

from __future__ import annotations

import time

import pytest
import requests
import responses

from ytdrivarr_peloton_worker.bearer import MintedSession
from ytdrivarr_peloton_worker.errors import SessionRejectedError
from ytdrivarr_peloton_worker.validate_session import (
    API_ME_URL,
    BROWSER_USER_AGENT,
    SessionValidator,
)

BEARER = "Bearer test-token"
FUTURE = int(time.time()) + 3600
COOKIES = [
    {"name": "peloton_session_id", "value": "fake-session-cookie", "domain": ".onepeloton.com",
     "path": "/", "secure": True, "expiry": FUTURE, "httpOnly": True},
    {"name": "api_only", "value": "fake-api-cookie", "domain": "api.onepeloton.com",
     "path": "/", "secure": True},
    # Host-only for the members site: a browser never sends it to api.*, nor should we.
    {"name": "members_only", "value": "fake-members-cookie", "domain": "members.onepeloton.com",
     "path": "/", "secure": True},
]


def _minted(bearer=BEARER, cookies=None):
    return MintedSession(bearer=bearer, cookies=list(COOKIES if cookies is None else cookies))


def _sent():
    return responses.calls[0].request


@responses.activate
def test_200_passes():
    responses.add(responses.GET, API_ME_URL, json={"id": "user-1"}, status=200)
    SessionValidator().validate(_minted())  # no raise
    assert len(responses.calls) == 1


@responses.activate
def test_authorization_is_the_minted_bearer_verbatim():
    # The #40 false-401: a doubled "Bearer Bearer ..." prefix. The minted value
    # already carries the prefix and must be sent exactly as delivered.
    responses.add(responses.GET, API_ME_URL, json={}, status=200)
    SessionValidator().validate(_minted())
    auth = _sent().headers["Authorization"]
    assert auth == "Bearer test-token"
    assert "Bearer Bearer" not in auth


@responses.activate
def test_minted_cookies_are_sent_to_api_host():
    responses.add(responses.GET, API_ME_URL, json={}, status=200)
    SessionValidator().validate(_minted())
    cookie_header = _sent().headers.get("Cookie", "")
    assert "peloton_session_id=fake-session-cookie" in cookie_header  # .onepeloton.com
    assert "api_only=fake-api-cookie" in cookie_header                 # api.onepeloton.com
    assert "members_only" not in cookie_header                         # host-only elsewhere


@responses.activate
def test_members_site_headers_present():
    responses.add(responses.GET, API_ME_URL, json={}, status=200)
    SessionValidator().validate(_minted())
    headers = _sent().headers
    assert headers["Origin"] == "https://members.onepeloton.com"
    assert headers["Referer"] == "https://members.onepeloton.com/"
    assert headers["Peloton-Platform"] == "web"
    assert headers["User-Agent"] == BROWSER_USER_AGENT
    assert "Chrome/" in BROWSER_USER_AGENT


@responses.activate
def test_401_json_names_status_and_error_code_not_secrets():
    responses.add(responses.GET, API_ME_URL, status=401,
                  json={"status": 401, "error_code": 3010, "message": "Login required",
                        "details": "echo of fake-session-cookie"})
    with pytest.raises(SessionRejectedError) as ei:
        SessionValidator().validate(_minted())
    msg = str(ei.value)
    assert "401" in msg and "3010" in msg
    assert "Login required" in msg
    # Never the token, a cookie value, or the full body.
    assert "test-token" not in msg
    assert "fake-session-cookie" not in msg and "fake-api-cookie" not in msg
    assert "details" not in msg


@responses.activate
def test_403_non_json_body():
    responses.add(responses.GET, API_ME_URL, status=403, body="<html>Forbidden</html>",
                  content_type="text/html")
    with pytest.raises(SessionRejectedError) as ei:
        SessionValidator().validate(_minted())
    msg = str(ei.value)
    assert "403" in msg
    assert "error_code" not in msg
    assert "<html>" not in msg


@pytest.mark.parametrize("exc_cls", [requests.ConnectionError, requests.Timeout])
@responses.activate
def test_transport_exception_names_the_class(exc_cls):
    responses.add(responses.GET, API_ME_URL, body=exc_cls("boom"))
    with pytest.raises(SessionRejectedError) as ei:
        SessionValidator().validate(_minted())
    assert exc_cls.__name__ in str(ei.value)
    assert "test-token" not in str(ei.value)


@responses.activate
def test_rejection_is_retryable_session_rejected_alarm():
    responses.add(responses.GET, API_ME_URL, status=401, json={"error_code": 3010})
    with pytest.raises(SessionRejectedError) as ei:
        SessionValidator().validate(_minted())
    assert ei.value.retryable is True
    alarm = ei.value.to_alarm()
    assert alarm["kind"] == "session_rejected"
    assert "test-token" not in alarm["message"]


def test_injected_session_factory_and_timeout():
    captured = {}

    class _Resp:
        status_code = 200

    class _Session:
        def __init__(self):
            self.cookies = requests.cookies.RequestsCookieJar()
            self.closed = False
            captured["session"] = self

        def get(self, url, headers=None, timeout=None):
            captured.update(url=url, headers=headers, timeout=timeout)
            return _Resp()

        def close(self):
            self.closed = True

    assert SessionValidator().timeout == 20.0  # the default
    SessionValidator(session_factory=_Session, timeout=7.5).validate(_minted())
    assert captured["url"] == API_ME_URL
    assert captured["timeout"] == 7.5
    assert captured["headers"]["Authorization"] == BEARER
    assert captured["session"].closed is True
    assert {c.name for c in captured["session"].cookies} == {
        "peloton_session_id", "api_only", "members_only"}
