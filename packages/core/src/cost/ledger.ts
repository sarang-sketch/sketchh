// The cost ledger: the total is the SUM OVER EVENTS, and there is no other source.
//
// ── THE ONE RULE THIS FILE ENFORCES ────────────────────────────────────────
//
// Requirement 20.2: "the session total equals the sum over events with no independent
// source." So there is no counter incremented alongside the log, no cached subtotal, no
// number the loop keeps as it goes. {@link ledgerFor} is a PURE FUNCTION of an event
// array. Ask it twice and you get the same answer; ask it after the run and you get the
// same answer as during.
//
// Why so strict: a running counter and a log are two sources that agree right up until
// they do not, and when they disagree you cannot tell which is wrong. That is the exact
// bug shape this codebase has now avoided four times — one file cache (3.1), one
// authorisation point (6.3), one skill-state home (6.4), one place to read a run (7.5).
// The cost dashboard is the highest-stakes instance, because the number is money and a
// user will act on it.
//
// It also makes the reconciliation test in 8.5 possible to state exactly rather than
// approximately: `dashboardTotal === ledgerFor(events).usd`, no tolerance, because both
// sides are the same computation over the same bytes.
//
// ── UNPRICED CALLS ARE COUNTED, NOT ABSORBED ───────────────────────────────
//
// A run containing one call to a model that is not in the pricing table reports a priced
// subtotal AND `unpriced: 1`. It does not report the subtotal as if it were the total.
// A surface must show both, and `ledgerFor` makes that unavoidable by never folding an
// unknown price into the number.
//
// ── CACHE HITS COST NOTHING, AND SAYING SO IS THE POINT ────────────────────
//
// A `cache_hit` is a call that did not happen, so it contributes no tokens and no money.
// It is counted separately because "you saved this much" is the only way a user can tell
// the cache is working, and because a hit that was silently priced would inflate the
// total for traffic that never left the machine.
//
// Validates: Requirements 20.1, 20.2, 20.7, 20.8

import type { SketchEvent, Usage } from '../types.js'
import { costFor, isStale, PRICED_AT, round6 } from './pricing.js'

/** One priced model call, derived from one `llm_response` event. */
export interface LedgerEntry {
  runId: string
  /** Event id, so a surface can link a row back to the log line it came from. */
  eventId: string
  ts: number
  iteration: number | null
  /**
   * The model this call is attributed to: the model the provider said ANSWERED when
   * the event recorded one (`responseModel`, e.g. a router alias resolved), otherwise
   * the requested model. Pricing uses this, because you are billed for the model that
   * actually ran.
   */
  model: string | null
  /**
   * The model that was REQUESTED, when it differs from {@link model}. `null` when the
   * event recorded no alias, so a surface shows the difference only when there is one.
   */
  requestedModel: string | null
  /** The adapter/provider id, when the event recorded one. */
  provider: string | null
  usage: Usage
  /**
   * True unless the event said the provider reported NO usage (`usageKnown: false`). When
   * false, {@link usage} is a placeholder `{0,0}`, NOT a measurement: a surface shows the
   * tokens as "unknown" and {@link usd} is null (unknown), never 0 / $0.00. Old logs
   * without the flag read as known.
   */
  usageKnown: boolean
  /** True when the numbers are an estimate (the offline fake adapter's ~len/4), not a provider count. */
  usageEstimated: boolean
  /** USD, or null when this model is not in the pricing table OR its usage is unknown. */
  usd: number | null
  /** The pricing key that matched, for a surface that wants to show it. */
  matched: string | null
  local: boolean
}

/** What a run, or a whole log, cost. */
export interface Ledger {
  /** Total USD over the entries that COULD be priced. Never includes a guess. */
  usd: number
  tokensIn: number
  tokensOut: number
  /** Model calls that actually happened. Excludes cache hits. */
  calls: number
  /** Calls whose model is not in the pricing table. `usd` excludes these. */
  unpriced: number
  /**
   * Calls whose token usage the provider did not report. Their tokens are NOT in
   * {@link tokensIn}/{@link tokensOut} (there is nothing to add), and their cost is
   * unknown, so a surface says "tokens unknown for N of M calls" rather than showing 0.
   */
  usageUnknown: number
  /** Calls whose numbers are estimates (the offline fake adapter), counted but flagged. */
  usageEstimatedCalls: number
  /** Requests answered from the cache. No tokens, no money, no network. */
  cacheHits: number
  /**
   * USD the cache avoided, when the hits recorded enough to price.
   *
   * Best-effort by nature: a hit records the usage of the response it is replaying, so
   * this is what the call WOULD have cost. Reported separately from `usd` and never
   * subtracted from it — a saving is not a negative expense.
   */
  savedUsd: number
  /** True when every priced entry used a local model, so the total is really zero. */
  allLocal: boolean
  /** The pricing table's date, so a surface can never show money without it. */
  pricedAt: string
  /** True when the pricing table is older than its staleness window. */
  stale: boolean
  entries: LedgerEntry[]
}

/**
 * Compute the ledger for a set of events.
 *
 * Pure. No I/O, no clock of its own unless one is not supplied, and no state kept
 * between calls.
 */
export function ledgerFor(events: readonly SketchEvent[], now: number = Date.now()): Ledger {
  const entries: LedgerEntry[] = []
  let tokensIn = 0
  let tokensOut = 0
  let usd = 0
  let unpriced = 0
  let usageUnknown = 0
  let usageEstimatedCalls = 0
  let cacheHits = 0
  let savedUsd = 0
  let anyPriced = false
  let allLocal = true

  for (const event of events) {
    if (event.kind === 'cache_hit') {
      cacheHits += 1
      // What the avoided call would have cost, when the hit says enough to price it.
      const usage = readUsage(event.payload['usage'])
      const model = readString(event.payload['model'])
      const provider = readString(event.payload['adapter'] ?? event.payload['provider'])
      if (usage !== null) {
        const answer = costFor(usage, model ?? undefined, provider ?? undefined, now)
        if (answer.usd !== null) savedUsd = round6(savedUsd + answer.usd)
      }
      continue
    }

    if (event.kind !== 'llm_response') continue

    const usage = readUsage(event.payload['usage']) ?? { in: 0, out: 0 }
    const requested = readString(event.payload['model'])
    // The model that ANSWERED wins for attribution and pricing when the event recorded
    // one; a run billed by a router is billed for the model that actually ran.
    const answered = readString(event.payload['responseModel'])
    const model = answered ?? requested
    const provider = readString(event.payload['adapter'] ?? event.payload['provider'])
    // The provider reported no usage when the event explicitly says `usageKnown: false`.
    // Its `usage` is then a placeholder, not a measurement — do NOT sum it as real, and
    // its cost is unknown, never zero. An old log without the flag reads as known.
    const usageKnown = event.payload['usageKnown'] !== false
    const usageEstimated = event.payload['usageEstimated'] === true
    const answer = usageKnown
      ? costFor(usage, model ?? undefined, provider ?? undefined, now)
      : { usd: null, matched: null, local: false }

    if (usageKnown) {
      tokensIn += usage.in
      tokensOut += usage.out
    } else {
      usageUnknown += 1
    }
    if (usageEstimated) usageEstimatedCalls += 1

    if (!usageKnown) {
      // Cost is genuinely unknown; it is neither priced nor "unpriced-model". It simply
      // cannot be computed, so it does not touch `usd` and is not counted as unpriced.
      allLocal = false
    } else if (answer.usd === null) {
      unpriced += 1
      allLocal = false
    } else {
      usd = round6(usd + answer.usd)
      anyPriced = true
      if (!answer.local) allLocal = false
    }

    entries.push({
      runId: event.runId,
      eventId: event.id,
      ts: event.ts,
      iteration: readNumber(event.payload['iteration']),
      model,
      // Only when a router answered with a different model than requested.
      requestedModel: answered !== null && requested !== null && requested !== answered ? requested : null,
      provider,
      usage,
      usageKnown,
      usageEstimated,
      usd: answer.usd,
      matched: answer.matched,
      local: answer.local,
    })
  }

  return {
    usd: round6(usd),
    tokensIn,
    tokensOut,
    calls: entries.length,
    unpriced,
    usageUnknown,
    usageEstimatedCalls,
    cacheHits,
    savedUsd,
    // Vacuously true is wrong here: a run with no priced call has not established that
    // anything was free.
    allLocal: anyPriced && allLocal,
    pricedAt: PRICED_AT,
    stale: isStale(now),
    entries,
  }
}

/** The ledger for one run, from a log that may hold many. */
export function ledgerForRun(
  events: readonly SketchEvent[],
  runId: string,
  now: number = Date.now(),
): Ledger {
  return ledgerFor(
    events.filter((event) => event.runId === runId),
    now,
  )
}

/**
 * Money as a surface should print it, with the unknowns admitted.
 *
 * Deliberately not just a number: every call site that formats a total has to decide
 * what to do about unpriced calls, and putting the decision here means they cannot
 * quietly decide to ignore them.
 */
export function describeLedger(ledger: Ledger): string {
  const parts: string[] = []
  if (ledger.calls === 0 && ledger.cacheHits === 0) return 'No model calls yet.'

  if (ledger.unpriced === ledger.calls && ledger.calls > 0) {
    parts.push('Cost unknown')
  } else if (ledger.allLocal) {
    parts.push('$0.00 (local models only)')
  } else {
    parts.push(`$${ledger.usd.toFixed(4)}`)
  }

  const tokenNote = ledger.usageEstimatedCalls > 0 && ledger.usageEstimatedCalls === ledger.calls ? ' (estimated)' : ''
  parts.push(`${ledger.tokensIn} in / ${ledger.tokensOut} out over ${ledger.calls} call(s)${tokenNote}`)

  if (ledger.usageUnknown > 0) {
    parts.push(`tokens unknown for ${ledger.usageUnknown} of ${ledger.calls} call(s)`)
  }
  if (ledger.unpriced > 0 && ledger.unpriced < ledger.calls) {
    parts.push(`${ledger.unpriced} call(s) could not be priced, so the total is a lower bound`)
  }
  if (ledger.cacheHits > 0) {
    parts.push(
      ledger.savedUsd > 0
        ? `${ledger.cacheHits} cache hit(s), about $${ledger.savedUsd.toFixed(4)} avoided`
        : `${ledger.cacheHits} cache hit(s)`,
    )
  }
  parts.push(ledger.stale ? `priced ${ledger.pricedAt}, now stale` : `priced ${ledger.pricedAt}`)
  return parts.join(' · ')
}

function readUsage(value: unknown): Usage | null {
  if (typeof value !== 'object' || value === null) return null
  const usage = value as Record<string, unknown>
  if (typeof usage['in'] !== 'number' || typeof usage['out'] !== 'number') return null
  return { in: usage['in'], out: usage['out'] }
}

function readString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() !== '' ? value : null
}

function readNumber(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}
