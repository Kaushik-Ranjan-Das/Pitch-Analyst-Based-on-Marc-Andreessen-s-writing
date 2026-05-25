import { defineConfig, loadEnv } from 'vite'
import { readFileSync, existsSync } from 'node:fs'
import { resolve } from 'node:path'

export default defineConfig(({ mode }) => {
  const env = loadEnv(mode, process.cwd(), '')
  const apiKey = env.ANTHROPIC_API_KEY
  const voyageKey = env.VOYAGE_API_KEY
  const voyageModel = env.VOYAGE_MODEL || 'voyage-3.5-lite'

  // Load the corpus embedding index once at dev-server boot. The file is
  // produced by `bun run build:index` and lives at data/index.json.
  const indexPath = resolve(process.cwd(), 'data', 'index.json')
  let corpusIndex = null
  if (existsSync(indexPath)) {
    try {
      const raw = readFileSync(indexPath, 'utf-8')
      corpusIndex = JSON.parse(raw)
      console.log(`[retrieve] index loaded: ${corpusIndex.chunk_count} chunks, ${corpusIndex.dimension}-d`)
    } catch (err) {
      console.warn(`[retrieve] failed to parse data/index.json: ${err.message}`)
    }
  } else {
    console.warn('[retrieve] data/index.json not found — run `bun run build:index` first. /api/retrieve will return empty results.')
  }

  return {
    server: {
      port: 5173,
      open: true,
      host: '127.0.0.1',
      proxy: {
        '/api/anthropic': {
          target: 'https://api.anthropic.com',
          changeOrigin: true,
          rewrite: (p) => p.replace(/^\/api\/anthropic/, ''),
          configure: (proxy) => {
            proxy.on('proxyReq', (proxyReq) => {
              if (!apiKey) return
              proxyReq.setHeader('x-api-key', apiKey)
              proxyReq.setHeader('anthropic-version', '2023-06-01')
              // Vite forwards the browser Origin header, which makes Anthropic
              // treat this as a direct browser request and 401. This header
              // tells Anthropic that's intentional.
              proxyReq.setHeader('anthropic-dangerous-direct-browser-access', 'true')
              proxyReq.removeHeader('origin')
            })
          }
        }
      }
    },
    plugins: [
      {
        name: 'voice-pitch-retrieve',
        configureServer(server) {
          server.middlewares.use('/api/retrieve', async (req, res) => {
            if (req.method !== 'POST') {
              res.statusCode = 405
              res.end('method not allowed')
              return
            }
            try {
              const bodyText = await readRequestBody(req)
              const body = JSON.parse(bodyText || '{}')
              const query = String(body.query || '').trim()
              const k = Math.max(1, Math.min(20, Number(body.k) || 6))

              if (!query) {
                respondJson(res, 400, { error: 'query required' })
                return
              }
              if (!corpusIndex || !corpusIndex.chunks?.length) {
                respondJson(res, 200, { chunks: [], note: 'index empty — run build:index' })
                return
              }
              if (!voyageKey) {
                respondJson(res, 500, { error: 'VOYAGE_API_KEY missing in .env' })
                return
              }

              // Embed the query
              const embedding = await embedQuery(query, voyageKey, voyageModel)

              // Top-K by cosine similarity
              const ranked = rankByCosine(embedding, corpusIndex.chunks, k)

              respondJson(res, 200, { chunks: ranked })
            } catch (err) {
              console.warn('[retrieve] error:', err)
              respondJson(res, 500, { error: err.message || String(err) })
            }
          })
        }
      }
    ],
    build: {
      target: 'es2022',
      sourcemap: true
    },
    define: {
      __HAS_API_KEY__: JSON.stringify(Boolean(apiKey)),
      __HAS_VOYAGE_KEY__: JSON.stringify(Boolean(voyageKey)),
      __MODEL__: JSON.stringify(env.ANTHROPIC_MODEL || 'claude-sonnet-4-6')
    }
  }
})

// ============== helpers ==============

function readRequestBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (chunk) => { data += chunk })
    req.on('end', () => resolve(data))
    req.on('error', reject)
  })
}

function respondJson(res, status, payload) {
  res.statusCode = status
  res.setHeader('content-type', 'application/json')
  res.end(JSON.stringify(payload))
}

async function embedQuery(query, apiKey, model) {
  const resp = await fetch('https://api.voyageai.com/v1/embeddings', {
    method: 'POST',
    headers: {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json'
    },
    body: JSON.stringify({ input: [query], model, input_type: 'query' })
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`voyage ${resp.status}: ${text || resp.statusText}`)
  }
  const data = await resp.json()
  return data.data[0].embedding
}

function rankByCosine(queryVec, chunks, k) {
  // Vectors are dense float arrays. We don't pre-normalize the corpus, so we
  // do full cosine each time. ~3ms for 2k vectors of dim 1024.
  const qNorm = Math.sqrt(queryVec.reduce((s, x) => s + x * x, 0)) || 1
  const scored = new Array(chunks.length)
  for (let i = 0; i < chunks.length; i++) {
    const v = chunks[i].embedding
    let dot = 0
    let vNorm = 0
    for (let j = 0; j < v.length; j++) {
      dot += queryVec[j] * v[j]
      vNorm += v[j] * v[j]
    }
    vNorm = Math.sqrt(vNorm) || 1
    scored[i] = { idx: i, score: dot / (qNorm * vNorm) }
  }
  scored.sort((a, b) => b.score - a.score)
  return scored.slice(0, k).map(({ idx, score }) => {
    const c = chunks[idx]
    return {
      doc_id: c.doc_id,
      title: c.title,
      text: c.text,
      source_path: c.source_path,
      source_url: c.source_url,
      slug: c.slug,
      source_folder: c.source_folder,
      score: Number(score.toFixed(4))
    }
  })
}
