"""Prove a freshly minted session works BEFORE it is delivered (#40).

The mint only proves a bearer was *seen* on the wire; it never proved Peloton
would accept it. #40's investigation was misled by a false 401 (a doubled
``Bearer `` prefix added during manual testing), and nothing in the worker could
say whether the delivered ``bearer.txt``/``cookies.txt`` actually worked.

``SessionValidator`` replays EXACTLY what will be delivered against
``GET https://api.onepeloton.com/api/me``: the minted ``Authorization`` value
verbatim (it already carries ``Bearer `` — never add another) plus the minted
cookies, with browser-like members-site headers. 200 passes; anything else, or a
transport exception, raises ``SessionRejectedError`` (retryable, alarm
``session_rejected``) so the main loop fails the job instead of reporting a dead
session. Messages name the status / exception class and Peloton's ``error_code``
only — never the token, a cookie value or the response body.
"""

from __future__ import annotations

from collections.abc import Callable

import requests
from requests.cookies import create_cookie

from .bearer import MintedSession
from .errors import SessionRejectedError
from .logging_setup import get_logger

API_ME_URL = "https://api.onepeloton.com/api/me"
MEMBERS_ORIGIN = "https://members.onepeloton.com"
# A realistic desktop Chrome UA: /api/me is called by the members web app, so the
# check should look like that app rather than a bare python-requests client.
BROWSER_USER_AGENT = (
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/140.0.0.0 Safari/537.36"
)
DEFAULT_TIMEOUT = 20.0
_MAX_MESSAGE_CHARS = 120


class SessionValidator:
    """One ``GET /api/me`` with the minted bearer + cookies; raises on anything but 200."""

    def __init__(
        self,
        *,
        session_factory: Callable[[], requests.Session] = requests.Session,
        timeout: float = DEFAULT_TIMEOUT,
        url: str = API_ME_URL,
    ) -> None:
        # A fresh ``requests.Session`` per validation, so no cookie state carries
        # over between runs (injectable for tests).
        self._session_factory = session_factory
        self.timeout = timeout
        self.url = url
        self.logger = get_logger(f"{__name__}.SessionValidator")

    def validate(self, minted: MintedSession) -> None:
        """Raise ``SessionRejectedError`` unless /api/me answers 200 to this session."""
        http = self._session_factory()
        try:
            for cookie in minted.cookies:
                http.cookies.set_cookie(_to_requests_cookie(cookie))
            resp = http.get(self.url, headers=self._headers(minted), timeout=self.timeout)
        except requests.RequestException as exc:
            raise SessionRejectedError(
                f"session validation against /api/me failed: {type(exc).__name__}"
            ) from exc
        finally:
            http.close()

        if resp.status_code != 200:
            raise SessionRejectedError(_rejection_message(resp))
        self.logger.info("session validated against /api/me (200)")

    @staticmethod
    def _headers(minted: MintedSession) -> dict:
        return {
            # Verbatim: the captured value already starts with ``Bearer ``.
            "Authorization": minted.bearer,
            "Origin": MEMBERS_ORIGIN,
            "Referer": f"{MEMBERS_ORIGIN}/",
            "User-Agent": BROWSER_USER_AGENT,
            "Peloton-Platform": "web",
            "Accept": "application/json",
        }


def _to_requests_cookie(cookie: dict):
    """Selenium cookie dict -> cookielib ``Cookie`` (mirrors the cookies.txt render).

    A leading-dot domain (``.onepeloton.com``) is a domain cookie sent to every
    subdomain, api.onepeloton.com included; a bare host is host-only, exactly as
    the browser and the downloader treat it. Expiry 0/absent = session cookie.
    """
    expiry = cookie.get("expiry")
    return create_cookie(
        name=cookie.get("name", ""),
        value=cookie.get("value", ""),
        domain=cookie.get("domain", ""),
        path=cookie.get("path", "/") or "/",
        secure=bool(cookie.get("secure")),
        expires=int(expiry) if expiry else None,
    )


def _rejection_message(resp: requests.Response) -> str:
    """Status + Peloton ``error_code`` (+ a short ``message``), never the body itself."""
    parts = [f"session rejected by /api/me: HTTP {resp.status_code}"]
    try:
        body = resp.json()
    except ValueError:
        body = None
    if isinstance(body, dict):
        if body.get("error_code") is not None:
            parts.append(f"error_code={body['error_code']}")
        message = body.get("message")
        if isinstance(message, str) and message.strip():
            parts.append(f"({message.strip()[:_MAX_MESSAGE_CHARS]})")
    return " ".join(parts)
