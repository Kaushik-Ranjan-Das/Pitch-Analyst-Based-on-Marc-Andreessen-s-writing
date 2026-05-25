# Documentation

Day-to-day operating manual for Mark's Counsel. If you want the *what* and *why*, see [ARCHITECTURE.md](ARCHITECTURE.md). This file covers the *how*: setup, configuration, customization, common errors, and refreshing the corpus.

## Table of contents

1. [First-time setup](#1-first-time-setup)
2. [Running things](#2-running-things)
3. [Configuration reference](#3-configuration-reference)
4. [Customizing Aparna](#4-customizing-aparna)
5. [Customizing the pitch packet](#5-customizing-the-pitch-packet)
6. [Refreshing the corpus](#6-refreshing-the-corpus)
7. [Swap embedding provider](#7-swap-embedding-provider)
8. [Recording a demo](#8-recording-a-demo)
9. [Troubleshooting](#9-troubleshooting)
10. [Corpus and attribution](#10-corpus-and-attribution)
11. [Out of scope / good follow-ups](#11-out-of-scope-good-follow-ups)

---

## 1. First-time setup

### Prerequisites

| Tool | Tested version | Purpose |
|---|---|---|
| macOS | 14+ | Web Speech API works best in Chrome/Safari on macOS |
| Python | 3.9+ | Scrapers in [marc-agent/](marc-agent/) |
| Node | 20+ | Voice app in [voice-pitch-agent/](voice-pitch-agent/) — needs `--env-file` support |
| Chrome | Latest | Best browser for Web Speech STT |
| Anthropic API key | — | Get one at https://console.anthropic.com/settings/keys |
| Voyage AI API key | — | Get one at https://dash.voyageai.com/ (free tier is fine) |

Bun is supported but optional. The repo ships `bun.lock`, but `npm install` works identically.

### Setup steps

```bash
# 1. Clone (already done if you're reading this)
cd "Mark's Counsel"

# 2. Build the corpus
cd marc-agent
pip3 install -r requirements.txt
python3 scrape_all.py --source all
# → ~135 .md files across data/{essays,blog,pmarca,youtube,podcasts}/

# 3. Install voice app dependencies
cd ../voice-pitch-agent
npm install

# 4. Configure API keys
cp .env.example .env
# edit .env, set ANTHROPIC_API_KEY and VOYAGE_API_KEY

# 5. Build the embedding index
npm run build:index
# → writes data/index.json (~50 MB, ~2k chunks)

# 6. Run
npm run dev
# → opens http://127.0.0.1:5173 in your default browser
```

If any step in (2) fails for a single source, the orchestrator continues with the rest. Errors land in `marc-agent/data/<source>/fetch-errors.log`.

## 2. Running things

### Voice app — dev server

```bash
cd voice-pitch-agent
npm run dev
```

Vite serves at `http://127.0.0.1:5173`. The dev server proxies `/api/anthropic` to `https://api.anthropic.com` (injecting your key server-side so it never reaches the browser bundle) and hosts `POST /api/retrieve` locally.

### Voice app — production build

```bash
npm run build
npm run preview
```

`vite build` produces a static bundle in `dist/`. **Important**: the `/api/anthropic` proxy and `/api/retrieve` middleware only exist in dev mode. For a production deploy you need a real backend serving those endpoints. See [section 11](#11-out-of-scope-good-follow-ups).

### Scrapers — individual sources

```bash
cd marc-agent
python3 scrape_all.py --source essays
python3 scrape_all.py --source blog
python3 scrape_all.py --source pmarca
python3 scrape_all.py --source youtube
python3 scrape_all.py --source podcasts
python3 scrape_all.py --source all      # all five in sequence
```

After every run the orchestrator prints a summary: files per folder, total size, error counts.

### Text subagent

In a Claude Code session started from `marc-agent/`:

```
> Use the marc-andreessen-advisor agent: should I raise a Series A now or wait six months?
```

Or just ask a founder-style question; Claude will route to the subagent if the description matches.

## 3. Configuration reference

### `voice-pitch-agent/.env`

| Variable | Required | Default | Purpose |
|---|---|---|---|
| `ANTHROPIC_API_KEY` | Yes | — | Used by `/api/anthropic` proxy. Stays server-side. |
| `VOYAGE_API_KEY` | Yes | — | Used by `scripts/build-index.mjs` and `/api/retrieve` middleware. |
| `ANTHROPIC_MODEL` | No | `claude-sonnet-4-6` | Override the Claude model. |
| `VOYAGE_MODEL` | No | `voyage-3.5-lite` | Override the embedding model. Anything supported by Voyage works. |

### Index builder (`scripts/build-index.mjs`)

Constants at the top of the file:

| Constant | Default | What it does |
|---|---|---|
| `TARGET_CHARS` | 2400 | ~600 tokens per chunk. Bigger = more context per chunk, fewer chunks total. |
| `OVERLAP_CHARS` | 400 | Sliding-window overlap. Keeps a chunk's tail in the next chunk's head. |
| `BATCH_SIZE` | 128 | Voyage embeddings per HTTP request. Don't exceed Voyage's batch limit (varies by model). |
| `SOURCES` | `['essays', 'blog', 'pmarca', 'youtube', 'podcasts']` | Which subfolders of `../marc-agent/data/` to index. |

### Retrieval middleware (`vite.config.js`)

| Setting | Default | What it does |
|---|---|---|
| `k` (per query) | 6 (from `claude-client.js`) | How many chunks to retrieve per turn. 4 = leaner prompts, 8 = better recall. |
| Vector dimension | 1024 | Determined by `voyage-3.5-lite`. Changes automatically if you swap to a different model. |

### Voice loop tunables (`src/main.js`, `src/voice.js`)

| Setting | Default | What it does |
|---|---|---|
| Founder utterance debounce | 600ms | Time after `final` Web Speech result before sending to Claude. Lower = snappier but cuts off mid-sentence. |
| TTS rate | 1.05 | SpeechSynthesisUtterance.rate. 0.9–1.2 is the comfortable range. |
| Sentence boundary detection | `.` `!` `?` followed by whitespace | In `voice.js → splitSentences()`. |

## 4. Customizing Aparna

### Change her persona / introduction

Edit [voice-pitch-agent/src/claude-client.js](voice-pitch-agent/src/claude-client.js), the `SYSTEM_PROMPT` constant. The first two paragraphs cover identity + opening line. Don't remove the "you are not Marc" guardrail unless you want her to impersonate.

### Add or remove Marc frameworks

In `SYSTEM_PROMPT`, the section labeled `MARC'S FRAMEWORKS`. Keep this in sync with [marc-agent/.claude/agents/marc-andreessen-advisor.md](marc-agent/.claude/agents/marc-andreessen-advisor.md) so the text subagent and voice agent stay coherent.

### Change her pushback style

`SYSTEM_PROMPT → RULES → rule 6` controls how aggressive Aparna is. Currently: "Push back. Marc does not soften positions for social comfort, and neither should you." Soften that line if she's coming across too harsh in user testing.

### Change the voice

`voice.js → loadVoices()` has a preference list:

```js
const prefs = ['Samantha', 'Karen', 'Tessa', 'Moira',
               'Google US English', 'Microsoft Aria', 'Microsoft Jenny']
```

Reorder for your preferred voice. Available voices come from the OS (macOS) or browser (Chrome/Edge). To list every voice your environment offers, run in DevTools:

```js
speechSynthesis.getVoices().forEach(v => console.log(v.name, v.lang))
```

For dramatically better quality, swap to [ElevenLabs streaming](#11-out-of-scope-good-follow-ups).

## 5. Customizing the pitch packet

The pitch packet schema lives in [voice-pitch-agent/src/form-schema.js](voice-pitch-agent/src/form-schema.js). Adding a new section:

```js
{
  id: 'go_to_market',
  title: 'GTM',
  fields: [
    { id: 'acquisition_channel', label: 'Primary acquisition channel' },
    { id: 'cac', label: 'CAC', mono: true, required: false },
    { id: 'sales_motion', label: 'Sales motion' }
  ]
}
```

After editing `form-schema.js`, also:

1. Add the new section ID to the `enum` in `claude-client.js → TOOLS → update_field.input_schema.properties.section.enum`.
2. Add the new field IDs to the description of the `field` property in the same tool definition.
3. Add the new section + fields to the `PITCH PACKET FIELDS` block in `SYSTEM_PROMPT` so Aparna knows what to ask about.
4. (Optional) Add a `SECTION_PRESS` entry in `guidance-ui.js` for the "what Marc would press on next" sidebar.

The UI renders, completion math, and tool definition all derive from this one schema. Form-UI re-renders automatically on next state emit.

## 6. Refreshing the corpus

When you want fresh content from a source:

```bash
cd marc-agent

# Refresh just essays
python3 scrape_all.py --source essays

# Or all sources
python3 scrape_all.py --source all

# Then re-build the voice app's index
cd ../voice-pitch-agent
npm run build:index

# Restart the dev server to pick up the new index
# (Ctrl-C the running dev server, then:)
npm run dev
```

The scrapers skip files that already exist, so re-runs are cheap unless the source has new content. The blog scraper specifically de-duplicates by slug, so refreshing it only fetches articles added since the last run.

### Adding a new source type

If you want to add, say, "Marc's tweets" or "interview chapters from a specific book":

1. Create `marc-agent/scrapers/<source>.py` with a `run()` function that writes `.md` files to `marc-agent/data/<source>/`. Match the header format: `# title\n**Source:** url\n**Scraped:** YYYY-MM-DD\n---\n\nbody`.
2. Add `<source>` to `SOURCES` in `marc-agent/scrape_all.py` and `voice-pitch-agent/scripts/build-index.mjs`.
3. Re-run `build:index`. New chunks get embedded and added to the index.

## 7. Swap embedding provider

You don't have to use Voyage. Two clean alternatives:

### Local embeddings via `@xenova/transformers`

No API key, no network calls, ~80 MB model download on first run.

```bash
cd voice-pitch-agent
npm install @xenova/transformers
```

In `scripts/build-index.mjs` and `vite.config.js`, replace the `embedBatch` / `embedQuery` functions:

```js
import { pipeline } from '@xenova/transformers'

let extractor = null
async function getExtractor() {
  if (!extractor) {
    extractor = await pipeline('feature-extraction', 'Xenova/all-MiniLM-L6-v2')
  }
  return extractor
}

async function embedQuery(text) {
  const ext = await getExtractor()
  const output = await ext(text, { pooling: 'mean', normalize: true })
  return Array.from(output.data)
}
```

Quality is slightly lower than Voyage; latency is ~300ms per query instead of ~80ms. Vectors are 384-dim instead of 1024-dim. You'll need to re-run `build:index` after the swap so all chunks use the new model.

### OpenAI embeddings

Functionally similar to Voyage. Replace the Voyage URL with `https://api.openai.com/v1/embeddings`, model with `text-embedding-3-small`, header with `Authorization: Bearer ${OPENAI_API_KEY}`. 1536-dim by default.

## 8. Recording a demo

The voice app is designed to be screen-recorded.

### macOS — QuickTime + BlackHole

```bash
# One-time install
brew install --cask blackhole-2ch

# macOS Sound settings:
#   Output → "Multi-Output Device" (BlackHole + your speakers)
#   This lets you hear it AND record it

# QuickTime Player → File → New Screen Recording
#   Click the down-arrow next to record → Microphone: BlackHole 2ch
#   Record. Crop to the browser window.
```

Both your mic and Aparna's TTS end up on the recording.

### Browser tips

- **Use Chrome.** Web Speech recognition is best there. Safari works but has more frequent permission resets.
- **Wired headset or AirPods.** OS echo-cancellation prevents TTS from looping back into the recognizer.
- **Set Chrome's mic input to the headset, not the built-in mic**, in chrome://settings/content/microphone.

### Recommended demo arc (3–5 min)

1. Click **New pitch session**. Aparna introduces herself — "AI analyst who has studied Marc Andreessen…"
2. You: *"I'm building an AI tool for radiologists. Twelve hospital pilots running."*
3. Watch the pitch packet fill (`problem_statement`, `users_or_customers`).
4. Aparna asks about market timing or PMF. Click the **◆ N sources** badge to show the citation popover. The right rail's "Sources used" panel fills.
5. Ask a leading question: *"How big does this need to be for Marc to be interested?"* — should pull a market-size essay.
6. Optional: *"Actually, can I talk to a real partner?"* — handoff overlay plays through 5 stages.

## 9. Troubleshooting

### "API error 401: invalid x-api-key"

`.env` not loaded or `ANTHROPIC_API_KEY` is wrong. Re-check the file is at `voice-pitch-agent/.env`, has the key on its own line, and you've restarted the dev server.

### "Missing VOYAGE_API_KEY in environment" when running build:index

The npm script uses `node --env-file=.env`. If you're on Node < 20.6, `--env-file` isn't supported — either upgrade Node or run `dotenv` manually.

### Index loads but `/api/retrieve` returns empty

```bash
curl -s -X POST -H 'content-type: application/json' \
  -d '{"query":"product market fit","k":3}' \
  http://127.0.0.1:5173/api/retrieve
```

If you get `{"chunks":[]}`:

- Check Vite startup logs — did it print `[retrieve] index loaded: N chunks`?
- If `[retrieve] data/index.json not found`: you skipped step 5 of setup. Run `npm run build:index`.
- If `error: VOYAGE_API_KEY missing`: re-check `.env`.

### Mic permission denied / no STT

The page must be served from `127.0.0.1` (not a hostname), or via HTTPS. Vite defaults to `127.0.0.1:5173` for exactly this reason — don't override the `--host` flag.

Failing that, use the text input row at the bottom of the call panel. It produces identical user turns.

### Aparna's voice cuts out mid-sentence

This is a known Chrome bug with long-running `SpeechSynthesisUtterance`. The watchdog in `voice.js` calls `speechSynthesis.resume()` every 250ms; if it's still happening, the utterance might exceed the failsafe timeout. Shorten the system prompt's "two sentence max" rule wording — make replies shorter.

### Citations not appearing on Aparna's bubbles

Two things to check:

1. Did `/api/retrieve` actually return docs? Open DevTools → Network → look for the `/api/retrieve` POST. If `chunks: []`, the retrieval failed silently.
2. Did Claude actually quote one of the docs? Citations only fire when Claude's text overlaps a passage from a document block. If she's answering from memory rather than the docs, the badge won't appear. This is correct behavior — better to omit a citation than to fake one.

### Form not filling despite Aparna saying she captured it

Open DevTools → look for `[claude] streaming started` and follow the events. If you see `tool_use` blocks but `setField` isn't firing, check that the `section` value matches one of the enum values in `claude-client.js → TOOLS`. Schema changes that don't propagate to the tool definition cause silent drops.

### "Could not retrieve a transcript" errors during YouTube scrape

YouTube periodically deprecates videos or disables transcripts. The errors are logged to `marc-agent/data/youtube/fetch-errors.log` and the scraper continues with the rest. Find a replacement video ID and add it to `KNOWN_VIDEOS` in `scrapers/youtube_transcripts.py`.

### pmarca.com unreachable

`pmarca.com`'s SSL cert is broken (the domain is effectively dead). The scraper falls back to `pmarchive.com` automatically. If both are down, it tries the Wayback Machine. Errors here are expected and informational.

## 10. Corpus and attribution

The scraped content remains the intellectual property of its original authors and publishers:

- a16z essays and podcasts — © Andreessen Horowitz
- pmarca/pmarchive blog posts — © Marc Andreessen
- Podcast transcripts (Lex Fridman, Tim Ferriss, etc.) — © respective shows
- YouTube transcripts — © respective uploaders

The local copy in `marc-agent/data/` is intended for personal use, demoing, and as a knowledge base for this project's AI agent. Don't republish the corpus, train models on it commercially, or distribute it broadly without permission from the rights-holders. The citation popups in the voice app — which show source URLs prominently — are deliberately designed to make attribution unambiguous.

Each scraped file preserves the original source URL in its header, so any quote that surfaces in the UI is traceable back to its publisher.

## 11. Out of scope / good follow-ups

These are intentionally not built. They're the natural next steps if this graduates from demo to product.

### Quality

- **ElevenLabs streaming TTS** — Web Speech sounds robotic. ElevenLabs would dramatically improve perceived quality.
- **Hybrid retrieval** — add BM25 as a second signal, re-rank with a small cross-encoder. Top-K by pure embedding cosine misses named entities and codes.
- **Per-section retrieval boosts** — when filling the `market` section, weight market-related essays more heavily.

### Production-readiness

- **Real backend** — currently the Anthropic key lives in the Vite dev server's environment. For deploy, you need a real backend hosting `/api/anthropic` and `/api/retrieve`.
- **Twilio Voice integration** — turn this into a real phone-call agent instead of a browser app.
- **Pitch packet export** — JSON / PDF / Slack handoff so the packet leaves the browser.
- **Session persistence** — save calls to disk or a DB so they survive a refresh.
- **Auth** — none currently. Anyone with the URL can use the proxied Anthropic key.

### Operational

- **Live corpus reload** — currently you re-run `build:index` + restart Vite. Watch `data/index.json` for changes and reload without restart.
- **Scheduled scraper refresh** — cron the `scrape_all.py --source all` + `build:index` chain weekly.
- **Telemetry** — no observability today. For real use you'd want at minimum: per-turn latency, citation hit rate, tool-call success rate.

### Knowledge layer

- **More sources** — Twitter (X) archive, interview chapters from books, conference talks not on YouTube.
- **Update detection** — when a new essay appears on a16z, detect and add it automatically.
- **Source weighting** — essays should outweigh podcast transcripts; the current retrieval treats them equally.

None of these are necessary for the demo to be impressive. They're listed here so you know what's intentionally not done.
