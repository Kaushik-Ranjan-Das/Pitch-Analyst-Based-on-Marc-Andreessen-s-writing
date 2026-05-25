// Thin browser-side wrapper around POST /api/retrieve.
// The Vite dev server keeps the embedding index in memory and serves top-K
// chunks from the Marc Andreessen corpus per query.

/**
 * Retrieve the top-K most relevant chunks for a query.
 *
 * @param {string} query
 * @param {number} k
 * @returns {Promise<Array<{doc_id: string, title: string, text: string, source_path: string, source_url: string, slug: string, source_folder: string, score: number}>>}
 */
export async function retrieveDocuments(query, k = 6) {
  const resp = await fetch('/api/retrieve', {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify({ query, k })
  })
  if (!resp.ok) {
    const text = await resp.text().catch(() => '')
    throw new Error(`retrieve ${resp.status}: ${text || resp.statusText}`)
  }
  const data = await resp.json()
  return Array.isArray(data?.chunks) ? data.chunks : []
}
