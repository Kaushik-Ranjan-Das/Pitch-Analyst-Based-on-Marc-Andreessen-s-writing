// Renders the PA packet form section, syncs with state, supports inline edit.

import { SECTIONS, sectionCompletion, computeCompletion } from './form-schema.js'
import { setField, getState, subscribe } from './state.js'

const SECTION_TITLE = Object.fromEntries(SECTIONS.map((s) => [s.id, s.title]))

let mounted = false

export function mountForm(container) {
  if (mounted) return
  mounted = true

  for (const section of SECTIONS) {
    const sec = document.createElement('div')
    sec.className = 'form-section'
    sec.dataset.section = section.id

    const totalRequired = section.fields.filter((f) => f.required !== false).length
    sec.innerHTML = `
      <div class="section-head">
        <h3 class="section-title">${escapeHtml(section.title)}</h3>
        <span class="section-progress" data-section-progress="${section.id}">0 / ${totalRequired}</span>
        <div class="section-meter"><div class="section-meter-fill" data-section-meter="${section.id}"></div></div>
      </div>
      <div class="section-rows" data-section-rows="${section.id}"></div>
    `

    // Toggle expand on card click (but ignore clicks on inline-edit fields)
    sec.addEventListener('click', (e) => {
      if (e.target.closest('.field-row')) return
      const expanded = sec.dataset.expanded === 'true'
      sec.dataset.expanded = expanded ? 'false' : 'true'
    })
    const rowsEl = sec.querySelector(`[data-section-rows="${section.id}"]`)

    for (const field of section.fields) {
      const row = document.createElement('div')
      row.className = 'field-row'
      row.dataset.field = `${section.id}.${field.id}`
      if (field.mono) row.dataset.mono = 'true'

      row.innerHTML = `
        <div class="field-label">${escapeHtml(field.label)}${field.required === false ? ' <span style="color:var(--text-faint);font-size:11px">(optional)</span>' : ''}</div>
        <div class="field-value" contenteditable="plaintext-only" spellcheck="false" data-field-input data-status="missing">Missing: ${escapeHtml(field.label.toLowerCase())}</div>
        <div class="field-tag" data-field-tag>—</div>
      `

      const input = row.querySelector('[data-field-input]')
      input.addEventListener('focus', () => {
        if (input.dataset.status === 'missing') {
          input.textContent = ''
        }
      })
      input.addEventListener('blur', () => {
        const value = (input.textContent || '').trim()
        if (!value) {
          // Restore "Missing" state
          input.dataset.status = 'missing'
          input.textContent = `Missing: ${field.label.toLowerCase()}`
        } else {
          setField(section.id, field.id, value)
          row.querySelector('[data-field-tag]').textContent = 'Manual'
        }
      })
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { e.preventDefault(); input.blur() }
      })

      rowsEl.appendChild(row)
    }

    container.appendChild(sec)
  }

  subscribe((state) => syncForm(state))
  subscribe((state) => syncPacketTitle(state))
}

function syncPacketTitle(state) {
  const titleEl = document.querySelector('[data-packet-title]')
  if (!titleEl) return

  // Prefer the section of the most recent tool call. If none, fall back to
  // the first section that still has missing required fields. If everything
  // is filled, show the static "Authorization state".
  let active = state.activeSection
  if (!active) {
    for (const section of SECTIONS) {
      const sc = sectionCompletion(state.form, section.id)
      if (sc.pct < 100) { active = section.id; break }
    }
  }
  const { pct } = computeCompletion(state.form)
  if (pct === 100) active = null

  const next = active ? SECTION_TITLE[active] : 'Authorization state'
  if (titleEl.textContent !== next) titleEl.textContent = next
}

function syncForm(state) {
  for (const section of SECTIONS) {
    const sectionEl = document.querySelector(`[data-section="${section.id}"]`)
    if (!sectionEl) continue

    for (const field of section.fields) {
      const key = `${section.id}.${field.id}`
      const value = state.form[key]
      const row = sectionEl.querySelector(`[data-field="${key}"]`)
      if (!row) continue
      const input = row.querySelector('[data-field-input]')
      const tag = row.querySelector('[data-field-tag]')

      if (value && value.trim()) {
        if (input.textContent !== value) {
          input.textContent = value
          input.dataset.status = 'just-filled'
          requestAnimationFrame(() => {
            setTimeout(() => { if (input.dataset.status === 'just-filled') input.dataset.status = 'filled' }, 600)
          })
        } else if (input.dataset.status !== 'filled' && input.dataset.status !== 'just-filled') {
          input.dataset.status = 'filled'
        }
        if (tag.textContent === '—' || tag.textContent === '') tag.textContent = 'Claude extraction'
      } else {
        if (input.dataset.status !== 'missing') {
          input.dataset.status = 'missing'
          input.textContent = `Missing: ${field.label.toLowerCase()}`
          tag.textContent = '—'
        }
      }
    }

    // section progress + meter fill + completion state
    const { filled, total } = sectionCompletion(state.form, section.id)
    const progress = sectionEl.querySelector(`[data-section-progress="${section.id}"]`)
    if (progress) progress.textContent = `${filled} / ${total}`
    const meter = sectionEl.querySelector(`[data-section-meter="${section.id}"]`)
    if (meter) meter.style.width = total > 0 ? `${(filled / total) * 100}%` : '0%'
    if (filled === 0) sectionEl.removeAttribute('data-complete')
    else if (filled < total) sectionEl.dataset.complete = 'partial'
    else sectionEl.dataset.complete = 'full'
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}
