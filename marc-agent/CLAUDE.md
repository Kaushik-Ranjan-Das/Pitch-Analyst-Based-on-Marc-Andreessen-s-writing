# marc-agent — agent context

## What this folder is

The knowledge layer of the wider Mark's Counsel project. Scrapers fetch Marc Andreessen's public writing and interviews and normalise everything into clean markdown under `data/`. The voice app in `../voice-pitch-agent/` consumes that markdown at index-build time; this folder does not run at request time.

## Stack

- **Python 3.9+** for all scrapers
- `requests` + `beautifulsoup4` + `html2text` for HTML sources
- `feedparser` for RSS / Atom feeds
- `youtube-transcript-api` (primary) + `yt-dlp` (fallback) for video transcripts

## Layout

- [scrape_all.py](scrape_all.py) — dispatcher; `--source <name|all>` selects which scraper(s) to run
- [scrapers/](scrapers/) — one file per source, each with a `scrape()` entry point
- [data/](data/) — output directory, one subfolder per source. **Gitignored.**
- [.claude/agents/marc-andreessen-advisor.md](.claude/agents/marc-andreessen-advisor.md) — Claude Code subagent that reads `data/` directly for research-mode queries

## File format invariant

Every scraper MUST write files that look like this:

```markdown
# Title
**Source:** https://original.url
**Scraped:** YYYY-MM-DD
---

body
```

Header lines must appear within the first 10 lines of the file; the `---` separator marks the boundary between metadata and body. The voice app's chunker depends on this format — change it here and you break retrieval over there.

## Tone for future contributors

- Scrapers are idempotent. Re-running over an existing file should overwrite, not append.
- One scraper per source. Don't try to share a generic scraper across very different sites — each platform has its own quirks (a16z's React SPA, YouTube's transcript API, pmarca's archived HTML).
- If a fetch fails, write to `fetch-errors.log` next to the source folder and continue — never crash the whole batch run.
- Do not commit anything in `data/`. Treat the corpus as a build artifact.
