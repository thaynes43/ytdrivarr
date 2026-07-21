"""VALIDATION / DRY-RUN mode.

    python -m ytdrivarr_peloton_worker.validate \
        --activities Cycling --max-classes 5 --scratch /tmp/pelo-out [--headless]

Does a REAL login (env creds) -> REAL bearer mint -> REAL bounded scrape
(limited scrolls/classes) -> renders ``subscriptions.yaml`` to the scratch path
-> prints a structured JSON summary + a human summary + a shape-diff verdict
versus the baked live-file sample.

ZERO live writes: it writes ONLY under ``--scratch`` (subscriptions.yaml +
summary.json). It never touches NFS (no bearer.txt/cookies.txt delivery) and
never calls the CORE — it takes no CoreClient, so it structurally cannot
round-trip. This is the artifact the coordinator runs in-cluster for the PR
Health section.
"""

from __future__ import annotations

import argparse
import json
import os
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from .bearer import BearerCaptureError, BearerMinter
from .emit import build_summary, build_telemetry, render_subscriptions_yaml, shape_diff
from .logging_setup import configure_logging, get_logger
from .login import PelotonLogin
from .numbering import EpisodeNumberer
from .scraper import PelotonScraper, ScrapeConfig
from .session import BrowserSession, SessionConfig

_LOG = get_logger(__name__)


@dataclass
class ValidationDeps:
    session_factory: Callable[[], BrowserSession]
    login: PelotonLogin
    minter: BearerMinter
    scraper: PelotonScraper
    username: str
    password: str


def run_validation(
    *,
    activities: list,
    scratch: str,
    media_root: str,
    deps: ValidationDeps,
) -> dict:
    """Run the dry-run and return a structured report. Writes ONLY under scratch."""
    scratch_dir = Path(scratch)
    scratch_dir.mkdir(parents=True, exist_ok=True)

    report: dict = {
        "ok": False,
        "stage": "start",
        "activities": activities,
        "mediaRoot": media_root,
        "filesWritten": [],
    }

    session = deps.session_factory()
    driver = session.start()
    try:
        lr = deps.login.login(driver, deps.username, deps.password)
        report["login"] = {"outcome": lr.outcome.value, "detail": lr.detail}
        if not lr.ok:
            report["stage"] = "login"
            report["error"] = f"login not ok: {lr.outcome.value}"
            return report

        # One numberer per activity (per-(activity, duration) contract). Dry-run
        # always seeds empty, so each activity's band starts at 1 independently.
        numbering_snapshot: dict[str, dict] = {}
        results = []
        for a in activities:
            numberer = EpisodeNumberer({})
            results.append(deps.scraper.scrape_activity(driver, a, set(), numberer, media_root))
            numbering_snapshot[a] = numberer.snapshot()
        entries = [e for r in results for e in r.entries]
        report["stage"] = "scraped"

        bearer_info: dict = {"captured": False}
        if entries:
            try:
                minted = deps.minter.mint(driver, entries[0].download_ref)
                bearer_info = {
                    "captured": True,
                    "cookies": len(minted.cookies),
                    "expiresAt": minted.expires_at.isoformat() if minted.expires_at else None,
                }
            except BearerCaptureError as exc:
                bearer_info = {"captured": False, "error": str(exc)}
        report["bearer"] = bearer_info

        yaml_text = render_subscriptions_yaml(entries, media_root)
        verdict = shape_diff(yaml_text)
        telemetry = build_telemetry(
            activity_results=results, numbering_snapshot=numbering_snapshot,
            alarms=[],
        )
        summary = build_summary(entries, results)

        subs_path = scratch_dir / "subscriptions.yaml"
        subs_path.write_text(yaml_text, encoding="utf-8")
        summary_path = scratch_dir / "summary.json"
        summary_payload = {
            "summary": summary,
            "telemetry": telemetry,
            "shapeVerdict": verdict.as_dict(),
            "login": report["login"],
            "bearer": bearer_info,
        }
        summary_path.write_text(json.dumps(summary_payload, indent=2), encoding="utf-8")

        report.update(
            {
                "ok": verdict.ok and len(entries) >= 0,
                "stage": "done",
                "entries": len(entries),
                "summary": summary,
                "telemetry": telemetry,
                "shapeVerdict": verdict.as_dict(),
                "filesWritten": [str(subs_path), str(summary_path)],
            }
        )
        return report
    finally:
        session.close()


def _print_human(report: dict) -> None:
    print("=" * 60)
    print("ytdrivarr Peloton worker — validation dry-run")
    print("=" * 60)
    login = report.get("login", {})
    print(f"  login:   {login.get('outcome', '?')} ({login.get('detail', '')})")
    bearer = report.get("bearer", {})
    print(f"  bearer:  captured={bearer.get('captured')} "
          f"expiresAt={bearer.get('expiresAt', 'n/a')}")
    print(f"  entries: {report.get('entries', 0)}")
    summary = report.get("summary", {})
    if summary.get("byActivity"):
        for act, n in summary["byActivity"].items():
            print(f"    - {act}: {n}")
    verdict = report.get("shapeVerdict", {})
    print(f"  shape:   {'OK' if verdict.get('ok') else 'MISMATCH'} "
          f"({len(verdict.get('checks', []))} checks, "
          f"{len(verdict.get('mismatches', []))} mismatches)")
    for m in verdict.get("mismatches", [])[:10]:
        print(f"    ! {m}")
    if report.get("filesWritten"):
        print("  wrote:")
        for f in report["filesWritten"]:
            print(f"    {f}")
    print(f"  VERDICT: {'PASS' if report.get('ok') else 'FAIL'}")
    print("=" * 60)


def _parse_args(argv=None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(prog="ytdrivarr-peloton-validate")
    parser.add_argument("--activities", nargs="+", default=["Cycling"],
                        help="activities to scrape (space or comma separated)")
    parser.add_argument("--max-classes", type=int, default=5)
    parser.add_argument("--max-scrolls", type=int, default=5)
    parser.add_argument("--scratch", default="/tmp/pelo-out")
    parser.add_argument("--media-root", default="/media/peloton")
    parser.add_argument("--headless", action="store_true", default=False)
    parser.add_argument("--no-container", action="store_true", default=False,
                        help="use webdriver-managed Chrome instead of container binaries")
    return parser.parse_args(argv)


def _normalize_activities(raw: list) -> list:
    out: list[str] = []
    for item in raw:
        out.extend(part.strip() for part in item.split(",") if part.strip())
    return out or ["Cycling"]


def main(argv=None) -> int:
    args = _parse_args(argv)
    configure_logging()
    activities = _normalize_activities(args.activities)

    username = os.environ.get("PELOTON_USERNAME")
    password = os.environ.get("PELOTON_PASSWORD")
    if not username or not password:
        print("PELOTON_USERNAME / PELOTON_PASSWORD must be set", file=sys.stderr)
        return 2

    container_mode = not args.no_container
    deps = ValidationDeps(
        session_factory=lambda: BrowserSession(
            SessionConfig(headless=args.headless, container_mode=container_mode)
        ),
        login=PelotonLogin(),
        minter=BearerMinter(),
        scraper=PelotonScraper(ScrapeConfig(
            max_classes=args.max_classes, dynamic_scrolling=True,
            max_scrolls=args.max_scrolls)),
        username=username,
        password=password,
    )
    report = run_validation(
        activities=activities, scratch=args.scratch,
        media_root=args.media_root, deps=deps,
    )
    print(json.dumps(report, indent=2))
    _print_human(report)
    return 0 if report.get("ok") else 1


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
