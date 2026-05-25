# Technical lessons from Mark's Counsel

Notes from actually building and shipping this. Three areas where the obvious approach is wrong and the right approach takes a couple of iterations to find.

---

## 1. Choppy AI voice — what's actually happening and how to fix it

### The symptom

The AI's voice sounds stuttering, broken into tiny clips, hard to follow. It's especially bad when the model is streaming long replies token-by-token from a language model.

### The two compounding bugs

**Bug A: Sentence-per-utterance is the wrong granularity.** The browser's `SpeechSynthesis.speak()` API plays one `SpeechSynthesisUtterance` at a time and inserts ~100–300ms of silence between utterances. That gap is hard-coded in the OS audio subsystem — you cannot eliminate it from JavaScript. So if your code does this (a common pattern):

```js
// WRONG — every sentence becomes a separate utterance
onSentenceComplete: (sentence) => {
  speechSynthesis.speak(new SpeechSynthesisUtterance(sentence))
}
```

…a four-sentence reply produces four utterances and three audible gaps. The reply *sounds* broken even though the synthesis itself is fine.

**Bug B: A naive splitter shreds normal speech.** Splitting on `.` followed by whitespace treats *every* period as a sentence boundary:

- "Mr. Andreessen" → split into two utterances
- "U.S. market" → split
- "1.5x growth" → split (period between digits)
- "Hmm…" (ellipsis) → split three times
- "We launched. then iterated" (lowercase after period) → split, even though it's clearly one sentence with a typo

Each false split multiplies Bug A.

### The fix (browser-only, no third-party TTS)

In [voice-pitch-agent/src/voice.js](voice-pitch-agent/src/voice.js):

1. **Better splitter** — only treat `.` as a sentence terminator when none of these apply:
   - Preceded by a known abbreviation (`Mr`, `Dr`, `U.S`, `e.g`, `vs`, etc.)
   - Between two digits (decimals)
   - Part of an ellipsis
   - Followed by a lowercase letter
2. **Batch sentences into ~140-character utterances** before calling `speak()`. Short sentences ride along with the next one. This collapses 3–6 utterances per reply into 1–2.
3. **Prefer cloud-backed voices** — `localService === false` on Chrome (the Google voices) or `(Premium)`/`(Enhanced)` voices on macOS have far smoother prosody than basic local voices.
4. **Drop the rate from 1.05 to 1.0** — local voices garble above 1.0; premium voices handle it but 1.0 reads as natural either way.
5. **Keep the resume watchdog** — Chrome has a long-standing bug where `SpeechSynthesis` pauses itself after ~15s of audio. Polling `resume()` every 250ms while speaking fixes it.

### The bigger lesson

Browser `SpeechSynthesis` is **fundamentally a one-utterance-at-a-time API with no crossfade**. You can make it sound much better with batching and a smart splitter, but for production-quality voice (a real call, not a demo) you want streaming TTS from a service like ElevenLabs — they synthesize one continuous audio stream with proper prosody across sentence boundaries. That's not a bug in your code; it's a property of the platform.

---

## 2. Why RAG (Retrieval-Augmented Generation) is needed — and what it actually buys you

### The naive approach and why it fails

You might think: "Marc Andreessen has a public corpus. Why not just dump it into the system prompt and let Claude reference it?" Three reasons that doesn't work:

1. **Context windows are bounded.** Marc's published corpus is ~3.8 MB of clean markdown. That's millions of tokens. Even Claude's 1M-token context is well under that, and you'd pay for the full input every turn.
2. **The model can't be trusted to quote verbatim.** Even when the source text is in context, LLMs paraphrase, mis-attribute, and fabricate detail. They "remember" the gist, not the exact words.
3. **No verifiable provenance.** A paraphrase is unfalsifiable. "Marc says timing beats idea quality" — did he? In which essay? An investor watching the demo can't audit a claim without a source link.

### What RAG actually fixes

RAG isn't just "more context." It's the substrate that makes citations possible. The flow:

```
founder utterance → embed query → cosine similarity over chunk index →
top-K chunks → attach as `document` blocks on the user message →
Claude streams reply + emits `citations_delta` events anchored to
character spans in those documents
```

The critical piece is Anthropic's native **Citations API** ([docs](https://docs.anthropic.com/en/docs/build-with-claude/citations)). When you attach a content block like:

```js
{
  type: 'document',
  source: { type: 'text', media_type: 'text/plain', data: chunk.text },
  title: chunk.title,
  citations: { enabled: true }   // ← this is the magic flag
}
```

…Claude can only emit a citation that points to a real character span inside that document. The model **physically cannot fabricate a citation** — the citation API rejects anchors that don't match. Quoting accuracy goes from "trust the model" to "guaranteed by the protocol."

### Why retrieval matters as much as the citation API

Citations only fire when the model chooses to ground its text in an attached document. If no relevant document is attached, the model speaks freely without grounding (and the Citations API has nothing to anchor to). So:

- **Retrieval recall is the ceiling on citation rate.** If the embedding search misses the relevant chunk, no citation fires no matter how strong your system prompt is.
- **Retrieval query design matters.** Sending the founder's raw last utterance ("engineers") as the embedding query returns garbage. Blending the last few turns plus a fixed string of framework keywords ("market timing PMF urgency why-now incumbents…") dramatically improves recall.
- **k matters.** k=6 chunks gave the model too narrow a buffer; k=12 produced citations on essentially every substantive reply.

### The bigger lesson

RAG is two things in one: a way to fit a large corpus into a finite context window, *and* the only way to deliver verifiable, source-anchored claims. If you're building anything where "where did that fact come from?" is a question the user might ask, you need RAG. The Citations API turns it from a stylistic convention into a protocol guarantee.

---

## 3. Building a corpus from public information

### The pipeline

This project's corpus is 135 markdown files (~3.8 MB) covering Marc Andreessen's essays, blog posts, pmarca archive, podcast transcripts, and YouTube interview transcripts. The architecture is deliberately boring:

```
scrapers/  →  data/*.md  →  build-index.mjs  →  data/index.json
(HTML)        (markdown)    (chunks + embeddings)
```

Per-source tooling in [marc-agent/scrapers/](marc-agent/scrapers/):

| Source type | Tool | Why |
|---|---|---|
| Essays / blog HTML | `requests` + `beautifulsoup4` + `html2text` | Standard web scrape; html2text gives clean markdown |
| RSS / Atom feeds | `feedparser` | Finds new posts without scraping the index page |
| Podcast transcripts | site-specific scrapers | Each platform has its own DOM; no universal API |
| YouTube transcripts | `youtube-transcript-api` (primary), `yt-dlp` (fallback) | First is free + fast; second handles videos where auto-captions are off |

### What makes a corpus *useful* (not just *big*)

A few non-obvious things:

1. **Consistent header format on every file.** Every scraped file starts with:
   ```
   # Title
   **Source:** https://original.url
   **Scraped:** 2026-05-22
   ---
   
   body...
   ```
   This means the chunker can pull title + source URL into every chunk's metadata, and the UI can link each citation back to the original. Without consistent headers, you can't show "open original ↗" links and the demo loses half its credibility.

2. **Markdown, not HTML or PDF.** Markdown chunks predictably along paragraph boundaries (`\n\s*\n`). HTML chunks badly because tag boundaries don't match semantic boundaries. PDFs are a nightmare — column layouts, headers, footers, embedded images.

3. **Sliding-window chunking with overlap.** Each chunk is ~2,400 characters (~600 tokens) with ~400 characters (~100 tokens) of overlap with the previous chunk. The overlap matters: if a citation-worthy quote spans a chunk boundary, it still appears intact in *one* of the chunks. See [voice-pitch-agent/scripts/build-index.mjs:80-113](voice-pitch-agent/scripts/build-index.mjs#L80-L113):
   ```js
   function chunkBody(body) {
     const paragraphs = body.split(/\n\s*\n/).map(p => p.trim()).filter(Boolean)
     // ... merge paragraphs until TARGET_CHARS, then emit chunk
     // ... carry last OVERLAP_CHARS into the next chunk
   }
   ```

4. **Embedding model choice.** Voyage AI's `voyage-3.5-lite` (1024-dim) is the sweet spot for English text retrieval: cheap, fast, accurate. OpenAI's `text-embedding-3-small` works too. Don't overthink this — pick a model with native domain quality and stick with it.

5. **In-memory cosine similarity is fine.** For ~2,000 chunks at 1024 dimensions, the full similarity computation is ~3ms per query in pure JavaScript. You don't need a vector database. We did this in [voice-pitch-agent/vite.config.js](voice-pitch-agent/vite.config.js)'s `/api/retrieve` middleware — the entire retrieval layer is one function. Vector databases are necessary at ~100k+ chunks, not 2k.

### What can go wrong

A few things we hit:

- **Rate limits during indexing.** Voyage's free tier is 3 requests/min and 10K tokens/min. A 2,000-chunk full build took 50+ minutes and eventually got rate-limited *past* its retry budget. Either add a payment method (standard rates burst at batch=128 with no throttle — full build in 30 seconds) or write incremental save-and-resume into your build script.

- **Partial corpora silently look complete.** Our first build wrote 48 chunks from 5 essays and reported "build complete" — the script didn't realize 95% of the corpus had failed to embed. **Always print per-source chunk counts at the end**, not just the global total. We added [a verification step](voice-pitch-agent/scripts/build-index.mjs#L175) that fails loudly when a source folder produces zero chunks.

- **macOS quarantine on `node_modules`.** When you copy a project from a Downloads folder, macOS quarantines the binaries inside `node_modules/.bin`. `npm run dev` then dies with `sh: vite: command not found` even though vite is right there. Fix: `xattr -dr com.apple.quarantine node_modules` and reinstall, or just `rm -rf node_modules && npm install` from a non-quarantined location.

### The bigger lesson

Corpus quality is the bottleneck on RAG quality, not retrieval sophistication. A 2,000-chunk well-cleaned corpus retrieved with cosine similarity beats a 200,000-chunk noisy corpus retrieved with a $5K/mo vector DB. Time spent on consistent metadata, header parsing, and paragraph-aware chunking pays back orders of magnitude more than time spent on fancy retrieval algorithms.

---

## 4. Bonus: how to know your system prompt is working

A subtle one we hit. The system prompt said:

> Every substantive claim you make about what Marc thinks must be grounded in one of the source documents provided in this turn.

…and Aparna emitted *zero* citations across a 10-turn conversation. Two things were going wrong:

1. **The retrieval was returning the wrong chunks** — so even when Aparna wanted to ground a claim, there was no relevant document to anchor to.
2. **The system prompt had an escape hatch** — "If you're not citing a document, say so plainly" — that the model took every turn.

The fix was structural, not tonal: remove the escape hatch, mandate "every reply must quote or paraphrase from a document block," and trust that an over-cited reply is recoverable while an under-cited reply is invisible. Once the corpus retrieval was returning relevant chunks, the strict prompt + Citations API combination produced one or more citations on essentially every reply.

The lesson: when an LLM doesn't do the thing your prompt says to do, **the bug is almost always either (a) the data isn't there, or (b) the prompt is permissive in a way you didn't notice**. It's almost never the model being "lazy."

---

## File pointers for further reading

| Topic | File |
|---|---|
| Voice batching + splitter | [voice-pitch-agent/src/voice.js](voice-pitch-agent/src/voice.js) |
| RAG retrieval middleware | [voice-pitch-agent/vite.config.js](voice-pitch-agent/vite.config.js) |
| Citations API wiring | [voice-pitch-agent/src/claude-client.js](voice-pitch-agent/src/claude-client.js) |
| System prompt | [voice-pitch-agent/src/claude-client.js](voice-pitch-agent/src/claude-client.js) (the `SYSTEM_PROMPT` constant) |
| Corpus chunker | [voice-pitch-agent/scripts/build-index.mjs](voice-pitch-agent/scripts/build-index.mjs) |
| Scrapers | [marc-agent/scrapers/](marc-agent/scrapers/) |
| Full architecture | [ARCHITECTURE.md](ARCHITECTURE.md) |
| Operating the system | [DOCUMENTATION.md](DOCUMENTATION.md) |
