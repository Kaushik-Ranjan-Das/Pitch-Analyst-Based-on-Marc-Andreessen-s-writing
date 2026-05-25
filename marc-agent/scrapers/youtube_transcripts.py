"""Fetch YouTube transcripts for Marc Andreessen interviews."""
from __future__ import annotations

import json
import re
import subprocess
import sys
from datetime import date
from pathlib import Path

from tqdm import tqdm
from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api._errors import (
    NoTranscriptFound,
    TranscriptsDisabled,
    VideoUnavailable,
)

_TRANSCRIPT_CLIENT = YouTubeTranscriptApi()

KNOWN_VIDEOS = [
    ("hxeDjAxvJ8", "lex_fridman_386"),
    ("8quXLOR_iVE", "joe_rogan_2010"),
    ("E_1cTlLpNMg", "marc_charlie_songhurst"),
    ("87Pm0SGTtN8", "marc_real_ai_boom"),
    ("53FImKtf2i0", "marc_future_of_vc"),
    ("8aTjA_bGZO4", "marc_inventing_browser"),
]

SEARCH_QUERIES = [
    "Marc Andreessen interview 2024",
    "Marc Andreessen a16z talk 2023",
    "Marc Andreessen Lex Fridman",
    "Marc Andreessen Joe Rogan",
    "Marc Andreessen Ben Horowitz podcast",
]

MIN_DURATION_SECONDS = 25 * 60
TITLE_KEYWORDS = ("andreessen", "marc")

OUTPUT_DIR = Path(__file__).resolve().parent.parent / "data" / "youtube"
ERROR_LOG = OUTPUT_DIR / "fetch-errors.log"


def _log_error(message: str) -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    with ERROR_LOG.open("a", encoding="utf-8") as fh:
        fh.write(f"[{date.today().isoformat()}] {message}\n")


def _slugify(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"[^a-z0-9]+", "-", value).strip("-")
    return value[:80] if value else "untitled"


def _format_transcript(entries: list[dict]) -> str:
    return "\n".join(entry.get("text", "").strip() for entry in entries if entry.get("text"))


def fetch_transcript(video_id: str, title_slug: str, source_url: str | None = None) -> bool:
    out_path = OUTPUT_DIR / f"{video_id}_{title_slug}.md"
    if out_path.exists():
        return False
    try:
        fetched = _TRANSCRIPT_CLIENT.fetch(video_id)
        entries = fetched.to_raw_data()
    except (TranscriptsDisabled, NoTranscriptFound) as exc:
        _log_error(f"{video_id} ({title_slug}) -> {type(exc).__name__}")
        return False
    except VideoUnavailable as exc:
        _log_error(f"{video_id} ({title_slug}) -> VideoUnavailable: {exc}")
        return False
    except Exception as exc:  # noqa: BLE001 - transcript api raises broad set
        _log_error(f"{video_id} ({title_slug}) -> {type(exc).__name__}: {exc}")
        return False

    body = _format_transcript(entries)
    if len(body) < 200:
        _log_error(f"{video_id} ({title_slug}) -> transcript too short")
        return False

    url = source_url or f"https://www.youtube.com/watch?v={video_id}"
    header = (
        f"# {title_slug}\n"
        f"**Source:** {url}\n"
        f"**Scraped:** {date.today().isoformat()}\n"
        f"---\n\n"
    )
    out_path.write_text(header + body + "\n", encoding="utf-8")
    return True


def _search_videos(query: str, max_results: int = 10) -> list[dict]:
    """Use yt-dlp to search YouTube; return list of video metadata dicts."""
    cmd = [
        sys.executable,
        "-m",
        "yt_dlp",
        f"ytsearch{max_results}:{query}",
        "--flat-playlist",
        "--dump-json",
        "--no-warnings",
        "--skip-download",
    ]
    try:
        result = subprocess.run(cmd, capture_output=True, text=True, timeout=120, check=False)
    except (FileNotFoundError, subprocess.TimeoutExpired) as exc:
        _log_error(f"yt-dlp search failed for {query!r}: {exc}")
        return []

    if result.returncode != 0:
        _log_error(f"yt-dlp search exit {result.returncode} for {query!r}: {result.stderr[:200]}")
        # Continue anyway — yt-dlp may have emitted partial JSON
    videos: list[dict] = []
    for line in result.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        try:
            videos.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    return videos


def _video_passes_filters(meta: dict) -> bool:
    title = (meta.get("title") or "").lower()
    if not any(kw in title for kw in TITLE_KEYWORDS):
        return False
    duration = meta.get("duration")
    if duration is None or duration < MIN_DURATION_SECONDS:
        return False
    return True


def run() -> dict:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    saved, skipped = 0, 0

    for video_id, title_slug in tqdm(KNOWN_VIDEOS, desc="known yt"):
        if fetch_transcript(video_id, title_slug):
            saved += 1
        else:
            skipped += 1

    seen_ids = {vid for vid, _ in KNOWN_VIDEOS}
    discovered = 0
    for query in tqdm(SEARCH_QUERIES, desc="yt search"):
        candidates = _search_videos(query)
        for meta in candidates:
            video_id = meta.get("id")
            if not video_id or video_id in seen_ids:
                continue
            if not _video_passes_filters(meta):
                continue
            seen_ids.add(video_id)
            discovered += 1
            slug = _slugify(meta.get("title") or video_id)
            url = meta.get("webpage_url") or f"https://www.youtube.com/watch?v={video_id}"
            if fetch_transcript(video_id, slug, source_url=url):
                saved += 1
            else:
                skipped += 1

    return {
        "known": len(KNOWN_VIDEOS),
        "discovered": discovered,
        "saved": saved,
        "skipped": skipped,
    }


if __name__ == "__main__":
    print(run())
