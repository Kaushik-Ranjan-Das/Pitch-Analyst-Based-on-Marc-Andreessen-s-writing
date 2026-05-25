# voice-pitch-agent — agent context

## What this project is

A live voice pitch demo. Single-page Vite app. The AI agent (Aparna) talks to a founder over Web Speech APIs, fills a structured pitch packet via Claude tool calls, and grounds every substantive claim in a citation from Marc Andreessen's published writing (corpus lives in [`../marc-agent/data/`](../marc-agent/data/), indexed into [data/index.json](data/index.json) by [scripts/build-index.mjs](scripts/build-index.mjs)).

This is a **demo artifact**, not a production app. It's meant to be screen-recorded to show what a Marc-grounded pitch intake could look like.

## Stack

- **Vite** for dev server + HMR. Proxies `/api/anthropic/*` to `https://api.anthropic.com` and injects `x-api-key` server-side so the key never reaches the browser bundle. Also serves `/api/retrieve` middleware (in-memory cosine similarity over the embedding index).
- **Vanilla JS** modules. No React, no state library, no TS. The dashboard is small enough that a framework would be cargo-culting.
- **Claude Sonnet 4.6** via `/v1/messages` with streaming + tool use + native [Citations API](https://docs.anthropic.com/en/docs/build-with-claude/citations).
- **Voyage AI `voyage-3.5-lite`** (1024-dim) for embeddings — batched at index time, single-query at runtime.
- **Web Speech API** for STT, **SpeechSynthesis API** for TTS. Both browser-native.

## Architecture in 30 seconds

The whole app is one event loop:

1. User clicks **New pitch session** → `startCall()` in [src/main.js](src/main.js)
2. Mic opens via `startListening()` ([src/voice.js](src/voice.js))
3. Synthetic `[SESSION_START]` user message kicks off the conversation ([src/claude-client.js](src/claude-client.js))
4. For every turn after the intro: retrieval fires against the Marc corpus, top-k chunks attach as `document` blocks on the user message, Claude streams text + `citations_delta` events anchored to those chunks
5. Streaming events:
   - `text_delta` → transcript bubble + `createSentenceSpeaker().push()` → batched TTS
   - `citations_delta` → `attachCitationsToBubble()` → citations panel + Marc Says bibliography
   - `tool_use` `update_field` → `setField()` in [src/state.js](src/state.js) → pitch packet re-renders
   - `tool_use` `escalate_to_partner` → `startHandoff()` in [src/escalate-to-partner.js](src/escalate-to-partner.js)
6. Founder speaks → Web Speech `onresult` → debounce → `appendConversation()` → `sendToClaude()`

## Where things live

- [src/main.js](src/main.js) — entry, call control, mic↔TTS arbitration
- [src/claude-client.js](src/claude-client.js) — system prompt, tool definitions, SSE parser, Citations API wiring
- [src/retrieval.js](src/retrieval.js) — thin client over the Vite `/api/retrieve` middleware
- [src/voice.js](src/voice.js) — STT + TTS + sentence-batched speech (see LESSONS.md for the choppy-voice fix)
- [src/state.js](src/state.js) — pub-sub state store, ~160 lines
- [src/form-schema.js](src/form-schema.js) — pitch packet sections × fields. **Single source of truth.**
- [src/citations-ui.js](src/citations-ui.js) — citation popover, sources panel, live toast ticker
- [src/guidance-ui.js](src/guidance-ui.js) — "Marc Says" sidebar including the cited-sources bibliography
- [src/form-ui.js](src/form-ui.js), [src/transcript-ui.js](src/transcript-ui.js), [src/kpi-band.js](src/kpi-band.js) — other DOM renderers, all subscribe to state
- [src/escalate-to-partner.js](src/escalate-to-partner.js) — handoff overlay state machine
- [scripts/build-index.mjs](scripts/build-index.mjs) — one-time embedding builder over `../marc-agent/data/`
- [vite.config.js](vite.config.js) — dev server config, `/api/anthropic` proxy, `/api/retrieve` middleware
- [index.html](index.html) — markup (header + 3 panels + 2 overlays)
- [src/styles.css](src/styles.css) — all styling. Design tokens at the top of the file.

## Tone for future contributors

- This is a demo. No legacy patterns to preserve; the codebase is intentionally small.
- Don't add abstractions until they pay off twice.
- Pitch packet schema, tool definitions, and rendering all derive from [src/form-schema.js](src/form-schema.js) — change there, propagate everywhere.
- Don't add a framework "for scale". If you want to ship a real product, that's a different conversation and it gets a backend, auth, persistence, and ElevenLabs streaming TTS at the same time.
