"""Hardened per-activity scrape — ported from the donor ``scraper_strategy.py``.

Same listing URL, ``a[href*="classId="]`` links, ``data-test-id`` title/subtitle
selectors, ``·`` instructor split, per-activity cap and dedup vs existing ids.
Hardened:
  * every fixed ``time.sleep`` -> an explicit ``WebDriverWait`` (page-ready and
    per-scroll link-growth waits);
  * stale-element churn during scroll is retried instead of aborting the pass;
  * an activity that finds links but parses ZERO valid classes (selector drift),
    or finds zero links at all, records a typed signal the worker turns into a
    selector_drift / scroll_timeout alarm — it never silently yields nothing.
"""

from __future__ import annotations

from dataclasses import dataclass, field

from selenium.common.exceptions import (
    NoSuchElementException,
    StaleElementReferenceException,
    TimeoutException,
    WebDriverException,
)

from .emit import ScrapedClass, SubscriptionEntry, build_entry
from .logging_setup import get_logger
from .metadata import (
    extract_class_id_from_href,
    extract_duration_from_title,
    normalize_text,
    parse_subtitle,
)
from .numbering import EpisodeNumberer
from .waits import By, count_elements, wait_for_condition

LINK_SELECTOR = 'a[href*="classId="]'
TITLE_SELECTOR = '[data-test-id="videoCellTitle"]'
SUBTITLE_SELECTOR = '[data-test-id="videoCellSubtitle"]'
SCROLL_JS = "window.scrollTo(0, document.body.scrollHeight);"


@dataclass
class ScrapeConfig:
    max_classes: int = 25
    dynamic_scrolling: bool = True
    max_scrolls: int = 50
    scroll_pause_sec: float = 3.0
    page_load_wait_sec: float = 10.0
    poll: float = 0.5
    stale_retries: int = 3
    scroll_stall_limit: int = 2  # consecutive no-growth scrolls before we call it "bottom"


@dataclass
class ActivityScrapeResult:
    activity: str
    entries: list = field(default_factory=list)
    links_found: int = 0
    new_candidates: int = 0  # non-existing links with a parseable id
    skipped_existing: int = 0
    malformed: int = 0
    scrolls_performed: int = 0
    scroll_capped: bool = False

    @property
    def selector_drift(self) -> bool:
        # There were new classes to build, but selectors yielded none.
        return self.new_candidates > 0 and len(self.entries) == 0

    @property
    def zero_links(self) -> bool:
        return self.links_found == 0

    @property
    def suspicious(self) -> bool:
        """Zero entries for a reason worth alarming (not just 'nothing new')."""
        return self.zero_links or self.selector_drift


def activity_listing_url(activity: str) -> str:
    base = f"https://members.onepeloton.com/classes/{activity.lower()}"
    return base + "?class_languages=%5B%22en-US%22%5D&sort=original_air_time&desc=true"


class PelotonScraper:
    def __init__(self, config: ScrapeConfig | None = None) -> None:
        self.config = config or ScrapeConfig()
        self.logger = get_logger(f"{__name__}.PelotonScraper")

    def scrape_activity(
        self,
        driver,
        activity: str,
        existing_class_ids: set,
        numberer: EpisodeNumberer,
        media_root: str,
    ) -> ActivityScrapeResult:
        cfg = self.config
        existing = set(existing_class_ids or ())
        url = activity_listing_url(activity)
        self.logger.info("Scraping %s: %s", activity, url)
        result = ActivityScrapeResult(activity=activity)

        try:
            driver.get(url)
        except WebDriverException as exc:
            self.logger.warning("Navigation to %s failed: %s", activity, exc)
            return result

        # Wait for the listing to render (≥1 class link) instead of sleeping.
        try:
            wait_for_condition(
                driver,
                lambda d: count_elements(d, By.CSS_SELECTOR, LINK_SELECTOR) > 0,
                cfg.page_load_wait_sec,
                cfg.poll,
            )
        except TimeoutException:
            self.logger.warning("%s: no class links after %.1fs page-load wait",
                                activity, cfg.page_load_wait_sec)

        scrolls, capped = self._scroll(driver, existing)
        result.scrolls_performed = scrolls
        result.scroll_capped = capped

        collected, seen, new_candidates, malformed = self._collect(
            driver, activity, existing, numberer, media_root
        )
        result.links_found = seen
        result.new_candidates = new_candidates
        result.malformed = malformed
        # skipped_existing = unique links whose id was already in `existing`.
        result.skipped_existing = max(0, seen - new_candidates)
        result.entries = collected
        self.logger.info(
            "%s: %d links, %d new entries, %d skipped-existing, %d malformed, %d scrolls%s",
            activity, seen, len(collected), result.skipped_existing, malformed, scrolls,
            " (scroll-capped)" if capped else "",
        )
        return result

    # -- scrolling -----------------------------------------------------------
    def _scroll(self, driver, existing: set) -> tuple[int, bool]:
        cfg = self.config
        scrolls = 0
        stall = 0
        prev_total = count_elements(driver, By.CSS_SELECTOR, LINK_SELECTOR)
        while scrolls < cfg.max_scrolls:
            try:
                driver.execute_script(SCROLL_JS)
            except WebDriverException:
                break
            scrolls += 1
            # Per-scroll wait for link growth (the pause is the wait, not a sleep).
            baseline = prev_total
            try:
                wait_for_condition(
                    driver,
                    lambda d, b=baseline: count_elements(d, By.CSS_SELECTOR, LINK_SELECTOR) > b,
                    cfg.scroll_pause_sec,
                    cfg.poll,
                )
                grew = True
            except TimeoutException:
                grew = False

            now_total = count_elements(driver, By.CSS_SELECTOR, LINK_SELECTOR)

            if cfg.dynamic_scrolling:
                new_on_page = self._count_new(driver, existing)
                if new_on_page >= cfg.max_classes:
                    self.logger.debug("%s new classes on page after %d scrolls (target %d)",
                                      new_on_page, scrolls, cfg.max_classes)
                    return scrolls, False

            if grew or now_total > prev_total:
                stall = 0
            else:
                stall += 1
                if stall >= cfg.scroll_stall_limit:
                    # Content stopped growing -> we've reached the bottom (not a timeout).
                    return scrolls, False
            prev_total = now_total

        # Hit the scroll cap. It is a "scroll timeout" only if we were still
        # hunting (dynamic mode never reached its target); the worker decides.
        return scrolls, True

    def _count_new(self, driver, existing: set) -> int:
        seen: set[str] = set()
        try:
            links = driver.find_elements(By.CSS_SELECTOR, LINK_SELECTOR)
        except WebDriverException:
            return 0
        for link in links:
            try:
                cid = extract_class_id_from_href(link.get_attribute("href"))
            except StaleElementReferenceException:
                continue
            except WebDriverException:
                continue
            if cid and cid not in existing:
                seen.add(cid)
        return len(seen)

    # -- collection ----------------------------------------------------------
    def _collect(self, driver, activity, existing, numberer, media_root):
        cfg = self.config
        collected: dict[str, SubscriptionEntry] = {}
        numbered: set[str] = set()
        candidate_ids: set[str] = set()
        seen_ids: set[str] = set()
        malformed = 0

        attempts = 0
        while attempts <= cfg.stale_retries:
            attempts += 1
            try:
                links = driver.find_elements(By.CSS_SELECTOR, LINK_SELECTOR)
                for link in links:
                    if len(collected) >= cfg.max_classes:
                        break
                    href = link.get_attribute("href")
                    class_id = extract_class_id_from_href(href)
                    if not class_id:
                        continue
                    seen_ids.add(class_id)
                    if class_id in existing:
                        continue
                    if class_id in collected:
                        continue
                    candidate_ids.add(class_id)
                    meta = self._extract_metadata(link)
                    if meta is None:
                        malformed += 1
                        continue
                    title, instructor = meta
                    duration = extract_duration_from_title(title)
                    if class_id not in numbered:
                        episode = numberer.next(duration)
                        numbered.add(class_id)
                    else:  # defensive; shouldn't happen given the guards above
                        episode = numberer.current_max(duration)
                    sc = ScrapedClass(
                        class_id=class_id,
                        title=title,
                        instructor=instructor,
                        activity=activity,
                        duration=duration,
                        season=duration,
                        episode=episode,
                    )
                    collected[class_id] = build_entry(sc, media_root)
                # Completed a full pass without a stale blow-up.
                break
            except StaleElementReferenceException:
                self.logger.debug("%s: stale element during collect (attempt %d), retrying",
                                  activity, attempts)
                continue

        return (
            list(collected.values()),
            len(seen_ids),
            len(candidate_ids),
            malformed,
        )

    def _extract_metadata(self, link) -> tuple[str, str] | None:
        try:
            title_el = link.find_element(By.CSS_SELECTOR, TITLE_SELECTOR)
            title = normalize_text(title_el.text)
            subtitle_el = link.find_element(By.CSS_SELECTOR, SUBTITLE_SELECTOR)
            instructor, _activity = parse_subtitle(subtitle_el.text)
            if not title or instructor == "Unknown":
                return None
            return title, instructor
        except NoSuchElementException:
            return None
        except StaleElementReferenceException:
            raise
        except WebDriverException:
            return None
