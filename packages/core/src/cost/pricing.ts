// The one pricing table, and the date it was true.
//
// ── WHY THIS FILE EXISTS AT ALL ─────────────────────────────────────────────
//
// Before this task there were THREE private `COSTS` tables — one each in
// `providers/openai.ts`, `providers/anthropic.ts` and `providers/gemini.ts` — plus six
// adapters whose `estimateCost` was a hardcoded `return 0`. Three tables meant three
// answers to "what did that cost", and the `return 0` stubs meant a run on Groq or
// OpenRouter reported free. Both are the same failure the provider catalog and the
// secret-pattern table were centralised to avoid: a second copy of the truth, and the
// one on screen is the one that is wrong.
//
// So: one table here, and the three adapters now delegate to it. A test asserts no
// module outside this directory declares a per-model price.
//
// ── PRICES GO STALE, SO THE DATE IS PART OF THE DATA ───────────────────────
//
// A price table with no date implies live pricing, which this is not and cannot be
// without a network call on startup — exactly what this product refuses to make. So
// {@link PRICED_AT} travels with the numbers, every surface that shows money shows it,
// and `costFor` marks its answers `stale: true` once the table is older than
// {@link STALE_AFTER_DAYS}. A number a user cannot date is a number they cannot check.
//
// ── AN UNKNOWN MODEL COSTS `null`, NOT ZERO ────────────────────────────────
//
// This is the load-bearing decision in the file. A missing price is unknown, and
// reporting unknown as `$0.00` is the single most expensive lie a cost dashboard can
// tell: the user sees free, leaves it running, and finds out from an invoice. `null`
// propagates — a run containing one unpriced call reports a priced subtotal AND the
// count of calls it could not price, and the surface says so. `budget_exceeded` on a
// currency budget therefore cannot fire for an unpriced model, which is why a token
// budget exists alongside it and is the one that always works.
//
// ── LOCAL MODELS ARE GENUINELY FREE, AND THAT IS DIFFERENT ─────────────────
//
// `ollama` and `lmstudio` run on the user's own machine, so zero is the true price
// rather than an absent one. They are listed explicitly with `usdPerMillion: [0, 0]`,
// which is a priced answer of zero — distinguishable from `null` by construction.
//
// Validates: Requirements 20.1, 20.2, 20.8

import type { Usage } from '../types.js'

/**
 * The day these numbers were read from the vendors' own pricing pages.
 *
 * Bump it when you update a price, and only then. A date that moves with the calendar
 * would defeat the staleness warning it exists to raise.
 */
export const PRICED_AT = '2026-08-02'

/** After this long, `costFor` flags its answers as stale. Six months. */
export const STALE_AFTER_DAYS = 180

/** One model's price, in USD per million tokens. */
export interface ModelPrice {
  /** `[input, output]`, USD per 1 000 000 tokens. */
  usdPerMillion: readonly [number, number]
  /**
   * True when the price is zero because the model runs on the user's machine, not
   * because it is unknown. Never inferred from the numbers being zero.
   */
  local?: boolean
  /** Free tier, rate limits, or anything else that makes the number conditional. */
  note?: string
}

/**
 * Model id → price. Keys are matched case-insensitively and by longest prefix, so
 * `gpt-4o-2024-11-20` prices as `gpt-4o` without a row per dated snapshot.
 *
 * PREFIX MATCHING IS DELIBERATE AND IT HAS A SHARP EDGE: `gpt-4o-mini` must be found
 * before `gpt-4o`, or every mini call would be priced at sixteen times its real cost.
 * That is why the lookup sorts by key length descending rather than trusting object
 * order, and why `pricing.test.ts` asserts the mini case specifically.
 */
export const MODEL_PRICING: Readonly<Record<string, ModelPrice>> = Object.freeze({
  // ── OpenAI ────────────────────────────────────────────────────────────────
  'gpt-4o-mini': { usdPerMillion: [0.15, 0.6] },
  'gpt-4o': { usdPerMillion: [2.5, 10.0] },
  'gpt-4-turbo': { usdPerMillion: [10.0, 30.0] },
  'gpt-4': { usdPerMillion: [30.0, 60.0] },
  'gpt-3.5-turbo': { usdPerMillion: [0.5, 1.5] },
  'o1-mini': { usdPerMillion: [1.1, 4.4] },
  o1: { usdPerMillion: [15.0, 60.0] },

  // ── Anthropic ─────────────────────────────────────────────────────────────
  //
  // The ids the Anthropic adapter ships are placeholders (`claude-opus-latest`), so
  // both those and the real dated ids are priced. A run against either is priced;
  // neither silently reports zero.
  'claude-opus-latest': { usdPerMillion: [15.0, 75.0] },
  'claude-sonnet-latest': { usdPerMillion: [3.0, 15.0] },
  'claude-haiku-latest': { usdPerMillion: [0.8, 4.0] },
  'claude-3-opus': { usdPerMillion: [15.0, 75.0] },
  'claude-3-5-sonnet': { usdPerMillion: [3.0, 15.0] },
  'claude-3-5-haiku': { usdPerMillion: [0.8, 4.0] },
  'claude-3-haiku': { usdPerMillion: [0.25, 1.25] },

  // ── Google ────────────────────────────────────────────────────────────────
  'gemini-2.0-flash': { usdPerMillion: [0.075, 0.3] },
  'gemini-2.0-pro': { usdPerMillion: [1.25, 5.0] },
  'gemini-1.5-flash': { usdPerMillion: [0.075, 0.3] },
  'gemini-1.5-pro': { usdPerMillion: [1.25, 5.0] },

  // ── On-device: genuinely zero, and marked as such ─────────────────────────
  //
  // Priced by PROVIDER id rather than model, because a local runtime serves whatever
  // the user pulled and the cost is zero for all of it.
  ollama: { usdPerMillion: [0, 0], local: true, note: 'Runs on this machine.' },
  lmstudio: { usdPerMillion: [0, 0], local: true, note: 'Runs on this machine.' },

  // ── The offline test adapter ──────────────────────────────────────────────
  fake: { usdPerMillion: [0, 0], local: true, note: 'The offline test adapter. No provider is contacted.' },
})

/** What a lookup found, and how. */
export interface PriceLookup {
  price: ModelPrice | null
  /** The table key that matched, for a surface that wants to show it. */
  matched: string | null
}

/**
 * Find a price for a model, or a provider id when the model is unpriced.
 *
 * Longest-prefix wins, case-insensitively. The provider id is a FALLBACK, not a
 * primary: it exists so `ollama` prices at zero whatever model is loaded, and it must
 * not let a hosted provider inherit a price from a sibling model.
 */
export function priceFor(model: string | undefined, providerId?: string): PriceLookup {
  const keys = Object.keys(MODEL_PRICING).sort((a, b) => b.length - a.length)

  if (model !== undefined && model.trim() !== '') {
    const needle = model.trim().toLowerCase()
    for (const key of keys) {
      if (needle.startsWith(key.toLowerCase())) {
        return { price: MODEL_PRICING[key]!, matched: key }
      }
    }
  }

  if (providerId !== undefined && providerId.trim() !== '') {
    const needle = providerId.trim().toLowerCase()
    for (const key of keys) {
      // EXACT for a provider fallback. A prefix match here would let a provider
      // called `openai-proxy` inherit whatever `openai` costs.
      if (needle === key.toLowerCase()) return { price: MODEL_PRICING[key]!, matched: key }
    }
  }

  return { price: null, matched: null }
}

/** What one call cost, or an honest admission that it is not known. */
export interface CostAnswer {
  /** USD, or null when the model is not in the table. NEVER 0 for unknown. */
  usd: number | null
  /** The table key used, when one was. */
  matched: string | null
  /** True when the zero is real (a local model) rather than absent. */
  local: boolean
  /** True when the table is older than {@link STALE_AFTER_DAYS}. */
  stale: boolean
  /** The date the table claims. Always present, so a surface can show it. */
  pricedAt: string
}

/**
 * Price one call's usage.
 *
 * `now` is injected so a test can prove the staleness flag flips rather than waiting
 * six months for it.
 */
export function costFor(
  usage: Usage,
  model: string | undefined,
  providerId?: string,
  now: number = Date.now(),
): CostAnswer {
  const { price, matched } = priceFor(model, providerId)
  const stale = isStale(now)

  if (price === null) {
    return { usd: null, matched: null, local: false, stale, pricedAt: PRICED_AT }
  }

  const [inPer, outPer] = price.usdPerMillion
  const usd = (usage.in / 1_000_000) * inPer + (usage.out / 1_000_000) * outPer
  return {
    // Rounded to six decimal places: a single cheap call is genuinely worth
    // fractions of a cent, and floating-point noise at the fifteenth place makes a
    // reconciliation test fail for reasons that have nothing to do with cost.
    usd: round6(usd),
    matched,
    local: price.local === true,
    stale,
    pricedAt: PRICED_AT,
  }
}

/** True when the table is older than {@link STALE_AFTER_DAYS}. */
export function isStale(now: number = Date.now()): boolean {
  const pricedAt = Date.parse(`${PRICED_AT}T00:00:00Z`)
  if (Number.isNaN(pricedAt)) return true
  return now - pricedAt > STALE_AFTER_DAYS * 24 * 60 * 60 * 1000
}

/** Six decimal places. See the note in `costFor`. */
export function round6(value: number): number {
  return Math.round(value * 1_000_000) / 1_000_000
}
