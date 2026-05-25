# Voice Pitch Agent — Aparna, Marc Andreessen analyst

A browser-based voice agent that interviews founders about their pitch and grounds every reply in Marc Andreessen's published writing. Built on top of the original [voice-agent-case-manager-inquiry](https://github.com/Kaushik-Ranjan-Das/voice-agent-case-manager-inquiry) pattern.

**Aparna** is an AI analyst who has studied Marc's essays, blog posts, and interviews. She is not Marc — she's the analyst who has read everything Marc has published and can pull from it on demand. When she makes a substantive claim about Marc's frameworks, a citation popup shows the exact source passage in real-time. Every citation accumulates in a "Sources used this session" panel on the right.

## Quick start

```bash
# 1. Install
bun install   # or: npm install

# 2. Configure keys
cp .env.example .env
# edit .env:
#   ANTHROPIC_API_KEY=sk-ant-...     (Claude Sonnet 4.6)
#   VOYAGE_API_KEY=pa-...            (voyage-3.5-lite embeddings)

# 3. Build the embedding index (one-time, ~30s)
bun run build:index

# 4. Run
bun run dev   # opens http://127.0.0.1:5173
```

Click **New pitch session**. Aparna introduces herself and asks you to walk her through what you're building. Talk back. The pitch packet fills on the right as the conversation progresses. Whenever Aparna pulls from Marc's writing, a green "◆ N sources" badge appears under her reply — click it for the cited passage.

## How it works

```
        ┌──────────────────────┐
        │ Browser (Vite)       │
        │ ─────────────────────│
mic ───>│ Web Speech STT       │── transcript ──┐
        │                      │                 │
        │                      │     ┌───────────────────────┐
        │                      │     │ POST /api/retrieve    │── voyage-3.5-lite ──> top-k chunks
        │                      │     │ (Vite middleware)     │
        │                      │     └───────────────────────┘
        │                      │                 │
        │                      │     ┌───────────────────────┐
speaker<│ SpeechSynthesis      │<────│ Claude Sonnet 4.6     │
        │                      │     │ + system blocks       │
        │ form-ui.js           │<────│   - system prompt     │
        │ transcript-ui.js     │     │   - N document blocks │
        │ citations-ui.js      │<────│     w/ citations: on  │
        │ guidance-ui.js       │     │ + update_field tool   │
        └──────────────────────┘     │ + escalate_to_partner │
                                     └───────────────────────┘
```

The two key additions over the original case-manager demo:

1. **Pre-built embedding index** (`data/index.json`). `scripts/build-index.mjs` walks `../marc-agent/data/{essays,blog,pmarca,youtube,podcasts}/*.md`, chunks each file by paragraph into ~600-token windows with overlap, embeds via Voyage AI, and writes the JSON. The Vite dev server loads it once at boot and serves top-K matches at `/api/retrieve` (in-memory cosine, ~3ms per query for ~2k vectors).

2. **Anthropic native [Citations API](https://docs.anthropic.com/en/docs/build-with-claude/citations)**. Retrieved chunks are passed as `document` content blocks with `citations: { enabled: true }`. Claude returns `cited_text` + `document_title` + char ranges alongside the streamed reply, and `claude-client.js` forwards them to `state.bubbleCitations` so the UI can show the popup.

## Project layout

```
voice-pitch-agent/
├── index.html
├── vite.config.js          # dev server + Anthropic proxy + /api/retrieve middleware
├── scripts/
│   └── build-index.mjs     # one-time embedding index builder
├── data/
│   └── index.json          # produced by build:index (gitignored, ~30-60 MB)
└── src/
    ├── main.js
    ├── claude-client.js    # system prompt, tools, citation streaming
    ├── retrieval.js        # browser wrapper for /api/retrieve
    ├── voice.js            # STT + TTS (Web Speech)
    ├── state.js            # pub-sub store (+ citations slice)
    ├── form-schema.js      # 6 sections × ~3 fields (problem/solution/market/traction/team/ask)
    ├── form-ui.js          # pitch packet renderer
    ├── transcript-ui.js    # transcript bubbles + citation badges
    ├── citations-ui.js     # citation popover + sources panel
    ├── guidance-ui.js      # "what Marc would press on next" sidebar
    ├── kpi-band.js         # top metrics band
    ├── escalate-to-partner.js  # human handoff overlay
    └── styles.css
```

The corpus itself lives in the sibling project:

```
Mark's Counsel/
├── marc-agent/              # scrapers + scraped .md files
│   └── data/                # 135 markdown files indexed by this app
└── voice-pitch-agent/       # this project
```

If you move the corpus, update `CORPUS_ROOT` in `scripts/build-index.mjs`.

## Tweak the agent

- **System prompt + tools**: [src/claude-client.js](src/claude-client.js). The `SYSTEM_PROMPT` constant is where Aparna's voice, the framework list, and the rules live. Mirrors the [marc-andreessen-advisor subagent](../marc-agent/.claude/agents/marc-andreessen-advisor.md).
- **Pitch packet schema**: [src/form-schema.js](src/form-schema.js). Add or remove fields — the form, the completion ring, and Claude's tool description all read from this one file.
- **Section press prompts** (the "what Marc would press on next" sidebar): the `SECTION_PRESS` map at the top of [src/guidance-ui.js](src/guidance-ui.js).
- **Retrieval depth**: the `k` argument passed to `retrieveDocuments(query, k)` in [src/claude-client.js](src/claude-client.js) defaults to 6. Bump it for better coverage at the cost of more tokens per turn.
- **Visual style**: [src/styles.css](src/styles.css). Design tokens at the top; citation popover and sources panel styles at the bottom.

## Recording a demo on macOS

Same as the original — QuickTime screen recording with BlackHole virtual audio:

```bash
brew install --cask blackhole-2ch
# macOS Sound settings: Output → "Multi-Output Device" (BlackHole + speakers)
# QuickTime → New Screen Recording → Mic: BlackHole 2ch
```

Chrome handles Web Speech recognition best. Use a wired headset to keep TTS from looping back into the recognizer.

## What's missing (good follow-ups)

- **Better TTS**: SpeechSynthesis is fine for a demo; ElevenLabs streaming would sound dramatically more human.
- **Real phone call**: wire to Twilio Voice for actual PSTN.
- **Hybrid retrieval**: add BM25 as a second signal and re-rank. The current pure-embedding retrieval misses some named-entity queries.
- **Real partner handoff**: `escalate_to_partner` currently runs a 5-stage overlay simulation. Wire to a Slack webhook or email to actually notify someone.
- **Pitch packet export**: there's no export yet — packet lives in memory only.
- **Session history**: every session is fresh. No persistence.

## Why a separate project from `marc-agent/`?

The `marc-agent/` sibling owns scraping and stores the corpus. This app consumes it. Keeping them separate means the scrapers can grow (more sources, periodic refresh) without coupling to the UI, and the voice app can be deployed standalone once the index is built.
