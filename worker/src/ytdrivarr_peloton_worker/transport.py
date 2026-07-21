"""HTTP transport to the CORE job protocol (X-Api-Key auth).

Endpoints (normative contract):
  POST /api/v1/jobs/claim            -> {job: {...} | null}
  POST /api/v1/jobs/:id/heartbeat    -> {ok: true}  (409 => reclaimed => abort)
  POST /api/v1/jobs/:id/report       -> report entries + session + telemetry
  POST /api/v1/jobs/:id/fail         -> error + retryable + optional alarm

Retries transient failures (connection errors, 5xx) with backoff; 4xx (other
than 409 on heartbeat) is a hard ``TransportError`` — no point retrying a bad
request. A background ``Heartbeater`` keeps the claim alive while a job runs and
raises the reclaim signal into the worker if the CORE takes the job back.
"""

from __future__ import annotations

import threading
import time
from collections.abc import Callable
from dataclasses import dataclass

import requests

from .errors import JobReclaimed, TransportError
from .logging_setup import get_logger

RETRYABLE_STATUS = frozenset({500, 502, 503, 504, 429})


@dataclass
class Job:
    id: str
    kind: str
    provider_id: str
    payload: dict
    attempts: int = 0

    @classmethod
    def from_api(cls, data: dict) -> Job:
        return cls(
            id=str(data["id"]),
            kind=data.get("kind", ""),
            provider_id=data.get("providerId", ""),
            payload=data.get("payload", {}) or {},
            attempts=int(data.get("attempts", 0) or 0),
        )


class CoreClient:
    def __init__(
        self,
        base_url: str,
        api_key: str,
        worker: str,
        *,
        session: requests.Session | None = None,
        timeout: float = 30.0,
        max_retries: int = 3,
        backoff: float = 1.0,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.base_url = base_url.rstrip("/")
        self.api_key = api_key
        self.worker = worker
        self.timeout = timeout
        self.max_retries = max_retries
        self.backoff = backoff
        self._sleep = sleep
        self._session = session or requests.Session()
        self.logger = get_logger(f"{__name__}.CoreClient")

    # -- protocol methods ----------------------------------------------------
    def claim(self, kinds: list | None = None, provider_id: str | None = None) -> Job | None:
        body: dict = {"worker": self.worker}
        if kinds:
            body["kinds"] = kinds
        if provider_id:
            body["providerId"] = provider_id
        data = self._post("/api/v1/jobs/claim", body)
        job = (data or {}).get("job")
        if not job:
            return None
        return Job.from_api(job)

    def heartbeat(self, job_id: str) -> None:
        """Raise ``JobReclaimed`` on 409; otherwise return on {ok:true}."""
        self._post(f"/api/v1/jobs/{job_id}/heartbeat", {"worker": self.worker},
                   reclaim_on_409=True)

    def report(self, job_id: str, result: dict) -> None:
        self._post(f"/api/v1/jobs/{job_id}/report",
                   {"worker": self.worker, "result": result})

    def fail(self, job_id: str, error: str, retryable: bool, alarm: dict | None = None) -> None:
        body: dict = {"worker": self.worker, "error": error, "retryable": bool(retryable)}
        if alarm:
            body["alarm"] = alarm
        self._post(f"/api/v1/jobs/{job_id}/fail", body)

    # -- HTTP with retry/backoff --------------------------------------------
    def _post(self, path: str, body: dict, *, reclaim_on_409: bool = False) -> dict:
        url = f"{self.base_url}{path}"
        headers = {"X-Api-Key": self.api_key, "Content-Type": "application/json"}
        last_exc: Exception | None = None
        for attempt in range(self.max_retries + 1):
            try:
                resp = self._session.post(url, json=body, headers=headers, timeout=self.timeout)
            except requests.RequestException as exc:
                last_exc = exc
                if attempt < self.max_retries:
                    self._backoff(attempt)
                    continue
                raise TransportError(f"POST {path} failed after retries: {exc}") from exc

            if reclaim_on_409 and resp.status_code == 409:
                raise JobReclaimed(f"job reclaimed (409) on {path}")

            if resp.status_code in RETRYABLE_STATUS:
                last_exc = TransportError(f"{resp.status_code} on {path}")
                if attempt < self.max_retries:
                    self.logger.warning("Transient %s on %s, retrying", resp.status_code, path)
                    self._backoff(attempt)
                    continue
                raise TransportError(f"POST {path} failed: {resp.status_code} after retries")

            if resp.status_code >= 400:
                raise TransportError(f"POST {path} -> {resp.status_code}: {resp.text[:300]}")

            if not resp.content:
                return {}
            try:
                return resp.json()
            except ValueError:
                return {}
        # Unreachable, but keep the type-checker happy.
        raise TransportError(f"POST {path} exhausted retries: {last_exc}")

    def _backoff(self, attempt: int) -> None:
        self._sleep(self.backoff * (2 ** attempt))


class Heartbeater:
    """Background thread that heartbeats a running job until stopped/reclaimed."""

    def __init__(
        self,
        client: CoreClient,
        job_id: str,
        *,
        interval: float = 15.0,
        on_reclaim: Callable[[], None] | None = None,
        sleep: Callable[[float], None] = time.sleep,
    ) -> None:
        self.client = client
        self.job_id = job_id
        self.interval = interval
        self._on_reclaim = on_reclaim
        self._sleep = sleep
        self._stop = threading.Event()
        self._reclaimed = threading.Event()
        self._thread: threading.Thread | None = None
        self.logger = get_logger(f"{__name__}.Heartbeater")

    @property
    def reclaimed(self) -> bool:
        return self._reclaimed.is_set()

    def start(self) -> None:
        self._thread = threading.Thread(target=self._run, name=f"hb-{self.job_id}", daemon=True)
        self._thread.start()

    def stop(self) -> None:
        self._stop.set()
        if self._thread is not None:
            self._thread.join(timeout=self.interval + 5)

    def _run(self) -> None:
        while not self._stop.is_set():
            # Sleep the interval in small slices so stop() is responsive.
            waited = 0.0
            step = min(0.5, self.interval)
            while waited < self.interval and not self._stop.is_set():
                self._sleep(step)
                waited += step
            if self._stop.is_set():
                return
            try:
                self.client.heartbeat(self.job_id)
            except JobReclaimed:
                self.logger.warning("Job %s reclaimed by CORE", self.job_id)
                self._reclaimed.set()
                if self._on_reclaim:
                    self._on_reclaim()
                return
            except TransportError as exc:
                # A transient heartbeat miss shouldn't kill the job; log and keep trying.
                self.logger.warning("Heartbeat error for %s: %s", self.job_id, exc)
