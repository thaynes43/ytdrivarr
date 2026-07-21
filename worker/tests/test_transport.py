"""Transport: claim/heartbeat/report/fail, 409 reclaim, 5xx retry, heartbeater."""

from __future__ import annotations

import time

import pytest
import responses

from ytdrivarr_peloton_worker.errors import JobReclaimed, TransportError
from ytdrivarr_peloton_worker.transport import CoreClient, Heartbeater

BASE = "http://core.test"


def make_client(no_sleep):
    return CoreClient(BASE, "api-key", "worker-1", max_retries=3, backoff=0.01, sleep=no_sleep)


@responses.activate
def test_claim_returns_job(no_sleep):
    responses.add(responses.POST, f"{BASE}/api/v1/jobs/claim",
                  json={"job": {"id": "j1", "kind": "discovery", "providerId": "peloton",
                                "payload": {"mode": "scrape"}, "attempts": 0}}, status=200)
    client = make_client(no_sleep)
    job = client.claim(kinds=["discovery"], provider_id="peloton")
    assert job is not None
    assert job.id == "j1" and job.kind == "discovery"
    assert job.payload == {"mode": "scrape"}
    body = responses.calls[0].request.body
    assert b"worker-1" in body
    assert responses.calls[0].request.headers["X-Api-Key"] == "api-key"


@responses.activate
def test_claim_empty(no_sleep):
    responses.add(responses.POST, f"{BASE}/api/v1/jobs/claim", json={"job": None}, status=200)
    assert make_client(no_sleep).claim() is None


@responses.activate
def test_heartbeat_ok(no_sleep):
    responses.add(responses.POST, f"{BASE}/api/v1/jobs/j1/heartbeat",
                  json={"ok": True}, status=200)
    make_client(no_sleep).heartbeat("j1")  # no raise


@responses.activate
def test_heartbeat_409_reclaimed(no_sleep):
    responses.add(responses.POST, f"{BASE}/api/v1/jobs/j1/heartbeat", status=409)
    with pytest.raises(JobReclaimed):
        make_client(no_sleep).heartbeat("j1")


@responses.activate
def test_report_and_fail(no_sleep):
    responses.add(responses.POST, f"{BASE}/api/v1/jobs/j1/report", json={}, status=200)
    responses.add(responses.POST, f"{BASE}/api/v1/jobs/j1/fail", json={}, status=200)
    client = make_client(no_sleep)
    client.report("j1", {"entries": [], "telemetry": {}})
    client.fail("j1", "boom", retryable=True, alarm={"kind": "bearer_capture", "message": "x"})
    fail_body = responses.calls[1].request.body
    assert b"bearer_capture" in fail_body
    assert b"retryable" in fail_body


@responses.activate
def test_retry_on_transient_5xx_then_success(no_sleep):
    responses.add(responses.POST, f"{BASE}/api/v1/jobs/claim", status=503)
    responses.add(responses.POST, f"{BASE}/api/v1/jobs/claim", json={"job": None}, status=200)
    client = make_client(no_sleep)
    assert client.claim() is None
    assert len(responses.calls) == 2  # retried once
    assert len(no_sleep.calls) == 1


@responses.activate
def test_hard_4xx_no_retry(no_sleep):
    responses.add(responses.POST, f"{BASE}/api/v1/jobs/claim", status=400)
    client = make_client(no_sleep)
    with pytest.raises(TransportError):
        client.claim()
    assert len(responses.calls) == 1  # not retried
    assert no_sleep.calls == []


@responses.activate
def test_retry_exhausted_raises(no_sleep):
    for _ in range(5):
        responses.add(responses.POST, f"{BASE}/api/v1/jobs/claim", status=500)
    client = CoreClient(BASE, "k", "w", max_retries=2, backoff=0.01, sleep=no_sleep)
    with pytest.raises(TransportError):
        client.claim()
    assert len(responses.calls) == 3  # initial + 2 retries


class _StubClient:
    def __init__(self, reclaim_after=1):
        self.calls = 0
        self.reclaim_after = reclaim_after

    def heartbeat(self, job_id):
        self.calls += 1
        if self.calls >= self.reclaim_after:
            raise JobReclaimed("reclaimed")


def test_heartbeater_thread_reclaim(no_sleep):
    stub = _StubClient(reclaim_after=1)
    fired = {"n": 0}
    hb = Heartbeater(stub, "j1", interval=0.02, sleep=no_sleep,
                     on_reclaim=lambda: fired.__setitem__("n", fired["n"] + 1))
    hb.start()
    deadline = time.time() + 2.0
    while not hb.reclaimed and time.time() < deadline:
        time.sleep(0.005)
    hb.stop()
    assert hb.reclaimed is True
    assert fired["n"] == 1
    assert stub.calls >= 1


def test_heartbeater_stop_without_reclaim(no_sleep):
    class _OkClient:
        def __init__(self):
            self.calls = 0

        def heartbeat(self, job_id):
            self.calls += 1

    client = _OkClient()
    hb = Heartbeater(client, "j1", interval=0.02, sleep=no_sleep)
    hb.start()
    time.sleep(0.05)
    hb.stop()
    assert hb.reclaimed is False
