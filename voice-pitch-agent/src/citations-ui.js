// Citation system. Three surfaces:
//   1. Inline badge on each assistant bubble (click → popover with all sources)
//   2. Right-rail "Sources used" panel (grouped, click any to open popover)
//   3. Live toast ticker in the bottom-right that pops a card for every NEW
//      citation as it streams in mid-response, then auto-fades after ~6s.
//
// All three open the same citation-popover element for consistency.

import { subscribe, getState } from './state.js'

let popoverEl = null
let sourcesPanelEl = null
let tickerEl = null
let lastCitationCount = 0
let lastSourceKeys = new Set()

export function mountCitations() {
  popoverEl = document.querySelector('[data-citation-popover]')
  sourcesPanelEl = document.querySelector('[data-sources-panel]')
  tickerEl = document.querySelector('[data-citation-ticker]')

  if (popoverEl) {
    document.addEventListener('click', (e) => {
      if (popoverEl.hidden) return
      if (popoverEl.contains(e.target)) return
      if (e.target.closest('[data-citation-trigger]')) return
      if (e.target.closest('[data-source-trigger]')) return
      hidePopover()
    })
    const closeBtn = popoverEl.querySelector('[data-citation-close]')
    if (closeBtn) closeBtn.addEventListener('click', hidePopover)
  }

  subscribe((state) => {
    renderSourcesPanel(state)
    surfaceNewCitations(state)
  })
}

export function showPopover(triggerEl, citations) {
  if (!popoverEl || !citations?.length) return
  const body = popoverEl.querySelector('[data-citation-body]')
  body.innerHTML = citations.map((c) => `
    <article class="citation-card">
      <div class="citation-head">
        <span class="citation-folder">${escapeHtml(c.source_folder || '')}</span>
        <span class="citation-title">${escapeHtml(c.document_title || c.slug || 'source')}</span>
      </div>
      <blockquote class="citation-quote">${escapeHtml(c.cited_text || '(no excerpt)')}</blockquote>
      <div class="citation-meta">
        ${c.source_path ? `<code class="citation-path">${escapeHtml(c.source_path)}</code>` : ''}
        ${c.source_url ? `<a class="citation-link" href="${escapeAttr(c.source_url)}" target="_blank" rel="noopener">open original ↗</a>` : ''}
      </div>
    </article>
  `).join('')

  const rect = triggerEl.getBoundingClientRect()
  popoverEl.hidden = false
  const popH = popoverEl.offsetHeight || 240
  const spaceBelow = window.innerHeight - rect.bottom
  const placeAbove = spaceBelow < popH + 16 && rect.top > popH + 16
  popoverEl.style.left = `${Math.max(12, Math.min(window.innerWidth - 400, rect.left))}px`
  popoverEl.style.top = placeAbove
    ? `${rect.top - popH - 8 + window.scrollY}px`
    : `${rect.bottom + 8 + window.scrollY}px`
}

export function hidePopover() {
  if (popoverEl) popoverEl.hidden = true
}

function renderSourcesPanel(state) {
  if (!sourcesPanelEl) return
  const cites = state.citations || []
  if (!cites.length) {
    sourcesPanelEl.innerHTML = `<div class="sources-empty">Aparna's citations will accumulate here as she pulls from Marc's writing.</div>`
    lastSourceKeys = new Set()
    return
  }

  const grouped = new Map()
  for (const c of cites) {
    const key = c.source_path || c.slug || c.document_title
    if (!grouped.has(key)) {
      grouped.set(key, { ...c, count: 1, quotes: [c.cited_text], _key: key, _citations: [c] })
    } else {
      const g = grouped.get(key)
      g.count++
      g._citations.push(c)
      if (c.cited_text && !g.quotes.includes(c.cited_text)) g.quotes.push(c.cited_text)
    }
  }
  const items = Array.from(grouped.values()).sort((a, b) => b.count - a.count)
  const currentKeys = new Set(items.map((g) => g._key))

  sourcesPanelEl.innerHTML = items.map((g, i) => {
    const isNew = !lastSourceKeys.has(g._key)
    return `
      <article class="source-item${isNew ? ' is-new' : ''}" data-source-trigger data-source-index="${i}" tabindex="0">
        <header class="source-head">
          <span class="source-folder">${escapeHtml(g.source_folder || '')}</span>
          <span class="source-count">${g.count}×</span>
        </header>
        <div class="source-title">${escapeHtml(g.document_title || g.slug || 'source')}</div>
        ${g.quotes.slice(0, 2).map((q) => `<blockquote class="source-quote">${escapeHtml(q.slice(0, 220))}${q.length > 220 ? '…' : ''}</blockquote>`).join('')}
        ${g.source_url ? `<a class="source-link" href="${escapeAttr(g.source_url)}" target="_blank" rel="noopener" data-stop>open original ↗</a>` : ''}
      </article>
    `
  }).join('')

  // Wire each source card to open the popover (entire card is clickable)
  for (const el of sourcesPanelEl.querySelectorAll('[data-source-trigger]')) {
    el.addEventListener('click', (e) => {
      if (e.target.closest('[data-stop]')) return // let the link handle itself
      const idx = Number(el.dataset.sourceIndex)
      const group = items[idx]
      if (group) showPopover(el, group._citations)
    })
    el.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); el.click() }
    })
  }

  lastSourceKeys = currentKeys
}

// Live toast ticker: any citation that arrived since last render gets a card
// in the bottom-right corner. Clicking opens the popover; auto-fades after ~6s.
function surfaceNewCitations(state) {
  if (!tickerEl) return
  const cites = state.citations || []
  if (cites.length <= lastCitationCount) {
    lastCitationCount = cites.length
    return
  }
  const fresh = cites.slice(lastCitationCount)
  lastCitationCount = cites.length

  for (const c of fresh) {
    const toast = document.createElement('div')
    toast.className = 'live-citation-toast'
    toast.innerHTML = `
      <div class="live-citation-eyebrow">CITING · ${escapeHtml(c.source_folder || 'source')}</div>
      <div class="live-citation-title">${escapeHtml(c.document_title || c.slug || 'source')}</div>
      <p class="live-citation-quote">${escapeHtml((c.cited_text || '').slice(0, 130))}${(c.cited_text || '').length > 130 ? '…' : ''}</p>
      ${c.source_url ? `<a class="live-citation-link" href="${escapeAttr(c.source_url)}" target="_blank" rel="noopener" data-stop>open original ↗</a>` : ''}
    `
    toast.addEventListener('click', (e) => {
      if (e.target.closest('[data-stop]')) return
      showPopover(toast, [c])
    })
    tickerEl.appendChild(toast)

    // Auto-dismiss after ~6s. Cap at 4 visible toasts to avoid clutter.
    const enforceCap = () => {
      while (tickerEl.children.length > 4) {
        tickerEl.removeChild(tickerEl.firstChild)
      }
    }
    enforceCap()
    setTimeout(() => {
      toast.classList.add('fading')
      setTimeout(() => toast.remove(), 360)
    }, 6000)
  }
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}
function escapeAttr(s) { return escapeHtml(s).replace(/'/g, '&#39;') }
