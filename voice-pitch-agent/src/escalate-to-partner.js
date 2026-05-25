// Escalate-to-partner flow. Shows an overlay with progressing stages while
// Aparna winds down and a human partner "joins" (simulated for the demo).

import { setHandoff, patchHandoff, pushAudit, getState } from './state.js'

const STAGES = [
  { label: 'Notifying a partner…', wait: 1500, fill: 18 },
  { label: 'Locating an available partner…', wait: 1800, fill: 42 },
  { label: 'Sharing pitch packet and citations…', wait: 1500, fill: 70 },
  { label: 'Connecting now…', wait: 1500, fill: 92 },
  { label: 'Connected. A partner from the team is on the line.', wait: 0, fill: 100 }
]

let activeRunId = 0

export async function startEscalation(reason) {
  const runId = ++activeRunId

  setHandoff({ reason: reason || 'Founder requested a human partner.', stage: STAGES[0].label, fillPct: 0, complete: false })
  pushAudit(`Escalation initiated: ${reason || 'no reason given'}`)

  renderOverlay()

  for (const stage of STAGES) {
    if (runId !== activeRunId) return
    patchHandoff({ stage: stage.label, fillPct: stage.fill })
    renderOverlay()
    if (stage.wait) await sleep(stage.wait)
  }
  if (runId !== activeRunId) return
  patchHandoff({ complete: true })
  renderOverlay()
}

export function closeEscalation() {
  activeRunId++
  setHandoff(null)
  const overlay = document.querySelector('[data-handoff]')
  if (overlay) overlay.hidden = true
}

export function mountEscalationUI() {
  const closeBtn = document.querySelector('[data-handoff-close]')
  if (closeBtn) closeBtn.addEventListener('click', closeEscalation)
  renderOverlay()
}

function renderOverlay() {
  const state = getState()
  const overlay = document.querySelector('[data-handoff]')
  if (!overlay) return

  if (!state.handoff) {
    overlay.hidden = true
    return
  }
  overlay.hidden = false

  document.querySelector('[data-handoff-title]').textContent = state.handoff.complete
    ? 'Connected to a partner'
    : 'Connecting you to a partner…'
  document.querySelector('[data-handoff-reason]').textContent = state.handoff.reason
  document.querySelector('[data-handoff-stage]').textContent = state.handoff.stage
  document.querySelector('[data-handoff-fill]').style.width = `${state.handoff.fillPct}%`
  document.querySelector('[data-handoff-close]').hidden = !state.handoff.complete
}

function sleep(ms) { return new Promise((r) => setTimeout(r, ms)) }
