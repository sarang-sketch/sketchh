// Memory that fills itself from work.
//
// The store, its hygiene, its retrieval and its panel were all real, and the only writer
// was a person clicking a button. That made the compounding claim false by construction:
// a project got smarter from being annotated, never from being worked on.
//
// These tests pin both halves of the deal — that a run CAN write, and that it writes only
// what it actually observed.

import { afterEach, describe, expect, it } from 'vitest'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  ingestRunMemory,
  InMemoryStore,
  JsonlMemoryStore,
  PLAN_MEMORY_KEY,
  VERIFICATION_MEMORY_KEY,
} from '../src/memory/index.js'
import { createEngineExtensionRegistry } from '../src/extensions/index.js'
import { METHODS } from '../src/rpc/methods.js'
import { createMethodContext } from '../src/rpc/server.js'
import type { ChatAdapter, ProviderConfig, RunResult, SketchEvent } from '../src/types.js'

const roots: string[] = []

afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true })
})

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sketch-ingest-'))
  roots.push(root)
  return root
}

function event(kind: SketchEvent['kind'], payload: Record<string, unknown>, id = 'e'): SketchEvent {
  return { id, ts: 1_735_689_600_000, runId: 'r1', kind, payload }
}

describe('run-derived memory writes only what the run recorded', () => {
  it('files the verification outcome and the plan, attributed to the run', async () => {
    const store = new InMemoryStore()
    const result = await ingestRunMemory({
      store,
      runId: 'run-1',
      task: 'Add a health endpoint',
      // The prose comes from the caller, who read it from where the run wrote it. The
      // event only establishes THAT a plan was written — its payload carries the document
      // ids, not their text.
      plan: 'Expose /health returning 200.',
      events: [
        event('plan_written', { dir: '.sketch/plan/run-1', documents: ['prd'] }),
        event('verify_result', { name: 'typecheck', ok: true }),
        event('verify_result', { name: 'unit', ok: false }),
      ],
    })

    expect(result.reason).toBeNull()
    expect(result.written).toHaveLength(2)

    const test = result.written.find((entry) => entry.kind === 'test')!
    expect(test.key).toBe(VERIFICATION_MEMORY_KEY)
    expect(test.source).toBe('run')
    expect(test.runId).toBe('run-1')
    // The real outcome, both halves of it. A summary that only said "failed" would lose
    // which stages were fine.
    expect(test.text).toContain('failed at unit')
    expect(test.text).toContain('typecheck')

    const decision = result.written.find((entry) => entry.kind === 'decision')!
    expect(decision.key).toBe(PLAN_MEMORY_KEY)
    expect(decision.text).toContain('Expose /health returning 200.')
    // Labelled as a run's plan, not as the project's conclusion: the model's intent must
    // not go on the record as something the project decided.
    expect(decision.text).toContain('a run planned')
    expect(decision.text).toContain('Add a health endpoint')
  })

  it('writes nothing when the run established nothing', async () => {
    const store = new InMemoryStore()
    const result = await ingestRunMemory({
      store,
      runId: 'run-empty',
      events: [event('think', { text: 'considering' }), event('llm_request', { messages: 2 })],
    })
    // Silence is the honest answer. An entry here would be this module inventing content
    // and attributing it to the project.
    expect(result.written).toEqual([])
    expect(result.reason).toContain('no plan and no verification outcome')
    expect(await store.all()).toEqual([])
  })

  it('ignores a verify result whose outcome was not recorded as a boolean', async () => {
    const store = new InMemoryStore()
    const result = await ingestRunMemory({
      store,
      runId: 'run-unknown',
      // No `ok`. Reading a missing field as a pass is how a memory store starts asserting
      // that tests were green when nothing said so.
      events: [event('verify_result', { name: 'unit' })],
    })
    expect(result.written).toEqual([])
  })

  it('files no plan for a run that never wrote one, however the caller asks', async () => {
    const store = new InMemoryStore()
    // A caller must not be able to attribute a plan to a run that did not make one:
    // otherwise a stale read of another run's directory lands on this run's record.
    const result = await ingestRunMemory({
      store,
      runId: 'run-no-plan',
      plan: 'A plan this run never wrote.',
      events: [event('verify_result', { name: 'unit', ok: true })],
    })
    expect(result.written.map((entry) => entry.key)).toEqual([VERIFICATION_MEMORY_KEY])
  })

  it('files one plan entry for a run that replanned', async () => {
    const store = new InMemoryStore()
    // Two `plan_written` events, one plan on disk: `PlanWriter` overwrites the document,
    // so what the caller reads IS the run's final plan. The record must not gain an entry
    // per replan.
    const result = await ingestRunMemory({
      store,
      runId: 'run-replan',
      plan: 'Better idea.',
      events: [
        event('plan_written', { dir: 'd', documents: ['prd'] }, 'e1'),
        event('plan_written', { dir: 'd', documents: ['prd'] }, 'e2'),
      ],
    })
    expect(result.written.filter((entry) => entry.key === PLAN_MEMORY_KEY)).toHaveLength(1)
    expect(result.written[0]!.text).toContain('Better idea.')
  })

  it('supersedes the previous run rather than accumulating near-duplicates', async () => {
    const store = new InMemoryStore()
    const first = await ingestRunMemory({
      store,
      runId: 'run-1',
      events: [event('verify_result', { name: 'unit', ok: false })],
    })
    const second = await ingestRunMemory({
      store,
      runId: 'run-2',
      events: [event('verify_result', { name: 'unit', ok: true })],
    })

    expect(second.superseded).toContain(first.written[0]!.id)
    const live = (await store.all()).filter((entry) => entry.validTo === null)
    // ONE current answer per fact. A hundred runs leaving a hundred entries is how an
    // automatic writer destroys the store it was meant to fill.
    expect(live).toHaveLength(1)
    expect(live[0]!.text).toContain('Verification passed')
    expect(live[0]!.runId).toBe('run-2')

    // The history is still there: the log is append-only, so the old fact is closed and
    // not deleted, with a recorded reason.
    const all = await store.all()
    expect(all.length).toBeGreaterThan(1)
    const closed = all.find((entry) => entry.id === first.written[0]!.id && entry.validTo !== null)
    expect(closed).toBeDefined()
    expect(closed!.reason).toContain('run-2')
  })

  it('does not touch an entry the user wrote', async () => {
    const store = new InMemoryStore()
    const mine = await store.add({
      kind: 'test',
      key: VERIFICATION_MEMORY_KEY,
      text: 'I checked by hand and it works.',
      source: 'user',
    })
    await ingestRunMemory({
      store,
      runId: 'run-1',
      events: [event('verify_result', { name: 'unit', ok: true })],
    })
    const still = (await store.all()).find((entry) => entry.id === mine.id)!
    // A run must not close a person's entry. `user` entries are outside hygiene's reach
    // and outside this writer's reach for the same reason.
    expect(still.validTo).toBeNull()
  })
})

// ── through the wire ────────────────────────────────────────────────────────

const descriptor = {
  id: 'ingest-probe',
  name: 'Ingest Probe',
  kind: 'openai-compatible' as const,
  defaultBaseUrl: 'https://ingest.invalid/v1',
  needsKey: false,
  serverless: false,
}

function planningProvider() {
  return (_config: ProviderConfig): ChatAdapter => {
    let turn = 0
    return {
      id: descriptor.id,
      chat: async () => {
        turn += 1
        if (turn === 1) {
          return {
            text: JSON.stringify({
              action: 'plan',
              artifacts: { prd: 'Ship the endpoint.', arch: 'One module.', schema: 'none', tests: 'one' },
            }),
            usage: { in: 1, out: 1 },
          }
        }
        return { text: JSON.stringify({ action: 'done', text: 'finished' }), usage: { in: 1, out: 1 } }
      },
    }
  }
}

function contextFor(root: string) {
  const logs: string[] = []
  return {
    logs,
    ctx: createMethodContext('ingest-test', {
      writeFrame: () => {},
      writeErr: (line) => logs.push(line),
      env: {},
      cwd: () => root,
      secrets: new Set(),
      extensions: createEngineExtensionRegistry({
        providers: [{ descriptor, factory: planningProvider() }],
      }),
    }),
  }
}

const provider = { id: descriptor.id, kind: descriptor.kind, baseUrl: '', model: 'probe' }

describe('the run method writes memory only when asked', () => {
  it('writes nothing by default', async () => {
    const root = await tempRoot()
    const { ctx } = contextFor(root)
    await METHODS.run(
      { root, provider, task: { id: 't', prompt: 'Ship it.', verify: [] } },
      ctx,
    )
    // Off by default: writing to a user's project memory is a side effect on their
    // repository, and the eval harness scores thousands of runs whose plans are fixture
    // noise rather than project knowledge.
    expect(await new JsonlMemoryStore({ baseDir: root }).all()).toEqual([])
  }, 30_000)

  it('writes the run plan when the caller opts in', async () => {
    const root = await tempRoot()
    const { ctx } = contextFor(root)
    const result = (await METHODS.run(
      { root, provider, rememberRun: true, task: { id: 't', prompt: 'Ship it.', verify: [] } },
      ctx,
    )) as RunResult
    expect(result.ok).toBe(true)

    const entries = await new JsonlMemoryStore({ baseDir: root }).all()
    const plan = entries.find((entry) => entry.key === PLAN_MEMORY_KEY)
    expect(plan).toBeDefined()
    expect(plan!.text).toContain('Ship the endpoint.')
    expect(plan!.source).toBe('run')
    expect(plan!.runId).toBe(result.runId)
  }, 30_000)

  it('reports rather than fails the run when memory cannot be written', async () => {
    const root = await tempRoot()
    const { ctx, logs } = contextFor(root)
    const result = (await METHODS.run(
      {
        root,
        provider,
        rememberRun: true,
        // An unknown store id makes the write path throw. The run already happened and its
        // result is already correct, so losing the write must not turn it into an error.
        memoryStore: 'no-such-store',
        task: { id: 't', prompt: 'Ship it.', verify: [] },
      },
      ctx,
    )) as RunResult
    expect(result.ok).toBe(true)
    expect(logs.join('\n')).toContain('memory ingestion failed')
  }, 30_000)
})
