#!/usr/bin/env node
// One-time index builder. Walks ../marc-agent/data/{essays,blog,pmarca,youtube,podcasts}/*.md,
// chunks each file by paragraph into ~600-token windows with overlap, embeds via
// Voyage AI, and writes data/index.json — a flat array consumed by the Vite proxy.
//
// Run: bun run build:index   (or: node --env-file=.env scripts/build-index.mjs)

import { readdirSync, readFileSync, writeFileSync, statSync } from 'node:fs'
import { join, dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const __dirname = dirname(fileURLToPath(import.meta.url))
const ROOT = resolve(__dirname, '..')
const CORPUS_ROOT = resolve(ROOT, '..', 'marc-agent', 'data')
const OUT_PATH = join(ROOT, 'data', 'index.json')

const SOURCES = ['essays', 'blog', 'pmarca', 'youtube', 'podcasts']

const MODEL = process.env.VOYAGE_MODEL || 'voyage-3.5-lite'
const API_KEY = process.env.VOYAGE_API_KEY
// Free Voyage tier (no payment method): 3 RPM + 10K TPM. Batches of 16
// chunks ≈ 9,600 tokens each stay under TPM; waiting 22s between requests
// stays under RPM. Set VOYAGE_PAID=1 if you've added a payment method to
// burst at standard rates (batch 128, no throttle).
const PAID = process.env.VOYAGE_PAID === '1'
const BATCH_SIZE = PAID ? 128 : 16
const THROTTLE_MS = PAID ? 0 : 22000
const CHUNK_LIMIT = Number(process.env.CHUNK_LIMIT) || Infinity
const TARGET_CHARS = 2400 // ~600 tokens at ~4 chars/token
const OVERLAP_CHARS = 400 // ~100 tokens

if (!API_KEY) {
  console.error('Missing VOYAGE_API_KEY in environment. Copy .env.example to .env and add a key from https://dash.voyageai.com/.')
  process.exit(1)
}

function listMarkdown(dir) {
  let files = []
  for (const name of readdirSync(dir)) {
    if (name.startsWith('.') || name === 'fetch-errors.log') continue
    const path = join(dir, name)
    const stat = statSync(path)
    if (stat.isDirectory()) {
      files = files.concat(listMarkdown(path))
    } else if (name.endsWith('.md')) {
      files.push(path)
    }
  }
  return files
}

function parseHeader(text, path) {
  // Header format we wrote during scraping:
  //   # title\n**Source:** url\n**Scraped:** date\n---\n\nbody
  const lines = text.split('\n')
  let title = ''
  let sourceUrl = ''
  let bodyStart = 0
  if (lines[0]?.startsWith('# ')) title = lines[0].slice(2).trim()
  for (let i = 0; i < Math.min(lines.length, 10); i++) {
    const m = lines[i].match(/^\*\*Source:\*\*\s*(.+)$/)
    if (m) sourceUrl = m[1].trim()
    if (lines[i].trim() === '---') {
      bodyStart = i + 1
      break
    }
  }
  // Slug from filename minus .md
  const slug = path.split('/').pop().replace(/\.md$/, '')
  const sourceFolder = path.split('/').slice(-2, -1)[0]
  return {
    title: title || slug,
    sourceUrl,
    slug,
    sourceFolder,
    body: lines.slice(bodyStart).join('\n').trim()
  }
}

function chunkBody(body) {
  // Paragraph-aware sliding window. Merge paragraphs until we hit TARGET_CHARS;
  // then emit a chunk and slide back by OVERLAP_CHARS worth of text.
  const paragraphs = body.split(/\n\s*\n/).map((p) => p.trim()).filter(Boolean)
  const chunks = []
  let buf = ''
  for (const p of paragraphs) {
    if (!buf) {
      buf = p
      continue
    }
    if (buf.length + 2 + p.length <= TARGET_CHARS) {
      buf += '\n\n' + p
    } else {
      chunks.push(buf)
      // Overlap: keep last OVERLAP_CHARS of buf as a head for the next chunk.
      const tail = buf.length > OVERLAP_CHARS ? buf.slice(-OVERLAP_CHARS) : ''
      buf = (tail ? tail + '\n\n' : '') + p
    }
  }
  if (buf) chunks.push(buf)
  // Hard-split any chunk that's still way too big (a single huge paragraph).
  const out = []
  for (const c of chunks) {
    if (c.length <= TARGET_CHARS * 1.5) {
      out.push(c)
    } else {
      for (let i = 0; i < c.length; i += TARGET_CHARS - OVERLAP_CHARS) {
        out.push(c.slice(i, i + TARGET_CHARS))
      }
    }
  }
  return out
}

async function embedBatch(inputs, inputType) {
  const resp = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${API_KEY}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({
      input: inputs,
      model: MODEL,
      input_type: inputType
    })
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`Voyage API ${resp.status}: ${text || resp.statusText}`)
  }
  const data = await resp.json()
  return data.data.map((d) => d.embedding)
}

async function main() {
  const t0 = Date.now()
  console.log(`[build-index] corpus root: ${CORPUS_ROOT}`)
  console.log(`[build-index] embedding model: ${MODEL}`)

  // 1. Collect all source files
  const files = []
  for (const source of SOURCES) {
    const dir = join(CORPUS_ROOT, source)
    try {
      const found = listMarkdown(dir)
      files.push(...found)
    } catch (err) {
      console.warn(`[build-index] skipping ${source}: ${err.message}`)
    }
  }
  console.log(`[build-index] found ${files.length} markdown files`)

  // 2. Parse + chunk
  const chunks = []
  for (const path of files) {
    const raw = readFileSync(path, 'utf-8')
    const meta = parseHeader(raw, path)
    if (!meta.body || meta.body.length < 200) continue
    const pieces = chunkBody(meta.body)
    pieces.forEach((text, i) => {
      const relPath = path.slice(path.indexOf('marc-agent/'))
      chunks.push({
        doc_id: `${meta.sourceFolder}/${meta.slug}#${i}`,
        source_folder: meta.sourceFolder,
        slug: meta.slug,
        title: meta.title,
        source_url: meta.sourceUrl,
        source_path: relPath,
        chunk_index: i,
        text
      })
    })
  }
  console.log(`[build-index] produced ${chunks.length} chunks`)

  if (chunks.length === 0) {
    console.error('[build-index] no chunks produced — check that ../marc-agent/data/ has scraped .md files')
    process.exit(1)
  }

  // Optional cap for partial builds (free-tier-friendly smoke test)
  const limitedChunks = chunks.slice(0, Number.isFinite(CHUNK_LIMIT) ? CHUNK_LIMIT : chunks.length)
  if (limitedChunks.length < chunks.length) {
    console.log(`[build-index] CHUNK_LIMIT=${CHUNK_LIMIT} — embedding ${limitedChunks.length}/${chunks.length} only`)
  }
  console.log(`[build-index] batch=${BATCH_SIZE}${THROTTLE_MS ? ` throttle=${THROTTLE_MS}ms (free-tier mode; set VOYAGE_PAID=1 to disable)` : ''}`)

  // 3. Embed in batches (throttled for free tier)
  let totalEmbedded = 0
  for (let i = 0; i < limitedChunks.length; i += BATCH_SIZE) {
    const batch = limitedChunks.slice(i, i + BATCH_SIZE)
    const inputs = batch.map((c) => c.text)
    let attempt = 0
    while (true) {
      try {
        const embeddings = await embedBatch(inputs, 'document')
        for (let j = 0; j < batch.length; j++) batch[j].embedding = embeddings[j]
        break
      } catch (err) {
        attempt++
        const is429 = /429/.test(err.message)
        if (is429 && attempt <= 5) {
          const wait = 30000 * attempt
          console.warn(`\n[build-index] rate-limited; retrying in ${wait / 1000}s (attempt ${attempt})`)
          await new Promise((r) => setTimeout(r, wait))
        } else {
          throw err
        }
      }
    }
    totalEmbedded += batch.length
    process.stdout.write(`\r[build-index] embedded ${totalEmbedded}/${limitedChunks.length}`)
    if (THROTTLE_MS && i + BATCH_SIZE < limitedChunks.length) {
      await new Promise((r) => setTimeout(r, THROTTLE_MS))
    }
  }
  process.stdout.write('\n')

  // Replace chunks with the embedded subset for the payload below
  chunks.length = 0
  chunks.push(...limitedChunks)

  // 4. Write JSON
  const payload = {
    model: MODEL,
    dimension: chunks[0].embedding.length,
    built_at: new Date().toISOString(),
    chunk_count: chunks.length,
    chunks
  }
  writeFileSync(OUT_PATH, JSON.stringify(payload))
  const bytes = statSync(OUT_PATH).size
  const seconds = ((Date.now() - t0) / 1000).toFixed(1)
  console.log(`[build-index] wrote ${OUT_PATH}`)
  console.log(`[build-index] ${chunks.length} chunks, ${payload.dimension}-dim vectors, ${(bytes / 1024 / 1024).toFixed(1)} MB, ${seconds}s`)
}

main().catch((err) => {
  console.error(err)
  process.exit(1)
})
