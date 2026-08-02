// Cost accounting: one price table, and a total that is a pure function of the log.
//
// THE ASSERTIONS THAT MATTER MOST:
//   * §1 — an unknown model costs `null`, NEVER 0. Reporting unknown as $0.00 is the
//     single most expensive lie a cost dashboard can tell: the user sees free, leaves it
//     running, and finds out from an invoice.
//   * §1 — `gpt-4o-mini` prices as mini, not as `gpt-4o`. Longest-prefix matching is the
//     mechanism and getting it backwards overcharges by 16x.
//   * §2 — the ledger is a PURE FUNCTION of an event array. Requirement 20.2 says the
//     session total equals the sum over events "with no independent source", and a test
//     asserting there is no second source is the only way that stays true.
//   * §3 — the three duplicate price tables and the six `return 0` stubs are gone,
//     asserted at the source level, because the drift they caused is the whole reason
//     this module exists.
//
// Validates: Requirements 20.1, 20.2, 20.7, 20.8

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  MODEL_PRICING,
  PRICED_AT,
  STALE_AFTER_DAYS,
  costFor,
  describeLedger,
  isStale,
  ledgerFor,
  ledgerForRun,
  priceFor,
} from '../src/cost/index.js'
import { MemoryEventStore } from '../src/events/index.js'
import { DiskFileWriter } from '../src/orchestrator/file-writer.js'
import { PlanWriter } from '../src/plan/index.js'
import { runTask } from '../src/loop/index.js'
import { FakeChatAdapter } from '../src/providers/fake.js'
import { OpenAIAdapter } from '../src/providers/openai.js'
import { GroqAdapter, OllamaAdapter } from '../src/providers/openai-compatible.js'
import { AnthropicAdapter } from '../src/providers/anthropic.js'
import { GeminiAdapter } from '../src/providers/gemini.js'
import type { SketchEvent } from '../src/types.js'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { afterAll } from 'vitest'

const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const tmpDirs: string[] = []

afterAll(async () => {
  while (tmpDirs.length) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true }).catch(() => {})
  }
})

/** One million tokens each way, so a price reads as the table's own numbers summed. */
const MILLION = { in: 1_000_000, out: 1_000_000 }

let counter = 0
function event(kind: SketchEvent['kind'], payload: Record<string, unknown>, runId = 'r1'): SketchEvent {
  counter += 1
  return { id: `e${counter}`, ts: 1_000 + counter, runId, kind, payload }
}

// ── 1. the price table ──────────────────────────────────────────────────────

describe('the price table', () => {
  it('costs an unknown model NULL, never zero', () => {
    const answer = costFor(MILLION, 'some-model-nobody-has-heard-of')
    // THE ASSERTION. `0` here would mean a dashboard shows free for a paid run.
    expect(answer.usd).toBeNull()
    expect(answer.matched).toBeNull()
    // And it is not claimed to be local either: unknown is unknown.
    expect(answer.local).toBe(false)
  })

  it('prices gpt-4o-mini as mini and not as gpt-4o', () => {
    // Longest prefix wins. Backwards, every mini call is billed at 16x.
    const mini = costFor(MILLION, 'gpt-4o-mini')
    const full = costFor(MILLION, 'gpt-4o')
    expect(mini.matched).toBe('gpt-4o-mini')
    expect(full.matched).toBe('gpt-4o')
    expect(mini.usd).toBeCloseTo(0.15 + 0.6, 6)
    expect(full.usd).toBeCloseTo(2.5 + 10.0, 6)
    expect(mini.usd!).toBeLessThan(full.usd!)
  })

  it('prices a dated snapshot through its family prefix', () => {
    // A vendor ships `gpt-4o-2024-11-20`; the table must not need a row per date.
    expect(costFor(MILLION, 'gpt-4o-2024-11-20').matched).toBe('gpt-4o')
    expect(costFor(MILLION, 'CLAUDE-3-5-SONNET-20241022').matched).toBe('claude-3-5-sonnet')
  })

  it('gives a local runtime a REAL zero, distinguishable from unknown', () => {
    // Priced through the provider fallback: a local runtime serves whatever was pulled.
    const answer = costFor(MILLION, 'llama3.3:70b', 'ollama')
    expect(answer.usd).toBe(0)
    expect(answer.local).toBe(true)
    expect(answer.matched).toBe('ollama')
  })

  it('does not let a provider inherit a price by prefix', () => {
    // `openai-proxy` is not OpenAI. A prefix match on the provider fallback would let
    // any endpoint whose id starts with a known one adopt its prices.
    expect(priceFor(undefined, 'ollama-proxy').price).toBeNull()
    expect(priceFor(undefined, 'ollama').price).not.toBeNull()
  })

  it('carries the date it was priced, and flags itself stale in time', () => {
    expect(PRICED_AT).toMatch(/^\d{4}-\d{2}-\d{2}$/)
    const pricedAt = Date.parse(`${PRICED_AT}T00:00:00Z`)
    expect(isStale(pricedAt + 1000)).toBe(false)
    expect(isStale(pricedAt + (STALE_AFTER_DAYS + 1) * 86_400_000)).toBe(true)
    // Every answer carries the date, so a surface cannot show money without it.
    expect(costFor(MILLION, 'gpt-4o').pricedAt).toBe(PRICED_AT)
  })

  it('marks every zero-priced entry as local, so no zero is ambiguous', () => {
    for (const [key, price] of Object.entries(MODEL_PRICING)) {
      const isZero = price.usdPerMillion[0] === 0 && price.usdPerMillion[1] === 0
      expect(isZero, `${key} must declare local when it prices at zero`).toBe(price.local === true)
    }
  })
})

// ── 2. the ledger is a pure function of the log ─────────────────────────────

describe('the ledger', () => {
  it('sums over llm_response events and nothing else', () => {
    const events = [
      event('run_started', {}),
      event('llm_request', { model: 'gpt-4o' }),
      event('llm_response', { model: 'gpt-4o', usage: { in: 1_000_000, out: 0 } }),
      event('think', { text: 'not a cost' }),
      event('llm_response', { model: 'gpt-4o', usage: { in: 0, out: 1_000_000 } }),
      event('run_completed', {}),
    ]
    const ledger = ledgerFor(events)

    expect(ledger.calls).toBe(2)
    expect(ledger.tokensIn).toBe(1_000_000)
    expect(ledger.tokensOut).toBe(1_000_000)
    expect(ledger.usd).toBeCloseTo(2.5 + 10.0, 6)
  })

  it('is PURE: same input, same answer, and no state between calls', () => {
    const events = [event('llm_response', { model: 'gpt-4o', usage: { in: 1_000, out: 1_000 } })]
    const first = ledgerFor(events)
    const second = ledgerFor(events)
    const third = ledgerFor(events)
    // A running counter would drift here; a pure function cannot.
    expect(second.usd).toBe(first.usd)
    expect(third.usd).toBe(first.usd)
    expect(third.calls).toBe(1)
  })

  it('counts an unpriced call instead of absorbing it into the total', () => {
    const events = [
      event('llm_response', { model: 'gpt-4o', usage: { in: 1_000_000, out: 0 } }),
      event('llm_response', { model: 'mystery-model', usage: { in: 5_000_000, out: 5_000_000 } }),
    ]
    const ledger = ledgerFor(events)

    // The priced half is priced. The unpriced half is COUNTED, not zeroed.
    expect(ledger.usd).toBeCloseTo(2.5, 6)
    expect(ledger.unpriced).toBe(1)
    expect(ledger.calls).toBe(2)
    // Tokens are still counted for both: a token budget works where a currency
    // budget cannot, which is exactly why both exist.
    expect(ledger.tokensIn).toBe(6_000_000)
    // And the prose says the total is a floor, not the answer.
    expect(describeLedger(ledger)).toContain('could not be priced')
    expect(describeLedger(ledger)).toContain('lower bound')
  })

  it('says “cost unknown” rather than a number when nothing could be priced', () => {
    const ledger = ledgerFor([
      event('llm_response', { model: 'mystery', usage: { in: 10, out: 10 } }),
    ])
    expect(ledger.usd).toBe(0)
    expect(ledger.unpriced).toBe(1)
    // The number is 0 arithmetically and MUST NOT be shown as money.
    expect(describeLedger(ledger)).toContain('Cost unknown')
    expect(describeLedger(ledger)).not.toContain('$0')
  })

  it('reports a local-only run as a real $0.00 and says why', () => {
    const ledger = ledgerFor([
      event('llm_response', { adapter: 'ollama', usage: { in: 9_000, out: 9_000 } }),
    ])
    expect(ledger.usd).toBe(0)
    expect(ledger.allLocal).toBe(true)
    expect(describeLedger(ledger)).toContain('$0.00 (local models only)')
  })

  it('does not claim a run with no priced call was free', () => {
    // Vacuous truth is the wrong answer: nothing established that anything was free.
    expect(ledgerFor([]).allLocal).toBe(false)
    expect(describeLedger(ledgerFor([]))).toBe('No model calls yet.')
  })

  it('counts a cache hit as a call that did not happen', () => {
    const events = [
      event('llm_response', { model: 'gpt-4o', usage: { in: 1_000_000, out: 0 } }),
      event('cache_hit', { model: 'gpt-4o', usage: { in: 1_000_000, out: 0 } }),
    ]
    const ledger = ledgerFor(events)

    // One real call is charged. The hit is not.
    expect(ledger.calls).toBe(1)
    expect(ledger.usd).toBeCloseTo(2.5, 6)
    expect(ledger.cacheHits).toBe(1)
    // What it avoided, reported SEPARATELY. A saving is not a negative expense.
    expect(ledger.savedUsd).toBeCloseTo(2.5, 6)
    expect(ledger.usd).not.toBeCloseTo(0, 6)
  })

  it('scopes to one run when a log holds several', () => {
    const events = [
      event('llm_response', { model: 'gpt-4o', usage: { in: 1_000_000, out: 0 } }, 'runA'),
      event('llm_response', { model: 'gpt-4o', usage: { in: 2_000_000, out: 0 } }, 'runB'),
    ]
    expect(ledgerForRun(events, 'runA').usd).toBeCloseTo(2.5, 6)
    expect(ledgerForRun(events, 'runB').usd).toBeCloseTo(5.0, 6)
    expect(ledgerFor(events).usd).toBeCloseTo(7.5, 6)
  })

  it('survives a malformed usage payload without inventing a number', () => {
    const ledger = ledgerFor([
      event('llm_response', { model: 'gpt-4o', usage: 'not an object' }),
      event('llm_response', { model: 'gpt-4o' }),
      event('llm_response', { model: 'gpt-4o', usage: { in: 'x', out: 2 } }),
    ])
    expect(ledger.calls).toBe(3)
    expect(ledger.tokensIn).toBe(0)
    expect(ledger.usd).toBe(0)
  })

  it('links every row back to the log line it came from', () => {
    // A number a user cannot trace is a number they cannot check.
    const ledger = ledgerFor([
      event('llm_response', { model: 'gpt-4o', iteration: 3, usage: { in: 10, out: 20 } }),
    ])
    const entry = ledger.entries[0]!
    expect(entry.eventId).toBeTruthy()
    expect(entry.iteration).toBe(3)
    expect(entry.model).toBe('gpt-4o')
    expect(entry.usage).toEqual({ in: 10, out: 20 })
  })
})

// ── 3. a real run is priceable end to end ───────────────────────────────────

describe('a real run', () => {
  it('records the model on both llm events, so the ledger can price it', async () => {
    const project = await mkdtemp(join(tmpdir(), 'sketch-cost-'))
    tmpDirs.push(project)
    const events = new MemoryEventStore({ secrets: [] })

    const result = await runTask(
      { id: 'cost-run', prompt: 'Do a thing.', verify: [] },
      {
        adapter: new FakeChatAdapter(),
        events,
        plan: new PlanWriter({ baseDir: project, events }),
        files: new DiskFileWriter(),
        root: project,
      },
    )

    for (const kind of ['llm_request', 'llm_response'] as const) {
      const found = result.events.filter((e) => e.kind === kind)
      expect(found.length).toBeGreaterThan(0)
      for (const e of found) expect(e.payload['model']).toBe('fake')
    }

    // The offline adapter prices at a REAL zero, not "unknown": `fake` is in the table
    // and marked local, which is what makes an offline run's dashboard honest.
    const ledger = ledgerForRun(result.events, result.runId)
    expect(ledger.calls).toBeGreaterThan(0)
    expect(ledger.unpriced).toBe(0)
    expect(ledger.allLocal).toBe(true)
    expect(ledger.usd).toBe(0)
    expect(ledger.tokensIn).toBeGreaterThan(0)
  })

  it('reports an unnamed model as unpriced rather than as free', async () => {
    const project = await mkdtemp(join(tmpdir(), 'sketch-cost-'))
    tmpDirs.push(project)
    const events = new MemoryEventStore({ secrets: [] })

    // An adapter that does not say what model it is. The honest answer is "unknown".
    const anonymous = {
      id: 'mystery-provider',
      chat: async () => ({ text: JSON.stringify({ action: 'done', text: 'ok' }), usage: { in: 5, out: 5 } }),
    }

    const result = await runTask(
      { id: 'cost-unknown', prompt: 'Do a thing.', verify: [] },
      {
        adapter: anonymous,
        events,
        plan: new PlanWriter({ baseDir: project, events }),
        files: new DiskFileWriter(),
        root: project,
      },
    )

    const ledger = ledgerForRun(result.events, result.runId)
    expect(ledger.unpriced).toBe(ledger.calls)
    expect(ledger.allLocal).toBe(false)
    expect(describeLedger(ledger)).toContain('Cost unknown')
  })
})

// ── 4. the duplicates are gone ──────────────────────────────────────────────

describe('one price table, not nine', () => {
  it('declares no per-model price outside the cost module', () => {
    // The drift this prevents is the whole reason `cost/pricing.ts` exists: three
    // tables meant three answers to "what did that cost".
    for (const file of ['providers/openai.ts', 'providers/anthropic.ts', 'providers/gemini.ts']) {
      const text = readFileSync(join(src, file), 'utf8')
      expect(text, `${file} must not declare its own price table`).not.toContain(
        'const COSTS',
      )
    }
  })

  it('has one estimateCost implementation, in the base class', () => {
    const compatible = readFileSync(join(src, 'providers', 'openai-compatible.ts'), 'utf8')
    // Six `return 0` stubs lived here. For the hosted providers that read as FREE.
    expect(compatible).not.toMatch(/estimateCost\s*\(/)

    for (const file of ['providers/openai.ts', 'providers/anthropic.ts', 'providers/gemini.ts']) {
      const text = readFileSync(join(src, file), 'utf8')
      expect(text, `${file} must not override estimateCost`).not.toMatch(/^\s{2}estimateCost\(/m)
    }
    expect(readFileSync(join(src, 'providers', 'base.ts'), 'utf8')).toMatch(/estimateCost\(/)
  })

  it('now prices a hosted OpenAI-compatible provider that used to report free', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 }
    // Groq's override returned 0 for every model. Serving a model the table knows, it
    // is now priced like anywhere else.
    expect(new GroqAdapter().estimateCost(usage, 'gpt-4o-mini')).toBeCloseTo(0.75, 6)
    // A local runtime still reports zero, through the table rather than a stub.
    expect(new OllamaAdapter().estimateCost(usage, 'llama3.3:70b')).toBe(0)
  })

  it('keeps the legacy adapters agreeing with the one table', () => {
    const usage = { inputTokens: 1_000_000, outputTokens: 1_000_000 }
    expect(new OpenAIAdapter().estimateCost(usage, 'gpt-4o')).toBeCloseTo(12.5, 6)
    expect(new AnthropicAdapter().estimateCost(usage, 'claude-sonnet-latest')).toBeCloseTo(18.0, 6)
    expect(new GeminiAdapter().estimateCost(usage, 'gemini-2.0-flash')).toBeCloseTo(0.375, 6)
  })
})
