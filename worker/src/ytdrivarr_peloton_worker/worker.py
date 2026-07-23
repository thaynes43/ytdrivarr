"""The main claim -> heartbeat -> scrape/refresh -> report/fail loop.

Long-polls the CORE for jobs; for each job it stands up a browser session, does
the hardened login + bearer mint + bounded scrape (or a bearer-only refresh),
and reports entries + session + telemetry, or fails with the right typed alarm.
A background heartbeat keeps the claim alive; a 409 (reclaimed) aborts the job
cleanly without a spurious fail.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass, field

from .bearer import BearerMinter
from .emit import build_summary, build_telemetry
from .errors import (
    BearerCaptureError,
    JobReclaimed,
    LoginError,
    ScrollTimeoutError,
    SelectorDriftError,
    WorkerError,
)
from .logging_setup import get_logger
from .login import PelotonLogin
from .metadata import player_url_for
from .numbering import EpisodeNumberer
from .scraper import PelotonScraper, ScrapeConfig
from .session import BrowserSession, SessionConfig
from .transport import CoreClient, Heartbeater, Job


@dataclass
class PelotonPayload:
    mode: str = "scrape"
    activities: list = field(default_factory=list)
    max_classes: int = 25
    dynamic_scrolling: bool = True
    max_scrolls: int = 50
    scroll_pause_sec: float = 3.0
    page_load_wait_sec: float = 10.0
    login_wait_sec: float = 15.0
    existing_ids: set = field(default_factory=set)
    # Per-activity numbering bands: {activitySlug: {duration: currentMaxEpisode}}.
    # Each activity holds its own disjoint band (donor parity); the worker seeds a
    # fresh EpisodeNumberer per activity from its own entry here.
    episode_numbering: dict = field(default_factory=dict)
    media_root: str = "/media/peloton"
    folder: str = ""
    run_id: str = ""
    source_id: str = ""
    library_id: str = ""

    @classmethod
    def from_job(cls, job: Job) -> PelotonPayload:
        p = job.payload or {}
        pelo = p.get("peloton", {}) or {}
        return cls(
            mode=p.get("mode", "scrape"),
            activities=list(pelo.get("activities", []) or []),
            max_classes=int(pelo.get("maxClassesPerActivity", 25) or 25),
            dynamic_scrolling=bool(pelo.get("dynamicScrolling", True)),
            max_scrolls=int(pelo.get("maxScrolls", 50) or 50),
            scroll_pause_sec=float(pelo.get("scrollPauseSec", 3.0) or 3.0),
            page_load_wait_sec=float(pelo.get("pageLoadWaitSec", 10.0) or 10.0),
            login_wait_sec=float(pelo.get("loginWaitSec", 15.0) or 15.0),
            existing_ids=set(pelo.get("existingClassIds", []) or []),
            # NEW CONTRACT: {activitySlug: {durationString: currentMax}}. JSON delivers
            # the duration keys as strings; coerce them to int here at the boundary.
            episode_numbering={
                str(slug): {int(d): int(m) for d, m in (band or {}).items()}
                for slug, band in (pelo.get("episodeNumbering", {}) or {}).items()
            },
            media_root=pelo.get("mediaRoot", "/media/peloton") or "/media/peloton",
            folder=pelo.get("folder", "") or "",
            run_id=p.get("runId", "") or "",
            source_id=p.get("sourceId", "") or "",
            library_id=p.get("libraryId", "") or "",
        )


@dataclass
class WorkerConfig:
    core_url: str
    api_key: str
    worker_name: str
    username: str
    password: str
    kinds: list | None = None
    provider_id: str = "peloton"
    poll_interval: float = 5.0
    heartbeat_interval: float = 15.0
    headless: bool = True
    container_mode: bool = True


class PelotonWorker:
    def __init__(
        self,
        config: WorkerConfig,
        *,
        client: CoreClient | None = None,
        session_factory: Callable[[PelotonPayload], BrowserSession] | None = None,
        login_factory: Callable[[PelotonPayload], PelotonLogin] | None = None,
        minter_factory: Callable[[PelotonPayload], BearerMinter] | None = None,
        scraper_factory: Callable[[PelotonPayload], PelotonScraper] | None = None,
        heartbeater_factory: Callable[[str], Heartbeater] | None = None,
        sleep: Callable[[float], None] = time.sleep,
        clock: Callable[[], float] = time.monotonic,
    ) -> None:
        self.config = config
        self.client = client or CoreClient(config.core_url, config.api_key, config.worker_name)
        self.session_factory = session_factory or self._default_session_factory
        self.login_factory = login_factory or self._default_login_factory
        self.minter_factory = minter_factory or self._default_minter_factory
        self.scraper_factory = scraper_factory or self._default_scraper_factory
        self.heartbeater_factory = heartbeater_factory or self._default_heartbeater_factory
        self._sleep = sleep
        self._clock = clock
        self.logger = get_logger(f"{__name__}.PelotonWorker")

    def _default_heartbeater_factory(self, job_id: str) -> Heartbeater:
        return Heartbeater(self.client, job_id,
                           interval=self.config.heartbeat_interval, sleep=self._sleep)

    # -- defaults ------------------------------------------------------------
    def _default_session_factory(self, pelo: PelotonPayload) -> BrowserSession:
        return BrowserSession(SessionConfig(
            headless=self.config.headless, container_mode=self.config.container_mode))

    def _default_login_factory(self, pelo: PelotonPayload) -> PelotonLogin:
        return PelotonLogin(nav_timeout=pelo.login_wait_sec, field_timeout=pelo.page_load_wait_sec)

    def _default_minter_factory(self, pelo: PelotonPayload) -> BearerMinter:
        return BearerMinter(capture_timeout=max(15.0, pelo.page_load_wait_sec))

    def _default_scraper_factory(self, pelo: PelotonPayload) -> PelotonScraper:
        return PelotonScraper(ScrapeConfig(
            max_classes=pelo.max_classes,
            dynamic_scrolling=pelo.dynamic_scrolling,
            max_scrolls=pelo.max_scrolls,
            scroll_pause_sec=pelo.scroll_pause_sec,
            page_load_wait_sec=pelo.page_load_wait_sec,
        ))

    # -- loop ----------------------------------------------------------------
    def run_forever(self, stop: Callable[[], bool] | None = None) -> None:
        self.logger.info("Peloton worker '%s' polling %s", self.config.worker_name,
                         self.config.core_url)
        while not (stop and stop()):
            handled = self.run_once()
            if not handled:
                self._sleep(self.config.poll_interval)

    def run_once(self) -> bool:
        job = self.client.claim(kinds=self.config.kinds, provider_id=self.config.provider_id)
        if job is None:
            return False
        self.logger.info("Claimed job %s (kind=%s attempts=%d)", job.id, job.kind, job.attempts)
        self._handle(job)
        return True

    # -- per-job -------------------------------------------------------------
    def _handle(self, job: Job) -> None:
        pelo = PelotonPayload.from_job(job)
        hb = self.heartbeater_factory(job.id)
        hb.start()
        session: BrowserSession | None = None
        start = self._clock()
        try:
            session = self.session_factory(pelo)
            driver = session.start()

            login = self.login_factory(pelo)
            lr = login.login(driver, self.config.username, self.config.password)
            if not lr.ok:
                raise LoginError(f"login failed: {lr.outcome.value} ({lr.detail})",
                                 retryable=lr.retryable)

            if pelo.mode == "refresh":
                self._do_refresh(job, pelo, driver, hb, start, lr.attempts)
            else:
                self._do_scrape(job, pelo, driver, hb, start, lr.attempts)
        except JobReclaimed:
            self.logger.warning("Job %s aborted (reclaimed by CORE)", job.id)
        except WorkerError as exc:
            if hb.reclaimed:
                return
            self.logger.error("Job %s failed: %s", job.id, exc)
            self.client.fail(job.id, str(exc), retryable=exc.retryable, alarm=exc.to_alarm())
        except Exception as exc:  # noqa: BLE001 - last-resort honest failure
            if hb.reclaimed:
                return
            self.logger.exception("Job %s crashed", job.id)
            self.client.fail(job.id, f"unexpected error: {exc}", retryable=True)
        finally:
            hb.stop()
            if session is not None:
                session.close()

    def _do_refresh(self, job, pelo, driver, hb, start, login_attempts=0) -> None:
        minter = self.minter_factory(pelo)
        player_url = self._refresh_player_url(pelo, driver)
        minted = minter.mint(driver, player_url)  # raises BearerCaptureError on failure
        self._check_reclaim(hb)
        result = {
            "entries": [],
            "session": minted.to_session_payload(),
            "telemetry": {
                "mode": "refresh",
                "durationMs": self._elapsed_ms(start),
                "authOk": True,
                "loginOk": True,
                "loginAttempts": login_attempts,
                # ACTUAL capture attempts, not the configured max (`minter.retries + 1`
                # was always the ceiling regardless of a clean first-try mint).
                "bearerAttempts": minted.attempts,
                "alarms": [],
            },
            "summary": {"mode": "refresh", "bearerMinted": True},
        }
        self.client.report(job.id, result)
        self.logger.info("Job %s refresh reported (bearer minted)", job.id)

    def _do_scrape(self, job, pelo, driver, hb, start, login_attempts=0) -> None:
        scraper = self.scraper_factory(pelo)
        results = []
        # Donor parity: each activity gets its OWN numberer, seeded from its own
        # per-(activity, duration) band. Counters are never shared across
        # activities, so same-season classes advance in disjoint bands.
        numbering_snapshot: dict[str, dict] = {}
        for activity in pelo.activities:
            self._check_reclaim(hb)
            numberer = EpisodeNumberer(pelo.episode_numbering.get(activity, {}))
            results.append(
                scraper.scrape_activity(driver, activity, pelo.existing_ids, numberer, pelo.media_root)
            )
            numbering_snapshot[activity] = numberer.snapshot()
        entries = [e for r in results for e in r.entries]

        # Mint a fresh bearer whenever we have any class to mint from (even a
        # zero-new run still needs a fresh session for the backlog).
        minted = None
        player_url = self._scrape_player_url(entries, pelo)
        if player_url:
            minter = self.minter_factory(pelo)
            minted = minter.mint(driver, player_url)  # raises BearerCaptureError on failure

        self._check_reclaim(hb)
        alarms = self._collect_alarms(results)

        if entries or not any(r.suspicious for r in results):
            telemetry = build_telemetry(
                activity_results=results,
                numbering_snapshot=numbering_snapshot,
                login_attempts=login_attempts,
                bearer_attempts=minted.attempts if minted else 0,
                duration_ms=self._elapsed_ms(start),
                alarms=alarms,
            )
            result = {
                "entries": [e.to_transport() for e in entries],
                "session": minted.to_session_payload() if minted else None,
                "telemetry": telemetry,
                "summary": build_summary(entries, results),
            }
            self.client.report(job.id, result)
            self.logger.info("Job %s reported %d entries (%d alarms)",
                             job.id, len(entries), len(alarms))
            return

        # Zero entries AND at least one suspicious activity -> honest fail.
        self._raise_scrape_failure(results)

    # -- helpers -------------------------------------------------------------
    def _collect_alarms(self, results) -> list:
        alarms = []
        for r in results:
            if r.selector_drift:
                alarms.append({"kind": "selector_drift",
                               "message": f"{r.activity}: links found but 0 parsed"})
            elif r.zero_links and r.scroll_capped:
                alarms.append({"kind": "scroll_timeout",
                               "message": f"{r.activity}: scroll cap hit, 0 links"})
            elif r.zero_links:
                alarms.append({"kind": "selector_drift",
                               "message": f"{r.activity}: 0 class links on listing"})
        return alarms

    def _raise_scrape_failure(self, results) -> None:
        drift = [r.activity for r in results if r.selector_drift]
        zero_no_cap = [r.activity for r in results if r.zero_links and not r.scroll_capped]
        zero_capped = [r.activity for r in results if r.zero_links and r.scroll_capped]
        if drift or zero_no_cap:
            names = drift + zero_no_cap
            raise SelectorDriftError(f"selector drift / zero hits on activities: {names}")
        raise ScrollTimeoutError(f"scroll cap hit with no links on activities: {zero_capped}")

    def _scrape_player_url(self, entries, pelo: PelotonPayload) -> str | None:
        if entries:
            return entries[0].download_ref
        if pelo.existing_ids:
            return player_url_for(next(iter(pelo.existing_ids)))
        return None

    def _refresh_player_url(self, pelo: PelotonPayload, driver) -> str:
        if pelo.existing_ids:
            return player_url_for(next(iter(pelo.existing_ids)))
        # No known class id: do a minimal one-class scrape to find a player URL.
        scraper = PelotonScraper(ScrapeConfig(
            max_classes=1, dynamic_scrolling=True, max_scrolls=3,
            scroll_pause_sec=pelo.scroll_pause_sec, page_load_wait_sec=pelo.page_load_wait_sec))
        for activity in pelo.activities:
            # Numbering is discarded here (we only need one player URL to mint a
            # bearer) — a fresh per-activity numberer keeps the invariant clean.
            numberer = EpisodeNumberer({})
            r = scraper.scrape_activity(driver, activity, set(), numberer, pelo.media_root)
            if r.entries:
                return r.entries[0].download_ref
        raise BearerCaptureError("refresh: no class player URL available to mint a bearer")

    def _check_reclaim(self, hb: Heartbeater) -> None:
        if hb.reclaimed:
            raise JobReclaimed("heartbeat reported reclaim")

    def _elapsed_ms(self, start: float) -> int:
        return int((self._clock() - start) * 1000)
