// Entry point. Wires UI, voice IO, Claude streaming, tool handlers.

import {
  getState,
  subscribe,
  setStatus,
  setField,
  setNextQuestion,
  setPriority,
  setAgentState,
  startCallTimer,
  stopCallTimer,
  appendConversation,
  resetConversation,
  pushTranscript,
  finalizeTranscript,
  pushAudit,
  attachCitationsToBubble
} from './state.js'

import { mountForm } from './form-ui.js'
import { mountTranscript } from './transcript-ui.js'
import { mountGuidance } from './guidance-ui.js'
import { mountEscalationUI, startEscalation, closeEscalation } from './escalate-to-partner.js'
import { mountKpiBand } from './kpi-band.js'
import { mountCitations } from './citations-ui.js'

import {
  isSTTSupported,
  startListening,
  stopListening,
  speak,
  cancelSpeech,
  setSpeechCallbacks,
  createSentenceSpeaker,
  getMicLevel,
  testSpeaker,
  listVoices,
  getPreferredVoiceName,
  setPreferredVoiceByName,
  onVoicesChanged,
  diagnoseSpeech,
  testMicrophone
} from './voice.js'

import { streamClaude } from './claude-client.js'
import { computeCompletion } from './form-schema.js'

const $ = (sel) => document.querySelector(sel)

let micPausedForTTS = false
let aiSpeaking = false
let pendingUserUtterance = ''
let sentenceSpeaker = null
let currentInterimBubbleId = null
let inFlightAbort = null
let currentAgentBubbleId = null
let lastQuestionAsked = ''

document.addEventListener('DOMContentLoaded', () => {
  // eslint-disable-next-line no-undef
  if (typeof __HAS_API_KEY__ !== 'undefined' && __HAS_API_KEY__ === false) {
    document.querySelector('[data-setup]').hidden = false
  }

  mountForm($('[data-form]'))
  mountTranscript($('[data-transcript]'))
  mountGuidance()
  mountEscalationUI()
  mountKpiBand()
  mountCitations()

  const readoutState = $('[data-readout-state]')
  subscribe((state) => {
    const pill = $('[data-streaming-pill]')
    const tag = $('[data-streaming-tag]')
    if (pill) pill.hidden = state.status !== 'live'
    if (tag) tag.hidden = state.status !== 'live'

    document.body.classList.toggle('mic-active', state.status === 'live' && !micPausedForTTS && !aiSpeaking)
    document.body.classList.toggle('ai-speaking', aiSpeaking)

    if (readoutState) {
      const map = {
        idle: { text: state.status === 'idle' ? 'Ready to begin pitch session' : 'Idle', tone: '' },
        listening: { text: 'Listening to founder', tone: 'live' },
        thinking: { text: 'Aparna is thinking', tone: 'live' },
        speaking: { text: 'Aparna is speaking', tone: 'speaking' }
      }
      const r = map[state.agentState] || map.idle
      readoutState.textContent = r.text
      readoutState.dataset.tone = r.tone
    }
  })

  $('[data-start]').addEventListener('click', () => startCall())
  $('[data-stop]').addEventListener('click', () => stopCall())
  $('[data-reset]').addEventListener('click', () => resetCall())
  $('[data-test-speaker]').addEventListener('click', () => testSpeaker())

  const diagPanel = $('[data-diag-panel]')
  const diagBody = $('[data-diag-body]')
  $('[data-diagnose]')?.addEventListener('click', () => {
    if (!diagPanel || !diagBody) return
    diagPanel.hidden = false
    diagBody.textContent = 'Running…'
    diagnoseSpeech((report) => { diagBody.textContent = report })
  })
  $('[data-diag-close]')?.addEventListener('click', () => { if (diagPanel) diagPanel.hidden = true })

  // ===== Mic test =====
  const micPanel = $('[data-mic-panel]')
  const micBody = $('[data-mic-body]')
  const micStatus = $('[data-mic-status]')
  const micMeter = $('[data-mic-meter]')
  const micStartBtn = $('[data-mic-start]')

  let micTestRunning = false
  $('[data-test-mic]')?.addEventListener('click', () => {
    if (!micPanel) return
    micPanel.hidden = false
    if (micBody) micBody.textContent = 'Idle — click Start test to begin.'
    if (micStatus) {
      micStatus.innerHTML = 'Click <strong>Start test</strong> below, then speak for a few seconds.'
      delete micStatus.dataset.state
    }
    if (micMeter) micMeter.style.width = '0%'
    if (micStartBtn) micStartBtn.disabled = false
  })

  micStartBtn?.addEventListener('click', async () => {
    if (micTestRunning) return
    micTestRunning = true
    micStartBtn.disabled = true
    if (micBody) micBody.textContent = 'Starting…'
    if (micStatus) micStatus.textContent = 'Requesting mic permission…'

    await testMicrophone(({ lines, level, listening, done }) => {
      if (micBody) micBody.textContent = lines
      if (micMeter) micMeter.style.width = `${Math.min(100, level * 100)}%`
      if (micStatus) {
        if (done) {
          micStatus.textContent = 'Test complete — see verdict below.'
          micStatus.dataset.state = 'done'
        } else if (listening) {
          micStatus.textContent = 'Listening… speak now.'
          micStatus.dataset.state = 'listening'
        } else {
          micStatus.textContent = 'Preparing…'
        }
      }
    })

    micTestRunning = false
    if (micStartBtn) micStartBtn.disabled = false
  })

  $('[data-mic-close]')?.addEventListener('click', () => { if (micPanel) micPanel.hidden = true })

  const voicePicker = $('[data-voice-picker]')
  if (voicePicker) {
    onVoicesChanged(() => {
      const voices = listVoices()
      const current = getPreferredVoiceName()
      voicePicker.innerHTML = voices
        .map((v) => `<option value="${v.name}"${v.name === current ? ' selected' : ''}>${v.name} (${v.lang})</option>`)
        .join('')
    })
    voicePicker.addEventListener('change', (e) => {
      if (setPreferredVoiceByName(e.target.value)) testSpeaker()
    })
  }

  $('[data-text-form]').addEventListener('submit', (e) => {
    e.preventDefault()
    const input = $('[data-text-input]')
    const text = (input.value || '').trim()
    if (!text) return
    input.value = ''
    // Typed input goes to Claude but doesn't go through STT, so push a founder
    // bubble here so the transcript reflects what the user said. STT path
    // already pushes via handleFounderFinal.
    pushTranscript({ speaker: 'founder', text, partial: false })
    handleUserUtterance(text)
  })

  setSpeechCallbacks({
    onStart: () => {
      aiSpeaking = true
      micPausedForTTS = true
      document.body.classList.remove('mic-active')
      setAgentState('speaking')
    },
    onEnd: () => {
      aiSpeaking = false
      micPausedForTTS = false
      if (!speechSynthesis.speaking && !speechSynthesis.pending) {
        document.body.classList.add('mic-active')
        if (getState().status === 'live') setAgentState('listening')
        else setAgentState('idle')
      }
    }
  })

  startMicBars()
  mountTabStrip()
})

function mountTabStrip() {
  const buttons = document.querySelectorAll('[data-tab]')
  const panes = document.querySelectorAll('[data-tab-content]')
  if (!buttons.length) return

  function activate(tab) {
    for (const btn of buttons) {
      const isActive = btn.dataset.tab === tab
      btn.classList.toggle('is-active', isActive)
      btn.setAttribute('aria-selected', isActive ? 'true' : 'false')
    }
    for (const pane of panes) {
      pane.classList.toggle('is-active', pane.dataset.tabContent === tab)
    }
  }

  for (const btn of buttons) {
    btn.addEventListener('click', () => activate(btn.dataset.tab))
  }

  // Live tab-meta updates from state
  const metaTranscript = document.querySelector('[data-tab-meta="transcript"]')
  const metaMarc = document.querySelector('[data-tab-meta="marc"]')
  const citationsCount = document.querySelector('[data-citations-count]')
  subscribe((state) => {
    if (metaTranscript) {
      // Live transcript meta: number of conversation turns (founder + Aparna)
      const turns = (state.transcript || []).filter((t) => !t.partial).length
      metaTranscript.textContent = turns === 0 ? 'Between me & Aparna' : `${turns} exchange${turns === 1 ? '' : 's'}`
    }
    if (metaMarc) {
      const lvl = state.priority?.level || 'medium'
      metaMarc.textContent = lvl.charAt(0).toUpperCase() + lvl.slice(1) + ' priority'
    }
    if (citationsCount) {
      const n = state.citations?.length || 0
      citationsCount.textContent = String(n)
    }
  })
}

// ============== Call control ==============

async function startCall() {
  console.log('[call] startCall invoked')
  if (getState().status === 'live' || getState().status === 'connecting') {
    console.warn('[call] startCall ignored — already live/connecting')
    return
  }

  resetConversation()
  setStatus('connecting')
  pushAudit('Pitch session started')
  setPriority('medium', 'Waiting for founder to start the pitch')

  try {
    if (isSTTSupported()) {
      await startListening({
        onFinal: (text) => handleFounderFinal(text),
        onInterim: (text) => handleFounderInterim(text),
        onError: (err) => {
          console.warn('STT error:', err)
          if (err === 'not-allowed') {
            pushAudit('Mic permission denied — falling back to text input')
            setStatus('error')
          }
        }
      })
    } else {
      pushAudit('Web Speech API not supported in this browser — use text input below')
    }
  } catch (err) {
    console.warn('Mic init failed:', err)
    pushAudit(`Mic unavailable: ${err.message}. Use text input below.`)
  }

  setStatus('live')
  startCallTimer()
  setAgentState('thinking')

  appendConversation({
    role: 'user',
    content: '[SESSION_START] The founder just connected. Please introduce yourself per the system prompt and begin the pitch intake.'
  })
  // Empty retrieval query → no documents attached → no citations stream on
  // the intro turn. The opening "Hi, I'm Aparna…" line is hardcoded in the
  // system prompt and doesn't need Marc grounding. Citations resume on the
  // founder's first real reply.
  await sendToClaude(getState().conversation, '')
}

function stopCall() {
  if (inFlightAbort) {
    inFlightAbort.abort()
    inFlightAbort = null
  }
  cancelSpeech()
  stopListening()
  if (sentenceSpeaker) { sentenceSpeaker.cancel(); sentenceSpeaker = null }
  setStatus('idle')
  stopCallTimer()
  setAgentState('idle')
  aiSpeaking = false
  micPausedForTTS = false
  pushAudit('Session stopped — transcript and packet preserved')
}

function resetCall() {
  if (inFlightAbort) {
    inFlightAbort.abort()
    inFlightAbort = null
  }
  cancelSpeech()
  stopListening()
  resetConversation()
  setStatus('idle')
  stopCallTimer()
  setAgentState('idle')
  closeEscalation()
  $('[data-transcript]').innerHTML = `<div class="transcript-empty">
    Click <strong>New pitch session</strong> to start. Aparna will introduce herself and begin the pitch intake.
  </div>`
  pushAudit('Session reset')
}

// ============== Founder speech handling ==============

let interimDebounceTimer = null

function handleFounderInterim(text) {
  if (aiSpeaking) return
  if (!currentInterimBubbleId) {
    currentInterimBubbleId = pushTranscript({ speaker: 'founder', text, partial: true })
  } else {
    finalizeTranscript(currentInterimBubbleId, text)
    const item = getState().transcript.find((t) => t.id === currentInterimBubbleId)
    if (item) item.partial = true
  }
}

async function handleFounderFinal(text) {
  if (!text || !text.trim()) return
  if (currentInterimBubbleId) {
    finalizeTranscript(currentInterimBubbleId, text)
    const item = getState().transcript.find((t) => t.id === currentInterimBubbleId)
    if (item) item.partial = false
    currentInterimBubbleId = null
  } else {
    pushTranscript({ speaker: 'founder', text, partial: false })
  }

  await handleUserUtterance(text)
}

async function handleUserUtterance(text) {
  if (interimDebounceTimer) clearTimeout(interimDebounceTimer)
  pendingUserUtterance = pendingUserUtterance ? `${pendingUserUtterance} ${text}` : text

  await new Promise((r) => { interimDebounceTimer = setTimeout(r, 600) })

  const utterance = pendingUserUtterance.trim()
  pendingUserUtterance = ''
  if (!utterance) return

  appendConversation({ role: 'user', content: utterance })
  await sendToClaude(getState().conversation, buildRetrievalQuery(utterance))
}

// Build a richer retrieval query than the founder's raw utterance. We blend in
// the previous founder turn (context) and a fixed set of Marc-framework
// keywords so the cosine-similarity search has more semantic surface to anchor
// against. Without this, a one-word reply like "engineers" returns nothing
// useful from the corpus.
const MARC_KEYWORDS = 'market timing product-market fit urgency why now founder incumbents software eating world technology adoption raise capital moat'

function buildRetrievalQuery(latestUtterance) {
  const conv = getState().conversation
  const founderTurns = conv
    .filter((m) => m.role === 'user' && typeof m.content === 'string' && !m.content.startsWith('[SESSION_START]'))
    .slice(-3)
    .map((m) => m.content)
  const joined = founderTurns.join(' ')
  return `${joined} ${MARC_KEYWORDS}`.trim()
}

// ============== Claude streaming + tool handling ==============

async function sendToClaude(messages, retrievalQuery) {
  console.log(`[claude] sending ${messages.length} messages`)
  if (inFlightAbort) inFlightAbort.abort()
  inFlightAbort = new AbortController()
  if (getState().status === 'live' && !aiSpeaking) setAgentState('thinking')

  sentenceSpeaker = createSentenceSpeaker()

  let fullText = ''
  currentAgentBubbleId = null
  const pendingCitations = []

  await streamClaude(messages, {
    retrievalQuery,
    onTextDelta: (delta) => {
      if (!fullText) {
        console.log('[claude] first text delta arrived')
        if (getState().status === 'error') setStatus('live')
      }
      fullText += delta
      if (!currentAgentBubbleId) {
        currentAgentBubbleId = pushTranscript({ speaker: 'agent', text: fullText, partial: true })
        if (pendingCitations.length) {
          attachCitationsToBubble(currentAgentBubbleId, pendingCitations.splice(0))
        }
      } else {
        finalizeTranscript(currentAgentBubbleId, fullText)
        const item = getState().transcript.find((t) => t.id === currentAgentBubbleId)
        if (item) item.partial = true
      }
      sentenceSpeaker.push(delta)
    },
    onCitation: (cite) => {
      const preview = (cite.cited_text || '').slice(0, 80).replace(/\s+/g, ' ')
      console.log(
        `[citation] ${cite.document_title || cite.slug || 'unknown'} · "${preview}${(cite.cited_text || '').length > 80 ? '…' : ''}"`,
        currentAgentBubbleId ? '' : '(dropped — no bubble yet)'
      )
      if (currentAgentBubbleId) attachCitationsToBubble(currentAgentBubbleId, [cite])
      else pendingCitations.push(cite)
    },
    onToolUse: (tool) => handleToolCall(tool),
    onAssistantMessage: (msg) => {
      appendConversation({ role: msg.role, content: msg.content })
      if (currentAgentBubbleId && fullText) {
        finalizeTranscript(currentAgentBubbleId, fullText)
        const item = getState().transcript.find((t) => t.id === currentAgentBubbleId)
        if (item) item.partial = false
      }
      sentenceSpeaker.flush()

      const toolUses = msg.content.filter((c) => c.type === 'tool_use')
      if (toolUses.length) {
        const toolResults = toolUses.map((t) => ({
          type: 'tool_result',
          tool_use_id: t.id,
          content: t.name === 'escalate_to_partner' ? 'Escalation initiated. Inform the founder.' : 'Field saved.'
        }))
        appendConversation({ role: 'user', content: toolResults })
        // Defer so the current stream fully unwinds before the next request.
        // For tool follow-up turns there's no new user utterance, so reuse the
        // last founder query (or the start signal) as the retrieval query.
        const lastFounder = [...getState().conversation].reverse().find(
          (m) => m.role === 'user' && typeof m.content === 'string'
        )
        const followUpQuery = lastFounder?.content || retrievalQuery
        setTimeout(() => sendToClaude(getState().conversation, followUpQuery), 0)
      }

      if (fullText && /\?/.test(fullText)) {
        const lastQ = fullText.split('\n').reverse().find((line) => line.includes('?'))
        if (lastQ) {
          lastQuestionAsked = lastQ.trim()
          setNextQuestion(lastQuestionAsked)
        }
      }
    },
    onError: (err) => {
      console.error('[claude] stream error:', err)
      pushAudit(`API error: ${err.message}`)
      setStatus('error')
    },
    signal: inFlightAbort.signal
  })
}

function handleToolCall(tool) {
  if (tool.name === 'update_field') {
    const { section, field, value } = tool.input
    if (!section || !field || !value) return
    setField(section, field, String(value))
  } else if (tool.name === 'escalate_to_partner') {
    const reason = tool.input?.reason || 'Founder requested a human partner.'
    cancelSpeech()
    stopListening()
    startEscalation(reason)
  }
}

// ============== Mic visualization ==============

function startMicBars() {
  const leftBars = document.querySelectorAll('[data-bars="left"] span')
  const rightBars = document.querySelectorAll('[data-bars="right"] span')
  function tick() {
    const level = micPausedForTTS || aiSpeaking ? 0 : getMicLevel()
    const all = [...leftBars, ...rightBars]
    for (let i = 0; i < all.length; i++) {
      const wobble = Math.random() * 0.5 + 0.5
      const h = Math.max(6, Math.round(level * 50 * wobble + (level > 0 ? 8 : 0)))
      all[i].style.height = `${h}px`
      all[i].style.opacity = level > 0.02 ? '1' : '0.4'
    }
  }
  setInterval(tick, 80)
}
