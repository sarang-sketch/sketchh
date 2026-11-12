// Cost accounting, the budget guard, model routing, and the response cache.
//
// THE INVARIANT THIS MODULE EXISTS TO HOLD: the money number is a pure function of the
// event log. `ledgerFor(events)` and nothing else. No counter, no cached subtotal, no
// figure the loop keeps as it goes — because two sources agree until they do not, and
// then nobody can tell which is wrong.

export {
  MODEL_PRICING,
  PRICED_AT,
  STALE_AFTER_DAYS,
  costFor,
  isStale,
  priceFor,
  round6,
} from './pricing.js'
export type { CostAnswer, ModelPrice, PriceLookup } from './pricing.js'

export { describeLedger, ledgerFor, ledgerForRun } from './ledger.js'
export type { Ledger, LedgerEntry } from './ledger.js'

export { recordUsage, summarizeUsage, usageDir, USAGE_CAUSES } from './usage-log.js'
export type { UsageCause, UsageCauseSummary, UsageEntryInput, UsageRecord, UsageSummary } from './usage-log.js'

export { checkBudget, describeBudget, estimateRequestTokens } from './budget.js'
export type { BreachAction, BudgetVerdict, RunBudget, Router } from './budget.js'

export {
  FileResponseCache,
  MemoryResponseCache,
  RESPONSE_CACHE_VERSION,
  cachedAdapter,
  clearResponseCache,
  hashMessages,
  responseCacheDir,
  responseCacheKey,
  responseCacheSize,
  stableJson,
} from './response-cache.js'
export type {
  ResponseCache,
  ResponseCacheIdentity,
  ResponseCacheRecord,
  ResponseCacheStats,
} from './response-cache.js'
