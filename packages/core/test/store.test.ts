// Event store tests.
//
// Uses REAL: JsonlEventStore against real temp directories, MemoryEventStore,
// the real id generators, and the real payload sanitizer. Nothing is mocked —
// the append-only and redaction guarantees are only worth anything if they are
// asserted against actual bytes on disk.
//
// Validates: Requirements 3.2, 3.5, 3.6, 3.7, 3.8, 3.9

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, rm, readFile, appendFile, mkdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  JsonlEventStore,
  MemoryEventStore,
  newRunId,
  newEventId,
  sanitizePayload,
  REDACTED,
} from '../src/events/index.js'
import type { EventKind, SketchEvent } from '../src/types.js'

const tmpDirs: string[] = []

async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sketch-events-'))
  tmpDirs.push(dir)
  return dir
}

/** A store with an injected clock and id sequence: fully deterministic. */
function deterministicStore(baseDir: string, ts = 1_700_000_000_000) {
  let n = 0
  return new JsonlEventStore({
    baseDir,
    clock: () => ts,
    ids: () => `e${++n}`,
    secrets: [],
  })
}

afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

describe('JsonlEventStore round trip', () => {
  it('emits and reads back an event unchanged', async () => {
    const base = await makeTmp()
    const store = deterministicStore(base)

    await store.emit({ runId: 'r1', kind: 'run_started', payload: { prompt: 'hello' } })

    const all = await store.readAll()
    expect(all).toEqual([
      { id: 'e1', ts: 1_700_000_000_000, runId: 'r1', kind: 'run_started', payload: { prompt: 'hello' } },
    ])
  })

  it('writes one JSON object per line under .sketch/events/<date>.jsonl', async () => {
    const base = await makeTmp()
    const store = deterministicStore(base)

    await store.emit({ runId: 'r1', kind: 'think', payload: { text: 'a' } })
    await store.emit({ runId: 'r1', kind: 'think', payload: { text: 'b' } })

    const expected = join(base, '.sketch', 'events', '2023-11-14.jsonl')
    expect(store.fileFor(1_700_000_000_000)).toBe(expected)

    const raw = await readFile(expected, 'utf8')
    const lines = raw.split('\n').filter((l) => l !== '')
    expect(lines).toHaveLength(2)
    for (const line of lines) expect(() => JSON.parse(line)).not.toThrow()
  })

  it('survives deeply nested and array payloads', async () => {
    const base = await makeTmp()
    const store = deterministicStore(base)
    const payload = {
      list: [1, 'two', null, true, { deep: { deeper: [{ deepest: 'x' }] } }],
      empty: {},
      emptyList: [],
      nested: { a: { b: { c: { d: [1, [2, [3]]] } } } },
    }

    await store.emit({ runId: 'r1', kind: 'context_assembled', payload })

    const [event] = await store.readAll()
    expect(event!.payload).toEqual(payload)
  })

  it('defaults an omitted payload to an empty object', async () => {
    const base = await makeTmp()
    const store = deterministicStore(base)
    await store.emit({ runId: 'r1', kind: 'run_completed' })
    expect((await store.readAll())[0]!.payload).toEqual({})
  })
})

describe('emission order', () => {
  it('returns two events emitted within the same millisecond in emission order', async () => {
    const base = await makeTmp()
    // A fixed clock: every event shares a timestamp, so `ts` cannot order them.
    const store = deterministicStore(base, 1_700_000_000_000)

    for (const text of ['first', 'second', 'third', 'fourth']) {
      await store.emit({ runId: 'r1', kind: 'think', payload: { text } })
    }

    const all = await store.readAll()
    expect(all.map((e) => e.ts)).toEqual(Array(4).fill(1_700_000_000_000))
    expect(all.map((e) => e.payload.text)).toEqual(['first', 'second', 'third', 'fourth'])
  })

  it('forRun returns only that run\u2019s events, in emission order', async () => {
    const base = await makeTmp()
    const store = deterministicStore(base)

    await store.emit({ runId: 'a', kind: 'run_started', payload: { n: 1 } })
    await store.emit({ runId: 'b', kind: 'run_started', payload: { n: 2 } })
    await store.emit({ runId: 'a', kind: 'think', payload: { n: 3 } })
    await store.emit({ runId: 'b', kind: 'think', payload: { n: 4 } })
    await store.emit({ runId: 'a', kind: 'run_completed', payload: { n: 5 } })

    const a = await store.forRun('a')
    expect(a.map((e) => e.runId)).toEqual(['a', 'a', 'a'])
    expect(a.map((e) => e.payload.n)).toEqual([1, 3, 5])
    expect((await store.forRun('b')).map((e) => e.payload.n)).toEqual([2, 4])
    expect(await store.forRun('missing')).toEqual([])
  })

  it('reads across day files in date order', async () => {
    const base = await makeTmp()
    let day = 0
    // Clock advances a day per emit, so each event lands in its own file.
    const store = new JsonlEventStore({
      baseDir: base,
      clock: () => 1_700_000_000_000 + day++ * 86_400_000,
      secrets: [],
    })

    for (const n of [1, 2, 3]) await store.emit({ runId: 'r1', kind: 'think', payload: { n } })

    expect((await store.readAll()).map((e) => e.payload.n)).toEqual([1, 2, 3])
  })
})

describe('append-only guarantee', () => {
  it('never rewrites bytes already on disk', async () => {
    const base = await makeTmp()
    const store = deterministicStore(base)
    const file = store.fileFor(1_700_000_000_000)

    for (const n of [1, 2, 3]) await store.emit({ runId: 'r1', kind: 'think', payload: { n } })
    const before = await readFile(file)

    await store.emit({ runId: 'r1', kind: 'think', payload: { n: 4 } })
    const after = await readFile(file)

    expect(after.length).toBeGreaterThan(before.length)
    expect(after.subarray(0, before.length).equals(before)).toBe(true)
  })
})

describe('malformed line tolerance', () => {
  it('skips a malformed line in the middle and still loads its neighbours', async () => {
    const base = await makeTmp()
    const store = deterministicStore(base)
    const file = store.fileFor(1_700_000_000_000)

    await store.emit({ runId: 'r1', kind: 'think', payload: { n: 1 } })
    await appendFile(file, 'this is not json at all\n', 'utf8')
    await appendFile(file, '{"id":"x","ts":1}\n', 'utf8') // parses, wrong shape
    await store.emit({ runId: 'r1', kind: 'think', payload: { n: 2 } })

    const { events, skipped } = await store.readAllDetailed()
    expect(events.map((e) => e.payload.n)).toEqual([1, 2])
    expect(skipped).toBe(2)
  })

  it('skips a truncated final line left by a crash mid-write', async () => {
    const base = await makeTmp()
    const store = deterministicStore(base)
    const file = store.fileFor(1_700_000_000_000)

    await store.emit({ runId: 'r1', kind: 'think', payload: { n: 1 } })
    await store.emit({ runId: 'r1', kind: 'think', payload: { n: 2 } })
    // No trailing newline: the process died halfway through the append.
    await appendFile(file, '{"id":"e3","ts":170000000000,"runId":"r1","kind":"th', 'utf8')

    const { events, skipped } = await store.readAllDetailed()
    expect(events.map((e) => e.payload.n)).toEqual([1, 2])
    expect(skipped).toBe(1)
  })

  it('still reads lines written under the pre-amendment kinds (Requirement 3.1c)', async () => {
    // THE OLD-LOG QUESTION, asserted rather than asserted-in-prose. Before the
    // `EventKind` amendment the repo index reported `context_loaded` with
    // `component: "repo-graph"` and the cost router reported `strategy_selected`
    // with `component: "router"`. Those lines are on disk in real projects. The
    // reader validates SHAPE, not membership of the union, so they still load with
    // their kind and payload intact — which is what keeps an old timeline readable.
    const base = await makeTmp()
    const store = deterministicStore(base)
    const file = store.fileFor(1_700_000_000_000)

    await store.emit({ runId: 'r1', kind: 'repo_indexed', payload: { files: 4 } })
    await appendFile(
      file,
      `${JSON.stringify({
        id: 'legacy-1',
        ts: 1_700_000_000_001,
        runId: 'r1',
        kind: 'context_loaded',
        payload: { component: 'repo-graph', files: 9 },
      })}\n`,
      'utf8',
    )
    await appendFile(
      file,
      `${JSON.stringify({
        id: 'legacy-2',
        ts: 1_700_000_000_002,
        runId: 'r1',
        kind: 'strategy_selected',
        payload: { component: 'router', policy: 'always' },
      })}\n`,
      'utf8',
    )

    const { events, skipped } = await store.readAllDetailed()
    expect(skipped).toBe(0)
    expect(events.map((e) => e.kind)).toEqual([
      'repo_indexed',
      'context_loaded',
      'strategy_selected',
    ])
    expect(events[1]!.payload.component).toBe('repo-graph')
    expect(events[1]!.payload.files).toBe(9)
    expect(events[2]!.payload.component).toBe('router')
  })

  it('returns [] for a non-existent events directory', async () => {
    const base = await makeTmp()
    const store = new JsonlEventStore({ baseDir: join(base, 'never-written'), secrets: [] })
    expect(await store.readAll()).toEqual([])
    expect(await store.forRun('r1')).toEqual([])
  })

  it('ignores non-jsonl files sitting in the events directory', async () => {
    const base = await makeTmp()
    const store = deterministicStore(base)
    await store.emit({ runId: 'r1', kind: 'think', payload: { n: 1 } })
    await mkdir(store.directory, { recursive: true })
    await appendFile(join(store.directory, 'README.md'), 'not an event log\n', 'utf8')

    const { events, skipped } = await store.readAllDetailed()
    expect(events).toHaveLength(1)
    expect(skipped).toBe(0)
  })
})

describe('no payload may carry a secret', () => {
  const KEY = 'sk-live-A1b2C3d4E5f6G7h8I9j0'

  it('strips a known key value before it reaches disk', async () => {
    const base = await makeTmp()
    const store = new JsonlEventStore({
      baseDir: base,
      clock: () => 1_700_000_000_000,
      secrets: [KEY],
    })

    await store.emit({
      runId: 'r1',
      kind: 'llm_request',
      payload: {
        url: `https://api.example.com/v1/chat?key=${KEY}`,
        headers: { 'user-agent': 'sketch' },
        note: `failed with ${KEY} attached`,
        nested: { list: [{ deep: KEY }] },
      },
    })

    const raw = await readFile(store.fileFor(1_700_000_000_000), 'utf8')
    expect(raw).not.toContain(KEY)
    expect(raw).toContain(REDACTED)

    const [event] = await store.readAll()
    expect(event!.payload.url).toBe(`https://api.example.com/v1/chat?key=${REDACTED}`)
    expect(event!.payload.nested).toEqual({ list: [{ deep: REDACTED }] })
  })

  it('redacts credential-shaped keys regardless of their value', async () => {
    const base = await makeTmp()
    const store = new JsonlEventStore({ baseDir: base, clock: () => 1_700_000_000_000, secrets: [] })

    await store.emit({
      runId: 'r1',
      kind: 'llm_request',
      payload: {
        authorization: 'Basic dXNlcjpwYXNz',
        apiKey: 'anything-at-all',
        api_key: 'anything-at-all',
        'x-api-key': 'anything-at-all',
        'X-API-Key': 'anything-at-all',
        password: 'hunter2',
        token: 'abc',
        secret: 'shh',
        headers: { Authorization: 'Bearer nested-value' },
        // Not credentials: must survive untouched.
        maxTokens: 4096,
        usage: { in: 10, out: 20 },
      },
    })

    const raw = await readFile(store.fileFor(1_700_000_000_000), 'utf8')
    expect(raw).not.toContain('anything-at-all')
    expect(raw).not.toContain('hunter2')
    expect(raw).not.toContain('dXNlcjpwYXNz')
    expect(raw).not.toContain('nested-value')

    const [event] = await store.readAll()
    expect(event!.payload.authorization).toBe(REDACTED)
    expect(event!.payload.apiKey).toBe(REDACTED)
    expect(event!.payload['x-api-key']).toBe(REDACTED)
    expect(event!.payload.headers).toEqual({ Authorization: REDACTED })
    expect(event!.payload.maxTokens).toBe(4096)
    expect(event!.payload.usage).toEqual({ in: 10, out: 20 })
  })

  it('redacts key-shaped strings that were never configured', async () => {
    const base = await makeTmp()
    const store = new JsonlEventStore({ baseDir: base, clock: () => 1_700_000_000_000, secrets: [] })

    await store.emit({
      runId: 'r1',
      kind: 'llm_response',
      payload: { text: 'try ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345 next' },
    })

    const raw = await readFile(store.fileFor(1_700_000_000_000), 'utf8')
    expect(raw).not.toContain('ghp_ABCDEFGHIJKLMNOPQRSTUVWXYZ012345')
  })

  it('sanitizePayload does not mutate its input and tolerates cycles', () => {
    const input: Record<string, unknown> = { apiKey: 'k', keep: 'value' }
    const cyclic: Record<string, unknown> = { name: 'loop' }
    cyclic.self = cyclic
    input.cyclic = cyclic

    const out = sanitizePayload(input, [])
    expect(input.apiKey).toBe('k')
    expect(out.apiKey).toBe(REDACTED)
    expect(out.keep).toBe('value')
  })
})

describe('MemoryEventStore', () => {
  it('satisfies the same contract as the file store', async () => {
    let n = 0
    const store = new MemoryEventStore({ clock: () => 42, ids: () => `e${++n}`, secrets: ['s3cr3t-value'] })

    store.emit({ runId: 'a', kind: 'run_started', payload: { note: 'has s3cr3t-value inside' } })
    store.emit({ runId: 'b', kind: 'think', payload: { apiKey: 'x' } })
    store.emit({ runId: 'a', kind: 'run_completed', payload: {} })

    expect(store.size).toBe(3)
    expect((await store.readAll()).map((e) => e.id)).toEqual(['e1', 'e2', 'e3'])
    expect((await store.forRun('a')).map((e) => e.kind)).toEqual(['run_started', 'run_completed'])
    expect((await store.readAll())[0]!.payload.note).toBe(`has ${REDACTED} inside`)
    expect((await store.readAll())[1]!.payload.apiKey).toBe(REDACTED)
  })

  it('hands out copies so callers cannot mutate the log', async () => {
    const store = new MemoryEventStore({ secrets: [] })
    store.emit({ runId: 'a', kind: 'think', payload: { n: 1 } })
    const first = await store.readAll()
    first[0]!.runId = 'tampered'
    expect((await store.readAll())[0]!.runId).toBe('a')
  })
})

describe('run identifiers', () => {
  it('does not collide when many are minted in the same millisecond', () => {
    const fixedNow = 1_700_000_000_000
    const ids = new Set<string>()
    for (let i = 0; i < 20_000; i++) ids.add(newRunId(fixedNow))
    expect(ids.size).toBe(20_000)
  })

  it('does not collide across two stores minting at the same instant', () => {
    const fixedNow = 1_700_000_000_000
    const storeA = Array.from({ length: 500 }, () => newRunId(fixedNow))
    const storeB = Array.from({ length: 500 }, () => newRunId(fixedNow))
    expect(new Set([...storeA, ...storeB]).size).toBe(1000)
  })

  it('sorts lexicographically in creation order', () => {
    const created = [
      newRunId(1),
      newRunId(1_000),
      newRunId(1_600_000_000_000),
      newRunId(1_700_000_000_000),
      newRunId(1_700_000_000_001),
      newRunId(4_000_000_000_000),
    ]
    expect([...created].sort()).toEqual(created)
  })

  it('has a fixed-width sortable prefix and no shared state', () => {
    const a = newRunId(1_700_000_000_000)
    const b = newRunId(1_700_000_000_000)
    expect(a).toMatch(/^r[0-9a-z]{9}-[0-9a-f]{16}$/)
    expect(a.slice(0, 10)).toBe(b.slice(0, 10))
    expect(a).not.toBe(b)
  })

  it('mints unique event ids', () => {
    const ids = new Set(Array.from({ length: 5_000 }, () => newEventId()))
    expect(ids.size).toBe(5_000)
  })
})

// ---------------------------------------------------------------------------
// Property-based test: append/read round trip.
//
// Invariant: for ANY list of emitted events, readAll() returns exactly that
// list, in that order. Generator is hand-rolled over a seeded PRNG — no
// fast-check, no dependency, and a failure is reproducible from its seed.
// ---------------------------------------------------------------------------

/** mulberry32: tiny, fast, well-distributed seeded PRNG. */
function prng(seed: number): () => number {
  let a = seed >>> 0
  return () => {
    a = (a + 0x6d2b79f5) >>> 0
    let t = a
    t = Math.imul(t ^ (t >>> 15), t | 1)
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61)
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296
  }
}

const KINDS: EventKind[] = [
  'run_started',
  'plan_written',
  'llm_request',
  'llm_response',
  'think',
  'verify_started',
  'verify_result',
  'tool_called',
  'run_completed',
  'run_failed',
]

function genValue(rand: () => number, depth: number): unknown {
  const pick = rand()
  if (depth >= 3 || pick < 0.3) {
    const leaf = rand()
    if (leaf < 0.25) return Math.floor(rand() * 1_000_000)
    if (leaf < 0.4) return rand() < 0.5
    if (leaf < 0.5) return null
    // Alphanumeric only: no key-shaped substring can be generated by accident.
    const len = 1 + Math.floor(rand() * 12)
    let s = ''
    for (let i = 0; i < len; i++) s += 'abcdefghijklmnopqrstuvwxyz0123456789'[Math.floor(rand() * 36)]
    return s
  }
  if (pick < 0.65) {
    const n = Math.floor(rand() * 4)
    return Array.from({ length: n }, () => genValue(rand, depth + 1))
  }
  const n = Math.floor(rand() * 4)
  const obj: Record<string, unknown> = {}
  for (let i = 0; i < n; i++) obj[`k${i}`] = genValue(rand, depth + 1)
  return obj
}

function genEvents(
  rand: () => number,
  count: number,
): Array<{ runId: string; kind: EventKind; payload: Record<string, unknown> }> {
  const runs = ['run-a', 'run-b', 'run-c']
  return Array.from({ length: count }, () => ({
    runId: runs[Math.floor(rand() * runs.length)]!,
    kind: KINDS[Math.floor(rand() * KINDS.length)]!,
    payload: { field: genValue(rand, 1), n: Math.floor(rand() * 1000) },
  }))
}

describe('property: append/read round trip', () => {
  it('readAll returns exactly the emitted events, in order, for any generated list', async () => {
    for (let seed = 1; seed <= 25; seed++) {
      const rand = prng(seed)
      const base = await makeTmp()
      // Monotonic non-decreasing clock with repeated timestamps and occasional
      // day rollovers: ordering cannot be rescued by `ts`, and events spread
      // across several day files.
      let now = 1_700_000_000_000
      const store = new JsonlEventStore({
        baseDir: base,
        clock: () => {
          if (rand() < 0.35) now += rand() < 0.25 ? 86_400_000 : 1
          return now
        },
        secrets: [],
      })

      const inputs = genEvents(rand, 1 + Math.floor(rand() * 30))
      const emitted: SketchEvent[] = []
      for (const input of inputs) await store.emit(input)

      const read = await store.readAll()
      expect(read, `seed ${seed}`).toHaveLength(inputs.length)
      read.forEach((event, i) => {
        expect(event.runId, `seed ${seed} index ${i}`).toBe(inputs[i]!.runId)
        expect(event.kind, `seed ${seed} index ${i}`).toBe(inputs[i]!.kind)
        expect(event.payload, `seed ${seed} index ${i}`).toEqual(inputs[i]!.payload)
        emitted.push(event)
      })

      // forRun is a stable filter of the same order.
      for (const runId of ['run-a', 'run-b', 'run-c']) {
        expect(await store.forRun(runId), `seed ${seed} run ${runId}`).toEqual(
          emitted.filter((e) => e.runId === runId),
        )
      }
    }
  })
})
