// Versioned project memory: append-only rows, hygiene, and reranked retrieval.
//
// THE ASSERTIONS THAT MATTER MOST:
//   * §1 — the log is APPEND-ONLY by construction. Superseding appends a close op; no
//     line is ever rewritten, asserted on the bytes AND at the source level.
//   * §2 — superseding records a REASON and emits `memory_superseded`. "Superseded, no
//     reason given" is indistinguishable from a bug six months later.
//   * §3 — the lint pass REPORTS and supersedes nothing. Deciding from prose which of two
//     decisions is wrong would eventually discard the correct one.
//   * §4 — retrieval EXCLUDES retracted entries by default. A fact the project has
//     explicitly withdrawn, presented to a model as current, is worse than no memory.
//   * §4 — recency is a bounded PRIOR, not a sort: a strongly matching old entry still
//     beats a barely matching new one.
//   * §5 — the legacy `ProjectMemory` surface still works, so the orchestrator that
//     depends on four of its members is not broken by any of this.
//
// Validates: Requirements 21.1, 21.2, 21.3, 21.4, 21.5, 21.7

import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { readFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  InMemoryStore,
  JsonlMemoryStore,
  MEMORY_KINDS,
  applyOps,
  asMemoryEntry,
  asMemoryOp,
  describeWindow,
  expireMemory,
  isCurrent,
  isMemoryKind,
  legacyProjectMemory,
  lintMemory,
  memoryDigest,
  memoryDir,
  recencyBoost,
  remember,
  renderMemoryForPrompt,
  retrieveMemory,
  supersedeEntry,
  type MemoryEntry,
  type MemoryStore,
} from '../src/memory/index.js'
import { MemoryEventStore } from '../src/events/index.js'
import type { SketchEvent } from '../src/types.js'

const src = join(dirname(fileURLToPath(import.meta.url)), '..', 'src')
const tmpDirs: string[] = []

afterAll(async () => {
  while (tmpDirs.length) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true }).catch(() => {})
  }
})

async function project(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sketch-memory-'))
  tmpDirs.push(dir)
  return dir
}

const DAY = 86_400_000

/** A store with a controllable clock and deterministic ids. */
function fixedStore(start = 1_700_000_000_000) {
  let now = start
  let counter = 0
  const store = new InMemoryStore({
    clock: () => now,
    ids: () => `m${++counter}`,
  })
  return {
    store,
    at: (ts: number) => {
      now = ts
    },
    advance: (ms: number) => {
      now += ms
    },
    get now() {
      return now
    },
  }
}

// ── 1. append-only, and versioned ───────────────────────────────────────────

describe('the store is append-only', () => {
  it('writes only mkdir and appendFile — asserted at the source level', () => {
    // The same structural guard the event store has. "Append-only" that depends on
    // nobody adding a writeFile later is not a guarantee.
    const source = readFileSync(join(src, 'memory', 'store.ts'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '')
      .replace(/^[ \t]*\/\/.*$/gm, '')
    expect(source).toContain('appendFile')
    expect(source).not.toMatch(/\bwriteFile\b/)
    expect(source).not.toMatch(/\btruncate\b/)
    // And no read-modify-write of a line.
    expect(source).not.toMatch(/\brename\b/)
  })

  it('supersedes by APPENDING a close op, never rewriting the add', async () => {
    const { store } = fixedStore()
    const first = await store.add({ kind: 'decision', text: 'We use REST.' })
    await store.supersede({ id: first.id, reason: 'we moved to GraphQL' })

    // Two ops: the add, unchanged, and the close.
    const ops = store.ops
    expect(ops.map((op) => op.op)).toEqual(['add', 'close'])
    const add = ops[0]!
    expect(add.op).toBe('add')
    if (add.op === 'add') {
      // THE ASSERTION: the original record still says the entry was open. History is not
      // rewritten; the close is a separate fact appended after it.
      expect(add.entry.validTo).toBeNull()
      expect(add.entry.reason).toBeUndefined()
    }
  })

  it('closes the window and records the reason on the folded view', async () => {
    const { store, now } = fixedStore()
    const entry = await store.add({ kind: 'decision', text: 'We use REST.' })
    await store.supersede({ id: entry.id, reason: 'we moved to GraphQL' })

    const folded = await store.get(entry.id)
    expect(folded?.validTo).toBe(now)
    expect(folded?.reason).toBe('we moved to GraphQL')
    expect(isCurrent(folded!, now)).toBe(false)
  })

  it('links the replacement in both directions', async () => {
    const { store } = fixedStore()
    const old = await store.add({ kind: 'decision', key: 'api-style', text: 'We use REST.' })
    const result = await store.supersede({
      id: old.id,
      reason: 'GraphQL fits the client better',
      replacement: { kind: 'decision', key: 'api-style', text: 'We use GraphQL.' },
    })

    expect(result.ok).toBe(true)
    // Forwards from the old, backwards from the new. Following the chain is a lookup.
    expect(result.closed?.supersededBy).toBe(result.replacement?.id)
    expect(result.replacement?.supersedes).toBe(old.id)
  })

  it('writes the replacement BEFORE the close, so no op names a missing entry', async () => {
    const { store } = fixedStore()
    const old = await store.add({ kind: 'decision', key: 'api-style', text: 'REST.' })
    await store.supersede({
      id: old.id,
      reason: 'changed',
      replacement: { kind: 'decision', key: 'api-style', text: 'GraphQL.' },
    })

    // add(old), add(new), close(old). A reader replaying in order never sees a close
    // referring to an entry it has not seen.
    expect(store.ops.map((op) => op.op)).toEqual(['add', 'add', 'close'])
  })

  it('refuses to re-close an entry, so the first reason survives', async () => {
    const { store } = fixedStore()
    const entry = await store.add({ kind: 'decision', text: 'REST.' })
    await store.supersede({ id: entry.id, reason: 'the real reason' })
    const second = await store.supersede({ id: entry.id, reason: 'a later, wrong reason' })

    expect(second.ok).toBe(false)
    expect(second.reason).toContain('already superseded')
    expect((await store.get(entry.id))?.reason).toBe('the real reason')
  })

  it('answers what was believed at a past instant', async () => {
    // The whole point of the validity window: "why is this file like this" is a question
    // about the past.
    const clock = fixedStore(1_000_000)
    const old = await clock.store.add({ kind: 'decision', key: 'api', text: 'REST.' })
    clock.advance(10 * DAY)
    await clock.store.supersede({
      id: old.id,
      reason: 'moved on',
      replacement: { kind: 'decision', key: 'api', text: 'GraphQL.' },
    })

    const back = await clock.store.query({ at: 1_000_000 + DAY })
    expect(back.map((entry) => entry.text)).toEqual(['REST.'])
    const nowLive = await clock.store.query({ currentOnly: true })
    expect(nowLive.map((entry) => entry.text)).toEqual(['GraphQL.'])
  })

  it('covers all nine kinds the contract names', () => {
    expect(MEMORY_KINDS).toHaveLength(9)
    for (const kind of MEMORY_KINDS) expect(isMemoryKind(kind)).toBe(true)
    // Closed: an unrecognised kind is a typo, and accepting it would put a row in the
    // store that no retriever looks for.
    expect(isMemoryKind('decisions')).toBe(false)
    expect(isMemoryKind('')).toBe(false)
  })
})

// ── 1b. the same behaviour on real bytes ────────────────────────────────────

describe('the JSONL store on disk', () => {
  it('round-trips through real files, sharded one per UTC day', async () => {
    const root = await project()
    const store = new JsonlMemoryStore({ baseDir: root, clock: () => 1_700_000_000_000 })

    const entry = await store.add({ kind: 'standard', key: 'tests', text: 'Tests live beside code.' })
    await store.supersede({ id: entry.id, reason: 'moved to a tests/ directory' })

    const files = await readdir(memoryDir(root))
    expect(files).toEqual(['2023-11-14.jsonl'])

    // Two lines: the add and the close. The add's own bytes still say `"validTo":null`.
    const text = await readFile(join(memoryDir(root), files[0]!), 'utf8')
    const lines = text.trim().split('\n')
    expect(lines).toHaveLength(2)
    expect(lines[0]).toContain('"op":"add"')
    expect(lines[0]).toContain('"validTo":null')
    expect(lines[1]).toContain('"op":"close"')
    expect(lines[1]).toContain('moved to a tests/ directory')

    // And the folded read agrees with the in-memory store's semantics.
    const reread = new JsonlMemoryStore({ baseDir: root })
    const folded = await reread.get(entry.id)
    expect(folded?.validTo).toBe(1_700_000_000_000)
    expect(folded?.reason).toBe('moved to a tests/ directory')
  })

  it('does not dirty git status', async () => {
    const root = await project()
    const store = new JsonlMemoryStore({ baseDir: root })
    await store.add({ kind: 'decision', text: 'Anything.' })
    // The self-ignore marker, so a project that writes one memory entry does not show
    // `.sketch/` as an untracked change.
    expect(await readFile(join(root, '.sketch', '.gitignore'), 'utf8')).toContain('*')
  })

  it('skips a malformed line and counts it, rather than losing the file', async () => {
    const root = await project()
    const store = new JsonlMemoryStore({ baseDir: root, clock: () => 1_700_000_000_000 })
    await store.add({ kind: 'decision', text: 'A real entry.' })

    // A truncated line, as a crash mid-write would leave.
    const { appendFile } = await import('node:fs/promises')
    await appendFile(store.fileFor(1_700_000_000_000), '{"op":"add","entry":{"id"\n', 'utf8')
    await appendFile(store.fileFor(1_700_000_000_000), '{"not":"an op"}\n', 'utf8')

    const result = await store.readAllDetailed()
    // One bad byte must not cost a project its whole memory.
    expect(result.entries).toHaveLength(1)
    expect(result.skipped).toBe(2)
  })

  it('reads an absent directory as empty, not as an error', async () => {
    const root = await project()
    const store = new JsonlMemoryStore({ baseDir: root })
    expect(await store.all()).toEqual([])
  })

  it('ignores a close op for an id it has never seen', async () => {
    // A partially copied log is a real situation, and half a memory beats none.
    const ops = [asMemoryOp({ op: 'close', seq: 1, id: 'ghost', validTo: 5, reason: 'x' })!]
    expect(applyOps(ops)).toEqual([])
  })

  it('rejects a row that is JSON but not an entry', () => {
    expect(asMemoryEntry({})).toBeNull()
    expect(asMemoryEntry({ id: 'a', kind: 'nope', text: 't', validFrom: 1, validTo: null, source: 'run' })).toBeNull()
    expect(asMemoryEntry({ id: 'a', kind: 'decision', text: 't', validFrom: 1, validTo: null, source: 'alien' })).toBeNull()
    // Valid.
    expect(
      asMemoryEntry({ id: 'a', kind: 'decision', text: 't', validFrom: 1, validTo: null, source: 'run' }),
    ).not.toBeNull()
  })
})

// ── 2. hygiene: supersede with a reason, and the event ──────────────────────

describe('remember', () => {
  it('supersedes a same-key predecessor and emits memory_superseded', async () => {
    const { store } = fixedStore()
    const events = new MemoryEventStore({ secrets: [] })

    const first = await remember({
      store,
      events,
      entry: { kind: 'standard', key: 'test-location', text: 'Tests live beside the code.' },
    })
    const second = await remember({
      store,
      events,
      runId: 'run-7',
      entry: { kind: 'standard', key: 'test-location', text: 'Tests live in tests/.' },
      reason: 'the team moved them in PR 412',
    })

    expect(second.superseded?.id).toBe(first.entry.id)
    expect(second.superseded?.reason).toBe('the team moved them in PR 412')

    const emitted = (await events.readAll()).filter((e) => e.kind === 'memory_superseded')
    expect(emitted).toHaveLength(1)
    expect(emitted[0]!.runId).toBe('run-7')
    expect(emitted[0]!.payload['trigger']).toBe('same-key')
    expect(emitted[0]!.payload['reason']).toBe('the team moved them in PR 412')
    expect(emitted[0]!.payload['supersededId']).toBe(first.entry.id)
    expect(emitted[0]!.payload['replacementId']).toBe(second.entry.id)

    // Only one standard for that key is live.
    const live = await store.query({ kind: 'standard', key: 'test-location', currentOnly: true })
    expect(live.map((entry) => entry.text)).toEqual(['Tests live in tests/.'])
  })

  it('records a reason even when the caller supplies none', async () => {
    // Requirement 21.3 wants a reason recorded, and "" is not one.
    const { store } = fixedStore()
    await remember({ store, entry: { kind: 'standard', key: 'k', text: 'first' } })
    const second = await remember({ store, entry: { kind: 'standard', key: 'k', text: 'second' } })
    expect(second.superseded?.reason).toBeTruthy()
    expect(second.superseded?.reason).toContain('"k"')
  })

  it('does NOT supersede an unkeyed entry', async () => {
    // Two decisions are two decisions. Replacing one is a deliberate act.
    const { store } = fixedStore()
    await remember({ store, entry: { kind: 'decision', text: 'We use Postgres.' } })
    await remember({ store, entry: { kind: 'decision', text: 'We use Redis for sessions.' } })
    expect((await store.query({ currentOnly: true }))).toHaveLength(2)
  })

  it('keeps an append-only series when asked, so history survives', async () => {
    // `test` and `performance` are series: a run's outcome follows the previous one, it
    // does not invalidate it.
    const { store } = fixedStore()
    await remember({ store, entry: { kind: 'test', key: 'unit', text: 'passed' }, supersedeSameKey: false })
    await remember({ store, entry: { kind: 'test', key: 'unit', text: 'failed' }, supersedeSameKey: false })
    expect(await store.query({ kind: 'test', currentOnly: true })).toHaveLength(2)
  })

  it('will not let a run supersede something the user wrote', async () => {
    const { store } = fixedStore()
    const mine = await remember({
      store,
      entry: { kind: 'preference', key: 'style', text: 'I prefer tabs.', source: 'user' },
    })
    await remember({
      store,
      entry: { kind: 'preference', key: 'style', text: 'The project uses spaces.', source: 'run' },
    })

    // The user's entry stands. A heuristic does not overrule a person.
    expect((await store.get(mine.entry.id))?.validTo).toBeNull()

    // But the user can supersede their own.
    await remember({
      store,
      entry: { kind: 'preference', key: 'style', text: 'Actually, spaces.', source: 'user' },
    })
    expect((await store.get(mine.entry.id))?.validTo).not.toBeNull()
  })
})

describe('expiry', () => {
  it('closes entries older than their kind allows, with a reason', async () => {
    const clock = fixedStore(1_000_000_000)
    const events = new MemoryEventStore({ secrets: [] })
    const old = await clock.store.add({ kind: 'test', text: 'unit: passed' })
    clock.advance(30 * DAY)
    const fresh = await clock.store.add({ kind: 'test', text: 'unit: passed again' })

    const result = await expireMemory({
      store: clock.store,
      maxAge: { test: 7 * DAY },
      now: clock.now,
      events,
    })

    expect(result.expired.map((entry) => entry.id)).toEqual([old.id])
    expect(result.expired[0]!.reason).toContain('expired')
    expect((await clock.store.get(fresh.id))?.validTo).toBeNull()

    const emitted = (await events.readAll()).filter((e) => e.kind === 'memory_superseded')
    expect(emitted).toHaveLength(1)
    expect(emitted[0]!.payload['trigger']).toBe('expiry')
  })

  it('never expires what the user wrote, and says so', async () => {
    const clock = fixedStore(1_000_000_000)
    const mine = await clock.store.add({ kind: 'preference', text: 'I like tabs.', source: 'user' })
    clock.advance(400 * DAY)

    const result = await expireMemory({
      store: clock.store,
      maxAge: { preference: 1 * DAY },
      now: clock.now,
    })

    expect(result.expired).toEqual([])
    expect(result.exempt.map((row) => row.entry.id)).toEqual([mine.id])
    expect(result.exempt[0]!.reason).toContain('the user wrote this entry')
  })

  it('expires NOTHING for a kind with no configured age', async () => {
    // No defaults on purpose: a default expiry would silently delete a project's
    // architectural decisions after some number this code chose.
    const clock = fixedStore(1_000_000_000)
    await clock.store.add({ kind: 'architecture', text: 'The engine is dependency-free.' })
    clock.advance(1000 * DAY)
    const result = await expireMemory({ store: clock.store, maxAge: {}, now: clock.now })
    expect(result.expired).toEqual([])
  })
})

// ── 3. the lint pass reports and changes nothing ────────────────────────────

describe('lintMemory', () => {
  it('is CERTAIN about two live entries sharing a kind and key', async () => {
    const { store } = fixedStore()
    // Written straight to the store, bypassing `remember` — which is exactly the bug the
    // finding exists to catch.
    await store.add({ kind: 'standard', key: 'test-location', text: 'beside the code' })
    await store.add({ kind: 'standard', key: 'test-location', text: 'in tests/' })

    const findings = await lintMemory({ store })
    const contradiction = findings.find((f) => f.kind === 'contradiction')!
    expect(contradiction.confidence).toBe('certain')
    expect(contradiction.entries).toHaveLength(2)
    expect(contradiction.detail).toContain('Only one can be true')
  })

  it('changes NOTHING — it reports', async () => {
    const { store } = fixedStore()
    await store.add({ kind: 'standard', key: 'k', text: 'a' })
    await store.add({ kind: 'standard', key: 'k', text: 'b' })

    const before = await store.all()
    await lintMemory({ store })
    const after = await store.all()

    // THE ASSERTION. Deciding from prose which of two decisions is wrong would
    // eventually discard the correct one, and a store that silently deletes true things
    // cannot be debugged from outside.
    expect(after).toEqual(before)
    expect(after.every((entry) => entry.validTo === null)).toBe(true)
  })

  it('calls a negated pair LIKELY and a merely overlapping pair POSSIBLE', async () => {
    const { store } = fixedStore()
    await store.add({ kind: 'decision', subject: 'auth', text: 'Sessions are stored in Redis.' })
    await store.add({ kind: 'decision', subject: 'auth', text: 'Sessions are not stored in Redis.' })
    await store.add({ kind: 'standard', subject: 'logging', text: 'Logging uses structured JSON output.' })
    await store.add({ kind: 'standard', subject: 'logging', text: 'Logging uses structured line output.' })

    const findings = await lintMemory({ store })
    const authFinding = findings.find((f) => f.entries[0]?.subject === 'auth')!
    const logFinding = findings.find((f) => f.entries[0]?.subject === 'logging')!
    expect(authFinding.confidence).toBe('likely')
    expect(logFinding.confidence).toBe('possible')
    // Neither is a verdict, and the suggestion says so.
    expect(authFinding.suggestion).toContain('Read both')
  })

  it('flags an exact duplicate', async () => {
    const { store } = fixedStore()
    await store.add({ kind: 'decision', text: 'We use Postgres.' })
    await store.add({ kind: 'decision', text: 'we use postgres.' })
    const findings = await lintMemory({ store })
    expect(findings.some((f) => f.kind === 'duplicate')).toBe(true)
  })

  it('flags a close with no reason, which should be impossible through the API', async () => {
    const store = new InMemoryStore({ clock: () => 5, ids: () => 'x1' })
    await store.add({ kind: 'decision', text: 'A.' })
    // Reaching past `remember` and `expireMemory`, both of which require a reason.
    await store.supersede({ id: 'x1', reason: '   ' })
    const findings = await lintMemory({ store })
    expect(findings.some((f) => f.kind === 'unreasoned')).toBe(true)
  })

  it('is quiet about a healthy store', async () => {
    const { store } = fixedStore()
    await remember({ store, entry: { kind: 'standard', key: 'a', text: 'one' } })
    await remember({ store, entry: { kind: 'decision', text: 'two' } })
    expect(await lintMemory({ store })).toEqual([])
  })
})

// ── 4. retrieval ────────────────────────────────────────────────────────────

describe('retrieveMemory', () => {
  async function seeded(): Promise<{ store: MemoryStore; now: number }> {
    const clock = fixedStore(1_700_000_000_000)
    await clock.store.add({
      kind: 'decision',
      subject: 'auth',
      text: 'Sessions are stored in Redis with a 30 day expiry.',
    })
    await clock.store.add({
      kind: 'architecture',
      subject: 'payments',
      text: 'The payments module talks to Stripe through one adapter.',
    })
    await clock.store.add({
      kind: 'bug',
      subject: 'payments',
      text: 'A retry storm hammered Stripe because the backoff was linear.',
    })
    await clock.store.add({ kind: 'style', key: 'quotes', text: 'Single quotes everywhere.' })
    return { store: clock.store, now: clock.now }
  }

  it('finds the entry that answers the question', async () => {
    const { store, now } = await seeded()
    const result = await retrieveMemory({ store, query: 'how are sessions stored', now })
    expect(result.hits[0]!.entry.subject).toBe('auth')
    expect(result.hits[0]!.termsMatched).toBeGreaterThan(0)
  })

  it('matches on metadata as well as prose, and reports both channels', async () => {
    const { store, now } = await seeded()
    const result = await retrieveMemory({ store, query: 'payments', now })
    // Two entries share the subject; both are found.
    expect(result.hits.map((hit) => hit.entry.subject)).toEqual(['payments', 'payments'])
    expect(result.channels.map((channel) => channel.channel).sort()).toEqual(['metadata', 'text'])
    expect(result.hits[0]!.channels).toContain('metadata')
  })

  it('EXCLUDES a retracted entry by default', async () => {
    const clock = fixedStore(1_700_000_000_000)
    const old = await clock.store.add({ kind: 'decision', key: 'api', text: 'We use REST endpoints.' })
    clock.advance(DAY)
    await clock.store.supersede({
      id: old.id,
      reason: 'GraphQL replaced it',
      replacement: { kind: 'decision', key: 'api', text: 'We use GraphQL endpoints.' },
    })

    const result = await retrieveMemory({ store: clock.store, query: 'endpoints', now: clock.now })

    // THE ASSERTION, and Requirement 21.6's whole point.
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]!.entry.text).toContain('GraphQL')
    expect(result.hits[0]!.current).toBe(true)
    expect(result.supersededExcluded).toBe(1)
  })

  it('can be asked for history, and labels it as retracted', async () => {
    const clock = fixedStore(1_700_000_000_000)
    const old = await clock.store.add({ kind: 'decision', key: 'api', text: 'We use REST endpoints.' })
    clock.advance(DAY)
    await clock.store.supersede({
      id: old.id,
      reason: 'GraphQL replaced it',
      replacement: { kind: 'decision', key: 'api', text: 'We use GraphQL endpoints.' },
    })

    const result = await retrieveMemory({
      store: clock.store,
      query: 'endpoints',
      now: clock.now,
      includeSuperseded: true,
    })
    expect(result.hits).toHaveLength(2)
    const retracted = result.hits.find((hit) => !hit.current)!
    expect(retracted.entry.text).toContain('REST')

    // And a caller cannot mistake it for live when rendering.
    const rendered = renderMemoryForPrompt(result.hits)
    expect(rendered).toContain('RETRACTED')
    expect(rendered).toContain('GraphQL replaced it')
  })

  it('treats recency as a bounded prior, not as a sort', async () => {
    const clock = fixedStore(1_700_000_000_000)
    // An old entry that answers the question precisely.
    await clock.store.add({
      kind: 'architecture',
      subject: 'retry',
      text: 'The retry budget is capped at 4500 milliseconds by RETRY_BUDGET_MS.',
    })
    clock.advance(200 * DAY)
    // A new entry that barely touches it.
    await clock.store.add({ kind: 'conversation', text: 'We talked about the retry a bit.' })

    const result = await retrieveMemory({
      store: clock.store,
      query: 'RETRY_BUDGET_MS retry budget milliseconds',
      now: clock.now,
    })

    // A strongly matching old entry still wins. A recency SORT would have inverted this.
    expect(result.hits[0]!.entry.subject).toBe('retry')
    expect(result.hits[0]!.recency).toBeLessThan(result.hits[1]!.recency)
  })

  it('breaks a relevance tie by recency', async () => {
    const clock = fixedStore(1_700_000_000_000)
    await clock.store.add({ kind: 'decision', text: 'Caching uses Redis.' })
    clock.advance(60 * DAY)
    await clock.store.add({ kind: 'decision', text: 'Caching uses Redis.' })

    const result = await retrieveMemory({ store: clock.store, query: 'caching Redis', now: clock.now })
    // Identical text, so relevance ties and the newer one leads.
    expect(result.hits[0]!.entry.validFrom).toBeGreaterThan(result.hits[1]!.entry.validFrom)
  })

  it('has a decaying, capped recency curve', () => {
    expect(recencyBoost(0)).toBeCloseTo(1.5, 6)
    expect(recencyBoost(RECENCY_HALF_LIFE)).toBeCloseTo(1.25, 6)
    expect(recencyBoost(RECENCY_HALF_LIFE * 2)).toBeCloseTo(1.125, 6)
    // Bounded in both directions, and the RIGHT way round in each. An earlier version
    // handed an infinitely OLD entry the maximum boost, because one guard caught both
    // non-finite signs; this assertion is what found it.
    expect(recencyBoost(Number.POSITIVE_INFINITY)).toBe(1)
    // A future-dated entry — clock skew, or an imported window — is capped, not amplified.
    expect(recencyBoost(-1)).toBeCloseTo(1.5, 6)
    // An age that cannot be computed is not evidence of freshness.
    expect(recencyBoost(Number.NaN)).toBe(1)
  })

  it('emits memory_retrieved with ids and scores but NOT the text', async () => {
    const { store, now } = await seeded()
    const events = new MemoryEventStore({ secrets: [] })
    await retrieveMemory({ store, query: 'sessions Redis', now, events, runId: 'run-9' })

    const emitted = (await events.readAll()).filter((e) => e.kind === 'memory_retrieved')
    expect(emitted).toHaveLength(1)
    expect(emitted[0]!.runId).toBe('run-9')
    const payload = JSON.stringify(emitted[0]!.payload)
    // The ids are there.
    expect(payload).toContain('"kind":"decision"')
    // The remembered text is NOT. Memory holds whatever the user wrote down.
    expect(payload).not.toContain('30 day expiry')
  })

  it('says why nothing was found rather than returning silently', async () => {
    const { store, now } = await seeded()
    const result = await retrieveMemory({ store, query: 'the and for', now })
    // Every term was a stopword, so `queryTerms` fell back to the trimmed query, which
    // matches nothing. The channels report is what lets a surface explain that.
    expect(result.hits).toEqual([])
    expect(result.terms.length).toBeGreaterThan(0)
  })

  it('restricts to kinds and subjects when asked', async () => {
    const { store, now } = await seeded()
    const bugs = await retrieveMemory({ store, query: 'Stripe', kinds: ['bug'], now })
    expect(bugs.hits.every((hit) => hit.entry.kind === 'bug')).toBe(true)

    const payments = await retrieveMemory({ store, query: 'Stripe', subject: 'payments', now })
    expect(payments.hits.every((hit) => hit.entry.subject === 'payments')).toBe(true)
  })
})

describe('memoryDigest', () => {
  it('groups current entries by kind, in a stable order, with their dates', async () => {
    const clock = fixedStore(1_700_000_000_000)
    await clock.store.add({ kind: 'decision', text: 'We use Postgres.' })
    await clock.store.add({ kind: 'standard', key: 's', text: 'Tests beside code.' })
    const dead = await clock.store.add({ kind: 'decision', text: 'We used MySQL.' })
    await clock.store.supersede({ id: dead.id, reason: 'migrated' })

    const digest = await memoryDigest({ store: clock.store, now: clock.now })
    expect(digest).toContain('## Decisions')
    expect(digest).toContain('We use Postgres.')
    expect(digest).toContain('## Standards')
    // A retracted fact does not reach the prompt.
    expect(digest).not.toContain('MySQL')
    // Dated, so a model can reason about when it was true.
    expect(digest).toContain('(since 2023-11-14)')
    // Decisions before Standards, always.
    expect(digest.indexOf('## Decisions')).toBeLessThan(digest.indexOf('## Standards'))
  })

  it('is empty for an empty store', async () => {
    expect(await memoryDigest({ store: new InMemoryStore() })).toBe('')
  })
})

// ── 5. the legacy surface still works ───────────────────────────────────────

describe('the legacy ProjectMemory bridge', () => {
  it('satisfies the four members the legacy orchestrator depends on', async () => {
    const { store } = fixedStore()
    const legacy = legacyProjectMemory({ store })

    await legacy.addTestRecord({ id: 't1-unit', checkName: 'unit', passed: false, output: 'boom' })
    await legacy.addConversation({ id: 't1', task: 'add a button', messages: '{}' })
    await legacy.addDecision({ id: 'd1', summary: 'Use Postgres', rationale: 'we know it' })

    const records = await legacy.listTestRecords()
    expect(records[0]!.id).toBe('t1-unit')
    expect(records[0]!.checkName).toBe('unit')
    expect(records[0]!.passed).toBe(false)
    expect(records[0]!.output).toBe('boom')

    expect((await legacy.listConversations())[0]!.task).toBe('add a button')
    expect((await legacy.listDecisions())[0]!.summary).toBe('Use Postgres')
    expect(await legacy.digest()).toContain('Use Postgres')
  })

  it('turns setStandard into a supersede, so the old value survives with its window', async () => {
    const clock = fixedStore(1_700_000_000_000)
    const legacy = legacyProjectMemory({ store: clock.store })

    await legacy.setStandard('indent', 'two spaces')
    clock.advance(DAY)
    await legacy.setStandard('indent', 'four spaces')

    // The legacy read is the upsert it always was.
    expect(await legacy.getStandard('indent')).toBe('four spaces')
    expect(await legacy.listStandards()).toHaveLength(1)

    // But underneath, the history is intact — which the Map-backed original could not do.
    const all = await clock.store.all()
    expect(all).toHaveLength(2)
    const closed = all.find((entry) => entry.validTo !== null)!
    expect(closed.text).toBe('two spaces')
    expect(closed.reason).toBeTruthy()
  })

  it('keeps test history append-only rather than superseding it', async () => {
    const { store } = fixedStore()
    const legacy = legacyProjectMemory({ store })
    await legacy.addTestRecord({ id: 'a', checkName: 'unit', passed: true, output: '' })
    await legacy.addTestRecord({ id: 'b', checkName: 'unit', passed: false, output: '' })
    // "The tests were passing last week" has to remain answerable.
    expect(await legacy.listTestRecords()).toHaveLength(2)
  })

  it('finds bugs by file, as the original did', async () => {
    const { store } = fixedStore()
    const legacy = legacyProjectMemory({ store })
    await legacy.addBug({ id: 'b1', description: 'off by one', fix: 'use <=', files: ['src/a.ts'] })
    expect(await legacy.findBugsByFile('src/a.ts')).toHaveLength(1)
    expect(await legacy.findBugsByFile('src/b.ts')).toHaveLength(0)
  })
})

// ── 6. explicit supersede, as the panel calls it ────────────────────────────

describe('supersedeEntry', () => {
  it('emits the event with an explicit trigger', async () => {
    const { store } = fixedStore()
    const events = new MemoryEventStore({ secrets: [] })
    const entry = await store.add({ kind: 'decision', text: 'A.' })

    const result = await supersedeEntry({
      store,
      events,
      id: entry.id,
      reason: 'the user deleted it from the Memory panel',
    })

    expect(result.ok).toBe(true)
    const emitted = (await events.readAll()).filter((e: SketchEvent) => e.kind === 'memory_superseded')
    expect(emitted[0]!.payload['trigger']).toBe('explicit')
    expect(emitted[0]!.payload['reason']).toContain('Memory panel')
  })

  it('reports an unknown id rather than throwing', async () => {
    const result = await supersedeEntry({ store: new InMemoryStore(), id: 'nope', reason: 'x' })
    expect(result.ok).toBe(false)
    expect(result.reason).toContain('no memory entry')
  })

  it('describes a window in words', async () => {
    const clock = fixedStore(1_700_000_000_000)
    const entry = await clock.store.add({ kind: 'decision', text: 'A.' })
    expect(describeWindow(entry, clock.now)).toBe('valid since 2023-11-14')

    await clock.store.supersede({ id: entry.id, reason: 'changed our minds' })
    const closed = (await clock.store.get(entry.id))!
    expect(describeWindow(closed, clock.now)).toContain('superseded: changed our minds')
  })
})

/** Re-exported constant, aliased so the curve test reads clearly. */
const RECENCY_HALF_LIFE = 14 * 24 * 60 * 60 * 1000

/** Keeps the import used if a future edit drops its only reference. */
const _entryType: MemoryEntry[] = []
void _entryType
