// Hybrid retrieval tests: lexical + vector, reciprocal rank fusion, rerank.
//
// Uses REAL: temp projects with real files on disk, the real walker/chunker via
// `buildRepoGraph`, the real `rg` binary when this machine has one (and the real
// fallback scanner when it does not, forced explicitly so BOTH engines are
// covered on every machine), the real `HashEmbedder` and `MemoryVectorStore`, and
// a real `MemoryEventStore`. Nothing is mocked and nothing is stubbed.
//
// The load-bearing tests here are:
//   * `does not ship a vector-only default`   — Requirement 18.2, straight up
//   * `finds an exact identifier the vector channel alone misses` — the reason
//     the requirement exists, demonstrated on a concrete repository
//   * `orders identically regardless of the order candidates arrive in` — the
//     determinism guarantee the tie-break rules exist to provide
//   * `passes a query with shell metacharacters through as one argv element`
//
// Validates: Requirements 18.2

import { describe, it, expect, afterEach, beforeEach } from 'vitest'
import { mkdtemp, mkdir, rm, writeFile, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { buildRepoGraph, type RepoGraph } from '../src/context/repo-graph.js'
import {
  chunkForLine,
  countMatches,
  detectRipgrep,
  DEFAULT_SEARCH_CONFIG,
  hybridSearch,
  isVectorOnly,
  lexicalSearch,
  looksLikeDefinition,
  MAX_QUERY_TERMS,
  parseRipgrepLine,
  queryTerms,
  reciprocalRankFusion,
  rerank,
  rerankScore,
  resetRipgrepDetection,
  resolveSearchConfig,
  ripgrepArgs,
  RRF_K,
  smartCase,
  vectorSearch,
  type FusedCandidate,
  type HybridHit,
  type LexicalHit,
  type RankedList,
} from '../src/context/hybrid-search.js'
import { chunkFile } from '../src/context/chunker.js'
import { HashEmbedder } from '../src/context/embedder.js'
import { MemoryVectorStore } from '../src/context/vector-store.js'
import { MemoryEventStore } from '../src/events/index.js'

const tmpDirs: string[] = []

/** A binary name that cannot exist, to force the fallback deterministically. */
const MISSING_BINARY = 'sketch-no-such-ripgrep-binary'

beforeEach(() => {
  // Detection is cached process-wide by design; tests must not inherit it.
  resetRipgrepDetection()
})

afterEach(async () => {
  resetRipgrepDetection()
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

async function makeProject(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sketch-hybrid-'))
  tmpDirs.push(dir)
  return dir
}

async function write(root: string, relative: string, content: string): Promise<void> {
  const full = join(root, relative)
  await mkdir(dirname(full), { recursive: true })
  await writeFile(full, content, 'utf8')
}

/**
 * The fixture that makes the point of Requirement 18.2.
 *
 * `src/retry.ts` DEFINES `parse_retry_budget` and uses it once. Eight small notes
 * merely MENTION the name. A nearest-neighbour search prefers the notes — their
 * chunks are short, so the query token dominates the chunk's vector — while the
 * definition is diluted among a screenful of unrelated tuning constants. That is
 * the everyday failure of vector-only retrieval on code, not a contrivance.
 */
async function seedIdentifierProject(root: string): Promise<void> {
  const knobs = Array.from(
    { length: 20 },
    (_, i) => `export const knob_${i} = ${i} // tuning knob ${i} for the backoff jitter window alpha${i}`
  )
  const target = [
    '// HTTP retry policy for the transport layer.',
    ...knobs,
    'const DEFAULT_BUDGET = 250',
    'export function parse_retry_budget(raw: string): number {',
    '  const parsed = Number.parseInt(raw, 10)',
    '  return Number.isFinite(parsed) ? parsed : DEFAULT_BUDGET',
    '}',
    "export const budget = parse_retry_budget('250')",
    '',
  ].join('\n')
  await write(root, 'src/retry.ts', target)

  for (let i = 0; i < 8; i++) {
    await write(root, `notes/note-${i}.md`, `mentions parse_retry_budget\n`)
  }
}

/** Index every graph file into a real vector store with the real hash embedder. */
async function buildVectorChannel(
  root: string,
  graph: RepoGraph
): Promise<{ embedder: HashEmbedder; store: MemoryVectorStore }> {
  const embedder = new HashEmbedder()
  const store = new MemoryVectorStore()
  for (const file of graph.files) {
    const content = await readFile(join(root, file.path), 'utf8')
    const chunks = chunkFile(file.path, content)
    const vectors = await embedder.embed(chunks.map(c => c.content))
    await store.upsert(chunks.map((c, i) => ({ ...c, embedding: vectors[i]! })))
  }
  return { embedder, store }
}

function item(path: string, chunkIndex: number) {
  return { id: `${path}#${chunkIndex}`, path, chunkIndex, startLine: 0, endLine: 10 }
}

// ── the requirement itself ──────────────────────────────────────────────────

describe('search configuration', () => {
  it('does not ship a vector-only default', () => {
    // Requirement 18.2: "Vector-only retrieval SHALL NOT be the shipped default."
    // Flip `lexical` to false in DEFAULT_SEARCH_CONFIG and this test is what fails.
    expect(DEFAULT_SEARCH_CONFIG.lexical).toBe(true)
    expect(DEFAULT_SEARCH_CONFIG.vector).toBe(true)
    expect(isVectorOnly(resolveSearchConfig())).toBe(false)
    expect(isVectorOnly(resolveSearchConfig({}))).toBe(false)
    // Overriding an unrelated knob must not quietly drop the lexical channel.
    expect(isVectorOnly(resolveSearchConfig({ topK: 3 } as never))).toBe(false)
    expect(resolveSearchConfig().rerank).toBe(true)
    expect(resolveSearchConfig().rrfK).toBe(RRF_K)
  })

  it('keeps vector-only reachable but labels it', () => {
    // Reachable, because a test has to be able to demonstrate how bad it is.
    expect(isVectorOnly(resolveSearchConfig({ lexical: false }))).toBe(true)
    expect(isVectorOnly(resolveSearchConfig({ vector: false }))).toBe(false)
  })

  it('clamps a k that would divide by zero', () => {
    expect(resolveSearchConfig({ rrfK: 0 }).rrfK).toBe(1)
    expect(resolveSearchConfig({ rrfK: -5 }).rrfK).toBe(1)
  })
})

describe('hybrid retrieval on a real repository', () => {
  it('finds an exact identifier the vector channel alone misses', async () => {
    const root = await makeProject()
    await seedIdentifierProject(root)
    const { graph } = await buildRepoGraph({ root, persist: false })
    const vector = await buildVectorChannel(root, graph)
    const query = 'parse_retry_budget'

    // 1. Vector-only, exactly as a vector-only product would ship it.
    const vectorOnly = await hybridSearch({
      root,
      query,
      graph,
      vector,
      topK: 5,
      config: { lexical: false },
    })
    expect(vectorOnly.vectorOnly).toBe(true)
    expect(vectorOnly.hits.length).toBe(5)
    // The definition is right there in the repository and embeddings do not
    // surface it: eight short notes that merely mention the name score higher.
    expect(vectorOnly.hits.some(h => h.path === 'src/retry.ts')).toBe(false)
    expect(vectorOnly.hits.every(h => h.path.startsWith('notes/'))).toBe(true)

    // 2. The shipped default. Same repository, same query, same budget.
    const hybrid = await hybridSearch({ root, query, graph, vector, topK: 5 })
    expect(hybrid.vectorOnly).toBe(false)
    expect(hybrid.hits[0]!.path).toBe('src/retry.ts')
    expect(hybrid.hits[0]!.channels).toContain('lexical')
    expect(hybrid.hits[0]!.definition).toBe(true)
    expect(hybrid.hits[0]!.preview).toContain('export function parse_retry_budget')
    // And the vector channel still contributes: the notes are still retrieved.
    expect(hybrid.hits.some(h => h.path.startsWith('notes/'))).toBe(true)
  })

  it('reports which channels ran and which engine carried the lexical one', async () => {
    const root = await makeProject()
    await seedIdentifierProject(root)
    const { graph } = await buildRepoGraph({ root, persist: false })
    const vector = await buildVectorChannel(root, graph)
    const events = new MemoryEventStore()

    const result = await hybridSearch({
      root,
      query: 'parse_retry_budget',
      graph,
      vector,
      events,
      runId: 'run-7',
    })

    expect(result.lexicalEngine === 'ripgrep' || result.lexicalEngine === 'scanner').toBe(true)
    expect(result.channels.map(c => c.channel)).toEqual(['lexical', 'vector'])
    expect(result.channels.every(c => c.ran)).toBe(true)
    expect(result.reranked).toBe(true)

    const emitted = await events.readAll()
    expect(emitted).toHaveLength(1)
    // No retrieval EventKind exists in the contract and inventing one is not
    // allowed, so an existing kind carries a payload discriminator.
    expect(emitted[0]!.kind).toBe('context_assembled')
    expect(emitted[0]!.runId).toBe('run-7')
    expect(emitted[0]!.payload.component).toBe('hybrid-search')
    expect(emitted[0]!.payload.lexicalEngine).toBe(result.lexicalEngine)
    expect(emitted[0]!.payload.vectorOnly).toBe(false)
    expect(emitted[0]!.payload.rrfK).toBe(RRF_K)
    expect(emitted[0]!.payload.channels).toEqual([
      { channel: 'lexical', ran: true, engine: result.lexicalEngine, hits: expect.any(Number), degraded: false, reason: null },
      { channel: 'vector', ran: true, engine: 'vector-store', hits: expect.any(Number), degraded: false, reason: null },
    ])
    // The query text itself is never logged.
    expect(JSON.stringify(emitted[0]!.payload)).not.toContain('parse_retry_budget')
  })

  it('says so when a channel cannot run instead of degrading silently', async () => {
    const root = await makeProject()
    await seedIdentifierProject(root)
    const { graph } = await buildRepoGraph({ root, persist: false })

    // No embedder, no store: the vector channel is configured on but absent.
    const result = await hybridSearch({ root, query: 'parse_retry_budget', graph })
    const vectorReport = result.channels.find(c => c.channel === 'vector')!

    expect(vectorReport.ran).toBe(false)
    expect(vectorReport.degraded).toBe(true)
    expect(vectorReport.reason).toBe('no embedder or vector store supplied')
    expect(result.degraded).toBe(true)
    // Still useful, because the lexical channel is the one that finds identifiers.
    expect(result.hits[0]!.path).toBe('src/retry.ts')
  })

  it('falls back to the persisted graph when no graph is passed', async () => {
    const root = await makeProject()
    await seedIdentifierProject(root)
    await buildRepoGraph({ root })

    const result = await hybridSearch({ root, query: 'parse_retry_budget' })
    expect(result.hits[0]!.path).toBe('src/retry.ts')
  })
})

// ── the lexical channel ─────────────────────────────────────────────────────

describe('lexical channel', () => {
  it('produces the same ranking from ripgrep and from the fallback scanner', async () => {
    const root = await makeProject()
    await seedIdentifierProject(root)
    const { graph } = await buildRepoGraph({ root, persist: false })
    const query = 'parse_retry_budget'

    const fast = await lexicalSearch({ root, query, graph })
    const slow = await lexicalSearch({ root, query, graph, preferRipgrep: false })

    // Pinned to what this machine actually has, so the test states which channel
    // it exercised rather than accepting either outcome.
    const probe = await detectRipgrep({ cwd: root })
    expect(fast.engine).toBe(probe.available ? 'ripgrep' : 'scanner')
    expect(fast.degraded).toBe(!probe.available)

    // Whichever engine this machine has, the two must agree — otherwise the
    // fallback silently changes what the product retrieves.
    expect(slow.engine).toBe('scanner')
    expect(fast.hits.map(h => h.id)).toEqual(slow.hits.map(h => h.id))
    expect(fast.hits.map(h => h.score)).toEqual(slow.hits.map(h => h.score))
    expect(fast.hits[0]!.path).toBe('src/retry.ts')
    expect(fast.hits[0]!.exactMatches).toBe(2)
    expect(fast.hits[0]!.definition).toBe(true)
  })

  it('names the fallback and its reason when ripgrep is absent', async () => {
    const root = await makeProject()
    await seedIdentifierProject(root)
    const { graph } = await buildRepoGraph({ root, persist: false })

    const probe = await detectRipgrep({ binary: MISSING_BINARY, cwd: root })
    expect(probe.available).toBe(false)
    expect(probe.reason).toContain(MISSING_BINARY)

    const result = await lexicalSearch({
      root,
      query: 'parse_retry_budget',
      graph,
      binary: MISSING_BINARY,
    })

    expect(result.engine).toBe('scanner')
    expect(result.degraded).toBe(true)
    expect(result.reason).toContain(MISSING_BINARY)
    expect(result.reason).toContain('scanning the indexed file list')
    // Degraded, not broken: the right chunk is still first.
    expect(result.hits[0]!.path).toBe('src/retry.ts')
  })

  it('restricts both engines to the indexed file list', async () => {
    const root = await makeProject()
    await seedIdentifierProject(root)
    const { graph } = await buildRepoGraph({ root, persist: false })
    // Written AFTER the graph was built, so it is not part of the universe.
    await write(root, 'src/unindexed.ts', 'export const parse_retry_budget = 1\n')

    const fast = await lexicalSearch({ root, query: 'parse_retry_budget', graph })
    const slow = await lexicalSearch({ root, query: 'parse_retry_budget', graph, preferRipgrep: false })

    expect(fast.hits.some(h => h.path === 'src/unindexed.ts')).toBe(false)
    expect(slow.hits.some(h => h.path === 'src/unindexed.ts')).toBe(false)
  })

  it('weights identifier-boundary matches above substring matches', async () => {
    const root = await makeProject()
    await write(root, 'src/exact.ts', 'export const budget = 1\nconst other = budget\n')
    await write(root, 'src/substring.ts', 'const retryBudgetMs = 1\nconst budgetish = 2\nconst xbudget = 3\n')
    const { graph } = await buildRepoGraph({ root, persist: false })

    // `ignoreCase: false` is explicit here, and it has to be: `budget` is
    // all-lower-case, so the default is now smart case (see the next test).
    const result = await lexicalSearch({ root, query: 'budget', graph, ignoreCase: false })
    expect(result.hits[0]!.path).toBe('src/exact.ts')
    expect(result.hits[0]!.exactMatches).toBe(2)
    expect(result.hits[0]!.score).toBe(6)
    const substring = result.hits.find(h => h.path === 'src/substring.ts')!
    // `budgetish` and `xbudget` only; `retryBudgetMs` does not match a
    // case-sensitive `budget` at all.
    expect(substring.matches).toBe(2)
    expect(substring.exactMatches).toBe(0)
    expect(substring.score).toBe(2)
  })

  it('folds case for a lower-case term and keeps it for a spelled-out identifier', async () => {
    // SMART CASE, per term. A prompt says "retry budget"; the constant is spelled
    // RETRY_BUDGET_MS. Strict case-sensitivity means a natural-language prompt can
    // never find a SCREAMING_CASE constant, which is most configuration in most
    // repositories.
    const root = await makeProject()
    await write(root, 'src/config.ts', 'export const RETRY_BUDGET_MS = 4500\n')
    await write(root, 'src/other.ts', 'export const budget = 1\n')
    const { graph } = await buildRepoGraph({ root, persist: false })

    for (const preferRipgrep of [false, true]) {
      const prose = await lexicalSearch({ root, query: 'budget', graph, preferRipgrep })
      expect(prose.hits.map(h => h.path).sort(), `engine ${prose.engine}`).toEqual([
        'src/config.ts',
        'src/other.ts',
      ])

      // An identifier the caller spelled with capitals keeps its precision: this
      // must NOT also match the lower-case `budget` in other.ts.
      const exact = await lexicalSearch({ root, query: 'RETRY_BUDGET_MS', graph, preferRipgrep })
      expect(exact.hits.map(h => h.path), `engine ${exact.engine}`).toEqual(['src/config.ts'])
    }
  })

  it('returns nothing, and no error, for an empty query', async () => {
    const root = await makeProject()
    await seedIdentifierProject(root)
    const { graph } = await buildRepoGraph({ root, persist: false })

    const result = await lexicalSearch({ root, query: '   ', graph })
    expect(result.hits).toEqual([])
    expect(result.reason).toBe('empty query')
  })
})

// ── untrusted queries ───────────────────────────────────────────────────────

describe('untrusted queries', () => {
  it('builds an argv vector with the query after a -- terminator', () => {
    const nasty = "-e'; rm -rf / && echo $(whoami)"
    const args = ripgrepArgs(nasty)
    const terminator = args.indexOf('--')

    expect(terminator).toBeGreaterThan(-1)
    // The query is ONE element, positioned after option parsing has stopped, so
    // a leading dash is a pattern rather than a flag.
    expect(args[terminator + 1]).toBe(nasty)
    expect(args.filter(a => a === nasty)).toHaveLength(1)
    // Nothing was concatenated into a command string anywhere.
    expect(args.every(a => typeof a === 'string')).toBe(true)
    expect(args).toContain('--fixed-strings')
  })

  it('passes a query with shell metacharacters through as data', async () => {
    const root = await makeProject()
    const nasty = "-e'; rm -rf / && echo $(whoami)"
    await write(root, 'src/quarantine.ts', `export const suspicious = ${JSON.stringify(nasty)}\n`)
    await write(root, 'src/keep.ts', 'export const keep = true\n')
    const { graph } = await buildRepoGraph({ root, persist: false })

    const fast = await lexicalSearch({ root, query: nasty, graph })
    const slow = await lexicalSearch({ root, query: nasty, graph, preferRipgrep: false })

    // The literal is found, which proves the string reached the matcher intact.
    expect(fast.hits.map(h => h.path)).toEqual(['src/quarantine.ts'])
    expect(slow.hits.map(h => h.path)).toEqual(['src/quarantine.ts'])
    // And nothing executed: the other file is untouched and the project is intact.
    expect(await readFile(join(root, 'src/keep.ts'), 'utf8')).toBe('export const keep = true\n')
  })

  it('treats a leading-dash query as a pattern, not an option', async () => {
    const root = await makeProject()
    await write(root, 'src/flags.ts', 'const usage = "--help shows the flags"\n')
    const { graph } = await buildRepoGraph({ root, persist: false })

    const fast = await lexicalSearch({ root, query: '--help', graph })
    const slow = await lexicalSearch({ root, query: '--help', graph, preferRipgrep: false })

    expect(fast.hits.map(h => h.path)).toEqual(['src/flags.ts'])
    expect(slow.hits.map(h => h.path)).toEqual(['src/flags.ts'])
    expect(fast.reason).toBeNull()
  })
})

// ── fusion ──────────────────────────────────────────────────────────────────

describe('reciprocal rank fusion', () => {
  it('scores by 1/(k + rank) with k = 60, hand-computed', () => {
    const lists: RankedList[] = [
      { channel: 'lexical', items: [item('a.ts', 0), item('b.ts', 0), item('c.ts', 0)] },
      { channel: 'vector', items: [item('c.ts', 0), item('a.ts', 0), item('d.ts', 0)] },
    ]

    const fused = reciprocalRankFusion(lists)

    // a: 1/61 + 1/62 = 0.032917...   c: 1/63 + 1/61 = 0.032268...
    // b: 1/62 = 0.016129...          d: 1/63 = 0.015873...
    expect(fused.map(f => f.id)).toEqual(['a.ts#0', 'c.ts#0', 'b.ts#0', 'd.ts#0'])
    expect(fused[0]!.rrf).toBeCloseTo(1 / 61 + 1 / 62, 12)
    expect(fused[1]!.rrf).toBeCloseTo(1 / 63 + 1 / 61, 12)
    expect(fused[2]!.rrf).toBeCloseTo(1 / 62, 12)
    expect(fused[3]!.rrf).toBeCloseTo(1 / 63, 12)
    expect(fused[0]!.channels).toEqual(['lexical', 'vector'])
    expect(fused[0]!.ranks).toEqual({ lexical: 1, vector: 2 })
    expect(RRF_K).toBe(60)
  })

  it('lets agreement across channels beat a single strong rank', () => {
    const lists: RankedList[] = [
      { channel: 'lexical', items: [item('solo.ts', 0), item('both.ts', 0)] },
      { channel: 'vector', items: [item('other.ts', 0), item('both.ts', 0)] },
    ]
    // both: 1/62 + 1/62 = 0.032258 > solo and other, which both hold a single
    // rank 1 (1/61) and are therefore separated by the path tie-break alone.
    expect(reciprocalRankFusion(lists).map(f => f.id)).toEqual(['both.ts#0', 'other.ts#0', 'solo.ts#0'])
  })

  it('orders identically regardless of the order candidates arrive in', () => {
    // A candidate ranked (1, 3) and one ranked (3, 1) score EXACTLY the same
    // (1/61 + 1/63) and share a best-rank of 1, so nothing but the documented
    // path / chunk-index tie-break can separate them. Each pair is fused twice
    // with the two channels' lists swapped, which changes the order candidates
    // are discovered in without changing a single score. Remove the tie-break and
    // the two runs disagree — which is exactly the churn between runs the rule
    // exists to prevent.
    const byPathA: RankedList[] = [
      { channel: 'lexical', items: [item('b.ts', 1), item('m.ts', 0), item('a.ts', 0)] },
      { channel: 'vector', items: [item('a.ts', 0), item('m.ts', 0), item('b.ts', 1)] },
    ]
    const byPathB: RankedList[] = [
      { channel: 'lexical', items: [item('a.ts', 0), item('m.ts', 0), item('b.ts', 1)] },
      { channel: 'vector', items: [item('b.ts', 1), item('m.ts', 0), item('a.ts', 0)] },
    ]

    const firstA = reciprocalRankFusion(byPathA)
    const firstB = reciprocalRankFusion(byPathB)

    expect(firstA.map(f => f.rrf)).toEqual(firstB.map(f => f.rrf))
    expect(firstA.map(f => f.id)).toEqual(firstB.map(f => f.id))
    expect(firstA[0]!.rrf).toBeCloseTo(firstA[1]!.rrf, 15)
    // Tied pair sorted by path; `m.ts#0` sits third on 2/62, which is genuinely
    // lower than 1/61 + 1/63.
    expect(firstA.map(f => f.id)).toEqual(['a.ts#0', 'b.ts#1', 'm.ts#0'])

    // Same construction with the tie inside one file, so the chunk-index
    // comparator is the only thing left to decide it.
    const byChunkA: RankedList[] = [
      { channel: 'lexical', items: [item('b.ts', 1), item('m.ts', 0), item('b.ts', 0)] },
      { channel: 'vector', items: [item('b.ts', 0), item('m.ts', 0), item('b.ts', 1)] },
    ]
    const byChunkB: RankedList[] = [
      { channel: 'lexical', items: [item('b.ts', 0), item('m.ts', 0), item('b.ts', 1)] },
      { channel: 'vector', items: [item('b.ts', 1), item('m.ts', 0), item('b.ts', 0)] },
    ]

    const secondA = reciprocalRankFusion(byChunkA)
    const secondB = reciprocalRankFusion(byChunkB)

    expect(secondA.map(f => f.id)).toEqual(secondB.map(f => f.id))
    expect(secondA.map(f => f.id)).toEqual(['b.ts#0', 'b.ts#1', 'm.ts#0'])
  })

  it('never counts one channel twice for the same chunk', () => {
    const lists: RankedList[] = [
      { channel: 'lexical', items: [item('a.ts', 0), item('a.ts', 0)] },
    ]
    const fused = reciprocalRankFusion(lists)
    expect(fused).toHaveLength(1)
    expect(fused[0]!.rrf).toBeCloseTo(1 / 61, 12)
  })
})

// ── rerank ──────────────────────────────────────────────────────────────────

function fusedOf(path: string, rrf: number, channels: Array<'lexical' | 'vector'>): FusedCandidate {
  return {
    ...item(path, 0),
    ranks: Object.fromEntries(channels.map((c, i) => [c, i + 1])),
    channels,
    rrf,
    bestRank: 1,
  }
}

function lexicalOf(path: string, partial: Partial<LexicalHit> = {}): LexicalHit {
  return {
    id: `${path}#0`,
    path,
    chunkIndex: 0,
    startLine: 0,
    endLine: 10,
    matches: 1,
    exactMatches: 1,
    matchLines: 1,
    termsMatched: 1,
    score: 3,
    firstLine: 0,
    preview: '',
    definition: false,
    matchedLines: [],
    ...partial,
  }
}

describe('rerank pass', () => {
  it('promotes a definition over a mention with a better fused score', () => {
    const mention = fusedOf('notes.md', 1 / 61, ['lexical'])
    const definition = fusedOf('src/impl.ts', 1 / 62, ['lexical'])
    const lexicalById = new Map<string, LexicalHit>([
      ['notes.md#0', lexicalOf('notes.md')],
      ['src/impl.ts#0', lexicalOf('src/impl.ts', { definition: true })],
    ])

    const ranked = rerank([mention, definition], lexicalById, 'thing')

    // definition: (1/62) * (1 + 0.5 + 0.05) = 0.024999...
    // mention:    (1/61) * (1 + 0.05)       = 0.017213...
    expect(ranked.map(h => h.id)).toEqual(['src/impl.ts#0', 'notes.md#0'])
    expect(ranked[0]!.score).toBeCloseTo((1 / 62) * 1.55, 12)
    expect(ranked[1]!.score).toBeCloseTo((1 / 61) * 1.05, 12)
    expect(ranked[0]!.boost).toBeCloseTo(0.55, 12)
  })

  it('cannot lift a poorly fused candidate above a well fused one', () => {
    // The cap is what keeps rerank a reordering pass rather than a second,
    // unfused ranker: the best possible boost is 2x.
    const strong = fusedOf('strong.ts', 1 / 61 + 1 / 61, ['lexical', 'vector'])
    const boosted = fusedOf('weak.ts', 1 / 160, ['lexical', 'vector'])
    const lexicalById = new Map<string, LexicalHit>([
      ['weak.ts#0', lexicalOf('weak.ts', { definition: true, exactMatches: 9 })],
    ])

    const ranked = rerank([strong, boosted], lexicalById, 'weak.ts')
    expect(ranked[0]!.id).toBe('strong.ts#0')
    // Every signal firing at once: 0.5 + 0.2 + 4 x 0.05 + 0.1 = the 1.0 cap.
    expect(ranked[1]!.boost).toBeCloseTo(1, 12)
    expect(ranked[1]!.score).toBeCloseTo(2 / 160, 12)
    // And a boost beyond the cap changes nothing.
    expect(rerankScore(1 / 160, 5)).toBeCloseTo(2 / 160, 12)
  })

  it('leaves the fused order untouched when disabled', () => {
    const a = fusedOf('a.ts', 1 / 61, ['lexical'])
    const b = fusedOf('b.ts', 1 / 62, ['lexical'])
    const lexicalById = new Map<string, LexicalHit>([['b.ts#0', lexicalOf('b.ts', { definition: true })]])

    const ranked = rerank([a, b], lexicalById, 'x', false)
    expect(ranked.map(h => h.id)).toEqual(['a.ts#0', 'b.ts#0'])
    expect(ranked.every(h => h.boost === 0)).toBe(true)
    expect(ranked.every((h: HybridHit) => h.score === h.rrfScore)).toBe(true)
  })

  it('breaks equal reranked scores by path then chunk index', () => {
    const shuffled: FusedCandidate[] = [
      { ...item('b.ts', 1), ranks: { lexical: 1 }, channels: ['lexical'], rrf: 1 / 61, bestRank: 1 },
      { ...item('a.ts', 0), ranks: { lexical: 1 }, channels: ['lexical'], rrf: 1 / 61, bestRank: 1 },
      { ...item('b.ts', 0), ranks: { lexical: 1 }, channels: ['lexical'], rrf: 1 / 61, bestRank: 1 },
    ]
    const ranked = rerank(shuffled, new Map(), 'q')
    expect(ranked.map(h => h.id)).toEqual(['a.ts#0', 'b.ts#0', 'b.ts#1'])
  })
})

// ── the small pieces ────────────────────────────────────────────────────────

describe('match counting', () => {
  it('counts occurrences and identifier-boundary occurrences separately', () => {
    expect(countMatches('const budget = budget + 1', 'budget')).toEqual({ matches: 2, exact: 2 })
    expect(countMatches('retryBudget and budgetMs', 'Budget')).toEqual({ matches: 1, exact: 0 })
    expect(countMatches('BUDGET', 'budget')).toEqual({ matches: 0, exact: 0 })
    expect(countMatches('BUDGET', 'budget', true)).toEqual({ matches: 1, exact: 1 })
    expect(countMatches('anything', '')).toEqual({ matches: 0, exact: 0 })
  })

  it('recognises declarations without mistaking calls for them', () => {
    expect(looksLikeDefinition('export function parse_retry_budget(raw: string) {', 'parse_retry_budget')).toBe(true)
    expect(looksLikeDefinition('class RetryBudget {', 'RetryBudget')).toBe(true)
    expect(looksLikeDefinition('def parse_retry_budget(raw):', 'parse_retry_budget')).toBe(true)
    expect(looksLikeDefinition('parse_retry_budget = 1', 'parse_retry_budget')).toBe(true)
    expect(looksLikeDefinition('  const n = parse_retry_budget(raw)', 'parse_retry_budget')).toBe(false)
    expect(looksLikeDefinition('// see parse_retry_budget', 'parse_retry_budget')).toBe(false)
  })
})

describe('ripgrep output parsing', () => {
  const known = (p: string) => p === 'src/a.ts' || p === 'src/we:ird.ts'

  it('parses path, 0-based line and text', () => {
    expect(parseRipgrepLine('src/a.ts:12:const x = 1', known)).toEqual({
      path: 'src/a.ts',
      line: 11,
      text: 'const x = 1',
    })
  })

  it('normalises the separators ripgrep prints for a "." search root', () => {
    expect(parseRipgrepLine('./src/a.ts:1:x', known)?.path).toBe('src/a.ts')
    expect(parseRipgrepLine('.\\src\\a.ts:1:x', known)?.path).toBe('src/a.ts')
  })

  it('prefers the boundary that yields a known path when the path has a colon', () => {
    expect(parseRipgrepLine('src/we:ird.ts:3:hit:9:more', known)).toEqual({
      path: 'src/we:ird.ts',
      line: 2,
      text: 'hit:9:more',
    })
  })

  it('returns null for a line with no line number', () => {
    expect(parseRipgrepLine('', known)).toBeNull()
    expect(parseRipgrepLine('no line number here', known)).toBeNull()
  })
})

describe('chunk attribution', () => {
  it('assigns a line to the lowest-indexed chunk that contains it', () => {
    const file = {
      path: 'a.ts',
      size: 0,
      hash: 'x',
      extension: '.ts',
      specifiers: [],
      imports: [],
      chunks: [
        { index: 0, startLine: 0, endLine: 20, chars: 100 },
        { index: 1, startLine: 18, endLine: 40, chars: 100 },
      ],
    }
    expect(chunkForLine(file, 0)?.index).toBe(0)
    // Overlapping range: the lower index wins, always.
    expect(chunkForLine(file, 19)?.index).toBe(0)
    expect(chunkForLine(file, 30)?.index).toBe(1)
    // A file that grew since indexing still attributes rather than losing the hit.
    expect(chunkForLine(file, 999)?.index).toBe(1)
    expect(chunkForLine({ ...file, chunks: [] }, 1)).toBeNull()
  })
})

describe('vector channel', () => {
  it('orders by score and breaks ties by id', async () => {
    const root = await makeProject()
    await seedIdentifierProject(root)
    const { graph } = await buildRepoGraph({ root, persist: false })
    const { embedder, store } = await buildVectorChannel(root, graph)

    const hits = await vectorSearch({ embedder, store }, 'mentions parse_retry_budget', 4)
    expect(hits).toHaveLength(4)
    for (let i = 1; i < hits.length; i++) {
      expect(hits[i - 1]!.score).toBeGreaterThanOrEqual(hits[i]!.score)
      if (hits[i - 1]!.score === hits[i]!.score) {
        expect(hits[i - 1]!.id < hits[i]!.id).toBe(true)
      }
    }
  })
})

// ── sentence-shaped queries ─────────────────────────────────────────────────
//
// The lexical channel is handed `task.prompt`, and a prompt is a sentence. Before
// query terms existed, the channel searched for the whole sentence as one fixed
// string, found nothing, and hybrid retrieval quietly became vector-only — the very
// thing Requirement 18.2 forbids, reached without anyone disabling a channel.
//
// Both engines are exercised on every machine: `preferRipgrep: false` forces the
// scanner, and the ripgrep path runs when the binary is there.

describe('query terms', () => {
  it('leaves a single identifier exactly as it was', () => {
    // The pre-existing behaviour, pinned. An identifier is not split on its own
    // case or underscore boundaries: one precise term beats three vague ones.
    expect(queryTerms('parse_retry_budget')).toEqual(['parse_retry_budget'])
    expect(queryTerms('RETRY_BUDGET_MS')).toEqual(['RETRY_BUDGET_MS'])
    expect(queryTerms('parseRetryBudget')).toEqual(['parseRetryBudget'])
  })

  it('drops prose and punctuation from a real prompt', () => {
    expect(queryTerms('Where is the payments retry budget set?')).toEqual([
      'payments',
      'retry',
      'budget',
    ])
  })

  it('deduplicates case-insensitively, keeping the first spelling', () => {
    expect(queryTerms('Budget budget BUDGET')).toEqual(['Budget'])
  })

  it('caps the term count, so a long prompt cannot fan out unbounded', () => {
    const long = Array.from({ length: 40 }, (_, i) => `term_${i}`).join(' ')
    expect(queryTerms(long)).toHaveLength(MAX_QUERY_TERMS)
  })

  it('falls back to the query itself when every token is filtered out', () => {
    // Otherwise a query of "the" would search for nothing at all and the channel
    // would report zero hits as though the repository were empty.
    expect(queryTerms('the and for')).toEqual(['the and for'])
    expect(queryTerms('??')).toEqual(['??'])
    expect(queryTerms('   ')).toEqual([])
  })
})

describe('lexical channel on a sentence query', () => {
  it('finds the definition that a whole-sentence literal search cannot', async () => {
    const root = await makeProject()
    await seedIdentifierProject(root)
    const { graph } = await buildRepoGraph({ root, persist: false })
    const query = 'Where is the retry budget parsed?'

    for (const preferRipgrep of [false, true]) {
      const result = await lexicalSearch({ root, query, graph, preferRipgrep })
      expect(result.terms).toEqual(['retry', 'budget', 'parsed'])
      expect(result.hits.length, `engine ${result.engine}`).toBeGreaterThan(0)
      // src/retry.ts carries both `retry` and `budget`; the notes carry only the
      // one identifier, and coverage is the first sort key.
      expect(result.hits[0]!.path, `engine ${result.engine}`).toBe('src/retry.ts')
      expect(result.hits[0]!.termsMatched).toBeGreaterThan(1)
    }
  })

  it('ranks broad term coverage above one term repeated', async () => {
    const root = await makeProject()
    // `wide.ts` matches two terms once each. `narrow.ts` matches one term twelve
    // times, which is the higher raw score and the wrong answer.
    await write(root, 'src/wide.ts', 'export const payments = 1\nexport const retry = 2\n')
    await write(
      root,
      'src/narrow.ts',
      `${Array.from({ length: 12 }, (_, i) => `export const retry_${i} = ${i}`).join('\n')}\n`
    )
    const { graph } = await buildRepoGraph({ root, persist: false })

    for (const preferRipgrep of [false, true]) {
      const result = await lexicalSearch({
        root,
        query: 'payments retry',
        graph,
        preferRipgrep,
      })
      expect(result.hits[0]!.path, `engine ${result.engine}`).toBe('src/wide.ts')
      expect(result.hits[0]!.termsMatched).toBe(2)
      const narrow = result.hits.find(h => h.path === 'src/narrow.ts')!
      expect(narrow.termsMatched).toBe(1)
      // Not dropped — outranked. A one-term match is still evidence.
      expect(narrow.score).toBeGreaterThan(result.hits[0]!.score)
    }
  })

  it('counts a line matching several terms as one matching line', async () => {
    const root = await makeProject()
    await write(root, 'src/one.ts', 'export const paymentsRetryBudget = 4500\n')
    const { graph } = await buildRepoGraph({ root, persist: false })

    const result = await lexicalSearch({
      root,
      query: 'payments retry budget',
      graph,
      preferRipgrep: false,
      ignoreCase: true,
    })
    expect(result.hits).toHaveLength(1)
    expect(result.hits[0]!.matchLines).toBe(1)
    expect(result.hits[0]!.termsMatched).toBe(3)
  })

  it('reports the same terms whichever engine ran', async () => {
    const root = await makeProject()
    await seedIdentifierProject(root)
    const { graph } = await buildRepoGraph({ root, persist: false })
    const query = 'retry budget parsing'

    const scanner = await lexicalSearch({ root, query, graph, preferRipgrep: false })
    const other = await lexicalSearch({ root, query, graph, binary: MISSING_BINARY })
    expect(scanner.terms).toEqual(other.terms)
    // Ordering must not depend on which engine discovered the files.
    expect(scanner.hits.map(h => h.id)).toEqual(other.hits.map(h => h.id))
  })

  it('keeps hybrid retrieval genuinely hybrid for a sentence query', async () => {
    const root = await makeProject()
    await seedIdentifierProject(root)
    const { graph } = await buildRepoGraph({ root, persist: false })
    const vector = await buildVectorChannel(root, graph)

    const result = await hybridSearch({
      root,
      query: 'Where is the retry budget parsed?',
      graph,
      vector,
      preferRipgrep: false,
    })

    const lexical = result.channels.find(c => c.channel === 'lexical')!
    // The assertion that would have caught the original defect: a sentence query
    // must not leave the lexical channel with zero hits.
    expect(lexical.ran).toBe(true)
    expect(lexical.hits).toBeGreaterThan(0)
    expect(result.vectorOnly).toBe(false)
    expect(result.hits[0]!.path).toBe('src/retry.ts')
  })
})

describe('smart case', () => {
  it('folds an all-lower-case term and preserves one carrying capitals', () => {
    expect(smartCase('budget')).toBe(true)
    expect(smartCase('retry_budget')).toBe(true)
    expect(smartCase('RETRY_BUDGET_MS')).toBe(false)
    expect(smartCase('parseRetry')).toBe(false)
  })

  it('lets an explicit setting win in both directions', () => {
    expect(smartCase('budget', false)).toBe(false)
    expect(smartCase('RETRY_BUDGET_MS', true)).toBe(true)
  })
})
