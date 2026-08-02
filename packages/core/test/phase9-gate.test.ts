// Phase 9 gate — a contradicting decision supersedes the older one, and a related query
// returns the newer while the older is marked superseded.
//
// THE CLAIM, from tasks.md 9.5, which is unusually specific:
//   "Insert a decision, insert a contradicting decision, and prove a related query returns
//    the newer while the older is marked superseded."
//
// Offline, with no API key.
//
// ── ONE CHAIN, OVER REAL BYTES ─────────────────────────────────────────────
//
// The interesting failures are in the joins, so this is a single sequence over a real
// append-only log on disk rather than three separate assertions:
//
//   record a decision → record the contradicting one → the log is APPEND-ONLY (the first
//     add still reads open) → a related query returns ONLY the newer → the older is
//     marked superseded WITH ITS REASON → the digest that reaches a prompt contains the
//     newer and not the older → asking for history returns both, the old one labelled
//     RETRACTED → the panel's own RPC path agrees with all of it
//
// Each of those can pass while another fails. A store can supersede correctly and still
// leak the retracted fact into the prompt digest. Retrieval can exclude it and the panel
// can hide it, at which point the user cannot audit their own memory. The chain is what
// catches those.
//
// ── WHY THE QUERY IS "RELATED" AND NOT THE DECISION'S OWN WORDS ─────────────
//
// The requirement says a RELATED query. Querying with the entry's exact text would prove
// only that string matching works. So the query here shares vocabulary with both decisions
// without quoting either, which is what a developer actually types.
//
// ── WHAT THIS GATE DOES NOT CLAIM ──────────────────────────────────────────
//
// * NOT that contradictions are detected automatically from prose. They are not, on
//   purpose: `lintMemory` reports and supersedes nothing, because deciding by keyword
//   overlap which of two decisions is wrong would eventually discard the correct one. What
//   is automatic is superseding by KIND AND KEY, which is an explicit statement of
//   identity by whoever wrote them. §3 asserts both halves of that.
// * NOT that memory reaches a live agent run by default. `memoryDigest` fills the
//   `assembleContext({ memory })` seam that has existed since Phase 5, and the RPC does not
//   pass it yet — stated in the handoff rather than implied here.
// * NOT semantic retrieval. There are no embeddings for memory rows; the channels are text
//   and metadata, and `channels` reports which ran.
//
// Validates: Requirements 21.1, 21.2, 21.3, 21.5, 21.6

import { afterAll, describe, expect, it } from 'vitest'
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  JsonlMemoryStore,
  isCurrent,
  lintMemory,
  memoryDigest,
  memoryDir,
  remember,
  renderMemoryForPrompt,
  retrieveMemory,
} from '../src/memory/index.js'
import { MemoryEventStore } from '../src/events/index.js'
import { METHODS } from '../src/rpc/methods.js'
import type { MethodContext } from '../src/rpc/methods.js'

const tmpDirs: string[] = []

afterAll(async () => {
  while (tmpDirs.length) {
    await rm(tmpDirs.pop()!, { recursive: true, force: true }).catch(() => {})
  }
})

async function makeProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sketch-phase9-'))
  tmpDirs.push(dir)
  return dir
}

function methodContext(root: string, log: string[] = []): MethodContext {
  return {
    emitEvent: () => {},
    log: (message) => log.push(message),
    rememberSecret: () => {},
    secrets: () => [],
    env: {},
    cwd: () => root,
  }
}

const DAY = 86_400_000

// ── 1. the chain ────────────────────────────────────────────────────────────

describe('Phase 9 gate — a decision, a contradiction, and what a query returns', () => {
  it('runs the whole chain offline, with no key', async () => {
    expect(process.env.ANTHROPIC_API_KEY ?? '').toBe('')
    expect(process.env.OPENAI_API_KEY ?? '').toBe('')

    const project = await makeProject()
    const events = new MemoryEventStore({ secrets: [] })
    const report: string[] = []

    // A controllable clock, so the two decisions have genuinely different windows rather
    // than colliding in one millisecond.
    let now = Date.parse('2026-03-01T00:00:00Z')
    const store = new JsonlMemoryStore({ baseDir: project, clock: () => now })

    // ── (a) the first decision ────────────────────────────────────────────
    const first = await remember({
      store,
      events,
      runId: 'run-march',
      entry: {
        kind: 'decision',
        key: 'session-storage',
        subject: 'auth',
        text: 'Sessions are stored in Redis, because we already run it for the job queue.',
      },
    })
    expect(first.superseded).toBeNull()
    expect(first.entry.validTo).toBeNull()
    report.push(`  march: "${first.entry.text.slice(0, 40)}…" valid from 2026-03-01`)

    // ── (b) the contradicting decision, three months later ────────────────
    now += 90 * DAY
    const second = await remember({
      store,
      events,
      runId: 'run-june',
      entry: {
        kind: 'decision',
        key: 'session-storage',
        subject: 'auth',
        text: 'Sessions are stored in Postgres, because Redis persistence was losing them on restart.',
      },
      reason: 'Redis was losing sessions on restart, so the storage moved to Postgres',
    })

    // It superseded the first, and it knows which.
    expect(second.superseded?.id).toBe(first.entry.id)
    expect(second.entry.supersedes).toBe(first.entry.id)
    report.push(`  june:  "${second.entry.text.slice(0, 40)}…" superseded the march decision`)

    // ── (c) THE LOG IS APPEND-ONLY ────────────────────────────────────────
    //
    // Asserted on the bytes, not on the API. The first decision's own record still says
    // it was open; the close is a separate fact appended after it. A store that edited
    // the row in place would pass every other assertion in this file and lose the
    // history, which is the one thing versioning exists to keep.
    const files = (await readdir(memoryDir(project))).sort()
    const lines = (
      await Promise.all(files.map((file) => readFile(join(memoryDir(project), file), 'utf8')))
    )
      .join('')
      .trim()
      .split('\n')

    const adds = lines.filter((line) => line.includes('"op":"add"'))
    const closes = lines.filter((line) => line.includes('"op":"close"'))
    expect(adds).toHaveLength(2)
    expect(closes).toHaveLength(1)
    // The march decision's ORIGINAL bytes.
    const marchLine = adds.find((line) => line.includes(first.entry.id))!
    expect(marchLine).toContain('"validTo":null')
    expect(marchLine).not.toContain('Redis was losing sessions')
    report.push(`  log: ${adds.length} add(s) + ${closes.length} close(s), first add still open on disk`)

    // ── (d) A RELATED QUERY RETURNS THE NEWER, AND ONLY THE NEWER ─────────
    //
    // Shares vocabulary with both without quoting either. Querying an entry's own text
    // would prove only that string matching works.
    const retrieved = await retrieveMemory({
      store,
      query: 'where do we keep sessions for auth',
      events,
      runId: 'run-query',
      now,
    })

    // THE CLAIM.
    expect(retrieved.hits).toHaveLength(1)
    expect(retrieved.hits[0]!.entry.id).toBe(second.entry.id)
    expect(retrieved.hits[0]!.entry.text).toContain('Postgres')
    expect(retrieved.hits[0]!.current).toBe(true)
    // The older one was considered and excluded, and the count says so rather than the
    // entry silently not existing.
    expect(retrieved.supersededExcluded).toBe(1)
    report.push(
      `  query "where do we keep sessions for auth" → 1 hit (Postgres), 1 retracted excluded`,
    )

    // ── (e) THE OLDER IS MARKED SUPERSEDED, WITH ITS REASON ──────────────
    const marchNow = (await store.get(first.entry.id))!
    expect(marchNow.validTo).toBe(now - 0)
    expect(isCurrent(marchNow, now)).toBe(false)
    expect(marchNow.supersededBy).toBe(second.entry.id)
    // A reason, not just a flag. "Superseded, no reason given" is indistinguishable from
    // a bug months later.
    expect(marchNow.reason).toBe(
      'Redis was losing sessions on restart, so the storage moved to Postgres',
    )

    // And the event log records it, so the change is on the same timeline as everything
    // else the project did.
    const superseded = (await events.readAll()).filter((event) => event.kind === 'memory_superseded')
    expect(superseded).toHaveLength(1)
    expect(superseded[0]!.runId).toBe('run-june')
    expect(superseded[0]!.payload['supersededId']).toBe(first.entry.id)
    expect(superseded[0]!.payload['replacementId']).toBe(second.entry.id)
    expect(superseded[0]!.payload['reason']).toContain('losing sessions on restart')

    const retrievedEvents = (await events.readAll()).filter(
      (event) => event.kind === 'memory_retrieved',
    )
    expect(retrievedEvents).toHaveLength(1)
    // Ids and scores, never the remembered text — memory holds whatever a user wrote down.
    expect(JSON.stringify(retrievedEvents[0]!.payload)).not.toContain('job queue')
    report.push(`  events: 1 memory_superseded (run-june), 1 memory_retrieved, no text on either`)

    // ── (f) THE PROMPT DIGEST CARRIES THE NEWER AND NOT THE OLDER ────────
    //
    // The join that matters most. A store can supersede perfectly and still leak the
    // retracted fact into the prompt, at which point the model is told both.
    const digest = await memoryDigest({ store, now })
    expect(digest).toContain('Postgres')
    expect(digest).not.toContain('Redis, because we already run it')
    // Dated, so the model can reason about when it became true.
    expect(digest).toContain('(since 2026-05-30)')
    report.push(`  digest: contains Postgres, excludes the Redis decision`)

    // ── (g) HISTORY IS STILL ASKABLE, AND LABELLED ───────────────────────
    //
    // The opposite requirement to (d), and both have to hold: hidden from the prompt,
    // visible to the user. A memory a user cannot audit is a memory they cannot trust.
    const history = await retrieveMemory({
      store,
      query: 'where do we keep sessions for auth',
      includeSuperseded: true,
      now,
    })
    expect(history.hits).toHaveLength(2)
    const rendered = renderMemoryForPrompt(history.hits)
    expect(rendered).toContain('RETRACTED')
    expect(rendered).toContain('losing sessions on restart')
    report.push(`  history: 2 hits, the older rendered as RETRACTED with its reason`)

    // ── (h) THE PANEL'S OWN PATH AGREES ──────────────────────────────────
    //
    // Through `METHODS`, the same table the sidecar and the dev bridge dispatch. A gate
    // that only exercised the library would not catch a panel wired to a different answer.
    const listed = (await METHODS['memory-list']!({ root: project }, methodContext(project))) as {
      total: number
      current: number
      entries: Array<{ id: string; current: boolean; reason?: string; window: string }>
      findings: unknown[]
      skipped: number
    }
    expect(listed.total).toBe(2)
    expect(listed.current).toBe(1)
    expect(listed.skipped).toBe(0)
    // Both rows are offered to the user, newest first, with the closed one flagged.
    expect(listed.entries).toHaveLength(2)
    expect(listed.entries[0]!.id).toBe(second.entry.id)
    expect(listed.entries[0]!.current).toBe(true)
    expect(listed.entries[1]!.id).toBe(first.entry.id)
    expect(listed.entries[1]!.current).toBe(false)
    expect(listed.entries[1]!.window).toContain('superseded')
    // Nothing is wrong with this store, so the lint pass is quiet.
    expect(listed.findings).toEqual([])

    const searched = (await METHODS['memory-search']!(
      { root: project, query: 'where do we keep sessions for auth' },
      methodContext(project),
    )) as { hits: Array<{ entry: { id: string } }>; supersededExcluded: number }
    // The wire agrees with the library: the newer, and only the newer.
    expect(searched.hits).toHaveLength(1)
    expect(searched.hits[0]!.entry.id).toBe(second.entry.id)
    expect(searched.supersededExcluded).toBe(1)
    report.push(`  rpc: memory-list shows 2 (1 current); memory-search returns the newer only`)

    // eslint-disable-next-line no-console
    console.log(['[phase 9 gate] the chain, offline, no key:', ...report].join('\n'))
  }, 30_000)
})

// ── 2. the older decision is still answerable as history ────────────────────

describe('Phase 9 gate — the past stays answerable', () => {
  it('says what the project believed at a past date', async () => {
    // The reason validity windows exist at all: "why is this file like this" is a question
    // about the past, and a store that only knows the present cannot answer it.
    const project = await makeProject()
    let now = Date.parse('2026-03-01T00:00:00Z')
    const store = new JsonlMemoryStore({ baseDir: project, clock: () => now })

    await remember({
      store,
      entry: { kind: 'decision', key: 'session-storage', text: 'Sessions live in Redis.' },
    })
    now += 90 * DAY
    await remember({
      store,
      entry: { kind: 'decision', key: 'session-storage', text: 'Sessions live in Postgres.' },
      reason: 'Redis lost them on restart',
    })

    // In April, the answer was Redis.
    const april = await store.query({ at: Date.parse('2026-04-01T00:00:00Z') })
    expect(april.map((entry) => entry.text)).toEqual(['Sessions live in Redis.'])

    // Today it is Postgres.
    const today = await store.query({ currentOnly: true, at: now })
    expect(today.map((entry) => entry.text)).toEqual(['Sessions live in Postgres.'])
  })
})

// ── 3. what is automatic, and what is deliberately not ──────────────────────

describe('Phase 9 gate — the limits of automatic hygiene, asserted', () => {
  it('supersedes automatically on kind AND key, because that is an explicit identity', async () => {
    const project = await makeProject()
    const store = new JsonlMemoryStore({ baseDir: project })
    await remember({ store, entry: { kind: 'standard', key: 'indent', text: 'two spaces' } })
    await remember({ store, entry: { kind: 'standard', key: 'indent', text: 'four spaces' } })

    // A second standard for the same key is an UPDATE. Treating it as a contradiction to
    // be flagged would be pedantry.
    const live = await store.query({ kind: 'standard', currentOnly: true })
    expect(live.map((entry) => entry.text)).toEqual(['four spaces'])
  })

  it('does NOT supersede two contradicting decisions from their prose — it reports', async () => {
    // THE LIMIT, and it is a deliberate design choice rather than an unfinished feature.
    // Deciding by keyword overlap which of two decisions is wrong would eventually discard
    // the correct one, and a memory store that silently deletes true things cannot be
    // debugged from outside. So without a shared key, both stay live and the lint pass
    // raises a question.
    const project = await makeProject()
    const store = new JsonlMemoryStore({ baseDir: project })
    await remember({
      store,
      entry: { kind: 'decision', subject: 'auth', text: 'Sessions are stored in Redis.' },
    })
    await remember({
      store,
      entry: { kind: 'decision', subject: 'auth', text: 'Sessions are not stored in Redis.' },
    })

    // Both live. Nothing was guessed.
    expect(await store.query({ currentOnly: true })).toHaveLength(2)

    // But the contradiction is surfaced, with a confidence rather than a verdict.
    const findings = await lintMemory({ store })
    const contradiction = findings.find((finding) => finding.kind === 'contradiction')!
    expect(contradiction).toBeDefined()
    expect(contradiction.confidence).toBe('likely')
    expect(contradiction.suggestion).toContain('Read both')

    // And the lint pass changed nothing.
    expect(await store.query({ currentOnly: true })).toHaveLength(2)
  })

  it('reports a store with nothing wrong as having nothing wrong', async () => {
    const project = await makeProject()
    const store = new JsonlMemoryStore({ baseDir: project })
    await remember({ store, entry: { kind: 'decision', text: 'We use Postgres.' } })
    expect(await lintMemory({ store })).toEqual([])
  })
})
