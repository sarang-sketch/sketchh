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
