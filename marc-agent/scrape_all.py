"""Orchestrate Marc Andreessen knowledge base scrapers."""
from __future__ import annotations

import argparse
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent
DATA_ROOT = ROOT / "data"
SOURCES = ["essays", "blog", "pmarca", "youtube", "podcasts"]
SUBFOLDERS = {
    "essays": "essays",
    "blog": "blog",
    "pmarca": "pmarca",
    "youtube": "youtube",
    "podcasts": "podcasts",
}


def _run_source(name: str) -> dict:
    if name == "essays":
        from scrapers import essays
        return essays.run()
    if name == "blog":
        from scrapers import a16z_blog
        return a16z_blog.run()
    if name == "pmarca":
        from scrapers import pmarca
        return pmarca.run()
    if name == "youtube":
        from scrapers import youtube_transcripts
        return youtube_transcripts.run()
    if name == "podcasts":
        from scrapers import podcasts
        return podcasts.run()
    raise ValueError(f"unknown source {name!r}")


def _folder_stats(path: Path) -> tuple[int, int, int]:
    if not path.exists():
        return 0, 0, 0
    files = [p for p in path.iterdir() if p.is_file() and p.suffix == ".md"]
    total_bytes = sum(p.stat().st_size for p in files)
    error_log = path / "fetch-errors.log"
    error_count = 0
    if error_log.exists():
        with error_log.open("r", encoding="utf-8") as fh:
            error_count = sum(1 for line in fh if line.strip())
    return len(files), total_bytes, error_count


def _print_summary() -> None:
    print("\n=== Scrape summary ===")
    total_bytes = 0
    for source in SOURCES:
        folder = DATA_ROOT / SUBFOLDERS[source]
        count, size, errors = _folder_stats(folder)
        total_bytes += size
        size_kb = size / 1024
        print(
            f"  {source:>9}: {count:>4} files, {size_kb:>9.1f} KB, "
            f"errors: {errors}"
        )
    print(f"  {'total':>9}: {total_bytes / (1024 * 1024):.2f} MB")


def main() -> int:
    parser = argparse.ArgumentParser(description="Marc Andreessen scraper orchestrator")
    parser.add_argument(
        "--source",
        choices=SOURCES + ["all"],
        required=True,
        help="Which scraper to run",
    )
    args = parser.parse_args()

    if args.source == "all":
        targets = SOURCES
    else:
        targets = [args.source]

    sys.path.insert(0, str(ROOT))

    for name in targets:
        print(f"\n--- Running scraper: {name} ---")
        try:
            result = _run_source(name)
            print(f"  result: {result}")
        except Exception as exc:  # noqa: BLE001
            print(f"  ERROR running {name}: {exc}")

    _print_summary()
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
