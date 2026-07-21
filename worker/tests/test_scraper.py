"""Hardened scrape: entries, dedup, cap, selector-drift, scroll-cap, stale retry."""

from __future__ import annotations

from selenium.common.exceptions import StaleElementReferenceException

from conftest import FakeDriver, FakeElement, make_class_link
from ytdrivarr_peloton_worker.numbering import EpisodeNumberer
from ytdrivarr_peloton_worker.scraper import (
    LINK_SELECTOR,
    PelotonScraper,
    ScrapeConfig,
)

MEDIA_ROOT = "/media/peloton"


def fast_cfg(**over):
    base = dict(
        max_classes=25, dynamic_scrolling=True, max_scrolls=3,
        scroll_pause_sec=0.03, page_load_wait_sec=0.05, poll=0.01,
        stale_retries=2, scroll_stall_limit=2,
    )
    base.update(over)
    return ScrapeConfig(**base)


def links_driver(links):
    d = FakeDriver()
    d.find_elements_handler = lambda by, value: list(links) if value == LINK_SELECTOR else []
    return d


class StaleOnceElement(FakeElement):
    """Raises StaleElementReferenceException on the first get_attribute, then recovers."""

    def __init__(self, **kw):
        super().__init__(**kw)
        self._recovered = False

    def get_attribute(self, name):
        if not self._recovered:
            self._recovered = True
            raise StaleElementReferenceException("stale once")
        return super().get_attribute(name)


def test_scrape_happy_path_builds_entries():
    links = [
        make_class_link("id1", "30 min HIIT Ride", "Cody Rigsby"),
        make_class_link("id2", "30 min Climb Ride", "Ally Love"),
        make_class_link("id3", "45 min Power Ride", "Emma Lovewell"),
    ]
    d = links_driver(links)
    numberer = EpisodeNumberer({30: 100, 45: 5})
    scraper = PelotonScraper(fast_cfg())
    r = scraper.scrape_activity(d, "cycling", set(), numberer, MEDIA_ROOT)

    assert len(r.entries) == 3
    e = {x.entry_key: x for x in r.entries}
    assert e["id1"].display_name == "30 min HIIT Ride with Cody Rigsby"
    assert e["id1"].chip == "Cycling (30 min)"
    assert e["id1"].overrides["season_number"] == 30
    assert e["id1"].overrides["tv_show_directory"] == "/media/peloton/Cycling/Cody Rigsby"
    # Per-duration numbering continues from seed: two 30-min (101,102), one 45-min (6).
    eps30 = sorted(x.overrides["episode_number"] for x in r.entries if x.overrides["season_number"] == 30)
    assert eps30 == [101, 102]
    assert e["id3"].overrides["episode_number"] == 6
    assert not r.selector_drift and not r.zero_links


def test_scrape_dedup_existing():
    links = [
        make_class_link("keep", "30 min Ride", "Cody Rigsby"),
        make_class_link("skip", "30 min Ride", "Ally Love"),
    ]
    d = links_driver(links)
    numberer = EpisodeNumberer({30: 100})
    scraper = PelotonScraper(fast_cfg())
    r = scraper.scrape_activity(d, "cycling", {"skip"}, numberer, MEDIA_ROOT)
    assert [x.entry_key for x in r.entries] == ["keep"]
    assert r.skipped_existing == 1
    # Numbering only advanced for the new class (immutability of the skipped one).
    assert r.entries[0].overrides["episode_number"] == 101
    assert numberer.snapshot()[30] == 101


def test_scrape_per_activity_cap():
    links = [make_class_link(f"id{i}", "30 min Ride", "Cody Rigsby") for i in range(5)]
    d = links_driver(links)
    scraper = PelotonScraper(fast_cfg(max_classes=2))
    r = scraper.scrape_activity(d, "cycling", set(), EpisodeNumberer({}), MEDIA_ROOT)
    assert len(r.entries) == 2


def test_scrape_selector_drift_zero_parsed():
    # Links present, but the title/subtitle selectors return nothing.
    bare = [FakeElement(attributes={"href": f"https://x?classId=id{i}"}) for i in range(3)]
    d = links_driver(bare)
    scraper = PelotonScraper(fast_cfg())
    r = scraper.scrape_activity(d, "cycling", set(), EpisodeNumberer({}), MEDIA_ROOT)
    assert r.entries == []
    assert r.new_candidates == 3
    assert r.malformed == 3
    assert r.selector_drift is True  # links found but zero parsed -> drift
    assert r.suspicious is True


def test_scrape_zero_links():
    d = links_driver([])  # nothing on the page at all
    scraper = PelotonScraper(fast_cfg())
    r = scraper.scrape_activity(d, "cycling", set(), EpisodeNumberer({}), MEDIA_ROOT)
    assert r.entries == []
    assert r.zero_links is True
    assert r.suspicious is True


def test_scrape_scroll_cap_hit():
    # Links grow every scroll and the (huge) target is never met -> scroll capped.
    grow = [make_class_link("seed", "30 min Ride", "Cody Rigsby")]
    d = FakeDriver()
    d.find_elements_handler = lambda by, value: list(grow) if value == LINK_SELECTOR else []
    counter = {"n": 0}

    def on_scroll(drv):
        counter["n"] += 1
        grow.append(make_class_link(f"grown{counter['n']}", "30 min Ride", "Cody Rigsby"))

    d.on_scroll = on_scroll
    scraper = PelotonScraper(fast_cfg(max_classes=10_000, max_scrolls=3))
    r = scraper.scrape_activity(d, "cycling", set(), EpisodeNumberer({}), MEDIA_ROOT)
    assert r.scrolls_performed == 3
    assert r.scroll_capped is True


def test_scrape_stale_element_retry():
    links = [
        StaleOnceElement(
            attributes={"href": "https://x?classId=s1"},
            children=make_class_link("s1", "30 min Ride", "Cody Rigsby")._children,
        ),
        make_class_link("s2", "30 min Ride", "Ally Love"),
    ]
    d = links_driver(links)
    scraper = PelotonScraper(fast_cfg())
    r = scraper.scrape_activity(d, "cycling", set(), EpisodeNumberer({30: 0}), MEDIA_ROOT)
    # After the stale retry, both classes are collected exactly once.
    keys = sorted(x.entry_key for x in r.entries)
    assert keys == ["s1", "s2"]
    # No double-numbering from the retried pass.
    assert sorted(x.overrides["episode_number"] for x in r.entries) == [1, 2]
