// The cost guard: checked BEFORE the call, and deterministic by configuration.
//
// ── WHY BEFORE ──────────────────────────────────────────────────────────────
//
// A budget checked after a request has already been exceeded. The money is spent, the
// tokens are gone, and the guard's only remaining job is to report a fact. So
// {@link RunBudget} is consulted between the iteration increment and the request, using
// the ledger so far plus an ESTIMATE of the request about to be made — the same
// pre-flight shape `skills/optimizer.ts` already uses for the trainer's own spend, and
// the reason that one was written the same way.
//
// ── WHY DETERMINISTIC BY CONFIGURATION ─────────────────────────────────────
//
// Requirement 20.4 is explicit: on breach, either downgrade or stop, "deterministically
// by configuration". Not a heuristic, not "usually stop unless it looks close". A user
// who cannot predict what their tool does when it runs out of money does not have a
// budget, they have a surprise. So `onBreach` is a required field with two values and no
// default — a caller that sets a budget has to say what happens when it is reached, and
// forgetting is a compile error rather than a silent choice made on their behalf.
//
// ── WHY A TOKEN BUDGET AND A CURRENCY BUDGET BOTH EXIST ────────────────────
//
// Because a currency budget CANNOT WORK for an unpriced model. `cost/pricing.ts` reports
// an unknown model as `null` rather than zero, on purpose, which means a currency ceiling
// is unenforceable against it — and silently treating unpriced as free would turn the
// guard off exactly where it is needed most. A token ceiling always works, because tokens
// are counted by the provider and do not need a price table. `maxTokens` is therefore the
// dependable one, and a policy with only `maxUsd` set is warned about in
// {@link describeBudget} rather than quietly trusted.
//
// ── DOWNGRADE IS A REAL ROUTE, NOT A LABEL ─────────────────────────────────
//
// `downgrade` only means anything if there is somewhere cheaper to go. With no cheaper
// adapter supplied it degrades to `stop`, says so on the event, and does NOT pretend to
// have downgraded — a run that reports "downgraded" while calling the same expensive
// model is worse than one that stops.
//
// Validates: Requirements 20.3, 20.4, 20.5, 20.6, 5.10

import type { ChatAdapter, SketchEvent, Usage } from '../types.js'
import { costFor } from './pricing.js'
import { ledgerFor, type Ledger } from './ledger.js'

/** What to do when a budget is reached. No default: the caller must decide. */
export type BreachAction =
  /** Fail the run with `run_failed{reason:"budget"}`. */
  | 'stop'
  /** Switch to the cheap adapter and keep going. Falls back to `stop` without one. */
  | 'downgrade'

export interface RunBudget {
  /**
   * Total tokens (in plus out) allowed across the run.
   *
   * THE DEPENDABLE CEILING. Works for every provider including unpriced ones, because
   * tokens do not need a price table.
   */
  maxTokens?: number
  /**
   * Total USD allowed across the run.
   *
   * Cannot constrain a model that is not in the price table — an unpriced call
   * contributes nothing to the spend this can see. Pair it with `maxTokens`.
   */
  maxUsd?: number
  /** Model calls allowed across the run, whatever they cost. */
  maxCalls?: number
  /** What happens on breach. Deterministic, and required (Requirement 20.4). */
  onBreach: BreachAction
}

/** A cheaper model to fall back to, and the class of work it is trusted with. */
export interface Router {
  /**
   * The inexpensive or local adapter. A downgrade switches to this for the rest of the
   * run — not for one call, because a run that ping-pongs between price tiers has no
   * predictable cost at all.
   */
  cheap?: ChatAdapter
  /**
   * Route the FIRST call to the cheap model too.
   *
   * Requirement 20.6 wants mechanical work on a cheap model and a frontier model
   * reserved for hard calls. This is the honest version of that: the loop cannot know
   * which turn is hard, so the caller declares a policy rather than the engine guessing.
   * `'always'` runs the whole task cheaply; `'never'` uses the cheap model only after a
   * breach; `'after-plan'` uses the frontier model for the planning turn — the one turn
   * whose quality determines every turn after it — and the cheap model for the rest.
   */
  policy?: 'never' | 'after-plan' | 'always'
}

/** What the guard decided, before a call. */
export interface BudgetVerdict {
  /** True when the call may proceed. */
  allowed: boolean
  /** Which ceiling was reached, when one was. */
  limit: 'tokens' | 'usd' | 'calls' | null
  /** Plain words, for the event and for the model's feedback. */
  detail: string
  /** What the configuration says to do. Only set when `allowed` is false. */
  action: BreachAction | null
  /** Spend so far, for the event payload. */
  spent: { tokens: number; usd: number; calls: number; unpriced: number }
}

/**
 * Estimate the tokens a request will consume.
 *
 * Four characters per token, the same crude ratio the trainer's budget uses, and output
 * is assumed to be at most `assumedOutputTokens` because nothing can know it in advance.
 * DELIBERATELY PESSIMISTIC: a guard that under-estimates lets the last call cross the
 * line it exists to hold.
 */
export function estimateRequestTokens(
  messages: readonly { content: string }[],
  assumedOutputTokens = 1_000,
): Usage {
  const chars = messages.reduce((sum, message) => sum + message.content.length, 0)
  return { in: Math.ceil(chars / 4), out: assumedOutputTokens }
}

/**
 * Decide whether one more call fits inside the budget.
 *
 * Pure: it reads the log (through `ledgerFor`) and the pending request, and keeps no
 * state. So it can be called twice with the same answer, and the number it compares
 * against is the same number the dashboard shows.
 */
export function checkBudget(options: {
  budget: RunBudget
  /** The run's events so far. The ONE source of spend. */
  events: readonly SketchEvent[]
  /** The request about to be made, for the pre-flight estimate. */
  pending?: { usage: Usage; model?: string; provider?: string }
  now?: number
}): BudgetVerdict {
  const { budget, events, pending } = options
  const now = options.now ?? Date.now()
  const ledger: Ledger = ledgerFor(events, now)

  const spentTokens = ledger.tokensIn + ledger.tokensOut
  const spent = {
    tokens: spentTokens,
    usd: ledger.usd,
    calls: ledger.calls,
    unpriced: ledger.unpriced,
  }

  // ── THE PROJECTION LEARNS FROM THIS RUN ─────────────────────────────────
  //
  // `estimateRequestTokens` counts the prompt and assumes a modest reply. That is the
  // only information available before the FIRST call, and it is badly wrong for a model
  // whose replies are large: the Phase 8 gate caught a run overshooting a 600 000-token
  // ceiling by 150 000, because a ~1 500-token estimate was compared against calls that
  // really cost 250 000 each.
  //
  // After one call, there is better evidence than a guess — what a call in THIS run
  // actually cost. So the projection uses the largest observed call, and the pre-flight
  // estimate only wins while nothing has been observed or when the prompt has grown
  // beyond anything seen so far. Largest rather than mean, because a ceiling that holds
  // on average is not a ceiling.
  //
  // WHAT THIS STILL CANNOT DO, and no pre-flight check can: guarantee the ceiling is
  // never crossed. The first call's real cost is unknowable in advance, so the
  // guaranteed bound is `maxTokens + the first call's usage`. That is stated in
  // `describeBudget` and asserted in the gate rather than glossed over.
  const observedMaxTokens = ledger.entries.reduce(
    (worst, entry) => Math.max(worst, entry.usage.in + entry.usage.out),
    0,
  )
  const observedMaxUsd = ledger.entries.reduce(
    (worst, entry) => Math.max(worst, entry.usd ?? 0),
    0,
  )

  const deny = (limit: 'tokens' | 'usd' | 'calls', detail: string): BudgetVerdict => ({
    allowed: false,
    limit,
    detail,
    action: budget.onBreach,
    spent,
  })

  if (budget.maxCalls !== undefined && ledger.calls >= budget.maxCalls) {
    return deny(
      'calls',
      `budget reached: ${ledger.calls} of ${budget.maxCalls} model call(s) already made`,
    )
  }

  if (budget.maxTokens !== undefined) {
    const estimated = pending === undefined ? 0 : pending.usage.in + pending.usage.out
    const expected = Math.max(estimated, observedMaxTokens)
    if (spentTokens + expected > budget.maxTokens) {
      return deny(
        'tokens',
        `budget reached: the next request is expected to cost ${expected} token(s)` +
          (observedMaxTokens > estimated
            ? ` (the largest call in this run so far)`
            : ` (estimated from the prompt)`) +
          ` and ${spentTokens} of ${budget.maxTokens} are already spent`,
      )
    }
  }

  if (budget.maxUsd !== undefined) {
    const estimatedUsd =
      pending === undefined
        ? 0
        : (costFor(pending.usage, pending.model, pending.provider, now).usd ?? 0)
    const expectedUsd = Math.max(estimatedUsd, observedMaxUsd)
    if (spent.usd + expectedUsd > budget.maxUsd) {
      return deny(
        'usd',
        `budget reached: the next request is expected to cost $${expectedUsd.toFixed(4)}` +
          (observedMaxUsd > estimatedUsd
            ? ` (the most expensive call in this run so far)`
            : ` (estimated from the prompt)`) +
          ` and $${spent.usd.toFixed(4)} of $${budget.maxUsd.toFixed(4)} is already spent`,
      )
    }
  }

  return { allowed: true, limit: null, detail: 'within budget', action: null, spent }
}

/**
 * The budget in words, INCLUDING what it cannot enforce.
 *
 * A currency-only budget against an unpriced model constrains nothing, and a user is
 * entitled to be told that by the thing that is supposed to be protecting them.
 */
export function describeBudget(budget: RunBudget, ledger?: Ledger): string {
  const parts: string[] = []
  if (budget.maxCalls !== undefined) parts.push(`${budget.maxCalls} call(s)`)
  if (budget.maxTokens !== undefined) parts.push(`${budget.maxTokens} token(s)`)
  if (budget.maxUsd !== undefined) parts.push(`$${budget.maxUsd.toFixed(2)}`)
  if (parts.length === 0) return 'No budget is configured, so nothing bounds this run.'

  const head =
    `Budget: ${parts.join(', ')}; on breach, ${budget.onBreach}. ` +
    // Stated, because a user who thinks a ceiling is absolute will be surprised once.
    'The first call\u2019s real cost cannot be known before it is made, so the ceiling ' +
    'is enforced from the second call onward and the guaranteed bound is the ceiling ' +
    'plus one call.'
  if (
    budget.maxUsd !== undefined &&
    budget.maxTokens === undefined &&
    budget.maxCalls === undefined
  ) {
    return `${head} A currency-only budget cannot constrain a model that is not in the price table, because an unpriced call adds nothing to the spend it can see. Set maxTokens as well.`
  }
  if (ledger !== undefined && ledger.unpriced > 0 && budget.maxUsd !== undefined) {
    return `${head} ${ledger.unpriced} call(s) in this run could not be priced, so the currency ceiling is not holding them.`
  }
  return head
}
