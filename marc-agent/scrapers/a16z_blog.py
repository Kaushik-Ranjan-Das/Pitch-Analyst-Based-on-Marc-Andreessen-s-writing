"""Scrape Marc-attributed posts from a16z.com/author/marc-andreessen/."""
from __future__ import annotations

import time
from datetime import date
from pathlib import Path
from urllib.parse import urljoin, urlparse

import html2text
import requests
from bs4 import BeautifulSoup
from tqdm import tqdm

AUTHOR_URL = "https://a16z.com/author/marc-andreessen/"
USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

ACCEPTED_PATH_PREFIXES = ("/podcast/", "/essay/", "/article/")
SLUG_KEYWORDS = (
    "marc-andreessen",
    "marc-and-ben",
    "ben-and-marc",
    "ben-marc",
    "with-marc",
    "pmarca",
    "andreessen-on",
    "andreessen-and",
)

OUTPUT_DIR = Path(__file__).resolve().parent.parent / "data" / "blog"
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


def _slug_from_url(url: str) -> str:
    path = urlparse(url).path.strip("/")
    return path.split("/")[-1] if path else ""


def _accept_link(href: str) -> bool:
    parsed = urlparse(href)
    if parsed.netloc and "a16z.com" not in parsed.netloc:
        return False
    path = parsed.path
    if not any(path.startswith(prefix) for prefix in ACCEPTED_PATH_PREFIXES):
        return False
    slug = _slug_from_url(href)
    return any(keyword in slug for keyword in SLUG_KEYWORDS)


def _extract_links(html: str, base_url: str) -> list[str]:
    soup = BeautifulSoup(html, "lxml")
    found: list[str] = []
    for a in soup.find_all("a", href=True):
        absolute = urljoin(base_url, a["href"])
        # Strip query string and fragment
        parsed = urlparse(absolute)
        clean = f"{parsed.scheme}://{parsed.netloc}{parsed.path}"
        if _accept_link(clean) and clean not in found:
            found.append(clean)
    return found


def _extract_article(soup: BeautifulSoup) -> tuple[str, str]:
    title_tag = soup.find("h1") or soup.find("title")
    title = title_tag.get_text(strip=True) if title_tag else "Untitled"
    for selector in ("article", ".post-content", ".entry-content", "main"):
        node = soup.select_one(selector)
        if node:
            return title, str(node)
    body = soup.find("body")
    return title, str(body) if body else str(soup)


def _collect_article_urls(headers: dict) -> list[str]:
    collected: list[str] = []
    seen: set[str] = set()
    page = 1
    while True:
        url = AUTHOR_URL if page == 1 else f"{AUTHOR_URL.rstrip('/')}/page/{page}/"
        try:
            resp = requests.get(url, headers=headers, timeout=30)
        except requests.RequestException as exc:
            _log_error(f"index page {url} -> request failed: {exc}")
            break

        if resp.status_code == 404:
            break
        if resp.status_code >= 400:
            _log_error(f"index page {url} -> status {resp.status_code}")
            break

        links = _extract_links(resp.text, url)
        new_links = [link for link in links if link not in seen]
        if not new_links:
            break

        for link in new_links:
            seen.add(link)
            collected.append(link)

        page += 1
        time.sleep(1)

    return collected


def fetch_article(url: str, converter: html2text.HTML2Text) -> bool:
    slug = _slug_from_url(url)
    if not slug:
        _log_error(f"{url} -> empty slug")
        return False

    out_path = OUTPUT_DIR / f"{slug}.md"
    if out_path.exists():
        return False  # skipped

    headers = {"User-Agent": USER_AGENT}
    try:
        resp = requests.get(url, headers=headers, timeout=30)
        resp.raise_for_status()
    except requests.RequestException as exc:
        _log_error(f"{url} -> request failed: {exc}")
        return False

    soup = BeautifulSoup(resp.text, "lxml")
    title, fragment = _extract_article(soup)
    markdown_body = converter.handle(fragment).strip()

    if len(markdown_body) < 500:
        _log_error(f"{url} -> body under 500 chars after parsing")
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
    headers = {"User-Agent": USER_AGENT}
    converter = _make_converter()

    urls = _collect_article_urls(headers)
    saved, skipped = 0, 0

    for url in tqdm(urls, desc="a16z blog"):
        if fetch_article(url, converter):
            saved += 1
        else:
            skipped += 1
        time.sleep(1)

    return {"discovered": len(urls), "saved": saved, "skipped": skipped}


if __name__ == "__main__":
    print(run())
