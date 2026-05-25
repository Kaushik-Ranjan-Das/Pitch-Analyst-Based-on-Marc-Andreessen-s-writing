"""Fetch Marc Andreessen essays from public URLs and save as markdown."""
from __future__ import annotations

import time
from datetime import date
from pathlib import Path

import html2text
import requests
from bs4 import BeautifulSoup
from tqdm import tqdm

ESSAYS = [
    ("techno_optimist_manifesto", "https://a16z.com/the-techno-optimist-manifesto/"),
    ("its_time_to_build", "https://a16z.com/its-time-to-build/"),
    ("why_software_is_eating_the_world", "https://a16z.com/why-software-is-eating-the-world/"),
    ("how_to_win_the_future", "https://a16z.com/how-to-win-the-future/"),
    ("pmarca_guide_pmf", "https://a16z.com/product-market-fit/"),
    ("pmarca_guide_startups", "https://a16z.com/the-pmarca-guide-to-startups/"),
    ("pmarca_guide_productivity", "https://a16z.com/the-pmarca-guide-to-personal-productivity/"),
    ("in_praise_of_risk", "https://a16z.com/in-praise-of-risk/"),
    ("marc_mindset_great_founders", "https://a16z.com/podcast/marc-andreessen-on-the-mindset-of-great-founders-with-david-senra/"),
    ("marc_how_he_uses_ai", "https://a16z.com/podcast/how-marc-andreessen-actually-uses-ai/"),
    ("marc_startup_timing", "https://a16z.com/podcast/marc-andreessen-on-startup-timing/"),
    ("marc_ai_will_save_world", "https://a16z.com/podcast/ai-will-save-the-world-with-marc-andreessen-and-martin-casado-2/"),
    ("beyond_chatbots", "https://a16z.com/podcast/beyond-chatbots-marc-andreessen-and-ben-horowitz-on-ais-future/"),
    ("marc_10x_bigger", "https://a16z.com/podcast/ben-marc-why-everything-is-about-to-get-10x-bigger/"),
    ("marc_most_important_moment", "https://a16z.com/podcast/marc-andreessen-on-why-this-is-the-most-important-moment-in-tech-history/"),
]

USER_AGENT = (
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
    "AppleWebKit/537.36 (KHTML, like Gecko) "
    "Chrome/124.0.0.0 Safari/537.36"
)

OUTPUT_DIR = Path(__file__).resolve().parent.parent / "data" / "essays"
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


def _extract_main(soup: BeautifulSoup) -> tuple[str, str]:
    title_tag = soup.find("h1") or soup.find("title")
    title = title_tag.get_text(strip=True) if title_tag else "Untitled"

    for selector in ("article", ".post-content", ".entry-content", "main"):
        node = soup.select_one(selector)
        if node:
            return title, str(node)

    body = soup.find("body")
    return title, str(body) if body else str(soup)


def fetch_essay(slug: str, url: str, converter: html2text.HTML2Text) -> bool:
    headers = {"User-Agent": USER_AGENT}
    try:
        resp = requests.get(url, headers=headers, timeout=30)
        resp.raise_for_status()
    except requests.RequestException as exc:
        _log_error(f"{slug} {url} -> request failed: {exc}")
        return False

    soup = BeautifulSoup(resp.text, "lxml")
    title, html_fragment = _extract_main(soup)
    markdown_body = converter.handle(html_fragment).strip()

    if len(markdown_body) < 500:
        _log_error(f"{slug} {url} -> body under 500 chars after parsing")
        return False

    header = (
        f"# {title}\n"
        f"**Source:** {url}\n"
        f"**Scraped:** {date.today().isoformat()}\n"
        f"---\n\n"
    )

    out_path = OUTPUT_DIR / f"{slug}.md"
    out_path.write_text(header + markdown_body + "\n", encoding="utf-8")
    return True


def run() -> dict:
    OUTPUT_DIR.mkdir(parents=True, exist_ok=True)
    converter = _make_converter()
    saved, skipped = 0, 0

    for slug, url in tqdm(ESSAYS, desc="essays"):
        ok = fetch_essay(slug, url, converter)
        if ok:
            saved += 1
        else:
            skipped += 1
        time.sleep(1.5)

    return {"saved": saved, "skipped": skipped, "total": len(ESSAYS)}


if __name__ == "__main__":
    result = run()
    print(result)
