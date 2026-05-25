# Mark's Counsel

An AI advisor system grounded in Marc Andreessen's published thinking. Founders can pitch to it by voice and get back framework-aware feedback with citations to the actual essay or interview each claim comes from.

The name says it: this is "Mark's counsel" — what Marc would push on, applied by an AI analyst who has read everything he's written, and traceable to source on every line.

## What's in this repo

Two sibling projects that work together:

```
Mark's Counsel/
├── marc-agent/             # The knowledge layer
│   ├── scrapers/           # Scrapes Marc's essays, blog, pmarca archive, YouTube, podcasts
│   ├── data/               # 135 markdown files — the corpus
│   └── .claude/agents/     # marc-andreessen-advisor (text-based subagent)
│
└── voice-pitch-agent/      # The interaction layer
    ├── scripts/build-index # One-time embedding builder (Voyage AI)
    ├── src/                # Vite + vanilla JS browser app
    └── vite.config.js      # Dev server with Anthropic proxy + /api/retrieve middleware
```

[`marc-agent/`](marc-agent/) owns scraping and stores the corpus. The scrapers run once (or periodically) and produce ~3.8 MB of clean markdown across essays, blog posts, the pmarca archive, podcast transcripts, and YouTube interview transcripts. There's also a text-based subagent in [`marc-agent/.claude/agents/`](marc-agent/.claude/agents/marc-andreessen-advisor.md) that uses this corpus directly from a Claude Code session.

[`voice-pitch-agent/`](voice-pitch-agent/) consumes that corpus to power a live voice conversation. Aparna — an AI analyst persona — interviews the founder, fills a structured pitch packet in real time, and grounds every substantive claim in a citation from the corpus. The citation popup is the centerpiece of the UX: every reply that quotes Marc's thinking shows the actual source passage.

For deeper technical detail see [ARCHITECTURE.md](ARCHITECTURE.md). For operating the system day-to-day see [DOCUMENTATION.md](DOCUMENTATION.md).

## Quick start

If you just want to get a pitch session running:

```bash
# 1. Build the corpus (one-time)
cd marc-agent
pip3 install -r requirements.txt
python3 scrape_all.py --source all

# 2. Build the voice app's embedding index
cd ../voice-pitch-agent
npm install
cp .env.example .env
# edit .env, add ANTHROPIC_API_KEY and VOYAGE_API_KEY
npm run build:index    # ~30s, embeds ~2k chunks
npm run dev            # opens http://127.0.0.1:5173
```

Click **New pitch session**. Aparna introduces herself, asks you to walk her through what you're building, and the pitch packet fills as you talk. Every time she invokes a Marc framework, click the green "◆ N sources" badge under her reply to see the cited passage.

## What each project is best at

| Use case | Project |
|---|---|
| Voice conversation with citations on screen | [voice-pitch-agent](voice-pitch-agent/) |
| Asking "what does Marc say about X" in a coding session | [marc-agent/.claude/agents/marc-andreessen-advisor](marc-agent/.claude/agents/marc-andreessen-advisor.md) |
| Adding new sources to the corpus | [marc-agent/scrapers/](marc-agent/scrapers/) |
| Refreshing the corpus periodically | `cd marc-agent && python3 scrape_all.py --source all` |
| Demoing to investors / founders | [voice-pitch-agent](voice-pitch-agent/) with QuickTime + BlackHole |

## Why is this two projects, not one?

The split is intentional:

- **The corpus has its own lifecycle.** Scraping runs maybe once a month. The voice app runs every session. Keeping them in separate folders means the scrapers can grow (more sources, smarter parsing, scheduled refresh) without ever touching the voice UI.
- **The corpus has multiple consumers.** Both the text subagent and the voice app read from `marc-agent/data/`. If you build a third consumer later (a Slack bot, a CLI, a notebook tool), it joins the same corpus rather than maintaining its own copy.
- **The voice app is a deployable artifact on its own.** Once `data/index.json` is built, the voice app doesn't need the scrapers at runtime. You could ship it as a static demo without exposing the corpus or the build pipeline.

## Project status

This is a **demo artifact**, not a production system. It's meant to run on a laptop, be recorded with QuickTime, and shown to founders or investors. Specifically:

- No auth, no rate limiting, no multi-tenant support.
- Pitch sessions live in browser memory only — no export, no persistence.
- The "escalate to partner" handoff plays a 5-stage UI overlay but doesn't actually contact anyone.
- Web Speech API is fine for a demo; for real production voice you'd want ElevenLabs streaming TTS + Twilio for PSTN.
- The corpus is scraped from public sources — be mindful of source URL accuracy and don't republish without proper attribution.

See [DOCUMENTATION.md → Out of scope / good follow-ups](DOCUMENTATION.md#out-of-scope-good-follow-ups) for what's intentionally not built yet.

## Tech stack at a glance

- **Scrapers**: Python 3.9+, `requests`, `beautifulsoup4`, `html2text`, `feedparser`, `youtube-transcript-api`, `yt-dlp`
- **Voice app**: Vite 7, vanilla JS, no framework, no build step beyond Vite
- **LLM**: Anthropic Claude Sonnet 4.6 via streaming `/v1/messages` with native [Citations API](https://docs.anthropic.com/en/docs/build-with-claude/citations)
- **Embeddings**: Voyage AI `voyage-3.5-lite` (1024-dim), batched at index time, single-query at runtime
- **Retrieval**: in-memory cosine similarity over ~2,000 chunks (~3ms per query)
- **STT/TTS**: browser-native Web Speech API + SpeechSynthesis (no third-party voice service)

## License

MIT for the code in each subproject (see their `LICENSE` files). The scraped corpus is the property of its original authors and publishers — see [DOCUMENTATION.md → Corpus and attribution](DOCUMENTATION.md#corpus-and-attribution) for guidance on responsible use.
