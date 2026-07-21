"""Entrypoint for the long-poll worker loop.

    python -m ytdrivarr_peloton_worker

Reads config from the environment:
  YTDRIVARR_CORE_URL   base URL of the CORE job API (required)
  YTDRIVARR_API_KEY    X-Api-Key credential (required)
  PELOTON_USERNAME     Peloton account (required)
  PELOTON_PASSWORD     Peloton password (required)
  WORKER_NAME          identity reported on claim/heartbeat (default: hostname)
  WORKER_KINDS         comma-separated job kinds to claim (optional)
  WORKER_PROVIDER_ID   provider filter on claim (default: peloton)
  WORKER_POLL_SEC      idle long-poll interval (default: 5)
  WORKER_HEARTBEAT_SEC heartbeat cadence (default: 15)
  WORKER_HEADLESS      "1"/"true" for headless (default: true)
"""

from __future__ import annotations

import os
import socket
import sys

from .logging_setup import configure_logging, get_logger
from .transport import CoreClient
from .worker import PelotonWorker, WorkerConfig

_LOG = get_logger(__name__)


def _bool_env(name: str, default: bool) -> bool:
    val = os.environ.get(name)
    if val is None:
        return default
    return val.strip().lower() in ("1", "true", "yes", "on")


def _build_config() -> WorkerConfig | None:
    core_url = os.environ.get("YTDRIVARR_CORE_URL")
    api_key = os.environ.get("YTDRIVARR_API_KEY")
    username = os.environ.get("PELOTON_USERNAME")
    password = os.environ.get("PELOTON_PASSWORD")
    missing = [n for n, v in (
        ("YTDRIVARR_CORE_URL", core_url),
        ("YTDRIVARR_API_KEY", api_key),
        ("PELOTON_USERNAME", username),
        ("PELOTON_PASSWORD", password),
    ) if not v]
    if missing:
        print(f"missing required env: {', '.join(missing)}", file=sys.stderr)
        return None

    kinds_raw = os.environ.get("WORKER_KINDS", "")
    kinds = [k.strip() for k in kinds_raw.split(",") if k.strip()] or None
    return WorkerConfig(
        core_url=core_url,
        api_key=api_key,
        worker_name=os.environ.get("WORKER_NAME") or socket.gethostname(),
        username=username,
        password=password,
        kinds=kinds,
        provider_id=os.environ.get("WORKER_PROVIDER_ID", "peloton"),
        poll_interval=float(os.environ.get("WORKER_POLL_SEC", "5")),
        heartbeat_interval=float(os.environ.get("WORKER_HEARTBEAT_SEC", "15")),
        headless=_bool_env("WORKER_HEADLESS", True),
    )


def main(argv=None) -> int:
    configure_logging()
    config = _build_config()
    if config is None:
        return 2
    client = CoreClient(config.core_url, config.api_key, config.worker_name)
    worker = PelotonWorker(config, client=client)
    try:
        worker.run_forever()
    except KeyboardInterrupt:  # pragma: no cover
        _LOG.info("interrupted, shutting down")
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
