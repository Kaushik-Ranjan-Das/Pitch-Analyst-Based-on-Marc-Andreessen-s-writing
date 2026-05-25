// Central pub-sub state. Simple enough that hand-rolled beats pulling in a store lib.

import { emptyForm } from './form-schema.js'

const state = {
  status: 'idle', // idle | connecting | live | error | handoff
  form: emptyForm(),
  conversation: [], // Anthropic-style messages [{role, content}]
  transcript: [], // [{ id, speaker: 'founder'|'agent'|'system', text, time, partial }]
  audit: [], // [{ time, message }]
  nextQuestion: '',
  priority: 'medium', // low | medium | high
  priorityReason: 'Waiting for founder to start the pitch',
  activeSection: null,
  agentState: 'idle', // idle | listening | thinking | speaking
  callStartTime: null,
  handoff: null,
  citations: [], // Flat list of every citation surfaced this session
  bubbleCitations: {} // { [bubbleId]: Array<citation> }
}

const subs = new Set()

export function getState() { return state }

export function subscribe(fn) {
  subs.add(fn)
  fn(state)
  return () => subs.delete(fn)
}

function emit() {
  for (const fn of subs) fn(state)
}

export function setStatus(status) {
  state.status = status
  emit()
}

export function setField(section, field, value) {
  const key = `${section}.${field}`
  if (state.form[key] === value) return
  state.form[key] = value
  state.activeSection = section
  state.audit.push({ time: nowHM(), message: `Filled ${section}.${field} → "${truncate(value, 40)}"` })
  emit()
}

export function setActiveSection(section) {
  if (state.activeSection === section) return
  state.activeSection = section
  emit()
}

export function setAgentState(next) {
  if (state.agentState === next) return
  state.agentState = next
  emit()
}

export function startCallTimer() {
  state.callStartTime = Date.now()
  emit()
}

export function stopCallTimer() {
  state.callStartTime = null
  emit()
}

export function clearForm() {
  state.form = emptyForm()
  state.activeSection = null
  state.audit.push({ time: nowHM(), message: 'Pitch packet reset' })
  emit()
}

export function appendConversation(message) {
  state.conversation.push(message)
  emit()
}

export function resetConversation() {
  state.conversation = []
  state.transcript = []
  state.audit = []
  state.nextQuestion = ''
  state.priority = 'medium'
  state.priorityReason = 'Waiting for founder to start the pitch'
  state.activeSection = null
  state.agentState = 'idle'
  state.callStartTime = null
  state.handoff = null
  state.citations = []
  state.bubbleCitations = {}
  state.form = emptyForm()
  emit()
}

export function pushTranscript(entry) {
  const id = entry.id || `t-${Date.now()}-${Math.random().toString(36).slice(2, 7)}`
  const next = { id, time: nowHM(), partial: false, ...entry }
  state.transcript.push(next)
  emit()
  return id
}

export function updateTranscript(id, patch) {
  const item = state.transcript.find((t) => t.id === id)
  if (!item) return
  Object.assign(item, patch)
  emit()
}

export function finalizeTranscript(id, text) {
  updateTranscript(id, { text, partial: false })
}

export function setNextQuestion(text) {
  if (!text) return
  state.nextQuestion = text
  emit()
}

export function setPriority(level, reason) {
  state.priority = level
  state.priorityReason = reason || ''
  emit()
}

export function pushAudit(message) {
  state.audit.push({ time: nowHM(), message })
  emit()
}

export function setHandoff(handoff) {
  state.handoff = handoff
  state.status = handoff ? 'handoff' : state.status
  emit()
}

export function patchHandoff(patch) {
  if (!state.handoff) return
  Object.assign(state.handoff, patch)
  emit()
}

export function attachCitationsToBubble(bubbleId, citations) {
  if (!bubbleId || !citations?.length) return
  const existing = state.bubbleCitations[bubbleId] || []
  state.bubbleCitations[bubbleId] = existing.concat(citations)
  state.citations = state.citations.concat(citations)
  emit()
}

function nowHM() {
  const d = new Date()
  return `${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`
}
function pad(n) { return String(n).padStart(2, '0') }
function truncate(s, n) { return s.length > n ? s.slice(0, n - 1) + '…' : s }
