"""Fetch the pmarca.com / pmarchive.com archive (Marc's 2007-2008 blog)."""
from __future__ import annotations

import re
import time
from datetime import date
from pathlib import Path
from urllib.parse import urljoin, urlparse

import html2text
import requests
from bs4 import BeautifulSoup
from tqdm import tqdm

ENTRY_POINTS = [
    "https://pmarca.com",
    "https://pmarchive.com",
]
WAYBACK_FALLBACK = "https://web.archive.org/web/2010/https://pmarca.com/"

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

OUTPUT_DIR = Path(__file__).resolve().parent.parent / "data" / "pmarca"
ERROR_LOG = OUTPUT_DIR / "fetch-errors.log"


def _make_converter() -> html2text.HTML2Text:
    h = html2text.HTML2Text()
    h.body_width = 0
    h.ignore_links = False
    return h


def _log_error(message: str) -> None:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    with ERROR_LOG.open("a", encoding="utf-8") as fh:
        fh.write(f"[{date.today().isoformat()}] {message}\n")


def _slugify(value: str) -> str:
    value = value.strip().lower()
    value = re.sub(r"[^a-z0-9]+", "-", value).strip("-")
    return value[:120] if value else "untitled"


def _slug_from_url(url: str) -> str:
    path = urlparse(url).path.strip("/")
    if not path:
        return ""
    last = path.split("/")[-1]
    last = re.sub(r"\.html?$", "", last)
    return _slugify(last)


def _fetch(url: str, headers: dict) -> requests.Response | None:
    try:
        resp = requests.get(url, headers=headers, timeout=30)
        resp.raise_for_status()
        return resp
    except requests.RequestException as exc:
        _log_error(f"{url} -> request failed: {exc}")
        return None


def _extract_article(soup: BeautifulSoup) -> tuple[str, str]:
    title_tag = soup.find("h1") or soup.find("title")
    title = title_tag.get_text(strip=True) if title_tag else "Untitled"
    for selector in ("article", ".post", ".entry", ".post-content", ".entry-content", "main"):
        node = soup.select_one(selector)
        if node:
            return title, str(node)
    body = soup.find("body")
    return title, str(body) if body else str(soup)


def _collect_index_links(html: str, base_url: str) -> list[str]:
    soup = BeautifulSoup(html, "lxml")
    base_host = urlparse(base_url).netloc
    links: list[str] = []
    seen: set[str] = set()
    for a in soup.find_all("a", href=True):
        href = a["href"]
        absolute = urljoin(base_url, href)
        parsed = urlparse(absolute)
        if parsed.netloc and parsed.netloc != base_host and "web.archive.org" not in parsed.netloc:
            continue
        # Heuristic: article paths are deeper than the root
        path = parsed.path.strip("/")
        if not path:
            continue
        if path.endswith((".css", ".js", ".png", ".jpg", ".gif", ".ico", ".xml")):
            continue
        clean = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
        if clean in seen:
            continue
        seen.add(clean)
        links.append(clean)
    return links


def fetch_article(url: str, converter: html2text.HTML2Text, headers: dict) -> bool:
    slug = _slug_from_url(url)
    if not slug:
        return False
    out_path = OUTPUT_DIR / f"{slug}.md"
    if out_path.exists():
        return False

    resp = _fetch(url, headers)
    if not resp:
        return False

    soup = BeautifulSoup(resp.text, "lxml")
    title, fragment = _extract_article(soup)
    markdown_body = converter.handle(fragment).strip()
    if len(markdown_body) < 500:
        _log_error(f"{url} -> body under 500 chars")
        return False

    header = (
        f"# {title}\n"
        f"**Source:** {url}\n"
        f"**Scraped:** {date.today().isoformat()}\n"
        f"---\n\n"
    )
    out_path.write_text(header + markdown_body + "\n", encoding="utf-8")
    return True


def run() -> dict:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    converter = _make_converter()
    headers = {"User-Agent": USER_AGENT}

    index_url = None
    index_html = None
    for candidate in ENTRY_POINTS:
        resp = _fetch(candidate, headers)
        if resp and len(resp.text) > 500:
            index_url = candidate
            index_html = resp.text
            break

    if index_html is None:
        _log_error("primary entry points unreachable; falling back to wayback")
        resp = _fetch(WAYBACK_FALLBACK, headers)
        if resp:
            index_url = WAYBACK_FALLBACK
            index_html = resp.text

    if index_html is None:
        _log_error("all entry points unreachable")
        return {"discovered": 0, "saved": 0, "skipped": 0}

    article_links = _collect_index_links(index_html, index_url)
    saved, skipped = 0, 0
    for url in tqdm(article_links, desc="pmarca"):
        if fetch_article(url, converter, headers):
            saved += 1
        else:
            skipped += 1
        time.sleep(1)

    return {"discovered": len(article_links), "saved": saved, "skipped": skipped, "entry": index_url}


if __name__ == "__main__":
    print(run())
