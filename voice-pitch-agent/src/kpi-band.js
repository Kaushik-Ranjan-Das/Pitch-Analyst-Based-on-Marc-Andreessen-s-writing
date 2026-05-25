// Drives the top KPI band: call duration, fields filled, completion %, priority,
// agent state, active section. Subscribes to state and ticks once a second for
// the call duration.

import { subscribe, getState } from './state.js'
import { SECTIONS, computeCompletion } from './form-schema.js'

const SECTION_TITLE = Object.fromEntries(SECTIONS.map((s) => [s.id, s.title]))

const AGENT_LABEL = {
  idle: 'idle',
  listening: 'listening',
  thinking: 'thinking',
  speaking: 'speaking'
}

export function mountKpiBand() {
  const $ = (sel) => document.querySelector(sel)

  const $duration = $('[data-kpi-duration]')
  const $filled = $('[data-kpi-filled]')
  const $pct = $('[data-kpi-pct]')
  const $priority = $('[data-kpi-priority]')
  const $agent = $('[data-kpi-agent]')
  const $section = $('[data-kpi-section]')
  const $statusPill = $('[data-status-pill]')
  const $statusText = $('[data-status-text]')
  const $statusDot = $('[data-status-dot]')

  subscribe((state) => {
    const { filled, total, pct } = computeCompletion(state.form)
    if ($filled) $filled.textContent = `${filled} / ${total}`
    if ($pct) {
      $pct.textContent = `${pct}%`
      $pct.dataset.tone = pct >= 100 ? 'live' : (pct > 0 ? '' : '')
    }
    if ($priority) {
      $priority.textContent = state.priority.charAt(0).toUpperCase() + state.priority.slice(1)
      $priority.dataset.tone = state.priority === 'high' ? 'warn' : ''
    }
    if ($agent) {
      $agent.textContent = AGENT_LABEL[state.agentState] || 'idle'
      $agent.dataset.tone = state.agentState === 'speaking' || state.agentState === 'listening' ? 'live' : ''
    }
    if ($section) {
      let active = state.activeSection
      if (!active) {
        for (const s of SECTIONS) {
          const remaining = s.fields.filter((f) => f.required !== false && !state.form[`${s.id}.${f.id}`])
          if (remaining.length) { active = s.id; break }
        }
      }
      if (pct === 100) active = null
      $section.textContent = active ? SECTION_TITLE[active] : '—'
    }

    // Status pill
    if ($statusPill && $statusText && $statusDot) {
      $statusPill.classList.remove('is-live', 'is-error', 'is-connecting')
      $statusDot.classList.remove('live', 'connecting', 'error')
      if (state.status === 'live') {
        $statusPill.classList.add('is-live')
        $statusDot.classList.add('live')
        $statusText.textContent = 'live'
      } else if (state.status === 'connecting') {
        $statusPill.classList.add('is-connecting')
        $statusDot.classList.add('connecting')
        $statusText.textContent = 'connecting'
      } else if (state.status === 'error') {
        $statusPill.classList.add('is-error')
        $statusDot.classList.add('error')
        $statusText.textContent = 'error'
      } else if (state.status === 'handoff') {
        $statusPill.classList.add('is-connecting')
        $statusDot.classList.add('connecting')
        $statusText.textContent = 'handoff'
      } else {
        $statusText.textContent = 'idle'
      }
    }
  })

  // Duration ticker — runs every 500ms while a call is active.
  setInterval(() => {
    const state = getState()
    if (!$duration) return
    if (!state.callStartTime) {
      $duration.textContent = '00:00'
      return
    }
    const ms = Date.now() - state.callStartTime
    $duration.textContent = formatDuration(ms)
  }, 500)
}

function formatDuration(ms) {
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  if (m >= 60) {
    const h = Math.floor(m / 60)
    const mm = m % 60
    return `${pad(h)}:${pad(mm)}:${pad(s)}`
  }
  return `${pad(m)}:${pad(s)}`
}
function pad(n) { return String(n).padStart(2, '0') }
