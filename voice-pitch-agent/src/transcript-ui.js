// Renders the live transcript bubbles. Assistant bubbles with citations get
// a "Why she's saying this" badge that opens the citation popover.

import { subscribe, getState } from './state.js'
import { showPopover } from './citations-ui.js'

let container = null
let lastCount = 0

export function mountTranscript(el) {
  container = el
  subscribe((state) => render(state.transcript, state.bubbleCitations))
}

function render(transcript, bubbleCitations) {
  if (!container) return

  const empty = container.querySelector('.transcript-empty')
  if (transcript.length && empty) empty.remove()

  for (const entry of transcript) {
    let node = container.querySelector(`[data-bubble-id="${entry.id}"]`)
    if (!node) {
      node = document.createElement('div')
      node.dataset.bubbleId = entry.id
      node.className = `bubble bubble-${entry.speaker}`
      const initials = entry.speaker === 'agent' ? 'AI' : entry.speaker === 'founder' ? 'You' : 'Sys'
      const name = entry.speaker === 'agent' ? 'Aparna' : entry.speaker === 'founder' ? 'You' : 'System'
      node.innerHTML = `
        <div class="bubble-avatar">${initials}</div>
        <div class="bubble-body">
          <div class="bubble-meta">
            <span class="bubble-name">${name}</span>
            <span class="bubble-time">${escapeHtml(entry.time)}</span>
          </div>
          <div class="bubble-text" data-text></div>
          <button class="bubble-citation-btn" data-citation-trigger hidden>
            <span class="bubble-citation-icon">◆</span>
            <span data-citation-count></span>
          </button>
        </div>
      `
      const btn = node.querySelector('[data-citation-trigger]')
      btn.addEventListener('click', (e) => {
        e.stopPropagation()
        const cites = (getState().bubbleCitations || {})[entry.id] || []
        if (cites.length) showPopover(btn, cites)
      })
      container.appendChild(node)
    }
    const textEl = node.querySelector('[data-text]')
    if (textEl.textContent !== entry.text) textEl.textContent = entry.text
    node.classList.toggle('bubble-partial', Boolean(entry.partial))

    // Update citation badge
    if (entry.speaker === 'agent') {
      const cites = (bubbleCitations || {})[entry.id] || []
      const btn = node.querySelector('[data-citation-trigger]')
      const count = node.querySelector('[data-citation-count]')
      if (btn && cites.length) {
        btn.hidden = false
        count.textContent = `${cites.length} source${cites.length > 1 ? 's' : ''}`
      } else if (btn) {
        btn.hidden = true
      }
    }
  }

  if (transcript.length > lastCount) {
    container.scrollTop = container.scrollHeight
  }
  lastCount = transcript.length
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}
