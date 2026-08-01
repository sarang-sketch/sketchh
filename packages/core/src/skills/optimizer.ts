// The provider-backed optimizer: the real `proposeEdit` (Requirement 9.5).
//
// ── WHAT IT IS ALLOWED TO CHANGE ────────────────────────────────────────────
//
// THE BODY. Nothing else. The candidate is built as `{ ...incumbent, body }`, so
// the name, the description, the source and — critically — the CAPABILITIES are
// carried over from the incumbent and cannot be touched by the model's reply.
//
// That is a security property, not tidiness. An optimizer that could rewrite
// `capabilities:` would be a privilege escalation with a training run as its
// delivery mechanism: propose a body that also asks for `net:http`, score well on
// unrelated cases, and the gate accepts a skill that can now reach the network.
// The trainable state is the prose (Requirement 9.1) and this file enforces that
// literally. `optimizer.test.ts` proves a reply attempting it is ignored.
//
// ── WHAT IT CANNOT DO ───────────────────────────────────────────────────────
//
// It cannot accept its own proposal. `proposeEdit` returns a candidate; the strict
// `>` validation gate in `trainer.ts` decides. This file has no access to the
// validation split, deliberately — an optimizer that can see the held-out set can
// overfit to it and the gate stops meaning anything. It is handed the incumbent
// and the TRAIN results only, and the type signature is what enforces that.
//
// ── THE BUDGET ──────────────────────────────────────────────────────────────
//
// Requirement 9.7 says training runs behind the cost guard. The loop-wide cost
// guard is Phase 8.2 and does not exist yet, so this file carries its own bound:
// {@link TrainingBudget} caps model calls and estimated tokens, is checked BEFORE
// each request, and refuses by returning null with a recorded reason rather than
// throwing. Stated plainly so nobody reads it as the Phase 8 guard: it bounds THIS
// optimizer's spend and nothing else in the system.
//
// A refusal returns null, which the trainer records as `no_proposal` and treats as
// "the incumbent survives this epoch". That is the safe direction: running out of
// budget must never be able to change a skill.
//
// Validates: Requirements 9.1, 9.5, 9.6, 9.7

import type { ChatAdapter, EvalResult, Message, Skill } from '../types.js'
import type { ProposeEdit } from './trainer.js'

/** Fence the model is asked to wrap the new body in. */
export const SKILL_FENCE = 'skill'

/**
 * Longest body a candidate may have, in characters.
 *
 * A runaway body is a cost bug that compounds: the skill is prepended to every
 * subsequent run's prompt, so an optimizer that doubles the body each epoch
 * doubles the cost of every future task. 20 000 characters is roughly 5 000
 * estimated tokens — generous for prose instructions, and far below anything that
 * would quietly become the dominant cost of a run.
 */
export const MAX_BODY_CHARS = 20_000

/** Shortest body worth proposing. Below this the reply was truncated, not written. */
export const MIN_BODY_CHARS = 40

/** Rough token count, the same `chars/4` estimate used elsewhere, stated as such. */
function estimateTokens(text: string): number {
  return text.length === 0 ? 0 : Math.max(1, Math.ceil(text.length / 4))
}

/**
 * A bound on what one training run may spend.
 *
 * NOT the Phase 8 cost guard. This bounds the optimizer's own model calls, which
 * is the only spend this file is responsible for.
 */
export interface TrainingBudget {
  /** Model calls allowed across the whole training run. */
  maxCalls: number
  /** Estimated tokens allowed across the whole training run, in plus out. */
  maxTokens: number
}

export const DEFAULT_TRAINING_BUDGET: Readonly<TrainingBudget> = Object.freeze({
  maxCalls: 8,
  maxTokens: 60_000,
})

/** What the budget has been spent on so far. Readable after a run. */
export interface BudgetLedger {
  calls: number
  tokens: number
  /** Why the last request was refused, when it was. */
  refusal: string | null
}

export interface ProviderProposeEditOptions {
  /** The model. The only network-touching collaborator here. */
  adapter: ChatAdapter
  /** Bound on the whole training run. Defaults to {@link DEFAULT_TRAINING_BUDGET}. */
  budget?: Partial<TrainingBudget>
  /**
   * Extra instruction from the user: "make it terser", "cover the CRLF case".
   * Appended to the prompt verbatim, so a user can steer without editing code.
   */
  guidance?: string
  /** Ledger to write into. Supply one to inspect spend after training. */
  ledger?: BudgetLedger
  signal?: AbortSignal
}

/** Failing checks, as the optimizer is told about them. */
function describeFailures(results: readonly EvalResult[]): string {
  const failing = results.filter((result) => !result.passed)
  if (failing.length === 0) {
    return 'Every training case already passes. Improve clarity and specificity without adding length.'
  }
  return [
    `${failing.length} of ${results.length} training case(s) did not pass:`,
    ...failing.map(
      (result) => `  - ${result.caseId}: scored ${result.score.toFixed(2)} — ${result.detail}`,
    ),
  ].join('\n')
}

/** The instruction. Explicit about the one thing it may return. */
function buildMessages(
  skill: Skill,
  trainResults: readonly EvalResult[],
  guidance: string | undefined,
): Message[] {
  const system = [
    'You improve the instruction text of an agent skill.',
    '',
    'You are given the skill\u2019s current body and how it scored on a set of training',
    'cases. Rewrite the BODY so the failing cases would pass, without breaking the',
    'ones that already pass.',
    '',
    'Rules:',
    `1. Reply with the complete new body inside one \`\`\`${SKILL_FENCE} fenced block, and nothing outside it.`,
    '2. Return the WHOLE body, not a diff and not a fragment.',
    '3. Do not include YAML frontmatter. The name, description and capabilities are fixed',
    '   and anything you write about them is discarded.',
    '4. Do not ask for new permissions or tools. You cannot be granted any.',
    `5. Keep it under ${MAX_BODY_CHARS} characters. Shorter and sharper beats longer.`,
    '6. If you cannot improve it, reply with an empty fenced block and nothing else.',
  ].join('\n')

  const user = [
    `# Skill: ${skill.name}`,
    skill.description === '' ? '' : skill.description,
    '',
    '## Current body',
    '',
    skill.body,
    '',
    '## Training results',
    '',
    describeFailures(trainResults),
    ...(guidance !== undefined && guidance.trim() !== ''
      ? ['', '## Additional guidance from the user', '', guidance.trim()]
      : []),
  ].join('\n')

  return [
    { role: 'system', content: system },
    { role: 'user', content: user },
  ]
}

/**
 * Extract the body from a reply.
 *
 * STRICT: no fenced block means no proposal. A reply that is prose about what it
 * would change must not become the skill's instructions, and being lenient here is
 * how a chatty apology ends up prepended to every future run's prompt.
 */
export function parseProposedBody(text: string): string | null {
  const fence = new RegExp(`\`\`\`${SKILL_FENCE}\\s*\\n([\\s\\S]*?)\`\`\``)
  const match = fence.exec(text)
  if (match === null) return null
  const body = (match[1] ?? '').trim()
  return body === '' ? null : body
}

/**
 * Strip anything that looks like frontmatter from a proposed body.
 *
 * Belt and braces on top of rule 3: a body that begins with `---` would, once
 * written to `best_skill.md` by `serializeSkill`, produce a file with TWO
 * frontmatter blocks — and the loader would read the model's block, not ours.
 * That is the concrete route by which a proposed body could rewrite
 * `capabilities:`, so it is closed here rather than trusted to the instruction.
 */
export function stripFrontmatter(body: string): string {
  if (!body.startsWith('---')) return body
  const end = body.indexOf('\n---', 3)
  if (end === -1) return body
  return body.slice(end + 4).trimStart()
}

/**
 * Build a provider-backed {@link ProposeEdit}.
 *
 * Offline-testable by construction: pass `FakeChatAdapter` with a scripted reply
 * and nothing touches the network. That is how `optimizer.test.ts` covers every
 * branch, and it is why the $0 promise survives this feature.
 */
export function providerProposeEdit(options: ProviderProposeEditOptions): ProposeEdit {
  const budget: TrainingBudget = {
    maxCalls: options.budget?.maxCalls ?? DEFAULT_TRAINING_BUDGET.maxCalls,
    maxTokens: options.budget?.maxTokens ?? DEFAULT_TRAINING_BUDGET.maxTokens,
  }
  const ledger: BudgetLedger = options.ledger ?? { calls: 0, tokens: 0, refusal: null }

  return async (skill: Skill, trainResults: readonly EvalResult[]): Promise<Skill | null> => {
    const messages = buildMessages(skill, trainResults, options.guidance)
    const requestTokens = messages.reduce((sum, message) => sum + estimateTokens(message.content), 0)

    // PRE-FLIGHT. Checked before the request, because a budget checked afterwards
    // has already been exceeded.
    if (ledger.calls >= budget.maxCalls) {
      ledger.refusal = `training budget reached: ${ledger.calls} of ${budget.maxCalls} model call(s) used`
      return null
    }
    if (ledger.tokens + requestTokens > budget.maxTokens) {
      ledger.refusal =
        `training budget reached: this request is an estimated ${requestTokens} token(s) and ` +
        `${ledger.tokens} of ${budget.maxTokens} are already spent`
      return null
    }

    let text: string
    try {
      const response = await options.adapter.chat(
        messages,
        options.signal ? { signal: options.signal } : undefined,
      )
      text = response.text ?? ''
      ledger.calls += 1
      // The adapter's own count when it has one; the estimate when it does not.
      ledger.tokens +=
        response.usage === undefined
          ? requestTokens + estimateTokens(text)
          : response.usage.in + response.usage.out
    } catch (err) {
      // The trainer records a throwing `proposeEdit` as `error` and keeps the
      // incumbent, so re-throwing is safe — but the ledger has to stay truthful
      // about the attempt.
      ledger.calls += 1
      ledger.refusal = err instanceof Error ? err.message : String(err)
      throw err
    }

    const parsed = parseProposedBody(text)
    if (parsed === null) return null

    const body = stripFrontmatter(parsed)
    if (body.length < MIN_BODY_CHARS) return null
    if (body.length > MAX_BODY_CHARS) return null
    // A candidate identical to the incumbent is not a proposal; scoring it would
    // spend a validation pass to learn nothing, and under strict `>` it could
    // never be accepted anyway.
    if (body.trim() === skill.body.trim()) return null

    // THE ONE FIELD THAT MOVES. Everything else is the incumbent's, including
    // `capabilities` — see the header.
    return { ...skill, body }
  }
}
