// Phase 8 gate — an overrun stops deterministically, a cache hit avoids the call, and
// the dashboard equals the log.
//
// THE THREE CLAIMS, from tasks.md 8.5:
//   1. An overrun stops or downgrades DETERMINISTICALLY (Requirement 20.4).
//   2. A cache hit avoids the second call (Requirement 20.7).
//   3. The dashboard equals the log (Requirement 20.8).
//
// All three offline, with no API key.
//
// ── ONE CHAIN, BECAUSE THE JOIN IS THE INTERESTING PART ────────────────────
//
// Section 1 runs them as a single sequence over one project, because each claim can hold
// alone and still be useless:
//
//   * A budget can stop a run correctly while the number it stopped on differs from the
//     number the dashboard shows — and then the user cannot tell why it stopped.
//   * A cache can avoid a call and not say so, in which case a working cache and a
//     broken one are indistinguishable from outside.
//   * A dashboard can sum correctly over an in-memory log and disagree with the JSONL
//     bytes the app actually reads.
//
//   a real run that overruns → the exact spend it stopped on → the same figure through
//     the `cost` RPC over the REAL JSONL log → a cached repeat that makes no call
//     → the ledger charging nothing for the hit while reporting what it avoided
//
// ── RECONCILIATION IS AN EQUALITY ──────────────────────────────────────────
//
// `toBe`, not `toBeCloseTo`. The two sides are the same function over the same bytes, so
// a tolerance would be hiding something rather than allowing for it. Requirement 20.8
// says "reconcile exactly" and this is what exactly means.
//
// ── WHAT THIS GATE DOES NOT CLAIM ──────────────────────────────────────────
//
// * NOT that the prices are correct. They are a table read from vendor pages on
//   `PRICED_AT` and they go stale; what is proved is that the arithmetic over the table is
//   right and that the date travels with every figure.
// * NOT that a currency budget can bound every run. It cannot bound an unpriced model, by
//   construction — §3 asserts that limitation rather than papering over it.
// * NOT that Sketch has ever spent real money. Every call here is scripted.
//
// Validates: Requirements 20.4, 20.7, 20.8

import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  MemoryResponseCache,
  cachedAdapter,
  describeLedger,
  ledgerFor,
  ledgerForRun,
  PRICED_AT,
} from '../src/cost/index.js'
import { JsonlEventStore, MemoryEventStore } from '../src/events/index.js'
import { DiskFileWriter } from '../src/orchestrator/file-writer.js'
import { PlanWriter } from '../src/plan/index.js'
import { runTask } from '../src/loop/index.js'
import { METHODS } from '../src/rpc/methods.js'
import type { MethodContext } from '../src/rpc/methods.js'
import type { ChatAdapter, Message, SketchEvent } from '../src/types.js'

const tmpDirs: string[] = []

afterAll(async () => {
  while (tmpDirs.length) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true }).catch(() => {})
  }
})

async function makeProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sketch-phase8-'))
  tmpDirs.push(dir)
  return dir
}

const PLAN = JSON.stringify({
  action: 'plan',
  artifacts: { prd: 'Ship it.', arch: 'One file.', schema: 'none', tests: 'one' },
})
const THINK = JSON.stringify({ action: 'think', text: 'working' })
const DONE = JSON.stringify({ action: 'done', text: 'finished' })

function methodContext(root: string, log: string[]): MethodContext {
  return {
    emitEvent: () => {},
    log: (message) => log.push(message),
    rememberSecret: () => {},
    secrets: () => [],
    env: {},
    cwd: () => root,
  }
}

/** An adapter that counts calls and reports a fixed, priceable usage. */
function counting(options: { id: string; model: string; script: string[]; usage: { in: number; out: number } }) {
  const state = { calls: 0 }
  let index = 0
  const adapter: ChatAdapter = {
    id: options.id,
    model: options.model,
    chat: async () => {
      state.calls += 1
      const text = options.script[Math.min(index, options.script.length - 1)]!
      index += 1
      return { text, usage: options.usage }
    },
  }
  return { adapter, state }
}

// ── 1. the chain ────────────────────────────────────────────────────────────

describe('Phase 8 gate — money is bounded, avoidable, and auditable', () => {
  it('runs the whole chain offline, with no key', async () => {
    expect(process.env.ANTHROPIC_API_KEY ?? '').toBe('')
    expect(process.env.OPENAI_API_KEY ?? '').toBe('')

    const project = await makeProject()
    const report: string[] = []

    // ── (a) a real run that overruns, stopping deterministically ──────────
    //
    // The JSONL store, not the memory one: the dashboard reads these bytes, so the gate
    // has to write them.
    const events = new JsonlEventStore({ baseDir: project, secrets: () => [] })
    const model = counting({
      id: 'openai',
      model: 'gpt-4o',
      // Never finishes on its own. The budget is what ends this run.
      script: [PLAN, THINK, THINK, THINK, THINK, THINK, DONE],
      usage: { in: 200_000, out: 50_000 },
    })

    const budget = { maxTokens: 600_000, onBreach: 'stop' as const }
    const result = await runTask(
      { id: 'phase8-overrun', prompt: 'Do expensive work.', verify: [] },
      {
        adapter: model.adapter,
        events,
        plan: new PlanWriter({ baseDir: project, events }),
        files: new DiskFileWriter(),
        root: project,
        maxIterations: 10,
        budget,
      },
    )

    // CLAIM 1. It stopped, and it stopped because of the budget — not because it ran out
    // of iterations, which would look the same from the outside.
    expect(result.ok).toBe(false)
    const failed = result.events.find((e) => e.kind === 'run_failed')!
    expect(failed.payload['reason']).toBe('budget')
    expect(result.iterations).toBeLessThan(10)

    const exceeded = result.events.find((e) => e.kind === 'budget_exceeded')!
    expect(exceeded.payload['limit']).toBe('tokens')
    expect(exceeded.payload['configured']).toBe('stop')
    expect(exceeded.payload['outcome']).toBe('stopped')

    // (b) THE SPEND IT STOPPED ON IS THE LEDGER'S NUMBER. If the guard kept its own
    // counter, this is where the two would diverge.
    const runLedger = ledgerForRun(result.events, result.runId)
    const spent = exceeded.payload['spent'] as { tokens: number; usd: number; calls: number }
    expect(spent.tokens).toBe(runLedger.tokensIn + runLedger.tokensOut)
    expect(spent.usd).toBe(runLedger.usd)
    expect(spent.calls).toBe(runLedger.calls)
    // AND IT REALLY WAS BOUNDED.
    //
    // The honest bound, and the one this asserts: spend never exceeds the ceiling plus
    // ONE call, because the first call's real cost cannot be known before making it. A
    // first version of this test asserted the ceiling absolutely and failed at 750 000
    // against 600 000 — the guard was comparing a ~1 500-token prompt estimate against
    // calls that really cost 250 000 each. The projection now uses the largest call
    // observed in the run, which brings the overshoot down to at most one call.
    const perCall = 250_000
    const totalTokens = runLedger.tokensIn + runLedger.tokensOut
    expect(totalTokens).toBeLessThanOrEqual(budget.maxTokens + perCall)
    // With the learned projection, this ceiling holds outright: two calls at 250 000
    // project a third to 750 000, which is refused.
    expect(runLedger.calls).toBe(2)
    expect(totalTokens).toBeLessThanOrEqual(budget.maxTokens)
    report.push(
      `stopped after ${runLedger.calls} call(s), ${runLedger.tokensIn + runLedger.tokensOut} of ${budget.maxTokens} tokens, $${runLedger.usd.toFixed(4)}`,
    )

    // ── (c) THE DASHBOARD EQUALS THE LOG, over the real JSONL bytes ───────
    const log: string[] = []
    const dashboard = (await METHODS['cost']!({ root: project }, methodContext(project, log))) as {
      total: { usd: number; tokensIn: number; tokensOut: number; calls: number; unpriced: number }
      pricedAt: string
      summary: string
      skipped: number
      entries: unknown[]
      runs: Array<{ runId: string; usd: number }>
    }

    // Read the same bytes independently and sum them with the library.
    const fromDisk = await new JsonlEventStore({ baseDir: project, secrets: () => [] }).readAll()
    const independent = ledgerFor(fromDisk)

    // CLAIM 3. EQUALITY, not closeness. Both sides are the same function over the same
    // bytes, so a tolerance would be hiding a bug rather than allowing for one.
    expect(dashboard.total.usd).toBe(independent.usd)
    expect(dashboard.total.tokensIn).toBe(independent.tokensIn)
    expect(dashboard.total.tokensOut).toBe(independent.tokensOut)
    expect(dashboard.total.calls).toBe(independent.calls)
    expect(dashboard.summary).toBe(describeLedger(independent))
    expect(dashboard.entries).toHaveLength(independent.entries.length)
    // Nothing was silently dropped on the way through the log.
    expect(dashboard.skipped).toBe(0)
    // And the money is dated, so no surface can show it without the date.
    expect(dashboard.pricedAt).toBe(PRICED_AT)
    // The per-run subtotal matches too, so a dashboard cannot be right in total and
    // wrong per run.
    expect(dashboard.runs.find((r) => r.runId === result.runId)!.usd).toBe(runLedger.usd)
    report.push(`dashboard $${dashboard.total.usd.toFixed(4)} === log $${independent.usd.toFixed(4)}`)

    // ── (d) A CACHE HIT AVOIDS THE SECOND CALL ───────────────────────────
    const cache = new MemoryResponseCache()
    const messages: Message[] = [
      { role: 'system', content: 'You are a helpful assistant.' },
      { role: 'user', content: 'Summarise this function.' },
    ]

    let realCalls = 0
    const first = cachedAdapter({
      adapter: {
        id: 'openai',
        model: 'gpt-4o',
        chat: async () => {
          realCalls += 1
          return { text: 'a summary', usage: { in: 1_000_000, out: 0 } }
        },
      },
      cache,
    })
    expect((await first.chat(messages)).text).toBe('a summary')
    expect(realCalls).toBe(1)

    // The second adapter THROWS if reached. That is what makes "no second network call"
    // an assertion rather than a hope.
    const hits: Array<{ model: string; usage: { in: number; out: number } }> = []
    const second = cachedAdapter({
      adapter: {
        id: 'openai',
        model: 'gpt-4o',
        chat: async () => {
          throw new Error('a second network call was made, which the cache exists to prevent')
        },
      },
      cache,
      onHit: (info) => {
        hits.push({ model: info.model, usage: info.usage })
      },
    })

    // CLAIM 2.
    const replayed = await second.chat(messages)
    expect(replayed.text).toBe('a summary')
    expect(realCalls).toBe(1)
    expect(hits).toHaveLength(1)

    // (e) And the hit charges NOTHING while reporting what it avoided — otherwise a
    // working cache and a broken one look identical from outside.
    const cacheEvents = new MemoryEventStore({ secrets: [] })
    await cacheEvents.emit({
      runId: 'cached-run',
      kind: 'cache_hit',
      payload: { adapter: 'openai', model: hits[0]!.model, usage: hits[0]!.usage },
    })
    const cachedLedger = ledgerForRun(await cacheEvents.readAll(), 'cached-run')
    expect(cachedLedger.calls).toBe(0)
    expect(cachedLedger.usd).toBe(0)
    expect(cachedLedger.cacheHits).toBe(1)
    // $2.50 for a million gpt-4o input tokens, reported as avoided rather than spent.
    expect(cachedLedger.savedUsd).toBe(2.5)
    report.push(`cache: 1 hit, 0 extra calls, $${cachedLedger.savedUsd.toFixed(4)} avoided`)

    // Printed so a reader of the gate sees the measurement, not just a green tick.
    for (const line of report) expect(line.length).toBeGreaterThan(0)
    console.log(report.join('\n'))
  }, 30_000)
})

// ── 2. downgrade is the other deterministic outcome ────────────────────────

describe('Phase 8 gate — the other configured outcome', () => {
  it('downgrades instead of stopping, and the run survives', async () => {
    // The same overrun, one word of configuration different, and a completely different
    // and equally predictable result. That is what "deterministically by configuration"
    // buys (Requirement 20.4).
    const project = await makeProject()
    const events = new MemoryEventStore({ secrets: [] })
    const frontier = counting({
      id: 'openai',
      model: 'gpt-4o',
      script: [PLAN, THINK, THINK, THINK],
      usage: { in: 200_000, out: 50_000 },
    })
    const cheap = counting({ id: 'ollama', model: 'llama3', script: [DONE], usage: { in: 10, out: 10 } })

    const result = await runTask(
      { id: 'phase8-downgrade', prompt: 'Do expensive work.', verify: [] },
      {
        adapter: frontier.adapter,
        events,
        plan: new PlanWriter({ baseDir: project, events }),
        files: new DiskFileWriter(),
        root: project,
        maxIterations: 10,
        budget: { maxTokens: 600_000, onBreach: 'downgrade' },
        router: { cheap: cheap.adapter },
      },
    )

    expect(result.ok).toBe(true)
    const exceeded = result.events.find((e) => e.kind === 'budget_exceeded')!
    expect(exceeded.payload['configured']).toBe('downgrade')
    expect(exceeded.payload['outcome']).toBe('downgraded')
    expect(exceeded.payload['to']).toBe('ollama')

    // The ledger attributes each call to the model that made it, so a downgraded run's
    // cost is visibly split rather than averaged.
    const ledger = ledgerForRun(result.events, result.runId)
    expect(ledger.entries.some((e) => e.model === 'gpt-4o' && e.local === false)).toBe(true)
    expect(ledger.entries.some((e) => e.model === 'llama3' && e.local === true)).toBe(true)
  }, 30_000)

  it('is deterministic across repeats, not merely once', async () => {
    // A guard that happened to fire is not a guard. Same inputs, five times.
    const outcomes: string[] = []
    for (let attempt = 0; attempt < 5; attempt++) {
      const project = await makeProject()
      const events = new MemoryEventStore({ secrets: [] })
      const model = counting({
        id: 'openai',
        model: 'gpt-4o',
        script: [PLAN, THINK, THINK, THINK],
        usage: { in: 200_000, out: 50_000 },
      })
      const result = await runTask(
        { id: `phase8-repeat-${attempt}`, prompt: 'Do expensive work.', verify: [] },
        {
          adapter: model.adapter,
          events,
          plan: new PlanWriter({ baseDir: project, events }),
          files: new DiskFileWriter(),
          root: project,
          maxIterations: 10,
          budget: { maxTokens: 600_000, onBreach: 'stop' },
        },
      )
      const exceeded = result.events.find((e) => e.kind === 'budget_exceeded')
      outcomes.push(`${result.ok}:${String(exceeded?.payload['limit'])}:${model.state.calls}`)
    }
    // Identical every time, including the call count.
    expect(new Set(outcomes).size).toBe(1)
    expect(outcomes[0]).toContain('false:tokens')
  }, 60_000)
})

// ── 3. what the guard admits it cannot do ──────────────────────────────────

describe('Phase 8 gate — the limitation, asserted rather than hidden', () => {
  it('cannot bound an UNPRICED model with a currency budget, and does not pretend to', async () => {
    // This is the honest edge of the design. `cost/pricing.ts` reports an unknown model
    // as `null` rather than zero, so a currency ceiling has nothing to add up — and
    // treating unpriced as free would switch the guard off exactly where a user is most
    // exposed. A token ceiling always works, which is why both exist and why
    // `describeBudget` warns about a currency-only policy.
    const project = await makeProject()
    const events = new MemoryEventStore({ secrets: [] })
    const model = counting({
      id: 'mystery-provider',
      model: 'a-model-not-in-the-table',
      script: [PLAN, THINK, THINK, THINK, THINK, DONE],
      usage: { in: 500_000, out: 500_000 },
    })

    const currencyOnly = await runTask(
      { id: 'phase8-unpriced-usd', prompt: 'Spend money invisibly.', verify: [] },
      {
        adapter: model.adapter,
        events,
        plan: new PlanWriter({ baseDir: project, events }),
        files: new DiskFileWriter(),
        root: project,
        maxIterations: 6,
        budget: { maxUsd: 0.01, onBreach: 'stop' },
      },
    )

    // The currency ceiling never fires, because the spend it can see is zero.
    expect(currencyOnly.events.some((e) => e.kind === 'budget_exceeded')).toBe(false)
    const ledger = ledgerForRun(currencyOnly.events, currencyOnly.runId)
    expect(ledger.unpriced).toBe(ledger.calls)
    expect(ledger.calls).toBeGreaterThan(0)
    // And the report says so, rather than showing $0.00 for a run that spent real money.
    expect(describeLedger(ledger)).toContain('Cost unknown')
    expect(describeLedger(ledger)).not.toContain('$0.00')

    // The token ceiling, on the same unpriced model, DOES hold.
    const project2 = await makeProject()
    const events2 = new MemoryEventStore({ secrets: [] })
    const model2 = counting({
      id: 'mystery-provider',
      model: 'a-model-not-in-the-table',
      script: [PLAN, THINK, THINK, THINK, THINK, DONE],
      usage: { in: 500_000, out: 500_000 },
    })
    const tokenBounded = await runTask(
      { id: 'phase8-unpriced-tokens', prompt: 'Spend money invisibly.', verify: [] },
      {
        adapter: model2.adapter,
        events: events2,
        plan: new PlanWriter({ baseDir: project2, events: events2 }),
        files: new DiskFileWriter(),
        root: project2,
        maxIterations: 6,
        budget: { maxTokens: 1_500_000, onBreach: 'stop' },
      },
    )
    expect(tokenBounded.ok).toBe(false)
    expect(tokenBounded.events.find((e) => e.kind === 'budget_exceeded')!.payload['limit']).toBe(
      'tokens',
    )
  }, 30_000)

  it('does not read an empty log as a run that was free', async () => {
    const project = await makeProject()
    const log: string[] = []
    const dashboard = (await METHODS['cost']!({ root: project }, methodContext(project, log))) as {
      total: { calls: number; allLocal: boolean }
      summary: string
    }
    expect(dashboard.total.calls).toBe(0)
    // Vacuous truth is the wrong answer: nothing established that anything was free.
    expect(dashboard.total.allLocal).toBe(false)
    expect(dashboard.summary).toBe('No model calls yet.')
  })
})

/** Guards against a stray import being dropped by a future edit. */
const _usedTypes: SketchEvent[] = []
void _usedTypes
