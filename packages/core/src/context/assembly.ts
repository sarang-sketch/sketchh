// Context assembly under a token budget — the step that decides what the model
// actually sees.
//
// ── WHAT GOES IN ─────────────────────────────────────────────────────────────
//
// Four sources, in one pass (Requirement 18.4):
//
//   1. MEMORY   — the project memory digest: standards, decisions, past bugs.
//   2. SKILLS   — the loaded skills' instructions.
//   3. CHUNKS   — the top-k spans from `hybridSearch` (lexical + vector, fused
//                 and reranked). Not vector-only; see hybrid-search.ts.
//   4. NEIGHBOURS — ONE HOP along the persisted graph's `imports` edges from the
//                 files the chunks came from. A neighbour is included for its
//                 INTERFACE, not its implementation, so it enters the ladder at
//                 the signature rung: what the retrieved code calls matters more
//                 than how the callee is written.
//
// ── THE BUDGET IS PRE-FLIGHT ────────────────────────────────────────────────
//
// Every rendering is measured BEFORE the text is joined. Assembling first and
// discovering the overrun afterwards means the request already went out and the
// money is already spent. `assembleContext` cannot return a context whose
// estimate exceeds the budget: the degradation loop is the single enforcement
// point, and `withinBudget` is the assertion a test can make about it.
//
// ── THE TOKEN NUMBER IS AN ESTIMATE. IT IS NOT A TOKENIZER COUNT ─────────────
//
// `chars / 4`, rounded up. That is all it is. It is reported as
// `tokenEstimateMethod: "chars/4"` with `tokenEstimateIsHeuristic: true` in
// both the result and the event, so nothing downstream can mistake it for a
// count from a real tokenizer. A tokenizer would be a runtime dependency, and
// `packages/core` has none — that is the tradeoff, stated rather than hidden.
// Real tokenizers typically land within ±20% of chars/4 on source code; budget
// with headroom accordingly.
//
// ── DEGRADATION: DETAIL BEFORE COVERAGE (Requirement 18.5) ──────────────────
//
// Each item carries a ladder of renderings, richest first. When the total is
// over budget the assembler SWEEPS: every item loses one rung, in priority
// order, before any item loses a second, and nothing is dropped until every
// ladder is exhausted. Priority order, least valuable first:
//
//   neighbours (reverse path order)
//     → chunks, LOWEST-SCORING FIRST
//       → skills (reverse name order)
//         → memory
//
// Detail goes before coverage, which is what makes forty signatures survive
// where three bodies would have been kept:
//
//   chunk:     body → signatures + doc → signatures → path only → dropped
//   neighbour: signatures → path only → dropped
//   skill:     name + description + body → name + description → name → dropped
//   memory:    full digest → first lines → dropped
//
// Signature rungs are OFFERED ONLY WHERE THEY ARE REAL. For a language the
// extractor cannot parse, or a chunk with no bounded declaration in it, those
// rungs are absent from the ladder and the item degrades body → path. See
// signatures.ts: emitting a mangled fragment would be worse than emitting less.
//
// ── DETERMINISM ──────────────────────────────────────────────────────────────
//
// Same graph, same query, same budget → byte-identical text. Hits arrive in
// `hybridSearch`'s total order, neighbours are sorted, skills are sorted by
// name, and no Map iteration order reaches the output.
//
// ── THE `context_assembled` DISCRIMINATOR, AND WHY IT SURVIVED ──────────────
//
// TWO call sites emit this EventKind, told apart by `component`:
//
//   * `component: "assembly"`   — HERE. The real assembly step, and the only
//     emitter carrying `primary: true`, the selected paths and the token
//     estimate that Requirement 18.6 asks for.
//   * `component: "agent-loop"`  — the loop's message-count breadcrumb.
//
// Both say "the context for this turn is now fixed"; they differ in fidelity, not
// in fact, so the `EventKind` amendment deliberately did NOT split them. The
// third emitter, retrieval telemetry, WAS a different fact and left for
// `context_retrieved`. The search's own event is still not emitted from here by
// default (`emitSearchEvent`): the assembly record already carries the search's
// status, and one retrieval should not appear on the log twice.
//
// Validates: Requirements 18.4, 18.5, 18.6, 18.8

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { EventInput } from '../events/store.js'
import type { Skill } from '../types.js'
import {
  DEFAULT_TOP_K,
  hybridSearch,
  type HybridHit,
  type LexicalEngine,
  type SearchConfig,
  type VectorChannel,
} from './hybrid-search.js'
import { loadRepoGraph, buildRepoGraph, type RepoGraph } from './repo-graph.js'
import {
  extractSignatures,
  renderSignatures,
  type SignatureExtraction,
} from './signatures.js'

/** Characters per token in the estimate. Documented, not tuned. */
export const CHARS_PER_TOKEN = 4
/** The name of the estimation method, carried in the payload verbatim. */
export const TOKEN_ESTIMATE_METHOD = 'chars/4'

/**
 * The token ESTIMATE for a string: `ceil(chars / 4)`.
 *
 * Not a tokenizer count. `ceil` matters for the budget guarantee: it is
 * subadditive (`ceil(a + b) <= ceil(a) + ceil(b)`), so the sum of the per-block
 * estimates is never LESS than the estimate of the concatenated text. Budgeting
 * on the sum therefore also bounds the whole.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN)
}

/** Where an included block came from. */
export type SectionKind = 'memory' | 'skill' | 'chunk' | 'neighbour'

/** A rung on an item's ladder. `dropped` is the implicit rung past the end. */
export type DetailLevel =
  | 'full'
  | 'head'
  | 'body'
  | 'signatures+doc'
  | 'signatures'
  | 'summary'
  | 'name'
  | 'path'
  | 'dropped'

export interface AssembledSection {
  kind: SectionKind
  /** Project-relative path, or null for memory and skills. */
  path: string | null
  /** Skill name, or the path, or `project-memory`. */
  label: string
  detail: DetailLevel
  /** Estimated tokens for this block, including its trailing blank line. */
  tokens: number
  /** True when this block is below the best rung its ladder offered. */
  degraded: boolean
}

export interface DroppedItem {
  kind: SectionKind
  label: string
  path: string | null
  reason: string
}

export interface AssembledContext {
  /** The context text, in presentation order. */
  text: string
  /** `estimateTokens(text)`. An estimate — see TOKEN_ESTIMATE_METHOD. */
  tokenEstimate: number
  tokenEstimateMethod: string
  budgetTokens: number
  /** Always true. False would be a bug, and a test asserts it never happens. */
  withinBudget: boolean
  sections: AssembledSection[]
  /** Every selected path, sorted and deduplicated. What 18.6 asks to log. */
  paths: string[]
  /** Paths contributed by retrieved chunks. */
  chunkPaths: string[]
  /** Paths reached by ONE HOP along `imports`. The consumed expansion (18.8). */
  neighbourPaths: string[]
  dropped: DroppedItem[]
  /** True when any item sits below the best rung it offered. */
  degraded: boolean
  /** Paths whose language has no signature extractor. Body or nothing. */
  signatureUnsupported: string[]
  /** Which engine carried the lexical channel, when a search ran. */
  lexicalEngine: LexicalEngine | null
  /** True when retrieval itself ran degraded. */
  searchDegraded: boolean
  vectorOnly: boolean
}

export interface AssembleContextOptions {
  /** Project root. Files are read from here. */
  root: string
  /** Where `.sketch/` lives. Defaults to `root`. */
  baseDir?: string
  /** The task or query driving retrieval. */
  query: string
  /** Hard ceiling on the estimate. Zero is legal and yields an empty context. */
  budgetTokens: number
  /** Omitted loads the persisted graph; null builds one without persisting. */
  graph?: RepoGraph | null
  /** Pre-computed hits. Supplying them skips retrieval entirely. */
  hits?: readonly HybridHit[]
  topK?: number
  /** The project memory digest, e.g. `ProjectMemory.digest()`. */
  memory?: string
  skills?: readonly Skill[]
  /** The vector channel's collaborators. Absent leaves retrieval lexical-only. */
  vector?: VectorChannel
  search?: Partial<SearchConfig>
  preferRipgrep?: boolean
  ripgrepBinary?: string
  /** One-hop neighbours considered, after sorting. Default 8. */
  maxNeighbours?: number
  /** Lines of the memory digest kept at the `head` rung. Default 12. */
  memoryHeadLines?: number
  /**
   * Also emit the search's own `context_assembled` event. Off by default: the
   * assembly event is the primary record and carries the search's status
   * already.
   */
  emitSearchEvent?: boolean
  events?: { emit(event: EventInput): Promise<void> | void }
  runId?: string
  signal?: AbortSignal
}

const DEFAULT_MAX_NEIGHBOURS = 8
const DEFAULT_MEMORY_HEAD_LINES = 12

interface Rung {
  detail: DetailLevel
  /** Block text, ending in a blank line so blocks concatenate directly. */
  text: string
}

interface Item {
  kind: SectionKind
  label: string
  path: string | null
  /** Presentation order. Not the degradation order. */
  order: number
  rungs: Rung[]
  /** Index into `rungs`; `rungs.length` means dropped. */
  level: number
}

function cost(item: Item): number {
  const rung = item.rungs[item.level]
  return rung === undefined ? 0 : estimateTokens(rung.text)
}

/**
 * Keep only rungs that are strictly cheaper than the rung above.
 *
 * A ladder must go DOWN. A signature rendering can occasionally cost more than
 * the body it replaces — a short function with a long doc comment — and a rung
 * that costs more would make degradation increase the total, which is not a
 * degradation. Such a rung is removed rather than reordered, so the ladder keeps
 * reading richest-to-poorest.
 */
function monotonic(rungs: readonly Rung[]): Rung[] {
  const kept: Rung[] = []
  let ceiling = Number.POSITIVE_INFINITY
  for (const rung of rungs) {
    const tokens = estimateTokens(rung.text)
    if (tokens >= ceiling) continue
    kept.push(rung)
    ceiling = tokens
  }
  return kept.length > 0 ? kept : [rungs[0]!]
}

/**
 * Assemble the context. Never exceeds `budgetTokens`.
 *
 * Reads files from disk (the graph stores spans, not content) and does no
 * network I/O of its own — retrieval's vector channel is whatever embedder the
 * caller supplied, which is offline by default.
 */
export async function assembleContext(
  options: AssembleContextOptions
): Promise<AssembledContext> {
  const budget = Math.max(0, Math.floor(options.budgetTokens))
  const baseDir = options.baseDir ?? options.root
  const graph = await resolveGraph(options, baseDir)

  // ── retrieval ─────────────────────────────────────────────────────────────
  let hits: readonly HybridHit[]
  let lexicalEngine: LexicalEngine | null = null
  let searchDegraded = false
  let vectorOnly = false

  if (options.hits !== undefined) {
    hits = options.hits
  } else {
    const search = await hybridSearch({
      root: options.root,
      baseDir,
      query: options.query,
      graph,
      config: options.search,
      vector: options.vector,
      topK: options.topK ?? DEFAULT_TOP_K,
      preferRipgrep: options.preferRipgrep,
      ripgrepBinary: options.ripgrepBinary,
      events: options.emitSearchEvent === true ? options.events : undefined,
      runId: options.runId,
      signal: options.signal,
    })
    hits = search.hits
    lexicalEngine = search.lexicalEngine
    searchDegraded = search.degraded
    vectorOnly = search.vectorOnly
  }

  // ── one hop along `imports` (Requirement 18.8) ────────────────────────────
  const chunkPaths = sortedUnique(hits.map(h => h.path))
  const neighbourPaths = oneHopNeighbours(
    graph,
    chunkPaths,
    options.maxNeighbours ?? DEFAULT_MAX_NEIGHBOURS
  )

  // ── build the ladders ─────────────────────────────────────────────────────
  const reader = new FileTextCache(options.root)
  const items: Item[] = []
  const dropped: DroppedItem[] = []
  const signatureUnsupported = new Set<string>()
  let order = 0

  const memoryText = (options.memory ?? '').trim()
  if (memoryText !== '') {
    items.push({
      kind: 'memory',
      label: 'project-memory',
      path: null,
      order: order++,
      rungs: monotonic(
        memoryRungs(memoryText, options.memoryHeadLines ?? DEFAULT_MEMORY_HEAD_LINES)
      ),
      level: 0,
    })
  }

  for (const skill of sortedSkills(options.skills ?? [])) {
    items.push({
      kind: 'skill',
      label: skill.name,
      path: null,
      order: order++,
      rungs: monotonic(skillRungs(skill)),
      level: 0,
    })
  }

  for (const hit of hits) {
    const text = await reader.lines(hit.path)
    if (text === null) {
      dropped.push({
        kind: 'chunk',
        label: hit.path,
        path: hit.path,
        reason: 'indexed but unreadable now',
      })
      continue
    }
    const body = text.slice(hit.startLine, hit.endLine + 1).join('\n')
    const extraction = extractSignatures(hit.path, body)
    if (!extraction.supported) signatureUnsupported.add(hit.path)
    items.push({
      kind: 'chunk',
      label: `${hit.path}:${hit.startLine + 1}-${hit.endLine + 1}`,
      path: hit.path,
      order: order++,
      rungs: monotonic(chunkRungs(hit, body, extraction)),
      level: 0,
    })
  }

  for (const path of neighbourPaths) {
    const text = await reader.lines(path)
    if (text === null) {
      dropped.push({
        kind: 'neighbour',
        label: path,
        path,
        reason: 'indexed but unreadable now',
      })
      continue
    }
    const extraction = extractSignatures(path, text.join('\n'))
    if (!extraction.supported) signatureUnsupported.add(path)
    items.push({
      kind: 'neighbour',
      label: path,
      path,
      order: order++,
      rungs: monotonic(neighbourRungs(path, extraction)),
      level: 0,
    })
  }

  // ── THE SINGLE BUDGET ENFORCEMENT POINT ───────────────────────────────────
  enforceBudget(items, budget)

  // ── render ────────────────────────────────────────────────────────────────
  const included = items
    .filter(item => item.level < item.rungs.length)
    .sort((a, b) => a.order - b.order)

  const text = included
    .map(item => item.rungs[item.level]!.text)
    .join('')
    .trimEnd()
  const finalText = text === '' ? '' : `${text}\n`

  const sections: AssembledSection[] = included.map(item => ({
    kind: item.kind,
    path: item.path,
    label: item.label,
    detail: item.rungs[item.level]!.detail,
    tokens: cost(item),
    degraded: item.level > 0,
  }))

  for (const item of items) {
    if (item.level < item.rungs.length) continue
    dropped.push({
      kind: item.kind,
      label: item.label,
      path: item.path,
      reason: 'token budget',
    })
  }

  const includedPaths = sortedUnique(
    sections.map(s => s.path).filter((p): p is string => p !== null)
  )
  const tokenEstimate = estimateTokens(finalText)

  const result: AssembledContext = {
    text: finalText,
    tokenEstimate,
    tokenEstimateMethod: TOKEN_ESTIMATE_METHOD,
    budgetTokens: budget,
    withinBudget: tokenEstimate <= budget,
    sections,
    paths: includedPaths,
    chunkPaths: sortedUnique(
      sections.filter(s => s.kind === 'chunk').map(s => s.path!)
    ),
    neighbourPaths: sortedUnique(
      sections.filter(s => s.kind === 'neighbour').map(s => s.path!)
    ),
    dropped: dropped.sort((a, b) =>
      a.kind !== b.kind ? compare(a.kind, b.kind) : compare(a.label, b.label)
    ),
    degraded: sections.some(s => s.degraded) || dropped.length > 0,
    signatureUnsupported: [...signatureUnsupported].sort(),
    lexicalEngine,
    searchDegraded,
    vectorOnly,
  }

  await options.events?.emit({
    runId: options.runId ?? 'assembly',
    kind: 'context_assembled',
    payload: {
      // THE PRIMARY EMITTER of this kind. See the collision note in the header.
      component: 'assembly',
      primary: true,
      // Requirement 18.6: the selected paths and the token estimate.
      paths: result.paths,
      chunkPaths: result.chunkPaths,
      neighbourPaths: result.neighbourPaths,
      tokenEstimate: result.tokenEstimate,
      tokenEstimateMethod: TOKEN_ESTIMATE_METHOD,
      // Said out loud so no consumer reads this as a tokenizer count.
      tokenEstimateIsHeuristic: true,
      budgetTokens: budget,
      withinBudget: result.withinBudget,
      sections: sections.map(s => ({
        kind: s.kind,
        path: s.path,
        label: s.label,
        detail: s.detail,
        tokens: s.tokens,
        degraded: s.degraded,
      })),
      dropped: result.dropped,
      degraded: result.degraded,
      signatureUnsupported: result.signatureUnsupported,
      lexicalEngine,
      searchDegraded,
      vectorOnly,
      // The query itself is never logged: it can carry whatever the user typed.
      queryLength: options.query.length,
    },
  })

  return result
}

// ── ladders ─────────────────────────────────────────────────────────────────

function block(header: string, body: string): string {
  return body === '' ? `${header}\n\n` : `${header}\n${body}\n\n`
}

function memoryRungs(digest: string, headLines: number): Rung[] {
  const lines = digest.split('\n')
  const rungs: Rung[] = [
    { detail: 'full', text: block('## Project memory', digest) },
  ]
  if (lines.length > headLines) {
    rungs.push({
      detail: 'head',
      text: block(
        `## Project memory (first ${headLines} lines)`,
        lines.slice(0, headLines).join('\n')
      ),
    })
  }
  return rungs
}

function skillRungs(skill: Skill): Rung[] {
  const header = `## Skill: ${skill.name}`
  const description = skill.description.trim()
  const body = skill.body.trim()
  const rungs: Rung[] = []
  if (body !== '') {
    rungs.push({
      detail: 'full',
      text: block(header, description === '' ? body : `${description}\n\n${body}`),
    })
  }
  if (description !== '') rungs.push({ detail: 'summary', text: block(header, description) })
  rungs.push({ detail: 'name', text: block(header, '') })
  return rungs
}

/**
 * A retrieved chunk. The signature rungs exist only where the extractor
 * actually found bounded declarations — the whole point of 18.5 is that
 * signatures beat bodies, not that a fabricated outline beats a body.
 */
function chunkRungs(
  hit: HybridHit,
  body: string,
  extraction: SignatureExtraction
): Rung[] {
  const span = `${hit.path}:${hit.startLine + 1}-${hit.endLine + 1}`
  const rungs: Rung[] = [{ detail: 'body', text: block(`## ${span}`, body) }]

  if (extraction.declarations.length > 0) {
    const withDoc = renderSignatures(extraction, { includeDoc: true })
    const bare = renderSignatures(extraction, { includeDoc: false })
    rungs.push({
      detail: 'signatures+doc',
      text: block(`## ${span} (signatures, bodies elided)`, withDoc),
    })
    if (bare !== withDoc) {
      rungs.push({
        detail: 'signatures',
        text: block(`## ${span} (signatures, bodies elided)`, bare),
      })
    }
  }

  rungs.push({ detail: 'path', text: block(`## ${span} (path only)`, '') })
  return rungs
}

/**
 * A one-hop neighbour enters at signatures: the retrieved code CALLS it, so its
 * interface is what matters. A language with no extractor has no signature rung
 * at all and degrades straight to its path.
 */
function neighbourRungs(path: string, extraction: SignatureExtraction): Rung[] {
  const rungs: Rung[] = []
  if (extraction.declarations.length > 0) {
    const header = `## ${path} (one-hop dependency, signatures)`
    const withDoc = renderSignatures(extraction, { includeDoc: true })
    const bare = renderSignatures(extraction, { includeDoc: false })
    rungs.push({ detail: 'signatures+doc', text: block(header, withDoc) })
    if (bare !== withDoc) rungs.push({ detail: 'signatures', text: block(header, bare) })
  }
  rungs.push({
    detail: 'path',
    text: block(`## ${path} (one-hop dependency, path only)`, ''),
  })
  return rungs
}

/**
 * THE ONE PLACE THE BUDGET IS ENFORCED.
 *
 * A SWEEP, not a walk. Pass 1 takes every item down one rung — in the priority
 * order below, least valuable first — before pass 2 takes anything down a
 * second. Nothing is DROPPED until every ladder is exhausted, in the final pass.
 *
 * That ordering is the whole of Requirement 18.5. The obvious alternative —
 * degrade the least valuable item all the way to dropped, then move on — spends
 * the budget on one whole body and drops the rest, which is precisely the
 * behaviour signature-over-body exists to replace.
 *
 * The check runs after EVERY single step, so the assembler stops the instant it
 * fits and keeps the richest context that does.
 */
function enforceBudget(items: readonly Item[], budget: number): void {
  const queue = degradationQueue(items)
  const total = (): number => items.reduce((sum, item) => sum + cost(item), 0)
  if (total() <= budget) return

  const deepest = items.reduce((max, item) => Math.max(max, item.rungs.length), 0)

  // Passes 1..deepest-1: lose DETAIL. `min(target, rungs.length - 1)` is the
  // floor that keeps a short ladder from being dropped ahead of a long one.
  for (let target = 1; target < deepest; target++) {
    for (const item of queue) {
      const floor = Math.min(target, item.rungs.length - 1)
      while (item.level < floor) {
        item.level++
        if (total() <= budget) return
      }
    }
  }

  // Final pass: lose COVERAGE. Only now may an item be dropped outright.
  for (const item of queue) {
    while (item.level < item.rungs.length) {
      item.level++
      if (total() <= budget) return
    }
  }
}

/**
 * THE DOCUMENTED PRIORITY ORDER, least valuable first. Read top to bottom, this
 * is the order in which context is sacrificed:
 *
 *   1. neighbours, reverse path order
 *   2. chunks, LOWEST-SCORING FIRST (retrieval order reversed)
 *   3. skills, reverse name order
 *   4. memory
 */
function degradationQueue(items: readonly Item[]): Item[] {
  const rank: Record<SectionKind, number> = {
    neighbour: 0,
    chunk: 1,
    skill: 2,
    memory: 3,
  }
  return [...items].sort((a, b) =>
    rank[a.kind] !== rank[b.kind] ? rank[a.kind] - rank[b.kind] : b.order - a.order
  )
}

// ── graph helpers ───────────────────────────────────────────────────────────

/**
 * One hop along the persisted graph's `imports` edges. Seeds themselves are
 * excluded; the result is sorted, so the selection is stable.
 */
export function oneHopNeighbours(
  graph: RepoGraph,
  seeds: readonly string[],
  limit: number
): string[] {
  const seedSet = new Set(seeds)
  const byPath = new Map<string, readonly string[]>()
  for (const file of graph.files) byPath.set(file.path, file.imports)

  const found = new Set<string>()
  for (const seed of [...seeds].sort(compare)) {
    for (const target of byPath.get(seed) ?? []) {
      if (!seedSet.has(target)) found.add(target)
    }
  }
  return [...found].sort(compare).slice(0, Math.max(0, limit))
}

async function resolveGraph(
  options: AssembleContextOptions,
  baseDir: string
): Promise<RepoGraph> {
  if (options.graph !== undefined && options.graph !== null) return options.graph
  if (options.graph === undefined) {
    const persisted = await loadRepoGraph(baseDir)
    if (persisted !== null) return persisted
  }
  const built = await buildRepoGraph({
    root: options.root,
    baseDir,
    previous: null,
    persist: false,
  })
  return built.graph
}

/**
 * Reads each file at most once. The graph persists spans, not content, so the
 * file on disk is the store — and it may have moved on since the index was
 * built, which is why an unreadable file is a dropped item and not an error.
 */
class FileTextCache {
  private readonly cache = new Map<string, string[] | null>()

  constructor(private readonly root: string) {}

  async lines(path: string): Promise<string[] | null> {
    const cached = this.cache.get(path)
    if (cached !== undefined) return cached
    let value: string[] | null
    try {
      const text = await readFile(join(this.root, path), 'utf8')
      value = text.split('\n').map(line => line.replace(/\r$/, ''))
    } catch {
      value = null
    }
    this.cache.set(path, value)
    return value
  }
}

function compare(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(compare)
}

function sortedSkills(skills: readonly Skill[]): Skill[] {
  return [...skills].sort((a, b) => compare(a.name, b.name))
}
