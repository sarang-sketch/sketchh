// The SkillOpt-style optimizer: bounded edits instead of a whole-body rewrite.
//
// Same contract as `providerProposeEdit` in optimizer.ts (only the body moves, the
// budget is checked before every call, the trainer's strict held-out gate decides),
// with the two parts of Microsoft's SkillOpt update rule that rewrite lacks:
//
//   * a TEXTUAL LEARNING RATE: at most `maxEdits` add/delete/replace edits per step;
//   * a REJECTED-EDIT BUFFER: edits the gate turned down are listed in later prompts
//     so the optimizer does not propose them again.
//
// The proposer learns of a rejection without any change to the trainer: the gate
// keeps the incumbent on a rejection, so when the next call arrives with the same
// incumbent body this proposer last edited, its last edits were rejected.

import type { ChatAdapter, EvalResult, Message, Skill } from '../types.js'
import { applyEdits, DEFAULT_MAX_EDITS, describeEdit, EDITS_FENCE, parseEdits } from './edits.js'
import { DEFAULT_TRAINING_BUDGET, MAX_BODY_CHARS, MIN_BODY_CHARS } from './optimizer.js'
import type { BudgetLedger, TrainingBudget } from './optimizer.js'
import type { ProposeEdit } from './trainer.js'

export interface ProviderProposeEditsOptions {
  adapter: ChatAdapter
  budget?: Partial<TrainingBudget>
  /** Edits applied per step. Defaults to {@link DEFAULT_MAX_EDITS}. */
  maxEdits?: number
  guidance?: string
  ledger?: BudgetLedger
  /** Receives one line per rejected edit. Supply one to read it after training. */
  rejected?: string[]
  signal?: AbortSignal
}

const estimateTokens = (text: string) => (text.length === 0 ? 0 : Math.max(1, Math.ceil(text.length / 4)))

function buildMessages(skill: Skill, results: readonly EvalResult[], maxEdits: number, rejected: readonly string[], guidance?: string): Message[] {
  const failing = results.filter((result) => !result.passed)
  const system = [
    'You improve the instruction text of an agent skill with small, targeted edits.',
    '',
    `Reply with at most ${maxEdits} edits as a JSON array inside one \`\`\`${EDITS_FENCE} fenced block, and nothing else.`,
    'Each edit is one of:',
    '  {"op":"add","text":"<new text>","after":"<exact text already in the skill>"}  (omit "after" to append)',
    '  {"op":"delete","find":"<exact text to remove>"}',
    '  {"op":"replace","find":"<exact text>","text":"<replacement>"}',
    '"find" and "after" must copy text that appears exactly once in the current body.',
    'Do not touch frontmatter, names, permissions or tools. Prefer the smallest change that fixes a failing case.',
    'If nothing would help, reply with an empty array.',
  ].join('\n')
  const user = [
    `# Skill: ${skill.name}`,
    '',
    '## Current body',
    '',
    skill.body,
    '',
    '## Training results',
    '',
    failing.length === 0
      ? 'Every training case passes. Make the instructions clearer without making them longer.'
      : [`${failing.length} of ${results.length} case(s) failed:`, ...failing.map((r) => `  - ${r.caseId}: ${r.score.toFixed(2)} — ${r.detail}`)].join('\n'),
    ...(rejected.length > 0 ? ['', '## Already tried and rejected by validation (do not propose again)', '', ...rejected.map((line) => `- ${line}`)] : []),
    ...(guidance !== undefined && guidance.trim() !== '' ? ['', '## Guidance from the user', '', guidance.trim()] : []),
  ].join('\n')
  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

/**
 * A proposer that can also be told training is over. The last round's edits have no
 * later call to learn their fate from, so `settle` takes the skill the trainer kept:
 * if it is still the body those edits were applied to, the gate rejected them.
 */
export type EditProposer = ProposeEdit & { settle(kept: Skill): void }

export function providerProposeEdits(options: ProviderProposeEditsOptions): EditProposer {
  const budget: TrainingBudget = {
    maxCalls: options.budget?.maxCalls ?? DEFAULT_TRAINING_BUDGET.maxCalls,
    maxTokens: options.budget?.maxTokens ?? DEFAULT_TRAINING_BUDGET.maxTokens,
  }
  const ledger: BudgetLedger = options.ledger ?? { calls: 0, tokens: 0, refusal: null }
  const rejected = options.rejected ?? []
  const maxEdits = Math.max(1, options.maxEdits ?? DEFAULT_MAX_EDITS)
  let last: { incumbent: string; edits: string[] } | null = null

  const settle = (kept: Skill): void => {
    // The gate kept the body this proposer last edited: those edits were rejected.
    if (last !== null && kept.body === last.incumbent) rejected.push(...last.edits)
    last = null
  }

  const propose: ProposeEdit = async (skill, trainResults) => {
    settle(skill)

    const messages = buildMessages(skill, trainResults, maxEdits, rejected, options.guidance)
    const requestTokens = messages.reduce((sum, message) => sum + estimateTokens(message.content), 0)
    if (ledger.calls >= budget.maxCalls) {
      ledger.refusal = `training budget reached: ${ledger.calls} of ${budget.maxCalls} model call(s) used`
      return null
    }
    if (ledger.tokens + requestTokens > budget.maxTokens) {
      ledger.refusal = `training budget reached: this request is an estimated ${requestTokens} token(s) and ${ledger.tokens} of ${budget.maxTokens} are already spent`
      return null
    }

    let text: string
    try {
      const response = await options.adapter.chat(messages, options.signal ? { signal: options.signal } : undefined)
      text = response.text ?? ''
      ledger.calls += 1
      ledger.tokens += response.usage === undefined ? requestTokens + estimateTokens(text) : response.usage.in + response.usage.out
    } catch (err) {
      ledger.calls += 1
      ledger.refusal = err instanceof Error ? err.message : String(err)
      throw err
    }

    const result = applyEdits(skill.body, parseEdits(text), maxEdits)
    const body = result.body.trim()
    if (result.applied.length === 0 || body === skill.body.trim()) return null
    if (body.length < MIN_BODY_CHARS || body.length > MAX_BODY_CHARS || body.startsWith('---')) return null

    last = { incumbent: skill.body, edits: result.applied.map(describeEdit) }
    return { ...skill, body }
  }

  return Object.assign(propose, { settle })
}
