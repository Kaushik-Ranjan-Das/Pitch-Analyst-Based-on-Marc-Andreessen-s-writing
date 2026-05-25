# marc-agent

The knowledge-layer half of [Mark's Counsel](../README.md). This folder owns scraping Marc Andreessen's public writing and interviews, normalising it into clean markdown, and providing a text-only Claude Code subagent that reads the corpus directly.

The voice app in [`../voice-pitch-agent/`](../voice-pitch-agent/) consumes this corpus at index-build time to produce the embedding index used by Aparna for citations. The scrapers run independently — refresh them when you want new sources or updated content; you do not need to re-run them every time you use the voice app.

## What's here

```
marc-agent/
├── scrape_all.py                       # one entry point, dispatches to scrapers
├── requirements.txt                    # Python deps (requests, bs4, feedparser, yt-dlp, …)
├── scrapers/
│   ├── essays.py                       # pmarca.com essays
│   ├── a16z_blog.py                    # Marc's posts on a16z.com
│   ├── pmarca.py                       # archived pmarca blog
│   ├── podcasts.py                     # selected podcast transcripts
│   └── youtube_transcripts.py          # interview transcripts via youtube-transcript-api / yt-dlp
├── .claude/agents/
│   └── marc-andreessen-advisor.md      # Claude Code subagent definition — reads data/ directly
└── data/                               # populated by scrapers (gitignored)
    ├── essays/      *.md
    ├── blog/        *.md
    ├── pmarca/      *.md
    ├── podcasts/    *.md
    └── youtube/     *.md
```

## Quick start

```bash
pip3 install -r requirements.txt

# Scrape everything (takes a few minutes; sources hit the open internet)
python3 scrape_all.py --source all

# Or just one source while iterating
python3 scrape_all.py --source essays
python3 scrape_all.py --source youtube
```

After scraping, `data/` will contain ~135 markdown files (~3.8 MB) — each with a consistent header (`# Title`, `**Source:** url`, `**Scraped:** date`) followed by the body. The voice app's [build-index script](../voice-pitch-agent/scripts/build-index.mjs) reads this directory next.

## Markdown format

Every scraper writes files in the same shape so the chunker downstream can extract title + source URL uniformly:

```markdown
# The actual title of the piece
**Source:** https://original.url/here
**Scraped:** 2026-05-23
---

body paragraph 1

body paragraph 2

…
```

If you add a new scraper, follow this format exactly. The chunker in `voice-pitch-agent/scripts/build-index.mjs` depends on `**Source:**` being on a line by itself within the first 10 lines and `---` being the body separator.

## The Claude Code subagent

[`.claude/agents/marc-andreessen-advisor.md`](.claude/agents/marc-andreessen-advisor.md) is a text-only subagent definition for [Claude Code](https://claude.com/claude-code). Open Claude Code in this directory and invoke it (e.g. `/agents marc-andreessen-advisor`) to query Marc's positions directly from a coding session — useful for grep-style research over the corpus without spinning up the voice app.

## License

MIT for the code. The scraped corpus is the property of its original authors and publishers — see the top-level [DOCUMENTATION.md](../DOCUMENTATION.md#corpus-and-attribution) for guidance on responsible use.
