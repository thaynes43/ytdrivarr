"""Pure text/metadata helpers ported from the donor ``webscraper/models.py``.

Kept as free functions with no Selenium dependency so they can be tested deeply
in isolation. Parity with the donor is deliberate: these feed the live-file
shape (entry name ``{Title} with {Instructor}``, ``= {Activity} ({min} min)``
chips, ``season = raw duration minutes``).
"""

from __future__ import annotations

import hashlib
import re
import unicodedata
from urllib.parse import parse_qs, urlparse

# NFC normalisation + a small set of explicit fixes, ported verbatim from the donor.
_NORMALIZE_REPLACEMENTS = {
    "�": "",  # Unicode replacement character
    "á": "á",
    "é": "é",
    "í": "í",
    "ñ": "ñ",
    "ó": "ó",
    "ú": "ú",
}

_FS_REPLACEMENTS = {
    "/": "-",
    "\\": "-",
    ";": "-",
    "*": "-",
    "?": "-",
    '"': "'",
    "<": "-",
    ">": "-",
    "|": "-",
    "\0": "",
    "\t": " ",
    "\n": " ",
    "\r": " ",
}

_DURATION_PREFIX_RE = re.compile(r"^\s*(\d+)\s*min", re.IGNORECASE)
_ANY_INT_RE = re.compile(r"\b(\d+)\b")
_PLAYER_ID_RE = re.compile(r"/(?:classes/)?player/([a-zA-Z0-9]+)")

#: The `Instructor · Activity` subtitle separator (middle dot U+00B7).
SUBTITLE_SEP = "·"


def normalize_text(text: str | None) -> str:
    """NFC-normalise and repair common encoding issues; strip. Empty-safe."""
    if not text:
        return text or ""
    text = unicodedata.normalize("NFC", text)
    for old, new in _NORMALIZE_REPLACEMENTS.items():
        text = text.replace(old, new)
    return text.strip()


def sanitize_for_filesystem(text: str | None) -> str:
    """Make text safe for file/dir names (ported from the donor)."""
    if not text:
        return text or ""
    text = normalize_text(text)
    for old, new in _FS_REPLACEMENTS.items():
        text = text.replace(old, new)
    # Drop remaining control chars (0-31, 127).
    text = "".join(ch for ch in text if ord(ch) > 31 and ord(ch) != 127)
    text = re.sub(r"\s+", " ", text).strip()
    return text.strip(". ")


def get_short_hash(text: str, length: int = 7) -> str:
    """Deterministic short sha256 hex (donor parity for de-dup suffixes)."""
    if not text:
        return ""
    return hashlib.sha256(text.encode("utf-8")).hexdigest()[:length]


def extract_class_id_from_href(url: str | None) -> str:
    """Extract the ``classId`` query param from a listing link href.

    Listing links look like ``.../classes/cycling?...&classId=<id>``.
    """
    if not url:
        return ""
    try:
        return parse_qs(urlparse(url).query).get("classId", [""])[0]
    except Exception:
        return ""


def extract_class_id_from_player_url(url: str | None) -> str:
    """Extract the class id from a ``/classes/player/<id>`` player URL."""
    if not url:
        return ""
    m = _PLAYER_ID_RE.search(url)
    return m.group(1) if m else ""


def player_url_for(class_id: str) -> str:
    return f"https://members.onepeloton.com/classes/player/{class_id}"


def extract_duration_from_title(title: str) -> int:
    """Season = RAW duration minutes from the title.

    ``^(\\d+)\\s*min`` first; fallback to any int; 0 if none. The donor's latent
    "round to nearest 5" default is deliberately DISCARDED (owner ruling: parity
    beats elegance — the live file is raw).
    """
    if not title:
        return 0
    m = _DURATION_PREFIX_RE.match(title)
    if m:
        return int(m.group(1))
    m = _ANY_INT_RE.search(title)
    if m:
        return int(m.group(1))
    return 0


def parse_subtitle(subtitle_text: str) -> tuple[str, str]:
    """Parse ``Instructor · Activity`` -> (instructor, activity), title-cased.

    Ported from the donor: split on the middle dot, ``.strip().title()`` each
    side. Returns ``("Unknown", "Unknown")`` on an unexpected shape (the caller
    treats a run of these as a selector-drift signal).
    """
    text = normalize_text(subtitle_text)
    parts = text.split(SUBTITLE_SEP)
    if len(parts) >= 2:
        instructor = normalize_text(parts[0].strip().title())
        activity = normalize_text(parts[1].strip().title())
        return instructor, activity
    return "Unknown", "Unknown"
