"""The claim -> heartbeat -> scrape/refresh -> report/fail loop."""

from __future__ import annotations

from ytdrivarr_peloton_worker.bearer import MintedSession
from ytdrivarr_peloton_worker.emit import ScrapedClass, build_entry
from ytdrivarr_peloton_worker.errors import BearerCaptureError
from ytdrivarr_peloton_worker.login import LoginOutcome, LoginResult
from ytdrivarr_peloton_worker.scraper import ActivityScrapeResult
from ytdrivarr_peloton_worker.transport import Job
from ytdrivarr_peloton_worker.worker import PelotonPayload, PelotonWorker, WorkerConfig

CONFIG = WorkerConfig(
    core_url="http://core.test", api_key="k", worker_name="w1",
    username="u", password="p", poll_interval=0.0,
)


# -- fakes -------------------------------------------------------------------
class FakeClient:
    def __init__(self, jobs=None):
        self._jobs = list(jobs or [])
        self.reported = []
        self.failed = []
        self.claim_count = 0

    def claim(self, kinds=None, provider_id=None):
        self.claim_count += 1
        return self._jobs.pop(0) if self._jobs else None

    def report(self, job_id, result):
        self.reported.append((job_id, result))

    def fail(self, job_id, error, retryable, alarm=None):
        self.failed.append({"id": job_id, "error": error, "retryable": retryable, "alarm": alarm})

    def heartbeat(self, job_id):
        pass


class FakeHeartbeater:
    def __init__(self, reclaimed=False):
        self._reclaimed = reclaimed
        self.started = self.stopped = False

    @property
    def reclaimed(self):
        return self._reclaimed

    def start(self):
        self.started = True

    def stop(self):
        self.stopped = True


class FakeSession:
    def __init__(self):
        self.closed = False

    def start(self):
        return object()

    def close(self):
        self.closed = True


class FakeLogin:
    def __init__(self, result):
        self.result = result

    def login(self, driver, username, password):
        return self.result


class FakeMinter:
    def __init__(self, session=None, raise_exc=None):
        self.session = session
        self.raise_exc = raise_exc
        self.retries = 2

    def mint(self, driver, url):
        if self.raise_exc:
            raise self.raise_exc
        return self.session


class FakeScraper:
    def __init__(self, results):
        self.results = results

    def scrape_activity(self, driver, activity, existing, numberer, media_root):
        return self.results.get(activity, ActivityScrapeResult(activity=activity))


class NumberingScraper:
    """A scraper fake that ACTUALLY numbers via the numberer the worker hands it,
    exactly like the real PelotonScraper (skip-existing then ``numberer.next``),
    so the worker's PER-ACTIVITY seeding is exercised end-to-end.

    ``classes`` maps ``{activity: [(class_id, duration_minutes), ...]}``.
    """

    def __init__(self, classes):
        self.classes = classes

    def scrape_activity(self, driver, activity, existing, numberer, media_root):
        entries = []
        candidates = 0
        for cid, duration in self.classes.get(activity, []):
            if cid in existing:  # skipped BEFORE numbering -> consumes no number
                continue
            candidates += 1
            episode = numberer.next(duration)
            entries.append(
                build_entry(
                    ScrapedClass(class_id=cid, title=f"{duration} min Class",
                                 instructor="Inst", activity=activity, duration=duration,
                                 season=duration, episode=episode),
                    media_root,
                )
            )
        links = len(self.classes.get(activity, []))
        return ActivityScrapeResult(
            activity=activity, entries=entries, links_found=links,
            new_candidates=candidates, skipped_existing=links - candidates,
        )


def make_worker(client, *, login=None, scraper=None, minter=None, hb=None):
    hb = hb or FakeHeartbeater()
    return PelotonWorker(
        CONFIG,
        client=client,
        session_factory=lambda pelo: FakeSession(),
        login_factory=lambda pelo: login or FakeLogin(LoginResult(LoginOutcome.OK)),
        minter_factory=lambda pelo: minter or FakeMinter(_minted()),
        scraper_factory=lambda pelo: scraper or FakeScraper({}),
        heartbeater_factory=lambda job_id: hb,
    )


def _minted():
    return MintedSession(bearer="Bearer tok", cookies=[])


def _entry(cid="c1", ep=101):
    return build_entry(
        ScrapedClass(class_id=cid, title="30 min Ride", instructor="Cody Rigsby",
                     activity="cycling", duration=30, season=30, episode=ep),
        "/media/peloton",
    )


def _scrape_job(**pelo):
    base = {"activities": ["cycling"], "existingClassIds": [], "mediaRoot": "/media/peloton"}
    base.update(pelo)
    return Job(id="j1", kind="discovery", provider_id="peloton",
               payload={"mode": "scrape", "peloton": base})


# -- tests -------------------------------------------------------------------
def test_empty_claim_is_idle():
    client = FakeClient(jobs=[])
    worker = make_worker(client)
    assert worker.run_once() is False
    assert client.reported == [] and client.failed == []


def test_scrape_happy_reports_entries():
    result = ActivityScrapeResult(activity="cycling", entries=[_entry("c1"), _entry("c2", 102)],
                                  links_found=2, new_candidates=2)
    client = FakeClient(jobs=[_scrape_job()])
    worker = make_worker(client, scraper=FakeScraper({"cycling": result}))
    assert worker.run_once() is True
    assert len(client.reported) == 1
    _, payload = client.reported[0]
    assert len(payload["entries"]) == 2
    assert payload["session"]["bearer"] == "Bearer tok"
    assert payload["telemetry"]["entriesBuilt"] == 2
    assert payload["summary"]["totalNew"] == 2
    assert client.failed == []


def test_scrape_telemetry_carries_login_and_bearer_attempts():
    # The metrics-accuracy fix: loginAttempts flows from the login result,
    # bearerAttempts from the minted session, scrollsPerformed from the scrape
    # results — the reported telemetry the CORE sums into
    # ytdrivarr_login_attempts_total / _bearer_capture_retries_total / _last_run_scrolls.
    result = ActivityScrapeResult(activity="cycling", entries=[_entry("c1")],
                                  links_found=1, new_candidates=1, scrolls_performed=5)
    client = FakeClient(jobs=[_scrape_job()])
    login = FakeLogin(LoginResult(LoginOutcome.OK, attempts=2))
    worker = make_worker(client, scraper=FakeScraper({"cycling": result}), login=login)
    assert worker.run_once() is True
    _, payload = client.reported[0]
    tel = payload["telemetry"]
    assert tel["loginAttempts"] == 2           # threaded from LoginResult.attempts
    assert tel["bearerAttempts"] == 1          # MintedSession.attempts (clean first-try mint)
    assert tel["scrollsPerformed"] == 5        # summed from the per-activity results
    assert tel["authOk"] is True and tel["loginOk"] is True


def test_login_bad_credentials_fails_not_retryable():
    client = FakeClient(jobs=[_scrape_job()])
    login = FakeLogin(LoginResult(LoginOutcome.BAD_CREDENTIALS, "wrong"))
    worker = make_worker(client, login=login)
    worker.run_once()
    assert len(client.failed) == 1
    f = client.failed[0]
    assert f["retryable"] is False
    assert f["alarm"]["kind"] == "login"
    assert client.reported == []


def test_selector_drift_zero_entries_fails_with_alarm():
    drift = ActivityScrapeResult(activity="cycling", entries=[], links_found=3, new_candidates=3)
    assert drift.selector_drift is True
    client = FakeClient(jobs=[_scrape_job()])
    worker = make_worker(client, scraper=FakeScraper({"cycling": drift}))
    worker.run_once()
    assert len(client.failed) == 1
    assert client.failed[0]["alarm"]["kind"] == "selector_drift"
    assert client.failed[0]["retryable"] is True


def test_scroll_timeout_zero_links_capped_fails():
    stuck = ActivityScrapeResult(activity="cycling", entries=[], links_found=0,
                                 new_candidates=0, scroll_capped=True)
    assert stuck.zero_links and stuck.scroll_capped
    client = FakeClient(jobs=[_scrape_job()])
    worker = make_worker(client, scraper=FakeScraper({"cycling": stuck}))
    worker.run_once()
    assert client.failed[0]["alarm"]["kind"] == "scroll_timeout"


def test_bearer_capture_failure_fails_with_alarm():
    result = ActivityScrapeResult(activity="cycling", entries=[_entry("c1")],
                                  links_found=1, new_candidates=1)
    client = FakeClient(jobs=[_scrape_job()])
    minter = FakeMinter(raise_exc=BearerCaptureError("no token"))
    worker = make_worker(client, scraper=FakeScraper({"cycling": result}), minter=minter)
    worker.run_once()
    assert len(client.failed) == 1
    assert client.failed[0]["alarm"]["kind"] == "bearer_capture"
    assert client.failed[0]["retryable"] is True


def test_nothing_new_reports_empty_no_alarm():
    # Links present, all already-known -> zero entries but NOT suspicious.
    empty = ActivityScrapeResult(activity="cycling", entries=[], links_found=5,
                                 new_candidates=0, skipped_existing=5)
    assert empty.suspicious is False
    client = FakeClient(jobs=[_scrape_job(existingClassIds=["a"])])
    worker = make_worker(client, scraper=FakeScraper({"cycling": empty}),
                         minter=FakeMinter(_minted()))
    worker.run_once()
    assert len(client.reported) == 1
    assert client.reported[0][1]["entries"] == []
    assert client.failed == []


def test_heartbeat_reclaim_aborts_cleanly():
    result = ActivityScrapeResult(activity="cycling", entries=[_entry("c1")],
                                  links_found=1, new_candidates=1)
    client = FakeClient(jobs=[_scrape_job()])
    hb = FakeHeartbeater(reclaimed=True)
    worker = make_worker(client, scraper=FakeScraper({"cycling": result}), hb=hb)
    worker.run_once()
    # Reclaimed before any activity work -> no report, no fail.
    assert client.reported == [] and client.failed == []
    assert hb.stopped is True


def test_refresh_mode_mints_bearer_only():
    job = Job(id="jr", kind="refresh", provider_id="peloton",
              payload={"mode": "refresh",
                       "peloton": {"activities": ["cycling"], "existingClassIds": ["existing1"],
                                   "mediaRoot": "/media/peloton"}})
    client = FakeClient(jobs=[job])
    worker = make_worker(client, minter=FakeMinter(_minted()))
    worker.run_once()
    assert len(client.reported) == 1
    _, payload = client.reported[0]
    assert payload["entries"] == []
    assert payload["session"]["bearer"] == "Bearer tok"
    assert payload["telemetry"]["mode"] == "refresh"


# -- per-(activity, duration) numbering (the contract fix) --------------------
def test_per_activity_numbering_independence():
    """Test #1 — THE regression test for the flat bug.

    One run scrapes ``cardio`` then ``cycling``, both with 30-min classes, seeded
    independently. Under the old (flat) model a single 30-min counter would be
    shared and cardio's new classes would land at 2151+. Under the contract each
    activity holds its OWN band: cardio continues 222 -> E223, E224 while cycling
    continues 2150 -> E2151, E2152. Both sequences asserted explicitly.
    """
    scraper = NumberingScraper({
        "cardio": [("ca1", 30), ("ca2", 30)],
        "cycling": [("cy1", 30), ("cy2", 30)],
    })
    job = _scrape_job(
        activities=["cardio", "cycling"],
        episodeNumbering={"cardio": {"30": 222}, "cycling": {"30": 2150}},
    )
    client = FakeClient(jobs=[job])
    worker = make_worker(client, scraper=scraper)
    assert worker.run_once() is True

    entries = client.reported[0][1]["entries"]
    eps = {e["entryKey"]: e["overrides"]["episode_number"] for e in entries}
    assert eps["ca1"] == 223 and eps["ca2"] == 224   # cardio's own band
    assert eps["cy1"] == 2151 and eps["cy2"] == 2152  # cycling's own, disjoint band


def test_worker_report_carries_per_activity_numbering():
    """Test #6 — the full loop's report body carries per-activity numbering under
    the new contract, both in the entry overrides AND the telemetry high-water."""
    scraper = NumberingScraper({
        "cardio": [("ca1", 30), ("ca2", 30)],
        "cycling": [("cy1", 30), ("cy2", 30)],
    })
    job = _scrape_job(
        activities=["cardio", "cycling"],
        episodeNumbering={"cardio": {"30": 222}, "cycling": {"30": 2150}},
    )
    client = FakeClient(jobs=[job])
    make_worker(client, scraper=scraper).run_once()

    _, payload = client.reported[0]
    # Per-activity high-water in telemetry (nested {slug: {durationString: max}}).
    assert payload["telemetry"]["episodeHighWater"] == {
        "cardio": {"30": 224},
        "cycling": {"30": 2152},
    }
    by_key = {e["entryKey"]: e for e in payload["entries"]}
    assert by_key["ca2"]["overrides"]["episode_number"] == 224
    assert by_key["cy2"]["overrides"]["episode_number"] == 2152


def test_unseeded_activity_numbers_from_one():
    """Test #2 at the worker seam — an activity absent from episodeNumbering seeds
    empty (``.get(activity, {})``) so its classes start at E1, per duration."""
    scraper = NumberingScraper({"yoga": [("y1", 20), ("y2", 20), ("y3", 30)]})
    job = _scrape_job(activities=["yoga"],
                      episodeNumbering={"cycling": {"30": 2150}})  # yoga NOT seeded
    client = FakeClient(jobs=[job])
    make_worker(client, scraper=scraper).run_once()

    eps = {e["entryKey"]: e["overrides"]["episode_number"]
           for e in client.reported[0][1]["entries"]}
    # 20-min band (y1,y2) and 30-min band (y3) both start at 1 independently.
    assert eps == {"y1": 1, "y2": 2, "y3": 1}


def test_existing_ids_do_not_consume_numbers():
    """Test #5 — a class already in existingClassIds is skipped BEFORE numbering,
    so it consumes no episode number; the next new class gets max+1, not max+2."""
    scraper = NumberingScraper({"cardio": [("old", 30), ("new", 30)]})
    job = _scrape_job(activities=["cardio"], existingClassIds=["old"],
                      episodeNumbering={"cardio": {"30": 222}})
    client = FakeClient(jobs=[job])
    make_worker(client, scraper=scraper).run_once()

    entries = client.reported[0][1]["entries"]
    assert [e["entryKey"] for e in entries] == ["new"]
    assert entries[0]["overrides"]["episode_number"] == 223  # not 224


def test_from_job_parses_nested_string_duration_keys():
    """Test #4 — the payload boundary parses {activitySlug: {durationString: max}}
    and coerces the JSON string duration keys to int (activity slugs stay str)."""
    job = _scrape_job(
        activities=["cycling", "cardio"],
        episodeNumbering={"cycling": {"30": 2150, "20": 40}, "cardio": {"30": 222}},
    )
    pelo = PelotonPayload.from_job(job)
    assert pelo.episode_numbering == {
        "cycling": {30: 2150, 20: 40},
        "cardio": {30: 222},
    }
