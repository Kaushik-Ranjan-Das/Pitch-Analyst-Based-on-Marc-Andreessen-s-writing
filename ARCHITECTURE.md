# Architecture

How the two projects in this repo fit together, and what happens on a single pitch turn from microphone to citation popup.

## 1. System overview

```
                  ┌────────────────────────────────────────────────────┐
                  │                                                    │
                  │           marc-agent/  (knowledge layer)           │
                  │                                                    │
                  │   ┌────────────────┐      ┌────────────────────┐   │
                  │   │   scrapers/    │─────>│   data/*.md (135   │   │
                  │   │ essays, blog,  │      │   files, ~3.8 MB)  │   │
                  │   │ pmarca, yt,    │      └─────────┬──────────┘   │
                  │   │ podcasts       │                │              │
                  │   └────────────────┘                │              │
                  │                                     │              │
                  │   ┌─────────────────────────────────┴────────┐     │
                  │   │ .claude/agents/marc-andreessen-advisor   │     │
                  │   │  (text-based subagent for Claude Code)   │     │
                  │   └──────────────────────────────────────────┘     │
                  └──────────────────────────────────┬─────────────────┘
                                                     │
                                                     │ reads at index-build time
                                                     │
                  ┌──────────────────────────────────▼──────────────────┐
                  │                                                     │
                  │       voice-pitch-agent/  (interaction layer)       │
                  │                                                     │
                  │   ┌────────────────────────────────────────────┐    │
                  │   │ scripts/build-index.mjs                    │    │
                  │   │   reads ../marc-agent/data/                │    │
                  │   │   chunks + embeds via Voyage AI            │    │
                  │   │   writes data/index.json                   │    │
                  │   └────────────────────────────────────────────┘    │
                  │                                                     │
                  │   ┌────────────────────────────────────────────┐    │
                  │   │ vite.config.js                             │    │
                  │   │   loads data/index.json into memory once   │    │
                  │   │   exposes POST /api/retrieve  (cosine)     │    │
                  │   │   proxies /api/anthropic -> api.anthropic  │    │
                  │   └─────┬──────────────────────────┬───────────┘    │
                  │         │                          │                │
                  │   ┌─────▼──────────┐         ┌─────▼─────────┐      │
                  │   │ Browser (Vite) │<───────>│ Claude API    │      │
                  │   │  Web Speech    │  SSE    │ Sonnet 4.6    │      │
                  │   │  STT / TTS     │ stream  │ + Citations   │      │
                  │   └────────────────┘         └───────────────┘      │
                  └─────────────────────────────────────────────────────┘
```

Two distinct flows touch the corpus:

- **Build-time flow** — once per corpus refresh. `scripts/build-index.mjs` reads every markdown file under `marc-agent/data/`, chunks each one, calls Voyage AI to get embeddings, and writes `voice-pitch-agent/data/index.json`. Takes ~30–60 seconds.
- **Runtime flow** — every pitch turn. The browser sends the founder's utterance to `/api/retrieve`, which embeds the query (one Voyage call) and returns top-K chunks. Those chunks become Anthropic `document` blocks in the Claude call. Claude streams back text + citation annotations.

## 2. The corpus (marc-agent)

### 2.1 What's collected

| Folder | Source | Count | Size |
|---|---|---|---|
| `data/essays/` | Curated list of Marc's published essays (a16z, archives) | 10 | 188 KB |
| `data/blog/` | a16z author page (`/author/marc-andreessen/`) — paginated, filtered for Marc-attributed posts | 33 | 445 KB |
| `data/pmarca/` | The pmarca/pmarchive archive (Marc's 2007–2008 blog) | 34 | 425 KB |
| `data/youtube/` | YouTube interview transcripts (Lex Fridman, Joe Rogan, a16z, etc.) via `youtube-transcript-api` + `yt-dlp` search | 20 | 2.7 MB |
| `data/podcasts/` | a16z, Lex Fridman, Tim Ferriss feeds — matching episodes by title; YouTube transcripts when available, show notes as fallback | 38 | 116 KB |

Every scraped file has the same header shape, which the index builder relies on:

```markdown
# <title>
**Source:** <url>
**Scraped:** YYYY-MM-DD
---

<body>
```

### 2.2 Scraper design notes

Each source has its own scraper in `marc-agent/scrapers/`. The shared patterns:

- **Standardized markdown output**: `html2text` with `body_width=0` (no wrapping) and `ignore_links=False` (links preserved).
- **Error logs per source**: each scraper writes a `fetch-errors.log` into its own data folder. The orchestrator (`scrape_all.py`) counts error log lines per source in the final summary.
- **Skip-if-exists**: re-running a scraper doesn't re-fetch what's already saved. The blog scraper de-dupes by slug, the YouTube scraper by video ID, the pmarca scraper by URL.
- **Rate-limiting**: sleep 1–1.5 seconds between fetches for HTTP scrapers. RSS feeds are parsed once each.
- **Fallback chains**: pmarca scraper tries `pmarca.com` first, falls back to `pmarchive.com`, then to the Wayback Machine. Podcasts try YouTube transcript first, fall back to show notes if no transcript.

### 2.3 The text subagent

[`marc-agent/.claude/agents/marc-andreessen-advisor.md`](marc-agent/.claude/agents/marc-andreessen-advisor.md) is a Claude Code subagent. It exists for the case where a developer is in a coding session and wants to ask "what would Marc say about this design decision" without leaving the terminal. It uses `Read`, `Glob`, `Grep`, `Bash` to search the same `data/` folder the voice app indexes. No embeddings — it just greps semantically using Claude's own pattern-matching, which is fine for interactive use.

The voice app's `SYSTEM_PROMPT` mirrors this subagent's framework list verbatim so the two stay coherent. If you update Marc's core frameworks in one, update the other.

## 3. The voice app (voice-pitch-agent)

### 3.1 Module map

```
voice-pitch-agent/src/
├── main.js                   Entry. Wires UI + voice IO + Claude streaming.
├── claude-client.js          System prompt, tool defs, SSE parser, citations handling.
├── retrieval.js              Browser fetch() wrapper for POST /api/retrieve.
├── voice.js                  Web Speech STT + SpeechSynthesis TTS + sentence buffering.
├── state.js                  Pub-sub store. Single source of truth for UI.
├── form-schema.js            Pitch packet sections + fields. Drives form, tool, and completion math.
├── form-ui.js                Renders the pitch packet panel. Subscribes to state.
├── transcript-ui.js          Renders transcript bubbles. Mounts citation badges.
├── citations-ui.js           Citation popover + persistent "Sources used" sidebar.
├── guidance-ui.js            Section dots, completion ring, "what Marc would press on next".
├── kpi-band.js               Top metrics band (session timer, completion, etc.).
├── escalate-to-partner.js    Handoff overlay (5 simulated stages).
└── styles.css                Design tokens at top, citation styles at bottom.
```

### 3.2 Single source of truth: `form-schema.js`

```js
export const SECTIONS = [
  { id: 'problem',    title: 'Problem',    fields: [...] },
  { id: 'solution',   title: 'Solution',   fields: [...] },
  { id: 'market',     title: 'Market',     fields: [...] },
  { id: 'traction',   title: 'Traction',   fields: [...] },
  { id: 'team',       title: 'Team',       fields: [...] },
  { id: 'ask',        title: 'Ask',        fields: [...] }
]
```

This one file drives:

- The packet panel layout (`form-ui.js` iterates `SECTIONS`).
- The completion ring + per-section progress dots (`guidance-ui.js` → `computeCompletion`, `sectionCompletion`).
- Claude's `update_field` tool description (`claude-client.js` enums the section IDs and lists field IDs).
- The system prompt's "PITCH PACKET FIELDS" section (currently hand-mirrored — keep in sync if you add fields).

Changing pitch packet shape = editing one file + one section of the system prompt. Everything else propagates.

### 3.3 State store

`src/state.js` is a hand-rolled pub-sub. The whole app is < 200 lines of state code. Every UI module calls `subscribe(state => render(state))` once at mount; state mutations call `emit()` which fan out to every subscriber.

Notable slices added for the pitch use case:

```js
state.citations = []                  // Flat list across the session
state.bubbleCitations = { [bubbleId]: [citation, ...] }  // Per-message
state.handoff = null                  // { reason, stage, fillPct, complete } when escalated
```

Why no Redux/Zustand/etc.? The state surface is tiny and the subscribers don't need selective re-rendering. Adding a state library would be larger than the store itself.

### 3.4 Voice loop

```
┌──────────┐  ondata  ┌──────────────┐  onfinal  ┌────────────────────┐
│   mic    │ ───────> │ Web Speech   │ ────────> │ handleFounderFinal │
└──────────┘          │ recognition  │           │ (debounce 600ms)   │
                      └──────────────┘           └─────────┬──────────┘
                                                           │
                                                           ▼
                                                  ┌────────────────┐
                                                  │ sendToClaude() │
                                                  │  retrieve docs │
                                                  │  POST messages │
                                                  └────────┬───────┘
                                                           │ SSE stream
                                                           ▼
                                                  ┌────────────────┐
                                                  │ onTextDelta:   │
                                                  │  - update      │
                                                  │    transcript  │
                                                  │  - push to     │
                                                  │    sentence    │
                                                  │    speaker     │
                                                  └────────┬───────┘
                                                           │ per sentence
                                                           ▼
                                                  ┌────────────────┐
                                                  │ SpeechSynthesis│
                                                  │ pauses mic     │
                                                  │ while speaking │
                                                  └────────────────┘
```

The mic-pauses-during-TTS guard in `voice.js` is the single non-obvious bit. Without it, Chrome/Safari pick up Aparna's own voice through the speakers and feed it back into the recognizer as new "founder" input. With it, the recognizer stops for the duration of every TTS utterance and resumes 200ms after the queue drains.

### 3.5 RAG pipeline

#### Build phase (`scripts/build-index.mjs`)

1. Walk `../marc-agent/data/{essays,blog,pmarca,youtube,podcasts}/*.md`.
2. For each file, strip the `# title / **Source:** / ---` header and capture `title`, `source_url`, `slug`, `source_folder`.
3. **Chunk by paragraph** with a sliding window:
   - Target ~2400 chars (~600 tokens at ~4 chars/token).
   - Overlap ~400 chars (~100 tokens) between consecutive chunks for continuity.
   - Any single paragraph over `1.5 × TARGET_CHARS` gets hard-split.
4. **Embed in batches of 128** via Voyage AI `voyage-3.5-lite` (`input_type: "document"`).
5. Write `data/index.json` as a flat array of `{ doc_id, title, source_url, source_path, slug, source_folder, chunk_index, text, embedding }`.

Why chunk at ~600 tokens? Two pressures:

- **Big enough to carry context** — paragraph-aware so Marc's argument structure survives.
- **Small enough that 6 chunks fit in Claude's prompt** alongside the system prompt and conversation history without truncation.

#### Runtime retrieval (`vite.config.js` middleware)

1. Vite dev server boots. Reads `data/index.json` once (~50 MB → ~2k chunks → ~1.5s parse time). Holds the array in memory.
2. Browser POSTs `{ query, k }` to `/api/retrieve`.
3. Middleware calls Voyage AI with `input_type: "query"` (one embedding, one HTTP round-trip).
4. **Cosine similarity** against every chunk's stored embedding. Pure in-memory math, ~3ms for 2k vectors of dim 1024.
5. Returns top-K with `{ doc_id, title, text, source_path, source_url, slug, source_folder, score }`.

No vector DB. The math is trivial at this scale and would only become a concern past ~100k chunks.

#### Why Voyage, not OpenAI / local

- **Voyage is Anthropic's recommended partner** for use with Claude — the design intent is that document-block citations work well against Voyage embeddings.
- **Free tier** covers this project comfortably (200K tokens/min, 50M/month).
- **Local (`@xenova/transformers`) is a viable swap** if you don't want an account. ~80MB model download, no API calls, slightly worse quality, ~3× slower per query. See [DOCUMENTATION.md → Swap embedding provider](DOCUMENTATION.md#swap-embedding-provider).

### 3.6 The citations API

Anthropic's [Citations API](https://docs.anthropic.com/en/docs/build-with-claude/citations) does the heavy lifting. We don't build our own citation protocol — we just enable theirs.

**On request**, retrieved chunks are passed as `document` blocks inside the `system` array:

```js
system: [
  { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } },
  ...retrievedDocs.map((doc, i) => ({
    type: 'document',
    source: { type: 'text', media_type: 'text/plain', data: doc.text },
    title: doc.title,
    context: doc.source_url ? `Source URL: ${doc.source_url}` : undefined,
    citations: { enabled: true }      // <— the magic flag
  }))
]
```

**On response**, every text block can be accompanied by a `citations` array. In streaming mode these arrive as `citations_delta` events:

```jsonc
{
  "type": "content_block_delta",
  "index": 0,
  "delta": {
    "type": "citations_delta",
    "citation": {
      "document_index": 2,
      "document_title": "why_software_is_eating_the_world",
      "cited_text": "More and more major businesses and industries are being run on software...",
      "start_char_index": 412,
      "end_char_index": 478
    }
  }
}
```

`claude-client.js` catches these, resolves `document_index` back into the retrieval result for full metadata (source URL, source path), and fires `onCitation(resolved)`. `main.js` attaches the citation to the current assistant bubble via `attachCitationsToBubble(bubbleId, [cite])`. `transcript-ui.js` flips on the "◆ N sources" badge; `citations-ui.js` renders the popover on click.

**Important constraint**: Anthropic does not accept citation annotations back on subsequent turns. When we reconstruct the assistant message for the next conversation turn, we strip citation metadata and store it separately in `state.bubbleCitations`. The conversation history sent to the API is plain `{type: 'text', text: '...'}` blocks; the citations stay client-side.

### 3.7 Tool calls

Two tools, both browser-side handlers in `main.js` → `handleToolCall`:

```
update_field { section, field, value }    → state.setField(section, field, value)
escalate_to_partner { reason }            → startEscalation(reason)
```

Tool-use turns work the standard way:

1. Claude emits `content_block_start` with type `tool_use`, then streams JSON via `input_json_delta`.
2. At `content_block_stop`, we parse the accumulated JSON and call `onToolUse`.
3. At `message_stop`, if there were any tool_use blocks, we synthesize `tool_result` user messages and recursively call `sendToClaude()` so Claude can finish its turn after the tool runs.

The system prompt instructs Aparna to call `update_field` multiple times in one turn whenever the founder volunteers multiple facts. Multiple `tool_use` blocks per assistant message is supported.

## 4. Sequence: one pitch turn from start to finish

Founder says: *"We're building a tool for radiologists. We have twelve hospital pilots running right now."*

```
T+0ms    main.js                 onFinal("We're building a tool for radiologists...")
T+0ms    main.js                 currentInterimBubbleId finalized as "founder" bubble
T+600ms  main.js                 debounce window closes; handleUserUtterance fires
T+600ms  state.js                appendConversation({role:'user', content:'<utterance>'})
T+600ms  claude-client.js        streamClaude() called with retrievalQuery=<utterance>
T+602ms  retrieval.js            POST /api/retrieve { query: '<utterance>', k: 6 }
T+605ms  vite.config.js          /api/retrieve: voyage.embed(query) -> 1024-d vector
T+685ms  vite.config.js          cosine vs ~2000 chunks; top-6 returned in ~3ms
T+685ms  claude-client.js        builds system: [text, document×6]; tools: [...]
T+688ms  /api/anthropic          forwards to api.anthropic.com with x-api-key header
T+1100ms api.anthropic.com       starts streaming SSE events back
T+1100ms claude-client.js        content_block_start (text)
T+1110ms claude-client.js        content_block_delta (text_delta "Two") -> sentenceSpeaker.push
T+1120ms claude-client.js        content_block_delta (text_delta " questions") -> ...
...
T+1400ms claude-client.js        content_block_delta (citations_delta { document_index: 2, ... })
T+1400ms main.js                 attachCitationsToBubble(bubbleId, [cite])
T+1400ms transcript-ui.js        badge becomes visible: "◆ 1 source"
...
T+1800ms claude-client.js        content_block_start (tool_use: update_field)
T+1810ms claude-client.js        input_json_delta '{"section":"problem","field":...'
T+1830ms claude-client.js        content_block_stop -> onToolUse -> setField('problem', 'problem_statement', '...')
T+1830ms form-ui.js              "Missing" cell flips to "just-filled" → "filled" (green flash)
T+2200ms claude-client.js        message_stop; assistant message persisted to conversation
T+2210ms voice.js                drainSpeakQueue() finishes last sentence; mic resumes
T+2400ms voice.js                recognition.start() listening again

(if tools were called) →
T+2300ms main.js                 synthesize tool_result user message, recurse sendToClaude
```

Total perceived latency from end-of-speech to first audible word from Aparna: ~1.5 seconds on a warm cache, dominated by Claude's time-to-first-token. The retrieval round-trip adds < 100ms.

## 5. Failure modes and how they're handled

| Failure | Where it surfaces | Handling |
|---|---|---|
| `data/index.json` missing at boot | Vite startup | Log warning, `/api/retrieve` returns `{chunks: []}`. App still works without citations. |
| `VOYAGE_API_KEY` missing | `/api/retrieve` | Returns 500; `retrieval.js` catches and returns `[]`; Claude turn proceeds without docs. |
| `ANTHROPIC_API_KEY` missing | First Claude call | `onError` fires, setup overlay (`[data-setup]`) is shown on page load. |
| Voyage rate limit | Index build or retrieval | Index build aborts with the upstream error. Retrieval errors degrade to "no docs this turn". |
| Anthropic stream truncation | Mid-response | The current bubble stays in `partial` state; `inFlightAbort.abort()` clears it on next user input. |
| Tool input JSON malformed | `content_block_stop` | Logs warning, calls `onToolUse` with empty input — tool handler ignores empty payloads. |
| Mic permission denied | Call start | Falls back to text input. Text input is always available even when STT works. |
| TTS never fires `onend` | Chrome bug, ~12s+ utterances | Watchdog `setInterval` in `voice.js` calls `speechSynthesis.resume()` every 250ms. Timeout failsafe advances the queue after `expectedMs`. |
| STT picks up TTS audio | Browser-level loopback | `pauseRecognitionForTTS()` stops the recognizer for the duration of every TTS utterance. |

## 6. Performance characteristics

- **Index size**: ~2,000 chunks × 1024-dim floats = ~16 MB raw, ~50 MB JSON-stringified. Loaded once at server boot.
- **Cosine query**: ~3ms for 2k vectors. Sub-1ms for top-K selection.
- **Voyage query embedding**: ~80ms (one HTTP round-trip).
- **Anthropic time-to-first-token**: 400–800ms with 6 documents attached. Streaming after that is fast.
- **Voice loop debounce**: 600ms after the last `final` result from Web Speech. This is the dominant tunable latency parameter.

Total pitch-turn latency from end-of-speech to start-of-Aparna-speech: ~1.2–1.7s in normal conditions.

## 7. Where the system would have to grow

The current architecture starts to strain at:

- **>~10k chunks** — in-memory cosine becomes noticeable (~50ms+). Switch to FAISS, ScaNN, or a real vector DB.
- **Multiple concurrent users** — the Vite middleware is single-process. Move retrieval to a dedicated service.
- **Real PSTN voice** — Web Speech is browser-only. Wire to Twilio Voice, switch TTS to ElevenLabs streaming.
- **Hot-reload of the corpus** — currently you re-run `build:index` and restart Vite. For live updates, watch `data/index.json` and reload on change.
- **Re-ranking** — top-K by pure cosine misses cases where lexical match matters (named entities, codes). A small cross-encoder rerank over top-30 would meaningfully improve quality.

None of these are necessary for a demo. They're the natural next steps if this graduates to a product.
