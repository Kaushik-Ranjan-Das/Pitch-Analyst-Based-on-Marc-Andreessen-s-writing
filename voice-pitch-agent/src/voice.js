// Voice IO. STT via Web Speech API (Chrome/Edge/Safari), TTS via SpeechSynthesis.
// Both are browser-native — zero extra API keys, decent latency for a demo.

let recognition = null
let recognitionShouldRun = false       // user intent — should we be listening?
let recognitionPausedForTTS = false    // temporarily stopped while Aparna speaks
let recognitionRunning = false         // actual state from onstart/onend
let recognitionStartPending = false    // start() called, waiting for onstart/onerror
let onFinalUtterance = null
let onInterim = null
let onSttError = null
let analyser = null
let audioCtx = null

// Exposed so the UI can show real STT state for debugging.
export function getSttState() {
  return {
    shouldRun: recognitionShouldRun,
    pausedForTTS: recognitionPausedForTTS,
    running: recognitionRunning,
    startPending: recognitionStartPending
  }
}

// Make actual STT state match the desired state. Idempotent — safe to call
// repeatedly from onstart/onend/onerror or external triggers.
function ensureRecognitionState() {
  if (!recognition) return
  const shouldBeRunning = recognitionShouldRun && !recognitionPausedForTTS

  if (shouldBeRunning && !recognitionRunning && !recognitionStartPending) {
    recognitionStartPending = true
    try {
      recognition.start()
    } catch (err) {
      // Chrome throws InvalidStateError if start() is called within ~300ms of
      // a previous stop(). Wait and retry.
      console.warn('[voice] STT start() threw, retrying:', err.message)
      recognitionStartPending = false
      setTimeout(ensureRecognitionState, 350)
    }
  } else if (!shouldBeRunning && recognitionRunning) {
    try { recognition.stop() } catch {}
  }
}

const SpeechRecognitionImpl =
  typeof window !== 'undefined' && (window.SpeechRecognition || window.webkitSpeechRecognition)

export function isSTTSupported() {
  return Boolean(SpeechRecognitionImpl)
}

export async function startListening({ onFinal, onInterim: onInt, onError }) {
  if (!SpeechRecognitionImpl) {
    throw new Error('Web Speech API not supported. Use Chrome, Edge, or Safari.')
  }
  if (recognitionShouldRun) return

  // Mic permission + waveform analyser
  const stream = await navigator.mediaDevices.getUserMedia({ audio: true })
  audioCtx = audioCtx || new (window.AudioContext || window.webkitAudioContext)()
  if (audioCtx.state === 'suspended') await audioCtx.resume()
  const source = audioCtx.createMediaStreamSource(stream)
  analyser = audioCtx.createAnalyser()
  analyser.fftSize = 256
  source.connect(analyser)

  recognition = new SpeechRecognitionImpl()
  recognition.continuous = true
  recognition.interimResults = true
  recognition.lang = 'en-US'

  onFinalUtterance = onFinal
  onInterim = onInt
  onSttError = onError

  recognition.onresult = (event) => {
    let interim = ''
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const result = event.results[i]
      const transcript = result[0].transcript
      if (result.isFinal) {
        if (onFinalUtterance) onFinalUtterance(transcript.trim())
      } else {
        interim += transcript
      }
    }
    if (interim && onInterim) onInterim(interim.trim())
  }

  recognition.onstart = () => {
    recognitionRunning = true
    recognitionStartPending = false
    console.log('[voice] STT onstart — listening')
  }

  recognition.onerror = (event) => {
    console.warn(`[voice] STT onerror: ${event.error}`)
    recognitionStartPending = false
    // 'no-speech' is harmless; everything else may have stopped the engine
    if (event.error === 'no-speech') return
    if (onSttError) onSttError(event.error)
    // Some errors (audio-capture, network, aborted) end the session; onend
    // will fire and ensureRecognitionState will restart if desired.
  }

  recognition.onend = () => {
    recognitionRunning = false
    recognitionStartPending = false
    console.log('[voice] STT onend')
    // Reconcile: restart if we still want to be listening (e.g. browser
    // session cap, or pause-then-resume sequence).
    ensureRecognitionState()
  }

  recognitionShouldRun = true
  ensureRecognitionState()
}

export function stopListening() {
  recognitionShouldRun = false
  recognitionPausedForTTS = false
  if (recognition) {
    try { recognition.stop() } catch {}
    recognition = null
  }
  recognitionRunning = false
  recognitionStartPending = false
  if (audioCtx) {
    audioCtx.close().catch(() => {})
    audioCtx = null
  }
  analyser = null
}

// Chrome/Safari mute SpeechSynthesis output when SpeechRecognition is active
// at the OS audio layer. Stop the recognizer while the AI is speaking, restart
// it after the queue drains.
function pauseRecognitionForTTS() {
  if (!recognition || !recognitionShouldRun || recognitionPausedForTTS) return
  recognitionPausedForTTS = true
  console.log('[voice] recognition paused for TTS')
  ensureRecognitionState()
}

function resumeRecognitionAfterTTS() {
  if (!recognition || !recognitionShouldRun || !recognitionPausedForTTS) return
  recognitionPausedForTTS = false
  console.log('[voice] recognition resumed after TTS')
  ensureRecognitionState()
}

export function getMicLevel() {
  if (!analyser) return 0
  const data = new Uint8Array(analyser.frequencyBinCount)
  analyser.getByteFrequencyData(data)
  let sum = 0
  for (let i = 0; i < data.length; i++) sum += data[i]
  return sum / data.length / 255 // 0-1
}

// ============== TTS ==============

let voiceCache = []
let preferredVoice = null
let voicesReady = false
const voicesReadyWaiters = []
const voiceChangeListeners = []
const VOICE_STORAGE_KEY = 'aparna.preferredVoice'

function loadVoices() {
  voiceCache = window.speechSynthesis.getVoices()
  if (!voiceCache.length) return

  // 1) Try user's saved choice first
  const saved = (() => { try { return localStorage.getItem(VOICE_STORAGE_KEY) } catch { return null } })()
  if (saved) {
    const match = voiceCache.find((v) => v.name === saved)
    if (match) preferredVoice = match
  }

  // 2) Otherwise, prefer high-quality (cloud-backed / premium) voices, then
  //    fall back to the Indian-female-name list, then en-IN, then any English.
  //    Cloud voices have far smoother prosody than the basic local ones, which
  //    is the single biggest lever on perceived audio quality.
  const isPremium = (v) =>
    v.localService === false
    || v.name.startsWith('Google')
    || / \((Premium|Enhanced)\)$/i.test(v.name)
  const indianNames = ['Tara', 'Veena', 'Tarini', 'Lekha', 'Isha', 'Sangeeta', 'Priya', 'Kiran']

  // 2a) Indian female + premium
  if (!preferredVoice) {
    preferredVoice = voiceCache.find(
      (v) => isPremium(v) && indianNames.some((n) => v.name.includes(n))
    )
  }
  // 2b) Any premium English voice
  if (!preferredVoice) {
    preferredVoice = voiceCache.find(
      (v) => isPremium(v) && v.lang?.startsWith('en')
    )
  }
  // 2c) Indian female names (any quality)
  if (!preferredVoice) {
    for (const name of indianNames) {
      const match = voiceCache.find((v) => v.name.includes(name))
      if (match) { preferredVoice = match; break }
    }
  }
  if (!preferredVoice) preferredVoice = voiceCache.find((v) => v.lang === 'en-IN')
  if (!preferredVoice) preferredVoice = voiceCache.find((v) => v.lang?.startsWith('en')) || voiceCache[0]

  voicesReady = true
  while (voicesReadyWaiters.length) voicesReadyWaiters.shift()()
  for (const fn of voiceChangeListeners) fn()
  console.log(`[voice] ${voiceCache.length} voices loaded, picked: ${preferredVoice?.name || 'default'}`)
}

export function listVoices() {
  // Show all voices, but float Google (cloud-backed, usually higher quality)
  // and Indian English/Hindi voices to the top so the user finds them first.
  const sorted = [...voiceCache]
  sorted.sort((a, b) => rank(a) - rank(b) || a.name.localeCompare(b.name))
  return sorted

  function rank(v) {
    const isGoogle = v.name.startsWith('Google')
    const isIndian = v.lang === 'en-IN' || v.lang === 'hi-IN'
    if (isGoogle && isIndian) return 0
    if (isGoogle) return 1
    if (isIndian) return 2
    if (v.lang?.startsWith('en')) return 3
    return 4
  }
}

export function getPreferredVoiceName() {
  return preferredVoice?.name || ''
}

export function setPreferredVoiceByName(name) {
  const match = voiceCache.find((v) => v.name === name)
  if (!match) return false
  preferredVoice = match
  try { localStorage.setItem(VOICE_STORAGE_KEY, name) } catch {}
  console.log(`[voice] preferred voice set to: ${name}`)
  return true
}

export function onVoicesChanged(fn) {
  voiceChangeListeners.push(fn)
  if (voicesReady) fn()
}

if (typeof window !== 'undefined' && 'speechSynthesis' in window) {
  loadVoices()
  window.speechSynthesis.onvoiceschanged = loadVoices
  // Some browsers never fire onvoiceschanged. Treat empty list as ready after 500ms.
  setTimeout(() => {
    if (!voicesReady) {
      voicesReady = true
      while (voicesReadyWaiters.length) voicesReadyWaiters.shift()()
      console.warn('[voice] voices not loaded after 500ms; speaking with browser default')
    }
  }, 500)
}

function whenVoicesReady() {
  if (voicesReady) return Promise.resolve()
  return new Promise((r) => voicesReadyWaiters.push(r))
}

const speakQueue = []
let speakingNow = false
let onSpeechStart = null
let onSpeechEnd = null

// Chrome has a long-standing bug where SpeechSynthesis pauses itself after ~15s
// of audio. The fix: poll resume() while we're speaking. Costs nothing on
// browsers that don't have the bug.
let resumeWatchdog = null
function startResumeWatchdog() {
  if (resumeWatchdog) return
  resumeWatchdog = setInterval(() => {
    if (window.speechSynthesis.speaking && window.speechSynthesis.paused) {
      window.speechSynthesis.resume()
    }
  }, 250)
}
function stopResumeWatchdog() {
  if (resumeWatchdog) { clearInterval(resumeWatchdog); resumeWatchdog = null }
}

export function setSpeechCallbacks({ onStart, onEnd }) {
  onSpeechStart = onStart
  onSpeechEnd = onEnd
}

export async function speak(text) {
  if (!text || !text.trim()) return
  if (!('speechSynthesis' in window)) {
    console.warn('[voice] speechSynthesis not supported in this browser')
    return
  }
  console.log(`[voice] queueing utterance (${text.length} chars):`, text.slice(0, 60))
  speakQueue.push(text)
  await whenVoicesReady()
  drainSpeakQueue()
}

export function cancelSpeech() {
  speakQueue.length = 0
  if ('speechSynthesis' in window) window.speechSynthesis.cancel()
  speakingNow = false
  stopResumeWatchdog()
  resumeRecognitionAfterTTS()
}

function drainSpeakQueue() {
  if (speakingNow) return
  const next = speakQueue.shift()
  if (!next) return

  speakingNow = true
  startResumeWatchdog()
  pauseRecognitionForTTS()

  const utt = new SpeechSynthesisUtterance(next)
  if (preferredVoice) utt.voice = preferredVoice
  utt.rate = 1.0
  utt.pitch = 1.0
  utt.volume = 1.0

  // Failsafe: if onend never fires (Chrome bug), force-advance after a generous timeout.
  // ~12 chars/sec for spoken English, plus 2s padding.
  const expectedMs = Math.max(2000, (next.length / 12) * 1000 + 2000)
  let advanceTimer = setTimeout(() => {
    console.warn('[voice] utterance timed out without onend, advancing queue')
    finalize()
  }, expectedMs)

  function finalize() {
    if (advanceTimer) { clearTimeout(advanceTimer); advanceTimer = null }
    speakingNow = false
    if (onSpeechEnd) onSpeechEnd(next)
    if (!speakQueue.length) {
      stopResumeWatchdog()
      // Give the OS audio layer a moment to release the synthesis channel
      // before re-opening the mic, otherwise STT can pick up TTS tail audio.
      setTimeout(resumeRecognitionAfterTTS, 200)
    }
    drainSpeakQueue()
  }

  utt.onstart = () => {
    console.log('[voice] utterance started')
    if (onSpeechStart) onSpeechStart(next)
  }
  utt.onend = () => {
    console.log('[voice] utterance ended')
    finalize()
  }
  utt.onerror = (e) => {
    console.warn('[voice] utterance error:', e?.error || e)
    finalize()
  }

  try {
    window.speechSynthesis.speak(utt)
  } catch (err) {
    console.error('[voice] speak() threw:', err)
    finalize()
  }
}

// Diagnostic — bound to the UI's "Test speaker" button.
export function testSpeaker() {
  cancelSpeech()
  speak('Test, one two three. If you can hear this, the voice agent will be audible.')
}

// Microphone test — opens the mic, shows live audio level, runs STT for ~6s,
// reports what it heard. Calls onUpdate({lines, level, listening, done}) repeatedly.
export async function testMicrophone(onUpdate) {
  const lines = []
  const log = (s) => { lines.push(s); console.log(`[mic-test] ${s}`) }
  let level = 0
  let listening = false
  let done = false

  const tick = () => onUpdate?.({ lines: lines.join('\n'), level, listening, done })

  log(`UA: ${navigator.userAgent}`)
  log(`SpeechRecognition supported: ${Boolean(SpeechRecognitionImpl)}`)
  tick()

  if (!SpeechRecognitionImpl) {
    log('VERDICT: this browser does not support SpeechRecognition. Use Chrome, Edge, or Safari.')
    done = true; tick(); return
  }

  // Get mic stream
  let stream
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    log('✓ mic permission granted')
  } catch (err) {
    log(`✗ mic permission denied or failed: ${err.message}`)
    log('VERDICT: browser blocked mic access. Check the site permission (lock icon → Microphone).')
    done = true; tick(); return
  }
  tick()

  // Audio level meter
  const ctx = new (window.AudioContext || window.webkitAudioContext)()
  if (ctx.state === 'suspended') await ctx.resume()
  const source = ctx.createMediaStreamSource(stream)
  const an = ctx.createAnalyser()
  an.fftSize = 256
  source.connect(an)
  const data = new Uint8Array(an.frequencyBinCount)
  let peakLevel = 0
  const meterId = setInterval(() => {
    an.getByteFrequencyData(data)
    let sum = 0
    for (let i = 0; i < data.length; i++) sum += data[i]
    level = sum / data.length / 255
    if (level > peakLevel) peakLevel = level
    tick()
  }, 80)

  // Speech recognition
  const rec = new SpeechRecognitionImpl()
  rec.continuous = true
  rec.interimResults = true
  rec.lang = 'en-US'
  let heardInterim = ''
  let heardFinal = ''
  let sttError = null

  rec.onstart = () => { listening = true; log('✓ STT onstart — listening for ~6 seconds'); log('Say something now…'); tick() }
  rec.onresult = (event) => {
    let interim = ''
    for (let i = event.resultIndex; i < event.results.length; i++) {
      const r = event.results[i]
      if (r.isFinal) heardFinal += (heardFinal ? ' ' : '') + r[0].transcript.trim()
      else interim += r[0].transcript
    }
    heardInterim = interim.trim()
    if (heardFinal || heardInterim) {
      // Replace last line if it starts with HEARD; else append.
      if (lines.length && lines[lines.length - 1].startsWith('HEARD:')) lines.pop()
      lines.push(`HEARD: ${heardFinal}${heardInterim ? ` [interim: ${heardInterim}]` : ''}`)
      tick()
    }
  }
  rec.onerror = (e) => {
    sttError = e?.error
    if (sttError && sttError !== 'no-speech') log(`✗ STT onerror: ${sttError}`)
    tick()
  }
  rec.onend = () => { listening = false; log('STT onend'); tick() }

  try {
    rec.start()
  } catch (err) {
    log(`✗ STT start() threw: ${err.message}`)
    log('VERDICT: SpeechRecognition could not start. Try refreshing the page.')
    clearInterval(meterId)
    stream.getTracks().forEach((t) => t.stop())
    ctx.close().catch(() => {})
    done = true; tick(); return
  }

  // Run for 6 seconds, then stop and report
  await new Promise((r) => setTimeout(r, 6000))
  try { rec.stop() } catch {}
  await new Promise((r) => setTimeout(r, 300))

  clearInterval(meterId)
  stream.getTracks().forEach((t) => t.stop())
  ctx.close().catch(() => {})

  log('')
  log(`peak audio level: ${(peakLevel * 100).toFixed(1)}%`)
  if (peakLevel < 0.02) {
    log('VERDICT: mic stream is silent. Check macOS Sound Input device (System Settings → Sound → Input) — Chrome routes audio from the system default input. Verify input level > 0 when you speak.')
  } else if (!heardFinal && !heardInterim) {
    log('VERDICT: audio came through (peak %.1f) but STT transcribed nothing. Common causes: (1) speaking too softly or background noise too loud, (2) microphone language mismatch, (3) you didn\'t speak during the window. Try again and speak clearly.'.replace('%.1f', (peakLevel * 100).toFixed(1)))
  } else if (sttError && sttError !== 'no-speech') {
    log(`VERDICT: STT reported error "${sttError}". This usually clears with a page refresh.`)
  } else {
    log('VERDICT: ✓ mic and STT both working. You should be able to talk to Aparna in a pitch session.')
  }
  done = true; tick()
}

// Deep diagnostic — speaks a phrase synchronously with bare-bones config (no
// preferred voice, no rate tweak, no queue) and reports every signal we can
// observe from SpeechSynthesis. Calls onUpdate(reportString) repeatedly as
// async events arrive over ~3 seconds.
export function diagnoseSpeech(onUpdate) {
  const lines = []
  const log = (s) => {
    lines.push(s)
    console.log(`[diag] ${s}`)
    if (onUpdate) onUpdate(lines.join('\n'))
  }

  log(`UA: ${navigator.userAgent}`)
  log(`speechSynthesis available: ${'speechSynthesis' in window}`)
  if (!('speechSynthesis' in window)) return

  const ss = window.speechSynthesis
  log(`state: speaking=${ss.speaking} paused=${ss.paused} pending=${ss.pending}`)
  const voices = ss.getVoices()
  log(`voices.length: ${voices.length}`)
  if (voices.length) {
    const en = voices.filter((v) => v.lang?.startsWith('en'))
    log(`english voices: ${en.length}`)
    log(`first 5: ${voices.slice(0, 5).map((v) => `${v.name} [${v.lang}]${v.default ? ' (default)' : ''}`).join(' | ')}`)
  } else {
    log('NO VOICES LOADED — likely cause of silence on Chrome.')
  }

  ss.cancel()

  // Try an explicit en-US voice to rule out default-voice routing weirdness
  const enVoice = voices.find((v) => v.name === 'Alex')
    || voices.find((v) => v.name === 'Daniel')
    || voices.find((v) => v.name === 'Samantha')
    || voices.find((v) => v.lang === 'en-US')

  const utt = new SpeechSynthesisUtterance('Diagnostic test. One. Two. Three.')
  if (enVoice) {
    utt.voice = enVoice
    log(`using voice: ${enVoice.name} [${enVoice.lang}] localService=${enVoice.localService}`)
  } else {
    log('using browser default voice (no explicit pick)')
  }
  utt.volume = 1.0
  utt.rate = 1.0
  utt.pitch = 1.0

  const t0 = performance.now()
  let started = false
  let ended = false
  let errored = null

  utt.onstart = () => { started = true; log(`✓ onstart fired @ ${Math.round(performance.now() - t0)}ms`) }
  utt.onend = () => { ended = true; log(`✓ onend fired @ ${Math.round(performance.now() - t0)}ms`) }
  utt.onerror = (e) => { errored = e?.error || String(e); log(`✗ onerror: ${errored}`) }

  try {
    ss.speak(utt)
    log('speak() called — no exception')
  } catch (err) {
    log(`speak() threw: ${err.message}`)
  }

  setTimeout(() => {
    log(`+200ms snapshot: speaking=${ss.speaking} started=${started} ended=${ended} error=${errored}`)
  }, 200)
  setTimeout(() => {
    log(`+2500ms snapshot: speaking=${ss.speaking} started=${started} ended=${ended} error=${errored}`)
    if (!started && !errored) {
      log('VERDICT: speak() accepted but onstart never fired. The TTS engine is wedged. Try: (1) close all browser tabs and reopen, (2) System Settings → Accessibility → Spoken Content → click the Play button to confirm macOS itself can speak, (3) try a different voice from the dropdown.')
    } else if (started && !ended) {
      log('VERDICT: TTS is running (onstart fired) but you cannot hear it. This is an OUTPUT DEVICE issue, not a code issue. Check: System Settings → Sound → Output — is it set to your speakers/headphones? Chrome routes TTS through the system default output, which can differ from media playback output.')
    } else if (started && ended && Math.round(performance.now() - t0) < 500) {
      log('VERDICT: onend fired suspiciously fast — engine aborted silently. Try a different voice.')
    } else if (started && ended) {
      log('VERDICT: TTS appears to have completed normally. If you still heard nothing, output device routing is the issue.')
    }
  }, 2500)
}

// Sentence-buffered TTS — feed streamed deltas, speak chunks of ~140+ chars
// so we don't hand the browser dozens of one-sentence utterances (each gap
// between utterances is audible and is what makes the agent sound choppy).
const MIN_SPEAK_CHARS = 140

export function createSentenceSpeaker() {
  let buf = ''      // unparsed text (may end mid-sentence)
  let pending = ''  // completed sentences waiting to be batched
  return {
    push(chunk) {
      buf += chunk
      const segments = splitSentences(buf)
      // All but the last segment are complete sentences.
      while (segments.length > 1) {
        const ready = segments.shift()
        pending += (pending ? ' ' : '') + ready
      }
      buf = segments[0] || ''
      if (pending.length >= MIN_SPEAK_CHARS) {
        speak(pending)
        pending = ''
      }
    },
    flush() {
      if (buf.trim()) {
        pending += (pending ? ' ' : '') + buf.trim()
        buf = ''
      }
      if (pending.trim()) {
        speak(pending.trim())
        pending = ''
      }
    },
    cancel() {
      buf = ''
      pending = ''
      cancelSpeech()
    }
  }
}

// Abbreviations whose trailing period must NOT be treated as a sentence end.
// Match the lowercased token ending right before the period.
const ABBREVIATIONS = new Set([
  'mr', 'mrs', 'ms', 'dr', 'prof', 'sr', 'jr', 'st',
  'vs', 'etc', 'e.g', 'i.e', 'u.s', 'u.k',
  'inc', 'co', 'ltd', 'no', 'fig', 'ave', 'blvd',
])

function splitSentences(text) {
  // Split after sentence-ending punctuation followed by whitespace or end.
  // Keep the punctuation. Avoid splitting on abbreviations, decimals, and
  // ellipses — those are the main sources of mid-phrase fragmentation.
  const out = []
  let cur = ''
  for (let i = 0; i < text.length; i++) {
    cur += text[i]
    const ch = text[i]
    const next = text[i + 1]
    const isTerminator = ch === '.' || ch === '!' || ch === '?'
    if (!isTerminator) continue
    if (next && !/\s/.test(next)) continue

    if (ch === '.') {
      // Ellipsis — current char is the last dot of "...", treat as mid-thought,
      // not a sentence break.
      if (text[i - 1] === '.' || text[i + 1] === '.') continue

      // Decimal — "1.5", "2.0".
      const prev = text[i - 1]
      const nextNonSpace = (() => {
        let j = i + 1
        while (j < text.length && /\s/.test(text[j])) j++
        return text[j]
      })()
      if (prev && /\d/.test(prev) && nextNonSpace && /\d/.test(nextNonSpace)) continue

      // Abbreviation — pull the word ending at this period.
      let start = i - 1
      while (start >= 0 && /[A-Za-z.]/.test(text[start])) start--
      const token = text.slice(start + 1, i).toLowerCase()
      if (token && ABBREVIATIONS.has(token)) continue

      // Next visible character isn't an uppercase letter / digit / quote /
      // opening bracket — almost certainly not a real sentence boundary.
      if (nextNonSpace && !/[A-Z0-9"'(\[]/.test(nextNonSpace)) continue
    }

    out.push(cur.trim())
    cur = ''
  }
  if (cur) out.push(cur)
  return out
}
