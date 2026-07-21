"""Minimal structured logging setup (stdlib only)."""

from __future__ import annotations

import logging
import os
import sys


def get_logger(name: str) -> logging.Logger:
    return logging.getLogger(name)


def configure_logging(level: str | None = None) -> None:
    """Configure root logging once, from LOG_LEVEL (default INFO)."""
    lvl = (level or os.environ.get("LOG_LEVEL") or "INFO").upper()
    root = logging.getLogger()
    if root.handlers:
        root.setLevel(lvl)
        return
    handler = logging.StreamHandler(sys.stdout)
    handler.setFormatter(
        logging.Formatter("%(asctime)s %(levelname)s %(name)s %(message)s")
    )
    root.addHandler(handler)
    root.setLevel(lvl)
