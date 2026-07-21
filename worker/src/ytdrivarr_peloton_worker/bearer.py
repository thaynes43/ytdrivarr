"""Hardened bearer + cookie mint — the most fragile leg.

Ports the CDP sniff from the donor ``scraper_manager._save_auth_artifacts``:
inject a fetch/XHR interceptor via ``Page.addScriptToEvaluateOnNewDocument``,
navigate to a class *player* page (the ``api.onepeloton.com/api/metrics/v2/video``
request only fires there), then poll BOTH ``window._capturedBearerToken`` and
the CDP performance log for an ``Authorization: Bearer`` header to
api.onepeloton.com.

Hardening vs the donor:
  * the ≤15s fixed-``sleep`` poll becomes an explicit ``WebDriverWait`` on the
    capture predicate;
  * capture is retried with backoff (re-navigating the player page);
  * on exhaustion it RAISES ``BearerCaptureError`` — the main loop turns that
    into ``fail(retryable=True, alarm=bearer_capture)``. It NEVER returns a
    stale/empty token silently (the donor's silent-stall blast radius).
"""

from __future__ import annotations

import base64
import json
import time
from collections.abc import Callable
from dataclasses import dataclass, field
from datetime import UTC, datetime

from selenium.common.exceptions import TimeoutException, WebDriverException

from .errors import BearerCaptureError
from .logging_setup import get_logger
from .waits import wait_for_condition

API_HOST = "api.onepeloton.com"
METRICS_URL_FRAGMENT = "api.onepeloton.com/api/metrics/v2/video"

# The interceptor is injected on every new document so it is in place before the
# page's own scripts issue the metrics request. Ported from the donor verbatim.
INTERCEPT_SCRIPT = r"""
(function() {
    window._capturedBearerToken = null;
    window._interceptionLog = [];

    const originalFetch = window.fetch;
    window.fetch = function(...args) {
        const url = typeof args[0] === 'string' ? args[0] : (args[0] ? args[0].url : '');
        const options = args[1] || {};
        window._interceptionLog.push('fetch: ' + url);
        if (url && url.includes('api.onepeloton.com')) {
            const headers = options.headers || {};
            const authHeader = headers.Authorization || headers.authorization;
            if (authHeader && authHeader.startsWith('Bearer ')) {
                window._capturedBearerToken = authHeader;
                window._interceptionLog.push('TOKEN CAPTURED FROM FETCH');
            }
        }
        return originalFetch.apply(this, args);
    };

    const originalOpen = XMLHttpRequest.prototype.open;
    const originalSetRequestHeader = XMLHttpRequest.prototype.setRequestHeader;
    XMLHttpRequest.prototype.open = function(method, url, ...rest) {
        this._url = url;
        return originalOpen.apply(this, [method, url, ...rest]);
    };
    XMLHttpRequest.prototype.setRequestHeader = function(header, value) {
        if (header.toLowerCase() === 'authorization' && value && value.startsWith('Bearer ')) {
            if (this._url && this._url.includes('api.onepeloton.com')) {
                window._capturedBearerToken = value;
                window._interceptionLog.push('TOKEN CAPTURED FROM XHR: ' + this._url);
            }
        }
        return originalSetRequestHeader.apply(this, [header, value]);
    };
})();
"""


@dataclass
class MintedSession:
    bearer: str
    cookies: list = field(default_factory=list)  # raw selenium cookie dicts
    minted_at: datetime = field(default_factory=lambda: datetime.now(UTC))

    @property
    def expires_at(self) -> datetime | None:
        """Best-effort JWT ``exp`` decode for the bearer-freshness SLA (D-07)."""
        return _jwt_expiry(self.bearer)

    def cookies_txt(self) -> str:
        return render_netscape_cookies(self.cookies)

    def to_session_payload(self) -> dict:
        exp = self.expires_at
        payload = {
            "bearer": self.bearer,
            "cookies": self.cookies_txt(),
            "mintedAt": self.minted_at.astimezone(UTC).isoformat(),
        }
        if exp is not None:
            payload["expiresAt"] = exp.astimezone(UTC).isoformat()
        return payload


class BearerMinter:
    def __init__(
        self,
        *,
        capture_timeout: float = 15.0,
        poll: float = 0.5,
        retries: int = 2,
        backoff: float = 2.0,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.capture_timeout = capture_timeout
        self.poll = poll
        self.retries = retries
        self.backoff = backoff
        self._sleep = sleep
        self.logger = get_logger(f"{__name__}.BearerMinter")

    def mint(self, driver, class_player_url: str) -> MintedSession:
        """Capture the bearer from a player page + snapshot cookies. Retries.

        Raises ``BearerCaptureError`` if the token is never seen.
        """
        last_exc: Exception | None = None
        for attempt in range(self.retries + 1):
            self.logger.info("Bearer mint attempt %d/%d via %s",
                             attempt + 1, self.retries + 1, class_player_url)
            try:
                token = self._capture(driver, class_player_url)
                cookies = _safe_get_cookies(driver)
                self.logger.info("Bearer captured (%d chars), %d cookies",
                                 len(token), len(cookies))
                return MintedSession(bearer=token.strip(), cookies=cookies)
            except BearerCaptureError as exc:
                last_exc = exc
                if attempt < self.retries:
                    delay = self.backoff * (attempt + 1)
                    self.logger.warning("Capture failed, backing off %.1fs: %s", delay, exc)
                    self._sleep(delay)
        raise BearerCaptureError(
            f"bearer token never captured after {self.retries + 1} attempts: {last_exc}"
        )

    def _capture(self, driver, class_player_url: str) -> str:
        try:
            for domain in ("Network", "Performance", "Page"):
                driver.execute_cdp_cmd(f"{domain}.enable", {})
            driver.execute_cdp_cmd(
                "Page.addScriptToEvaluateOnNewDocument", {"source": INTERCEPT_SCRIPT}
            )
            driver.get(class_player_url)
        except WebDriverException as exc:
            raise BearerCaptureError(f"could not prime player page: {exc}") from exc

        captured: dict[str, str | None] = {"token": None}

        def probe(d) -> str | bool:
            # 1) the injected JS hook
            try:
                tok = d.execute_script("return window._capturedBearerToken;")
                if tok:
                    return tok
            except WebDriverException:
                pass
            # 2) the CDP performance log (Network.requestWillBeSent)
            tok = _scan_perf_log(d)
            if tok:
                return tok
            return False

        try:
            token = wait_for_condition(driver, probe, self.capture_timeout, self.poll)
        except TimeoutException:
            self._log_final_interception(driver)
            raise BearerCaptureError(
                f"no Authorization: Bearer to {API_HOST} within {self.capture_timeout}s"
            ) from None
        finally:
            try:
                driver.execute_cdp_cmd("Network.disable", {})
            except WebDriverException:
                pass
        captured["token"] = token
        if not token:
            raise BearerCaptureError("capture predicate returned empty token")
        return token

    def _log_final_interception(self, driver) -> None:
        try:
            log = driver.execute_script("return window._interceptionLog || [];") or []
            tail = log[-8:] if isinstance(log, list) else log
            self.logger.warning("Bearer not captured. Interception log tail: %s", tail)
        except WebDriverException:
            pass


def _scan_perf_log(driver) -> str | None:
    """Scan CDP performance logs for the metrics request's Authorization header."""
    try:
        logs = driver.get_log("performance")
    except WebDriverException:
        return None
    for entry in logs[-40:]:
        message = entry.get("message", "")
        if API_HOST not in message:
            continue
        try:
            data = json.loads(message)
        except (json.JSONDecodeError, TypeError):
            continue
        msg = data.get("message", {})
        if msg.get("method") != "Network.requestWillBeSent":
            continue
        request = msg.get("params", {}).get("request", {})
        url = request.get("url", "")
        if "api.onepeloton.com" not in url:
            continue
        headers = request.get("headers", {})
        auth = headers.get("Authorization") or headers.get("authorization")
        if auth and auth.startswith("Bearer "):
            return auth
    return None


def _safe_get_cookies(driver) -> list:
    try:
        return list(driver.get_cookies() or [])
    except WebDriverException:
        return []


def render_netscape_cookies(cookies: list) -> str:
    """Render selenium cookie dicts to Netscape/Mozilla cookies.txt format.

    ``domain \\t include_subdomains \\t path \\t secure \\t expiry \\t name \\t value``
    (ported from the donor's ``MozillaCookieJar`` usage; ``include_subdomains``
    = domain starts with a dot, matching ``domain_initial_dot``).
    """
    lines = ["# Netscape HTTP Cookie File", "# Generated by ytdrivarr-peloton-worker", ""]
    for c in cookies:
        domain = c.get("domain", "")
        include_sub = "TRUE" if domain.startswith(".") else "FALSE"
        path = c.get("path", "/")
        secure = "TRUE" if c.get("secure") else "FALSE"
        expiry = int(c.get("expiry", 0) or 0)
        name = c.get("name", "")
        value = c.get("value", "")
        lines.append("\t".join([domain, include_sub, path, secure, str(expiry), name, value]))
    return "\n".join(lines) + "\n"


def _jwt_expiry(token: str) -> datetime | None:
    """Decode a JWT ``exp`` claim if the bearer is a JWT; else None."""
    raw = token.strip()
    if raw.lower().startswith("bearer "):
        raw = raw[7:]
    parts = raw.split(".")
    if len(parts) != 3:
        return None
    try:
        payload_b64 = parts[1]
        payload_b64 += "=" * (-len(payload_b64) % 4)  # pad base64
        payload = json.loads(base64.urlsafe_b64decode(payload_b64))
        exp = payload.get("exp")
        if isinstance(exp, (int, float)):
            return datetime.fromtimestamp(exp, tz=UTC)
    except Exception:
        return None
    return None
