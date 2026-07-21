"""Typed error + alarm taxonomy shared across the worker.

The donor's failure mode was a bare ``RuntimeError`` on bearer-capture failure
that failed the whole run, leaving the downloader running an aging token with no
alarm (Q-03 "bearer hard-fail silent-stall blast radius"). Here every fragile
leg raises a typed error the main loop maps to a transport ``fail`` with the
right ``retryable`` flag and one of the four contract alarm kinds.
"""

from __future__ import annotations

from enum import Enum


class AlarmKind(str, Enum):
    """The four first-class worker alarm kinds in the transport contract."""

    LOGIN = "login"
    BEARER_CAPTURE = "bearer_capture"
    SELECTOR_DRIFT = "selector_drift"
    SCROLL_TIMEOUT = "scroll_timeout"


class WorkerError(Exception):
    """Base class for worker errors that carry a fail(retryable, alarm) mapping."""

    #: Whether the CORE should re-enqueue the job (transient) or park it (needs a human/code fix).
    retryable: bool = True
    #: The alarm kind to surface, or ``None`` for a plain failure.
    alarm_kind: AlarmKind | None = None

    def __init__(self, message: str, *, retryable: bool | None = None,
                 alarm_kind: AlarmKind | None = None) -> None:
        super().__init__(message)
        if retryable is not None:
            self.retryable = retryable
        if alarm_kind is not None:
            self.alarm_kind = alarm_kind

    def to_alarm(self) -> dict | None:
        if self.alarm_kind is None:
            return None
        return {"kind": self.alarm_kind.value, "message": str(self)}


class LoginError(WorkerError):
    """Login did not reach an authenticated state.

    ``retryable`` depends on the outcome: a transient timeout/redirect is
    retryable; bad credentials / MFA / captcha need a human, so they are not.
    """

    alarm_kind = AlarmKind.LOGIN


class BearerCaptureError(WorkerError):
    """The ``Authorization: Bearer`` to api.onepeloton.com was never captured.

    Always retryable + always alarms: this is the donor's silent-stall gap made
    loud (D-05 / D-10). Never returned as an empty/stale token.
    """

    retryable = True
    alarm_kind = AlarmKind.BEARER_CAPTURE


class SelectorDriftError(WorkerError):
    """A scrape whose selectors returned zero or malformed hits where classes were expected.

    Retryable (a zero-hit page can also be a transient load failure) but always
    alarms so a real selector change is seen before the estate notices missing
    downloads (D-10).
    """

    retryable = True
    alarm_kind = AlarmKind.SELECTOR_DRIFT


class ScrollTimeoutError(WorkerError):
    """Dynamic scrolling hit its cap without ever surfacing the classes it needed."""

    retryable = True
    alarm_kind = AlarmKind.SCROLL_TIMEOUT


class TransportError(Exception):
    """A non-retryable transport failure (4xx other than 409, or retries exhausted)."""


class JobReclaimed(Exception):
    """Heartbeat returned 409: the CORE reclaimed this job. Abort it cleanly."""
