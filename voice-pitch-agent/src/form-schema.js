// Source of truth for the pitch packet. The Claude tool definition, the rendered
// UI, and the completion calculation all read from here.

export const SECTIONS = [
  {
    id: 'problem',
    title: 'Problem',
    fields: [
      { id: 'problem_statement', label: 'Problem statement' },
      { id: 'who_it_affects', label: 'Who it affects' },
      { id: 'urgency_evidence', label: 'Why it matters now' }
    ]
  },
  {
    id: 'solution',
    title: 'Solution',
    fields: [
      { id: 'solution_summary', label: 'What you built' },
      { id: 'why_now', label: 'Why now' },
      { id: 'current_stage', label: 'Stage', mono: true }
    ]
  },
  {
    id: 'market',
    title: 'Market',
    fields: [
      { id: 'target_customer', label: 'Target customer' },
      { id: 'market_size_estimate', label: 'Market size', mono: true },
      { id: 'market_timing_thesis', label: 'Market timing thesis' }
    ]
  },
  {
    id: 'traction',
    title: 'Traction',
    fields: [
      { id: 'users_or_customers', label: 'Users / customers' },
      { id: 'revenue_run_rate', label: 'Revenue run rate', mono: true, required: false },
      { id: 'growth_rate', label: 'Growth rate', mono: true, required: false },
      { id: 'key_metrics', label: 'Key metrics' },
      { id: 'retention_signal', label: 'Retention / engagement', required: false }
    ]
  },
  {
    id: 'team',
    title: 'Team',
    fields: [
      { id: 'founder_names', label: 'Founders' },
      { id: 'founder_backgrounds', label: 'Backgrounds' },
      { id: 'unfair_advantage', label: 'Unfair advantage' }
    ]
  },
  {
    id: 'ask',
    title: 'Ask',
    fields: [
      { id: 'round_target', label: 'Round target', mono: true },
      { id: 'valuation_expectation', label: 'Valuation expectation', mono: true, required: false },
      { id: 'use_of_funds', label: 'Use of funds' }
    ]
  }
]

export const ALL_FIELDS = SECTIONS.flatMap((s) =>
  s.fields.map((f) => ({ ...f, section: s.id, sectionTitle: s.title }))
)

export const REQUIRED_FIELDS = ALL_FIELDS.filter((f) => f.required !== false)

export const FIELD_LABEL = Object.fromEntries(ALL_FIELDS.map((f) => [`${f.section}.${f.id}`, f.label]))

export function emptyForm() {
  const form = {}
  for (const f of ALL_FIELDS) form[`${f.section}.${f.id}`] = ''
  return form
}

export function computeCompletion(form) {
  const filled = REQUIRED_FIELDS.filter((f) => (form[`${f.section}.${f.id}`] || '').trim() !== '')
  const total = REQUIRED_FIELDS.length
  return {
    filled: filled.length,
    total,
    pct: total === 0 ? 0 : Math.round((filled.length / total) * 100)
  }
}

export function sectionCompletion(form, sectionId) {
  const fields = SECTIONS.find((s) => s.id === sectionId)?.fields.filter((f) => f.required !== false) || []
  const filled = fields.filter((f) => (form[`${sectionId}.${f.id}`] || '').trim() !== '')
  return {
    filled: filled.length,
    total: fields.length,
    pct: fields.length === 0 ? 0 : Math.round((filled.length / fields.length) * 100)
  }
}

export function blockingFields(form) {
  return REQUIRED_FIELDS.filter((f) => !(form[`${f.section}.${f.id}`] || '').trim())
}
