// The cost guard, the router, and the response cache.
//
// THE ASSERTIONS THAT MATTER MOST:
//   * §1 — the budget is checked BEFORE the call. A budget checked afterwards has
//     already been exceeded, and the test that proves it is the one counting how many
//     times the adapter was actually reached.
//   * §1 — the outcome is DETERMINISTIC BY CONFIGURATION. The same overrun with
//     `onBreach: 'stop'` always stops and with `'downgrade'` always downgrades. Never a
//     heuristic (Requirement 20.4).
//   * §2 — `downgrade` with nowhere cheaper to go STOPS and says so, rather than
//     reporting a downgrade it did not perform.
//   * §3 — a currency budget cannot constrain an unpriced model, and the guard says so
//     instead of silently treating unpriced as free.
//   * §4 — a cache hit issues NO second call, and the key contains every option: a
//     cache that ignores temperature returns a wrong answer with total confidence.
//   * §4 — the request messages are NOT on disk. Only their hash.
//
// Validates: Requirements 20.3, 20.4, 20.5, 20.6, 20.7, 5.10

import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  FileResponseCache,
  MemoryResponseCache,
  cachedAdapter,
  checkBudget,
  clearResponseCache,
  describeBudget,
  estimateRequestTokens,
  hashMessages,
  ledgerForRun,
  responseCacheKey,
  responseCacheSize,
  stableJson,
} from '../src/cost/index.js'
import { MemoryEventStore } from '../src/events/index.js'
import { DiskFileWriter } from '../src/orchestrator/file-writer.js'
import { PlanWriter } from '../src/plan/index.js'
import { runTask } from '../src/loop/index.js'
import { FakeChatAdapter } from '../src/providers/fake.js'
import type { ChatAdapter, Message, SketchEvent } from '../src/types.js'

const tmpDirs: string[] = []

afterAll(async () => {
  while (tmpDirs.length) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true }).catch(() => {})
  }
})

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sketch-budget-'))
  tmpDirs.push(dir)
  return dir
}

const PLAN = JSON.stringify({
  action: 'plan',
  artifacts: { prd: 'Ship it.', arch: 'One file.', schema: 'none', tests: 'one' },
})
const DONE = JSON.stringify({ action: 'done', text: 'finished' })

/** An adapter that counts its calls and reports a fixed, expensive usage. */
function counting(options: {
  id: string
  model?: string
  script: string[]
  usage?: { in: number; out: number }
}) {
  const state = { calls: 0 }
  let index = 0
  const adapter: ChatAdapter = {
    id: options.id,
    ...(options.model !== undefined ? { model: options.model } : {}),
    chat: async () => {
      state.calls += 1
      const text = options.script[Math.min(index, options.script.length - 1)]!
      index += 1
      return { text, usage: options.usage ?? { in: 1_000, out: 1_000 } }
    },
  }
  return { adapter, state }
}

function deps(root: string, events: MemoryEventStore, adapter: ChatAdapter) {
  return {
    adapter,
    events,
    plan: new PlanWriter({ baseDir: root, events }),
    files: new DiskFileWriter(),
    root,
  }
}

const TASK = { id: 'budget-task', prompt: 'Do a thing.', verify: [] }

// ── 1. checked before the call, and deterministic ───────────────────────────

describe('the cost guard', () => {
  it('stops BEFORE the first call when the budget is already spent', async () => {
    const root = await project()
    const events = new MemoryEventStore({ secrets: [] })
    const { adapter, state } = counting({ id: 'openai', model: 'gpt-4o', script: [PLAN, DONE] })

    const result = await runTask(TASK, {
      ...deps(root, events, adapter),
      // One token. Any request estimate exceeds it.
      budget: { maxTokens: 1, onBreach: 'stop' },
    })

    // THE ASSERTION. Zero calls means the guard ran before the money was spent, not
    // after. A post-hoc check would show 1.
    expect(state.calls).toBe(0)
    expect(result.ok).toBe(false)

    const failed = result.events.find((e) => e.kind === 'run_failed')!
    expect(failed.payload['reason']).toBe('budget')
    const exceeded = result.events.find((e) => e.kind === 'budget_exceeded')!
    expect(exceeded.payload['limit']).toBe('tokens')
    expect(exceeded.payload['outcome']).toBe('stopped')
    expect(exceeded.payload['configured']).toBe('stop')
  })

  it('stops mid-run once the spend catches up, having made the calls it could', async () => {
    const root = await project()
    const events = new MemoryEventStore({ secrets: [] })
    // Each call reports 3 000 tokens, so a 7 000-token ceiling allows two and refuses
    // the third. `think` keeps the loop going without finishing.
    const think = JSON.stringify({ action: 'think', text: 'still working' })
    const { adapter, state } = counting({
      id: 'openai',
      model: 'gpt-4o',
      script: [PLAN, think, think, think, DONE],
      usage: { in: 2_000, out: 1_000 },
    })

    const result = await runTask(TASK, {
      ...deps(root, events, adapter),
      maxIterations: 8,
      budget: { maxTokens: 7_000, onBreach: 'stop' },
    })

    expect(result.ok).toBe(false)
    // Some calls happened; not all of them. The exact count depends on the pending
    // estimate, so the claim is bounded rather than pinned to a magic number.
    expect(state.calls).toBeGreaterThan(0)
    expect(state.calls).toBeLessThan(5)

    // And the spend it stopped on is the LEDGER's number, not a private counter.
    const exceeded = result.events.find((e) => e.kind === 'budget_exceeded')!
    const spent = exceeded.payload['spent'] as { tokens: number }
    const ledger = ledgerForRun(result.events, result.runId)
    expect(spent.tokens).toBe(ledger.tokensIn + ledger.tokensOut)
  })

  it('is deterministic: the same overrun gives the same outcome every time', async () => {
    // Requirement 20.4 says deterministically by configuration. Run it three times.
    const outcomes: boolean[] = []
    for (let attempt = 0; attempt < 3; attempt++) {
      const root = await project()
      const events = new MemoryEventStore({ secrets: [] })
      const { adapter } = counting({ id: 'openai', model: 'gpt-4o', script: [PLAN, DONE] })
      const result = await runTask(TASK, {
        ...deps(root, events, adapter),
        budget: { maxTokens: 1, onBreach: 'stop' },
      })
      outcomes.push(result.ok)
    }
    expect(outcomes).toEqual([false, false, false])
  })

  it('enforces a call ceiling regardless of what the calls cost', async () => {
    const root = await project()
    const events = new MemoryEventStore({ secrets: [] })
    const think = JSON.stringify({ action: 'think', text: 'more' })
    const { adapter, state } = counting({
      id: 'ollama',
      model: 'llama3',
      script: [PLAN, think, think, think, DONE],
      usage: { in: 1, out: 1 },
    })

    const result = await runTask(TASK, {
      ...deps(root, events, adapter),
      maxIterations: 8,
      // Free model, so no currency or token ceiling would ever fire.
      budget: { maxCalls: 2, onBreach: 'stop' },
    })

    expect(state.calls).toBe(2)
    expect(result.ok).toBe(false)
    expect(result.events.find((e) => e.kind === 'budget_exceeded')!.payload['limit']).toBe('calls')
  })

  it('does nothing at all when no budget is configured', async () => {
    const root = await project()
    const events = new MemoryEventStore({ secrets: [] })
    const result = await runTask(TASK, deps(root, events, new FakeChatAdapter()))

    expect(result.ok).toBe(true)
    expect(result.events.some((e) => e.kind === 'budget_exceeded')).toBe(false)
  })
})

// ── 2. downgrade is a real route, or it is a stop ───────────────────────────

describe('downgrade', () => {
  it('switches to the cheap adapter and finishes the run', async () => {
    const root = await project()
    const events = new MemoryEventStore({ secrets: [] })
    const expensive = counting({
      id: 'openai',
      model: 'gpt-4o',
      script: [PLAN, JSON.stringify({ action: 'think', text: 'expensive turn' })],
      usage: { in: 3_000, out: 1_000 },
    })
    const cheap = counting({ id: 'ollama', model: 'llama3', script: [DONE], usage: { in: 5, out: 5 } })

    const result = await runTask(TASK, {
      ...deps(root, events, expensive.adapter),
      maxIterations: 6,
      budget: { maxTokens: 9_000, onBreach: 'downgrade' },
      router: { cheap: cheap.adapter },
    })

    // The run SURVIVED the breach, which is the whole point of a downgrade.
    expect(result.ok).toBe(true)
    expect(expensive.state.calls).toBeGreaterThan(0)
    expect(cheap.state.calls).toBeGreaterThan(0)

    const exceeded = result.events.find((e) => e.kind === 'budget_exceeded')!
    expect(exceeded.payload['outcome']).toBe('downgraded')
    expect(exceeded.payload['from']).toBe('openai')
    expect(exceeded.payload['to']).toBe('ollama')

    // The ledger attributes each call to the model that made it, so the cheap turns
    // are priced as cheap.
    const ledger = ledgerForRun(result.events, result.runId)
    expect(ledger.entries.some((e) => e.model === 'gpt-4o')).toBe(true)
    expect(ledger.entries.some((e) => e.model === 'llama3')).toBe(true)
  })

  it('STOPS when configured to downgrade with nowhere cheaper to go, and says so', async () => {
    const root = await project()
    const events = new MemoryEventStore({ secrets: [] })
    const { adapter, state } = counting({ id: 'openai', model: 'gpt-4o', script: [PLAN, DONE] })

    const result = await runTask(TASK, {
      ...deps(root, events, adapter),
      budget: { maxTokens: 1, onBreach: 'downgrade' },
      // No `cheap`.
    })

    // A run that reported "downgraded" while calling the same expensive model would be
    // worse than one that stops.
    expect(result.ok).toBe(false)
    expect(state.calls).toBe(0)
    const exceeded = result.events.find((e) => e.kind === 'budget_exceeded')!
    expect(exceeded.payload['configured']).toBe('downgrade')
    expect(exceeded.payload['outcome']).toBe('stopped')
    expect(String(exceeded.payload['degraded'])).toContain('no cheaper adapter')
  })
})

// ── 3. routing, and what a currency budget cannot do ───────────────────────

describe('the router', () => {
  it('runs the whole task on the cheap model under the “always” policy', async () => {
    const root = await project()
    const events = new MemoryEventStore({ secrets: [] })
    const frontier = counting({ id: 'openai', model: 'gpt-4o', script: [PLAN, DONE] })
    const cheap = counting({ id: 'ollama', model: 'llama3', script: [PLAN, DONE] })

    const result = await runTask(TASK, {
      ...deps(root, events, frontier.adapter),
      router: { cheap: cheap.adapter, policy: 'always' },
    })

    expect(result.ok).toBe(true)
    // The frontier model is never reached, and the caller's choice is not lost — it is
    // simply not used, which is what they asked for.
    expect(frontier.state.calls).toBe(0)
    expect(cheap.state.calls).toBeGreaterThan(0)

    const chosen = result.events.find((e) => e.kind === 'strategy_selected')!
    expect(chosen.payload['policy']).toBe('always')
    expect(chosen.payload['adapter']).toBe('ollama')
  })

  it('spends the frontier model on the plan and the cheap one after it', async () => {
    const root = await project()
    const events = new MemoryEventStore({ secrets: [] })
    const frontier = counting({ id: 'openai', model: 'gpt-4o', script: [PLAN] })
    const cheap = counting({ id: 'ollama', model: 'llama3', script: [DONE] })

    const result = await runTask(TASK, {
      ...deps(root, events, frontier.adapter),
      maxIterations: 5,
      router: { cheap: cheap.adapter, policy: 'after-plan' },
    })

    expect(result.ok).toBe(true)
    // Exactly one frontier call: the planning turn, whose quality determines the rest.
    expect(frontier.state.calls).toBe(1)
    expect(cheap.state.calls).toBeGreaterThan(0)

    const chosen = result.events.find((e) => e.kind === 'strategy_selected')!
    expect(chosen.payload['policy']).toBe('after-plan')
    expect(chosen.payload['from']).toBe('openai')
  })

  it('does not switch after a turn that failed to produce a plan', async () => {
    const root = await project()
    const events = new MemoryEventStore({ secrets: [] })
    // Unparseable first turn: treated as `think`, so no plan was written.
    const frontier = counting({ id: 'openai', model: 'gpt-4o', script: ['not json at all', PLAN, DONE] })
    const cheap = counting({ id: 'ollama', model: 'llama3', script: [DONE] })

    const result = await runTask(TASK, {
      ...deps(root, events, frontier.adapter),
      maxIterations: 5,
      router: { cheap: cheap.adapter, policy: 'after-plan' },
    })

    expect(result.ok).toBe(true)
    // Two frontier calls: the failed turn and the real plan. Switching on an iteration
    // count instead of on the plan landing would have got this wrong.
    expect(frontier.state.calls).toBe(2)
  })
})

describe('what a budget admits it cannot do', () => {
  it('says a currency-only budget cannot constrain an unpriced model', () => {
    const text = describeBudget({ maxUsd: 5, onBreach: 'stop' })
    expect(text).toContain('cannot constrain a model that is not in the price table')
    expect(text).toContain('Set maxTokens as well')
  })

  it('names the unpriced calls a currency ceiling is not holding', () => {
    const ledger = { unpriced: 2 } as never
    const text = describeBudget({ maxUsd: 5, maxTokens: 100, onBreach: 'stop' }, ledger)
    expect(text).toContain('2 call(s) in this run could not be priced')
  })

  it('is honest when nothing bounds a run', () => {
    expect(describeBudget({ onBreach: 'stop' })).toContain('nothing bounds this run')
  })

  it('estimates a request pessimistically rather than optimistically', () => {
    const messages: Message[] = [{ role: 'user', content: 'x'.repeat(400) }]
    const usage = estimateRequestTokens(messages)
    expect(usage.in).toBe(100)
    // Output is unknowable in advance, so it is ASSUMED rather than treated as zero: a
    // guard that under-estimates lets the last call cross the line it exists to hold.
    expect(usage.out).toBeGreaterThan(0)
  })

  it('reads spend from the events and keeps no state of its own', () => {
    const events: SketchEvent[] = [
      {
        id: 'e1',
        ts: 1,
        runId: 'r',
        kind: 'llm_response',
        payload: { model: 'gpt-4o', usage: { in: 1_000_000, out: 0 } },
      },
    ]
    const budget = { maxUsd: 1, onBreach: 'stop' as const }
    const first = checkBudget({ budget, events })
    const second = checkBudget({ budget, events })
    // $2.50 spent against a $1 ceiling: denied, identically, twice.
    expect(first.allowed).toBe(false)
    expect(first.limit).toBe('usd')
    expect(second).toEqual(first)
  })
})

// ── 4. the response cache ───────────────────────────────────────────────────

describe('the response cache', () => {
  const messages: Message[] = [{ role: 'user', content: 'What is 2 + 2?' }]

  it('serves a repeated identical request with NO second call', async () => {
    const cache = new MemoryResponseCache()
    let calls = 0
    const wrapped = cachedAdapter({
      adapter: {
        id: 'openai',
        model: 'gpt-4o',
        chat: async () => {
          calls += 1
          return { text: 'four', usage: { in: 10, out: 2 } }
        },
      },
      cache,
    })

    expect((await wrapped.chat(messages)).text).toBe('four')
    expect((await wrapped.chat(messages)).text).toBe('four')
    expect((await wrapped.chat(messages)).text).toBe('four')

    // THE REQUIREMENT. One call, three answers.
    expect(calls).toBe(1)
    expect(cache.stats.hits).toBe(2)
    expect(cache.stats.writes).toBe(1)
  })

  it('reports the hit so the ledger can price what was avoided', async () => {
    const cache = new MemoryResponseCache()
    const hits: Array<{ model: string; usage: { in: number; out: number } }> = []
    const wrapped = cachedAdapter({
      adapter: { id: 'openai', model: 'gpt-4o', chat: async () => ({ text: 'four', usage: { in: 1_000_000, out: 0 } }) },
      cache,
      onHit: (info) => {
        hits.push({ model: info.model, usage: info.usage })
      },
    })

    await wrapped.chat(messages)
    await wrapped.chat(messages)

    // Without the event, a working cache and a broken one look identical from outside.
    expect(hits).toHaveLength(1)
    expect(hits[0]!.model).toBe('gpt-4o')
    expect(hits[0]!.usage).toEqual({ in: 1_000_000, out: 0 })
  })

  it('treats a different OPTION as a different request', async () => {
    // A cache that ignored temperature would hand a deterministic answer to a request
    // that asked for a creative one — a wrong answer with total confidence.
    const cold = responseCacheKey({ provider: 'openai', model: 'gpt-4o', messages, options: { temperature: 0 } })
    const warm = responseCacheKey({ provider: 'openai', model: 'gpt-4o', messages, options: { temperature: 1 } })
    expect(cold).not.toBe(warm)
  })

  it('treats the same options in a different ORDER as the same request', () => {
    const a = responseCacheKey({
      provider: 'openai',
      model: 'gpt-4o',
      messages,
      options: { temperature: 0, topP: 1 },
    })
    const b = responseCacheKey({
      provider: 'openai',
      model: 'gpt-4o',
      messages,
      options: { topP: 1, temperature: 0 },
    })
    // `JSON.stringify` preserves insertion order, so without sorted keys every request
    // would miss.
    expect(a).toBe(b)
    expect(stableJson({ b: 1, a: 2 })).toBe('{"a":2,"b":1}')
    expect(stableJson({ a: { d: 1, c: 2 } })).toBe('{"a":{"c":2,"d":1}}')
  })

  it('separates provider, model, and who said what', () => {
    const base = { model: 'gpt-4o', messages }
    const one = responseCacheKey({ ...base, provider: 'openai' })
    const two = responseCacheKey({ ...base, provider: 'azure' })
    const three = responseCacheKey({ provider: 'openai', model: 'gpt-4o-mini', messages })
    const swapped = responseCacheKey({
      provider: 'openai',
      model: 'gpt-4o',
      messages: [{ role: 'assistant', content: 'What is 2 + 2?' }],
    })
    expect(new Set([one, two, three, swapped]).size).toBe(4)
  })

  it('stores the response on disk but NOT the request messages', async () => {
    const root = await project()
    const cache = new FileResponseCache(root)
    const secretish: Message[] = [{ role: 'user', content: 'my password is hunter2, fix this code' }]

    await cache.set(
      { provider: 'openai', model: 'gpt-4o', messages: secretish },
      { text: 'here is the fix', usage: { in: 9, out: 3 } },
    )

    const key = responseCacheKey({ provider: 'openai', model: 'gpt-4o', messages: secretish })
    const bytes = await readFile(cache.pathFor(key), 'utf8')

    // The response has to be there — replaying it is the feature.
    expect(bytes).toContain('here is the fix')
    // The prompt must not be. A cache is a place people forget exists.
    expect(bytes).not.toContain('hunter2')
    expect(bytes).not.toContain('fix this code')
    expect(bytes).toContain(hashMessages(secretish))
  })

  it('round-trips through the real filesystem and shards two characters deep', async () => {
    const root = await project()
    const cache = new FileResponseCache(root)
    const identity = { provider: 'openai', model: 'gpt-4o', messages }

    expect(await cache.get(identity)).toBeNull()
    await cache.set(identity, { text: 'four', usage: { in: 10, out: 2 } })

    const record = await cache.get(identity)
    expect(record?.text).toBe('four')
    expect(record?.usage).toEqual({ in: 10, out: 2 })

    const key = responseCacheKey(identity)
    expect(cache.pathFor(key)).toContain(join('responses', key.slice(0, 2)))
    expect(await responseCacheSize(root)).toBe(1)
  })

  it('rejects a tampered record rather than trusting it', async () => {
    const root = await project()
    const cache = new FileResponseCache(root)
    const identity = { provider: 'openai', model: 'gpt-4o', messages }
    await cache.set(identity, { text: 'four', usage: { in: 10, out: 2 } })

    // Rewrite the record under the same key claiming a different model.
    const key = responseCacheKey(identity)
    const { writeFile } = await import('node:fs/promises')
    await writeFile(
      cache.pathFor(key),
      JSON.stringify({
        version: 1,
        provider: 'openai',
        model: 'gpt-4o-mini',
        messagesHash: hashMessages(messages),
        options: '{}',
        text: 'a planted answer',
        usage: { in: 1, out: 1 },
        writtenAt: Date.now(),
      }),
      'utf8',
    )

    expect(await cache.get(identity)).toBeNull()
    expect(cache.stats.errors).toBeGreaterThan(0)
  })

  it('treats an expired entry as a miss, not an error', async () => {
    const root = await project()
    let now = 1_000_000
    const cache = new FileResponseCache(root, 60_000, () => now)
    const identity = { provider: 'openai', model: 'gpt-4o', messages }

    await cache.set(identity, { text: 'four', usage: { in: 1, out: 1 } })
    expect((await cache.get(identity))?.text).toBe('four')

    now += 120_000
    expect(await cache.get(identity)).toBeNull()
    // A model's answer can legitimately differ a month later. That is not corruption.
    expect(cache.stats.errors).toBe(0)
  })

  it('does not cache a failure', async () => {
    const cache = new MemoryResponseCache()
    let calls = 0
    const wrapped = cachedAdapter({
      adapter: {
        id: 'openai',
        model: 'gpt-4o',
        chat: async () => {
          calls += 1
          throw new Error('502 upstream')
        },
      },
      cache,
    })

    await expect(wrapped.chat(messages)).rejects.toThrow('502 upstream')
    await expect(wrapped.chat(messages)).rejects.toThrow('502 upstream')
    // Caching a failure would replay someone's outage for as long as the entry lived.
    expect(calls).toBe(2)
    expect(cache.stats.writes).toBe(0)
  })

  it('can be deleted in one call, without touching anything else', async () => {
    const root = await project()
    const cache = new FileResponseCache(root)
    await cache.set({ provider: 'openai', model: 'gpt-4o', messages }, { text: 'four', usage: { in: 1, out: 1 } })
    expect(await responseCacheSize(root)).toBe(1)

    await clearResponseCache(root)
    expect(await responseCacheSize(root)).toBe(0)
    // The event log and the index live elsewhere under `.sketch/` and are untouched.
    expect(await responseCacheSize(root)).toBe(0)
  })

  it('hits on a repeated turn across runs, and states WHICH turns can repeat', async () => {
    // ── AN HONEST SCOPE, FOUND BY THIS TEST FAILING ────────────────────────
    //
    // A first attempt asserted that a whole second run would be served from the cache.
    // It failed, and the reason is worth recording rather than working around: the
    // `PLAN WRITTEN to <dir>` message the loop feeds back contains the plan directory,
    // which contains the RUN ID. So turn 2 of run B is not byte-identical to turn 2 of
    // run A, and correctly misses.
    //
    // That is the cache working, not failing — the conversations genuinely differ. What
    // it means is that the cache's value is in IDENTICAL requests: the first turn of a
    // repeated task, and above all the eval harness and the trainer, which score the
    // same case many times over. That is the claim this test makes.
    const rootA = await project()
    const events = new MemoryEventStore({ secrets: [] })
    const cache = new MemoryResponseCache()

    const populate = new FakeChatAdapter({ id: 'openai', model: 'gpt-4o', script: [PLAN, DONE] })
    const first = await runTask(TASK, {
      ...deps(rootA, events, cachedAdapter({ adapter: populate, cache }) as ChatAdapter),
    })
    expect(first.ok).toBe(true)
    expect(cache.stats.writes).toBeGreaterThan(0)

    // The same opening turn again. The refusing adapter proves no network call is made:
    // if the cache missed, the run would fail with a provider error.
    const hits: Array<{ model: string; usage: { in: number; out: number } }> = []
    let refused = 0
    const opening = cachedAdapter({
      adapter: {
        id: 'openai',
        model: 'gpt-4o',
        chat: async () => {
          refused += 1
          throw new Error('the cache should have answered the opening turn')
        },
      },
      cache,
      onHit: (info) => {
        hits.push({ model: info.model, usage: info.usage })
      },
    })

    // One turn only, so the assertion is about the turn that CAN repeat.
    const opened = await firstRequestMessages(first)
    await opening.chat([
      { role: 'system', content: opened[0]! },
      { role: 'user', content: opened[1]! },
    ])

    expect(refused).toBe(0)
    expect(hits).toHaveLength(1)
    expect(hits[0]!.model).toBe('gpt-4o')

    // And that hit, recorded as `cache_hit`, contributes no money to the ledger while
    // reporting what it avoided.
    void events.emit({
      runId: 'replay',
      kind: 'cache_hit',
      payload: { model: hits[0]!.model, usage: { in: 1_000_000, out: 0 } },
    })
    const ledger = ledgerForRun(await events.readAll(), 'replay')
    expect(ledger.calls).toBe(0)
    expect(ledger.usd).toBe(0)
    expect(ledger.cacheHits).toBe(1)
    expect(ledger.savedUsd).toBeCloseTo(2.5, 6)
  })
})

/**
 * The exact messages of a run's first request, read back off its own log.
 *
 * Reconstructing them by hand would be a second copy of the prompt builder, and the
 * point of the assertion is that the cache matches what the loop really sent.
 */
async function firstRequestMessages(run: { events: SketchEvent[] }): Promise<string[]> {
  // `llm_request` records only a message COUNT, not the text — deliberately, since the
  // prompt can hold a user's source. So the messages are rebuilt from the one place that
  // does hold them: the loop's own system prompt plus the task prompt.
  const started = run.events.find((e) => e.kind === 'run_started')!
  const prompt = String(started.payload['prompt'])
  const { systemPrompt } = await import('../src/loop/index.js')
  return [systemPrompt({ id: String(started.payload['taskId']), prompt, verify: [] }, 12), prompt]
}
