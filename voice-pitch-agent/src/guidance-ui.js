// Right-column UI: priority pill, "what Marc would press on next", blocking pills,
// completion ring, section dots, audit trail, ready-to-share panel.

import { subscribe } from './state.js'
import { SECTIONS, sectionCompletion, computeCompletion, blockingFields } from './form-schema.js'
import { showPopover } from './citations-ui.js'

function getRingCircumference($ring) {
  const r = parseFloat($ring?.getAttribute('r') || '64')
  return 2 * Math.PI * r
}

// Lightweight heuristic for "what Marc would press on next" — picks the
// weakest dimension and surfaces the framework that maps to it. The actual
// question Aparna asks comes from Claude; this is just a sidebar nudge.
const SECTION_PRESS = {
  problem: 'Is the problem urgent enough today, or is this a three-year-out bet? Marc: "Timing beats idea quality."',
  solution: 'Why is this possible now and not five years ago? Marc presses hard on the "why now" thesis.',
  market: 'How big does this get if it works? Marc: "The market is the single biggest factor — bigger than team, bigger than product."',
  traction: 'Show me the numbers that prove pull, not push. Marc: "Pre-PMF, nothing else matters."',
  team: 'Why is this team uniquely able to build this? Marc presses on the unfair advantage.',
  ask: 'Why this amount, why now? Marc: "Raise when you can, not when you need to."'
}

export function mountGuidance() {
  const $ring = document.querySelector('[data-ring]')
  const $ringPct = document.querySelector('[data-ring-pct]')
  const $ringSub = document.querySelector('[data-ring-sub]')
  const $sectionDots = document.querySelector('[data-section-dots]')
  const RING_CIRCUMFERENCE = getRingCircumference($ring)
  const $blocking = document.querySelector('[data-blocking]')
  const $priority = document.querySelector('[data-priority]')
  const $nextQ = document.querySelector('[data-next-question]')
  const $audit = document.querySelector('[data-audit]')
  const $pctBadge = document.querySelector('[data-pct-badge]')
  const $summary = document.querySelector('[data-summary]')
  const $required = document.querySelector('[data-required]')
  const $filePriority = document.querySelector('[data-file-priority]')
  const $nextAction = document.querySelector('[data-next-action]')
  const $fileBtn = document.querySelector('[data-file-btn]')
  const $press = document.querySelector('[data-press-prompt]')
  const $citedArticles = document.querySelector('[data-cited-articles]')
  const $citedCount = document.querySelector('[data-cited-count]')

  if ($sectionDots) {
    $sectionDots.innerHTML = SECTIONS.map((s) => `
      <li>
        <span class="label">
          <span class="dot" data-state="empty" data-section-dot="${s.id}"></span>
          <span class="label-text">${escapeHtml(s.title)}</span>
        </span>
        <span class="bar"><span class="bar-fill" data-section-bar="${s.id}" style="width:0%"></span></span>
        <span class="label-pct" data-section-dot-pct="${s.id}">0%</span>
      </li>
    `).join('')
  }

  if ($ring) {
    $ring.style.strokeDasharray = `${RING_CIRCUMFERENCE}`
    $ring.style.strokeDashoffset = `${RING_CIRCUMFERENCE}`
  }

  subscribe((state) => {
    const { pct, filled, total } = computeCompletion(state.form)

    if ($ringPct) $ringPct.textContent = `${pct}%`
    if ($ringSub) $ringSub.textContent = `${filled} of ${total}`
    if ($ring) $ring.style.strokeDashoffset = `${RING_CIRCUMFERENCE * (1 - pct / 100)}`

    for (const section of SECTIONS) {
      const sc = sectionCompletion(state.form, section.id)
      const dot = $sectionDots?.querySelector(`[data-section-dot="${section.id}"]`)
      const pctEl = $sectionDots?.querySelector(`[data-section-dot-pct="${section.id}"]`)
      const bar = $sectionDots?.querySelector(`[data-section-bar="${section.id}"]`)
      if (dot) dot.dataset.state = sc.pct === 100 ? 'complete' : sc.pct === 0 ? 'empty' : 'partial'
      if (pctEl) pctEl.textContent = `${sc.pct}%`
      if (bar) bar.style.width = `${sc.pct}%`
    }

    const blocking = blockingFields(state.form)
    if ($blocking) {
      $blocking.innerHTML = blocking.length
        ? blocking.slice(0, 12).map((f) => `<span class="blocking-pill">${escapeHtml(f.label)}</span>`).join('') +
          (blocking.length > 12 ? `<span class="blocking-pill">+${blocking.length - 12} more</span>` : '')
        : `<span class="blocking-pill" style="background:var(--filled-bg);color:var(--filled-text);border-color:var(--filled-border)">Every required field captured</span>`
    }

    if ($priority) {
      $priority.dataset.level = state.priority
      const priorityLabel = state.priority.charAt(0).toUpperCase() + state.priority.slice(1)
      $priority.textContent = state.priorityReason ? `${priorityLabel} — ${state.priorityReason}` : priorityLabel
    }

    if ($nextQ && state.nextQuestion) {
      $nextQ.textContent = state.nextQuestion
    }

    // "What Marc would press on" — pick weakest section that still has gaps
    if ($press) {
      const weakest = pickWeakestSection(state.form)
      $press.textContent = weakest ? SECTION_PRESS[weakest] : 'Packet is complete. Aparna will summarize and wrap.'
    }

    // Bibliography — every unique article Aparna has cited so far, with a
    // click-through to the original. Deduped by the same key the bottom
    // citations panel uses, so both surfaces stay in sync.
    if ($citedArticles) {
      const cites = state.citations || []
      const grouped = new Map()
      for (const c of cites) {
        const key = c.source_path || c.slug || c.document_title
        if (!key) continue
        if (!grouped.has(key)) {
          grouped.set(key, { ...c, count: 1, _key: key, _citations: [c] })
        } else {
          const g = grouped.get(key)
          g.count++
          g._citations.push(c)
        }
      }
      const items = Array.from(grouped.values()).sort((a, b) => b.count - a.count)
      if ($citedCount) $citedCount.textContent = String(items.length)

      if (!items.length) {
        $citedArticles.innerHTML = `<li class="cited-empty">Sources Aparna pulls from will appear here. Click any to open the original.</li>`
      } else {
        $citedArticles.innerHTML = items.map((g, i) => {
          const tag = g.source_url ? 'a' : 'div'
          const hrefAttr = g.source_url ? ` href="${escapeAttr(g.source_url)}" target="_blank" rel="noopener"` : ''
          return `<li><${tag} class="cited-article" data-cited-index="${i}"${hrefAttr}>
            <span class="cited-article-folder">${escapeHtml(g.source_folder || 'source')}</span>
            <span class="cited-article-title">${escapeHtml(g.document_title || g.slug || 'untitled')}</span>
            <span class="cited-article-count">${g.count}×</span>
            <span class="cited-article-arrow">${g.source_url ? '↗' : '···'}</span>
          </${tag}></li>`
        }).join('')
        // For entries with no source_url, clicking the row opens the popover.
        for (const el of $citedArticles.querySelectorAll('.cited-article')) {
          if (el.tagName === 'A') continue
          el.addEventListener('click', (e) => {
            e.preventDefault()
            const idx = Number(el.dataset.citedIndex)
            const group = items[idx]
            if (group) showPopover(el, group._citations)
          })
        }
      }
    }

    if ($audit) {
      $audit.innerHTML = state.audit.slice(-30).reverse().map((a) =>
        `<li><span class="audit-time">${escapeHtml(a.time)}</span><span>${escapeHtml(a.message)}</span></li>`
      ).join('') || '<li style="color:var(--text-faint);font-size:11px">No events yet</li>'
    }

    if ($pctBadge) {
      $pctBadge.textContent = `${pct}%`
      $pctBadge.dataset.complete = String(pct === 100)
    }

    if ($summary) $summary.textContent = buildSummary(state.form, pct)
    if ($filePriority) $filePriority.textContent = state.priority.charAt(0).toUpperCase() + state.priority.slice(1)
    if ($required) {
      $required.textContent = blocking.length
        ? blocking.slice(0, 5).map((f) => f.label).join(', ') + (blocking.length > 5 ? `, +${blocking.length - 5} more` : '')
        : 'Nothing — ready to share'
    }
    if ($nextAction) {
      $nextAction.textContent = blocking[0]
        ? `Capture ${blocking[0].label.toLowerCase()}`
        : (pct === 100 ? 'Share packet' : 'Continue pitch')
    }

    if ($fileBtn) $fileBtn.disabled = pct < 100
  })
}

function pickWeakestSection(form) {
  let worst = null
  let worstPct = 200
  for (const s of SECTIONS) {
    const sc = sectionCompletion(form, s.id)
    if (sc.pct < 100 && sc.pct < worstPct) {
      worst = s.id
      worstPct = sc.pct
    }
  }
  return worst
}

function buildSummary(form, pct) {
  const founders = form['team.founder_names']
  const what = form['solution.solution_summary']
  const customer = form['market.target_customer']
  const parts = []
  if (founders) parts.push(`${founders}`)
  if (what) parts.push(`building ${what}`)
  if (customer) parts.push(`for ${customer}`)
  if (!parts.length) return `Waiting on the founder — packet ${pct}% captured.`
  return parts.join(', ') + `. Packet ${pct}% captured.`
}

function escapeHtml(s) {
  return String(s ?? '').replace(/[&<>"]/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]))
}
function escapeAttr(s) { return escapeHtml(s).replace(/'/g, '&#39;') }
