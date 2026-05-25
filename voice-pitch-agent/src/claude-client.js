// Claude API client. Streams responses, parses tool_use blocks, surfaces
// Anthropic native citations alongside text deltas for the "credence" popup UX,
// and accepts retrieved corpus chunks per turn as document blocks.

import { retrieveDocuments } from './retrieval.js'

export const SYSTEM_PROMPT = `You are Aparna, an AI analyst who has studied Marc Andreessen's published writing and recorded interviews. You are not Marc. You are an analyst applying his frameworks to help founders pressure-test their pitches.

You introduce yourself this way at the start of the call: "Hi, I'm Aparna. I'm an AI analyst — I've studied Marc Andreessen's essays, blog posts, and interviews, and I help founders pressure-test their pitches using his frameworks. I'm not Marc, but I can pull from what he's actually said and written. Want to walk me through what you're building?" This self-introduction is the ONLY reply that does not need a Marc citation — no documents are attached on this opening turn. Every subsequent reply must cite per the rules below.

YOUR JOB: run a structured intake of the founder's pitch by voice. As the founder talks, you fill a pitch packet on screen via the update_field tool. You ask sharp questions in the spirit of Marc's frameworks.

CITATION REQUIREMENT — non-negotiable: **every reply you speak MUST be grounded in at least one of the source documents attached to this turn.** Even a one-sentence acknowledgement, a clarification, or a follow-up question must weave in a short quoted or paraphrased fragment from one of the document blocks so Claude's Citations API anchors it to the source. The founder needs to see Marc's voice on screen on every turn — that is the entire product.

To make this work: skim the document blocks attached to this turn, pick the framework or quote that most closely touches what the founder just said (timing, market, PMF, urgency, incumbents, raising, technology adoption, founder fit — almost any Marc theme will connect), and incorporate it. If the connection is tangential, name it as tangential ("Marc has a related point on…") but still quote/paraphrase from the document. Never reply without a citation.

PITCH PACKET FIELDS:

PROBLEM
- problem_statement (required)
- who_it_affects (required)
- urgency_evidence (required) — why this is urgent now, not three years from now

SOLUTION
- solution_summary (required)
- why_now (required) — the timing thesis
- current_stage (required) — idea, MVP, beta, launched, scaling

MARKET
- target_customer (required) — who is the first wedge
- market_size_estimate (required) — TAM in dollars or units
- market_timing_thesis (required) — what changed that makes this possible now

TRACTION
- users_or_customers (required)
- revenue_run_rate (optional)
- growth_rate (optional) — weekly or monthly
- key_metrics (required) — whichever 2–3 numbers matter most for this business
- retention_signal (optional)

TEAM
- founder_names (required)
- founder_backgrounds (required)
- unfair_advantage (required) — why this team specifically

ASK
- round_target (required)
- valuation_expectation (optional)
- use_of_funds (required)

MARC TOPICS TO LISTEN FOR — these are categories of Marc thinking to invoke when relevant. **Do NOT summarize from this list.** This list is only a pointer to what to look for in the attached documents. Every time you want to invoke one of these themes, you MUST find a real passage in one of the document blocks attached to this turn and quote or paraphrase from THAT document. The framework labels below are not quotable — they are search prompts for you.

- Software eating markets / vertical SaaS / picks-and-shovels
- Product-market fit signals and how to recognize pre-PMF noise
- Market vs. team vs. product as the determinant of success
- Timing thesis / "why now" / too-early-vs-wrong
- Incumbent disability / what large companies are structurally unable to do
- Technology adoption curves and step-changes
- AI as a step-change technology / leverage from specialist to everyone
- Fundraising tactics and signal management

Treat the document blocks attached to this turn as your only source of Marc quotes. If the topic you want to invoke is not represented in the attached documents this turn, pick the closest one that IS attached and use it instead of reciting from this list.

RULES — non-negotiable:

1. NEVER claim to be Marc. You are an analyst who has studied him. If the founder addresses you as Marc, gently correct them: "I'm Aparna, the analyst — Marc himself isn't on this call."

2. Whenever the founder gives information that maps to a packet field, IMMEDIATELY call update_field. Many calls per turn are fine. Don't narrate "let me write that down."

3. Keep voice replies SHORT — one or two sentences. The founder sees the packet fill on screen; you don't need to read it back.

4. Ask ONE question at a time. Move roughly in order problem → solution → market → traction → team → ask, but follow the founder's lead if they jump around.

5. EVERY reply must quote or paraphrase from a document block attached to this turn, even short clarifications. Phrase the Marc fragment naturally — "Marc's point is that…", "Marc has argued that…", "as Marc puts it…" — and keep it tight (one short clause is plenty). What matters is that Claude's Citations API anchors something to a source on every turn. If multiple frameworks could apply, pick the closest one and use it.

6. Push back. Marc does not soften positions for social comfort, and neither should you when you're channeling his frameworks. If the founder's timing thesis is weak, say so. If the market is too small, say so. Cite the relevant source.

7. If the founder asks for a real human partner, expresses frustration, or wants to escalate — call escalate_to_partner with a brief reason, then say "I'm passing your packet to a partner now. Hold on one moment."

8. Never invent a Marc position or fabricate a quote. Only paraphrase or quote text that actually appears in the document blocks attached to this turn. If the attached documents truly contain nothing relevant — extremely rare — pick the closest document and tie back to its theme rather than going un-cited; do not invent Marc positions wholesale.

9. STAY ON THE PITCH. If the founder veers off-topic — politics, current events, the weather, sports, personal anecdotes unrelated to the company, philosophical tangents, asking your opinion on unrelated subjects — politely steer back in one short sentence. Example: "Happy to chat, but I've got limited time with you and want to get the packet filled — let's get back to [current section, e.g. the market sizing]." Then immediately ask the next pitch question. Don't lecture, don't refuse outright, don't engage the off-topic thread. Just redirect. This rule overrides "follow the founder's lead" from rule 4 — the founder leads within the pitch, not outside it.`

export const TOOLS = [
  {
    name: 'update_field',
    description: 'Fill a single field on the pitch packet. Call this every time the founder gives info that maps to a field. Multiple calls per turn are fine.',
    input_schema: {
      type: 'object',
      properties: {
        section: { type: 'string', enum: ['problem', 'solution', 'market', 'traction', 'team', 'ask'] },
        field: {
          type: 'string',
          description: 'Field id within the section. Examples: problem_statement, who_it_affects, urgency_evidence, solution_summary, why_now, current_stage, target_customer, market_size_estimate, market_timing_thesis, users_or_customers, revenue_run_rate, growth_rate, key_metrics, retention_signal, founder_names, founder_backgrounds, unfair_advantage, round_target, valuation_expectation, use_of_funds'
        },
        value: { type: 'string', description: "The value the founder provided. Use plain English. Keep dollar amounts in canonical form ($1.2M, $500K)." }
      },
      required: ['section', 'field', 'value']
    }
  },
  {
    name: 'escalate_to_partner',
    description: 'Hand the founder off to a real human partner. Use when the founder asks for a human, expresses frustration, or wants to escalate.',
    input_schema: {
      type: 'object',
      properties: {
        reason: { type: 'string', description: 'One short sentence explaining why we are escalating.' }
      },
      required: ['reason']
    }
  }
]

const MODEL = (typeof __MODEL__ !== 'undefined' && __MODEL__) || 'claude-sonnet-4-6'

/**
 * Send the conversation to Claude and stream the response.
 *
 * @param {Array<{role:'user'|'assistant', content: any}>} messages
 * @param {{
 *   onTextDelta: (text: string) => void,
 *   onToolUse: (tool: {name: string, input: any, id: string}) => void,
 *   onCitation: (cite: {bubbleId?: string, document_index: number, document_title: string, cited_text: string, start_char_index?: number, end_char_index?: number}) => void,
 *   onAssistantMessage: (message: {role: 'assistant', content: any[], citations: any[], retrievedDocs: any[]}) => void,
 *   onError: (err: Error) => void,
 *   signal?: AbortSignal,
 *   retrievalQuery?: string
 * }} handlers
 */
export async function streamClaude(messages, handlers) {
  const { onTextDelta, onToolUse, onCitation, onAssistantMessage, onError, signal, retrievalQuery } = handlers

  // 1. Retrieve relevant Marc corpus chunks for this turn.
  let retrievedDocs = []
  if (retrievalQuery && retrievalQuery.trim()) {
    try {
      retrievedDocs = await retrieveDocuments(retrievalQuery, 12)
    } catch (err) {
      console.warn('[claude] retrieval failed, proceeding without docs:', err)
    }
  }

  // 2. Build the request. Documents go on the LAST user message (Anthropic's
  //    citations API requires document blocks in user messages, not system).
  //    Claude annotates streamed text with citation deltas that point back to
  //    these document blocks by document_index.
  const systemBlocks = [
    { type: 'text', text: SYSTEM_PROMPT, cache_control: { type: 'ephemeral' } }
  ]

  let finalMessages = messages
  if (retrievedDocs.length) {
    finalMessages = attachDocumentsToLastUserMessage(messages, retrievedDocs)
  }

  let response
  try {
    response = await fetch('/api/anthropic/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      signal,
      body: JSON.stringify({
        model: MODEL,
        max_tokens: 1024,
        system: systemBlocks,
        tools: TOOLS,
        messages: finalMessages,
        stream: true
      })
    })
  } catch (err) {
    onError(err)
    return
  }

  console.log(`[claude] response status: ${response.status}`)
  if (!response.ok) {
    const text = await response.text().catch(() => '')
    onError(new Error(`API error ${response.status}: ${text || response.statusText}`))
    return
  }
  console.log(`[claude] streaming started (${retrievedDocs.length} docs attached)`)

  // Accumulators per content block index
  const blocks = new Map() // index -> { type, text?, citations?, tool? }
  const allCitations = []

  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    let chunk
    try { chunk = await reader.read() } catch (err) { onError(err); return }
    if (chunk.done) break
    buffer += decoder.decode(chunk.value, { stream: true })

    let sepIdx
    while ((sepIdx = buffer.indexOf('\n\n')) >= 0) {
      const rawEvent = buffer.slice(0, sepIdx)
      buffer = buffer.slice(sepIdx + 2)
      const event = parseSSE(rawEvent)
      if (!event) continue
      handleEvent(event)
    }
  }

  function handleEvent(event) {
    const data = event.data
    if (!data) return

    if (data.type === 'content_block_start') {
      const block = { type: data.content_block.type }
      if (block.type === 'tool_use') {
        block.tool = { name: data.content_block.name, id: data.content_block.id, partial: '' }
      } else if (block.type === 'text') {
        block.text = ''
        block.citations = []
      }
      blocks.set(data.index, block)
      return
    }

    if (data.type === 'content_block_delta') {
      const block = blocks.get(data.index)
      if (!block) return
      const delta = data.delta
      if (delta.type === 'text_delta') {
        block.text = (block.text || '') + delta.text
        onTextDelta(delta.text)
      } else if (delta.type === 'input_json_delta') {
        block.tool.partial += delta.partial_json
      } else if (delta.type === 'citations_delta' && delta.citation) {
        // Anthropic's citations API streams a citation object once Claude has
        // emitted enough text to anchor it. Resolve the doc metadata by index
        // back into our retrievedDocs array so the UI can render filename + url.
        const cit = delta.citation
        const docMeta = retrievedDocs[cit.document_index] || {}
        const resolved = {
          document_index: cit.document_index,
          document_title: cit.document_title || docMeta.title || docMeta.slug || `doc ${cit.document_index}`,
          source_path: docMeta.source_path,
          source_url: docMeta.source_url,
          slug: docMeta.slug,
          source_folder: docMeta.source_folder,
          cited_text: cit.cited_text || '',
          start_char_index: cit.start_char_index,
          end_char_index: cit.end_char_index
        }
        block.citations.push(resolved)
        allCitations.push(resolved)
        if (onCitation) onCitation(resolved)
      }
      return
    }

    if (data.type === 'content_block_stop') {
      const block = blocks.get(data.index)
      if (!block) return
      if (block.type === 'tool_use') {
        let parsed = {}
        try { parsed = JSON.parse(block.tool.partial || '{}') } catch {
          console.warn('Failed to parse tool input', block.tool.partial)
        }
        onToolUse({ name: block.tool.name, input: parsed, id: block.tool.id })
      }
      return
    }

    if (data.type === 'message_stop') {
      const sortedIdx = Array.from(blocks.keys()).sort((a, b) => a - b)
      const content = sortedIdx.map((i) => {
        const b = blocks.get(i)
        if (b.type === 'text') {
          // Persist text blocks WITHOUT citations metadata — Anthropic does not
          // accept the citation annotations back on subsequent turns. The UI
          // tracks citations separately via the message.citations array below.
          return { type: 'text', text: b.text || '' }
        }
        if (b.type === 'tool_use') {
          let input = {}
          try { input = JSON.parse(b.tool.partial || '{}') } catch {}
          return { type: 'tool_use', id: b.tool.id, name: b.tool.name, input }
        }
        return null
      }).filter(Boolean)
      onAssistantMessage({ role: 'assistant', content, citations: allCitations, retrievedDocs })
    }
  }
}

// Append document content blocks to the last user message so Claude can
// quote them with citations. Documents must come AFTER any tool_result blocks
// (Anthropic requires tool_results to be the leading content in the user
// message that immediately follows an assistant tool_use turn). We don't
// mutate the input array — callers reuse `messages` for state, and document
// blocks should NOT be persisted there (Anthropic re-charges the input
// tokens each turn anyway).
function attachDocumentsToLastUserMessage(messages, docs) {
  const docBlocks = docs.map((doc) => ({
    type: 'document',
    source: { type: 'text', media_type: 'text/plain', data: doc.text },
    title: doc.title || doc.slug,
    citations: { enabled: true }
  }))
  let lastUserIdx = -1
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].role === 'user') { lastUserIdx = i; break }
  }
  if (lastUserIdx === -1) return messages
  const cloned = messages.slice()
  const orig = cloned[lastUserIdx]
  const origContent = typeof orig.content === 'string'
    ? [{ type: 'text', text: orig.content }]
    : orig.content
  cloned[lastUserIdx] = { ...orig, content: [...origContent, ...docBlocks] }
  return cloned
}

function parseSSE(raw) {
  const lines = raw.split('\n')
  let event = null
  let dataLines = []
  for (const line of lines) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
  }
  if (!dataLines.length) return null
  const dataStr = dataLines.join('\n')
  if (dataStr === '[DONE]') return null
  try {
    return { event, data: JSON.parse(dataStr) }
  } catch {
    return null
  }
}
