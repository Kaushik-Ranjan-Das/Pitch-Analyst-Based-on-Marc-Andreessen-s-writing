"""Fetch Marc Andreessen podcast episodes from RSS feeds."""
from __future__ import annotations

import re
from datetime import date
from pathlib import Path

import feedparser
import html2text
from bs4 import BeautifulSoup
from tqdm import tqdm
from youtube_transcript_api import YouTubeTranscriptApi
from youtube_transcript_api._errors import (
    NoTranscriptFound,
    TranscriptsDisabled,
    VideoUnavailable,
)

_TRANSCRIPT_CLIENT = YouTubeTranscriptApi()

FEEDS = [
    {
        "name": "a16z",
        "url": "https://feeds.simplecast.com/JGE3yC0V",
        "keywords": ("marc andreessen", "andreessen", "ben & marc", "ben marc", "marc and ben"),
    },
    {
        "name": "lex_fridman",
        "url": "https://lexfridman.com/feed/podcast/",
        "keywords": ("andreessen",),
    },
    {
        "name": "tim_ferriss",
        "url": "https://tim.blog/feed/podcast/",
        "keywords": ("andreessen",),
    },
]

YOUTUBE_PATTERNS = [
    re.compile(r"(?:youtube\.com/watch\?[^\"' >]*v=)([A-Za-z0-9_-]{11})"),
    re.compile(r"youtu\.be/([A-Za-z0-9_-]{11})"),
    re.compile(r"youtube\.com/embed/([A-Za-z0-9_-]{11})"),
]

OUTPUT_DIR = Path(__file__).resolve().parent.parent / "data" / "podcasts"
ERROR_LOG = OUTPUT_DIR / "fetch-errors.log"


def _log_error(message: str) -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    with ERROR_LOG.open("a", encoding="utf-8") as fh:
        fh.write(f"[{date.today().isoformat()}] {message}\n")


def _slugify(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"[^a-z0-9]+", "-", value).strip("-")
    return value[:120] if value else "untitled"


def _make_converter() -> html2text.HTML2Text:
    h = html2text.HTML2Text()
    h.body_width = 0
    h.ignore_links = False
    return h


def _matches_keywords(title: str, keywords: tuple[str, ...]) -> bool:
    low = title.lower()
    return any(kw in low for kw in keywords)


def _extract_youtube_id(text: str) -> str | None:
    for pattern in YOUTUBE_PATTERNS:
        match = pattern.search(text)
        if match:
            return match.group(1)
    return None


def _show_notes_text(entry, converter: html2text.HTML2Text) -> str:
    raw = ""
    if "content" in entry and entry["content"]:
        raw = entry["content"][0].get("value", "")
    if not raw:
        raw = entry.get("summary", "") or entry.get("description", "")
    if not raw:
        return ""
    soup = BeautifulSoup(raw, "lxml")
    return converter.handle(str(soup)).strip()


def _transcript_for(video_id: str) -> str | None:
    try:
        fetched = _TRANSCRIPT_CLIENT.fetch(video_id)
        entries = fetched.to_raw_data()
    except (TranscriptsDisabled, NoTranscriptFound, VideoUnavailable):
        return None
    except Exception:  # noqa: BLE001
        return None
    return "\n".join(e.get("text", "").strip() for e in entries if e.get("text"))


def _save_episode(
    podcast_name: str,
    title: str,
    source_url: str,
    body: str,
    notes: str | None = None,
) -> bool:
    if len(body) < 200:
        _log_error(f"{podcast_name} {title!r} -> body too short")
        return False
    slug = _slugify(title)
    out_path = OUTPUT_DIR / f"{podcast_name}_{slug}.md"
    if out_path.exists():
        return False
    header = (
        f"# {title}\n"
        f"**Source:** {source_url}\n"
        f"**Scraped:** {date.today().isoformat()}\n"
    )
    if notes:
        header += f"**Notes:** {notes}\n"
    header += "---\n\n"
    out_path.write_text(header + body + "\n", encoding="utf-8")
    return True


def _process_feed(feed_meta: dict, converter: html2text.HTML2Text) -> dict:
    parsed = feedparser.parse(feed_meta["url"])
    if parsed.bozo and not parsed.entries:
        _log_error(f"{feed_meta['name']} feed parse failed: {parsed.get('bozo_exception')}")
        return {"matched": 0, "saved": 0}

    matched = 0
    saved = 0
    for entry in parsed.entries:
        title = entry.get("title", "")
        if not _matches_keywords(title, feed_meta["keywords"]):
            continue
        matched += 1

        link = entry.get("link", "")
        notes_html = ""
        if "content" in entry and entry["content"]:
            notes_html = entry["content"][0].get("value", "")
        if not notes_html:
            notes_html = entry.get("summary", "") or entry.get("description", "")

        video_id = _extract_youtube_id(notes_html) or _extract_youtube_id(link)
        body: str | None = None
        notes_label: str | None = None

        if video_id:
            transcript = _transcript_for(video_id)
            if transcript:
                body = transcript
                notes_label = f"YouTube transcript ({video_id})"
            else:
                _log_error(f"{feed_meta['name']} {title!r} -> transcript unavailable for {video_id}")

        if body is None:
            notes_body = _show_notes_text(entry, converter)
            if not notes_body:
                _log_error(f"{feed_meta['name']} {title!r} -> no content available")
                continue
            body = notes_body
            notes_label = "Show notes (transcript unavailable)"

        if _save_episode(feed_meta["name"], title, link or feed_meta["url"], body, notes_label):
            saved += 1

    return {"matched": matched, "saved": saved}


def run() -> dict:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    converter = _make_converter()
    totals = {"matched": 0, "saved": 0}
    per_feed: dict[str, dict] = {}

    for feed_meta in tqdm(FEEDS, desc="podcasts"):
        stats = _process_feed(feed_meta, converter)
        per_feed[feed_meta["name"]] = stats
        totals["matched"] += stats["matched"]
        totals["saved"] += stats["saved"]

    return {"totals": totals, "per_feed": per_feed}


if __name__ == "__main__":
    print(run())
