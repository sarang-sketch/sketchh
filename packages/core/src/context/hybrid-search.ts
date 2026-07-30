// Hybrid retrieval: a lexical channel and a vector channel, fused by reciprocal
// rank, then reranked.
//
// ── WHY THIS EXISTS ──────────────────────────────────────────────────────────
//
// Vector-only retrieval is the single most common reason an AI coding tool
// "cannot find" a symbol that is sitting right there. Embeddings answer "what is
// this text about"; code questions are usually "where is this exact token".
// Exact identifiers, error strings and config keys are lexical problems, and a
// nearest-neighbour search over chunk embeddings will happily rank three chunks
// that *talk about* `parse_retry_budget` above the one that *defines* it.
//
// So the shipped default is hybrid (Requirement 18.2, conflict T6):
// `DEFAULT_SEARCH_CONFIG` enables both channels, and `isVectorOnly` exists so a
// test can assert the default never resolves to vector-only.
//
// ── THE LEXICAL CHANNEL: RIPGREP, THEN A SCANNER ─────────────────────────────
//
// `rg` is fast and correct and absent on plenty of machines. It is detected once
// per binary name (the answer is cached), and when it is missing the channel
// falls back to a hand-rolled scan over the persisted graph's file list. Both
// paths score with the SAME counting function, so the two channels agree about
// what a match is worth; only the speed differs.
//
// The fallback is never silent. `LexicalResult.degraded` is true whenever the
// weaker scanner ran, `reason` says why, and the reason travels into the
// `context_assembled` payload. A retriever that quietly got worse looks exactly
// like a repository that quietly lost a file.
//
// ── SPAWNING: ARGV, NEVER A COMMAND STRING ──────────────────────────────────
//
// The query is untrusted — it comes from a model, a user, or a config file. It is
// handed to `runCommand` (src/verify/runner.ts, `shell: false`) as a single argv
// element, and `--` terminates option parsing so a query of `-e` or `--help` is a
// PATTERN rather than a flag. There is no command string anywhere in this file,
// and there is no second spawn path: the verify runner is the one place this
// package starts a process.
//
// ── FUSION AND DETERMINISM ──────────────────────────────────────────────────
//
// RRF: `score(d) = Σ 1/(k + rank_i(d))` over the channels that returned `d`,
// with `k = RRF_K = 60` and 1-based ranks. Ties are broken in a fixed,
// documented order (see `compareFused` and `compareHits`) because a retriever
// whose output churns between identical runs makes every downstream diff, cache
// and test worthless.
//
// Validates: Requirements 18.2

import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { EventInput } from '../events/store.js'
import { runCommand } from '../verify/runner.js'
import { buildRepoGraph, loadRepoGraph, type GraphChunk, type GraphFile, type RepoGraph } from './repo-graph.js'
import type { Embedder, VectorStore } from './types.js'

/** The two retrieval channels. */
export type ChannelName = 'lexical' | 'vector'

/** Which implementation carried the lexical channel. */
export type LexicalEngine = 'ripgrep' | 'scanner'

/** The RRF constant. Fixed at 60, the value the original paper reports. */
export const RRF_K = 60

/** Default binary name probed for the fast lexical path. */
export const RIPGREP_BINARY = 'rg'

// ── configuration ───────────────────────────────────────────────────────────

export interface SearchConfig {
  /** Run the lexical channel. */
  lexical: boolean
  /** Run the vector channel. */
  vector: boolean
  /** Run the rerank pass over the fused candidates. */
  rerank: boolean
  /** RRF constant. */
  rrfK: number
}

/**
 * THE SHIPPED DEFAULT. Both channels on, rerank on.
 *
 * `lexical: false` here would make the product vector-only, which Requirement
 * 18.2 forbids outright. `search.guard.test.ts` fails if this object ever
 * resolves to vector-only.
 */
export const DEFAULT_SEARCH_CONFIG: Readonly<SearchConfig> = Object.freeze({
  lexical: true,
  vector: true,
  rerank: true,
  rrfK: RRF_K,
})

/** Merge a caller's overrides onto the shipped default. */
export function resolveSearchConfig(partial: Partial<SearchConfig> = {}): SearchConfig {
  const merged = { ...DEFAULT_SEARCH_CONFIG, ...partial }
  return {
    lexical: merged.lexical,
    vector: merged.vector,
    rerank: merged.rerank,
    // A k below 1 would make rank 0 divide by zero once ranks are 0-based
    // anywhere downstream; clamp rather than trust.
    rrfK: Math.max(1, Math.floor(merged.rrfK)),
  }
}

/**
 * True when a configuration would retrieve with embeddings alone.
 *
 * Callers may pass `{ lexical: false }` deliberately — the vector-only path has
 * to remain *reachable* so a test can demonstrate how much worse it is. What
 * must never happen is it being the default, or being reached silently: an
 * explicitly vector-only run is reported as such in `HybridSearchResult`.
 */
export function isVectorOnly(config: SearchConfig): boolean {
  return config.vector && !config.lexical
}

// ── ripgrep detection ───────────────────────────────────────────────────────

export interface RipgrepProbe {
  available: boolean
  version: string | null
  /** Why it is unavailable. Null when it is available. */
  reason: string | null
}

/** Detect once per binary name; searching should not re-probe on every query. */
const probeCache = new Map<string, RipgrepProbe>()

/** Clear the detection cache. Tests use this; nothing else should need it. */
export function resetRipgrepDetection(): void {
  probeCache.clear()
}

/**
 * Is ripgrep runnable? Spawned through the verify runner like everything else,
 * with a short timeout: a probe that hangs is a probe that never answers.
 */
export async function detectRipgrep(
  opts: { binary?: string; cwd?: string; timeoutMs?: number } = {}
): Promise<RipgrepProbe> {
  const binary = opts.binary ?? RIPGREP_BINARY
  const cached = probeCache.get(binary)
  if (cached !== undefined) return cached

  const result = await runCommand(
    { name: 'ripgrep-probe', cmd: binary, args: ['--version'], cwd: opts.cwd, timeoutMs: opts.timeoutMs ?? 5_000 },
    {}
  )

  const probe: RipgrepProbe = result.ok
    ? { available: true, version: result.stdout.split('\n')[0]?.trim() ?? null, reason: null }
    : {
        available: false,
        version: null,
        reason: `'${binary}' is not runnable (exit ${result.exitCode})`,
      }

  probeCache.set(binary, probe)
  return probe
}

// ── lexical channel ─────────────────────────────────────────────────────────

export interface LexicalHit {
  /** `${path}#${chunkIndex}` — the same id the chunker and vector store use. */
  id: string
  path: string
  chunkIndex: number
  startLine: number
  endLine: number
  /** Occurrences of the query inside this chunk. */
  matches: number
  /** Occurrences that sit on an identifier boundary. Weighted higher. */
  exactMatches: number
  /** Lines in this chunk that matched. */
  matchLines: number
  /** `3 * exactMatches + 1 * (matches - exactMatches)`. */
  score: number
  /** Lowest matching line number, 0-based like the chunker's `startLine`. */
  firstLine: number
  /** The first matching line, clipped. Evidence, not decoration. */
  preview: string
  /** True when some matching line looks like a definition of the query. */
  definition: boolean
}

export interface LexicalResult {
  engine: LexicalEngine
  hits: LexicalHit[]
  /** True when the weaker scanner ran instead of ripgrep. */
  degraded: boolean
  /** Why the scanner ran, or why ripgrep's output was incomplete. */
  reason: string | null
  filesScanned: number
  /** True when a cap stopped the search early. */
  truncated: boolean
}

export interface LexicalSearchOptions {
  root: string
  query: string
  /** The universe of files. Both engines are restricted to exactly this list. */
  graph: RepoGraph
  ignoreCase?: boolean
  /** Binary name to probe. Point it at nothing to force the fallback. */
  binary?: string
  /** Set false to skip detection entirely and scan. */
  preferRipgrep?: boolean
  maxHits?: number
  maxFilesScanned?: number
  signal?: AbortSignal
}

/** Matches reported per file. Beyond this a single file drowns the results. */
export const MAX_MATCHES_PER_FILE = 50
/** Chunks a single lexical search will return. */
export const MAX_LEXICAL_HITS = 200
/** Files the scanner will open. A big repo is not a reason to read all of it. */
export const MAX_SCANNED_FILES = 2_000
/** Longest preview line kept. */
const PREVIEW_CHARS = 240

/**
 * The exact argv handed to ripgrep, minus the program name.
 *
 * Exported so a test can assert the two properties that matter: the query is one
 * argv ELEMENT (never spliced into a string), and `--` precedes it so option
 * parsing has already stopped by the time ripgrep reads it.
 */
export function ripgrepArgs(
  query: string,
  opts: { ignoreCase?: boolean; maxCountPerFile?: number } = {}
): string[] {
  return [
    // A user's `RIPGREP_CONFIG_PATH` must not change what this repository's
    // retriever returns.
    '--no-config',
    '--no-heading',
    '--with-filename',
    '--line-number',
    '--color',
    'never',
    // Literal, not regex: the query is an identifier, and a stray `(` from a
    // model would otherwise be a syntax error instead of a search.
    '--fixed-strings',
    opts.ignoreCase === true ? '--ignore-case' : '--case-sensitive',
    '--max-count',
    String(opts.maxCountPerFile ?? MAX_MATCHES_PER_FILE),
    '--max-filesize',
    '1M',
    // END OF OPTIONS. Everything after this is positional, which is what makes a
    // query of `-e`, `--help` or `-rf` a pattern instead of a flag.
    '--',
    query,
    '.',
  ]
}

/** Identifier characters, for boundary detection. */
function isWordChar(ch: string | undefined): boolean {
  if (ch === undefined) return false
  return (ch >= 'a' && ch <= 'z') || (ch >= 'A' && ch <= 'Z') || (ch >= '0' && ch <= '9') || ch === '_' || ch === '$'
}

/**
 * Count occurrences of `query` in `line`, and how many of those sit on an
 * identifier boundary.
 *
 * Both engines call this, so `rg` and the scanner cannot disagree about a
 * match's worth. Boundary-aware counting is what separates `budget` inside
 * `retryBudgetMs` from a real reference to `budget`.
 */
export function countMatches(
  line: string,
  query: string,
  ignoreCase = false
): { matches: number; exact: number } {
  if (query === '') return { matches: 0, exact: 0 }
  const hay = ignoreCase ? line.toLowerCase() : line
  const needle = ignoreCase ? query.toLowerCase() : query

  let matches = 0
  let exact = 0
  let from = 0
  for (;;) {
    const at = hay.indexOf(needle, from)
    if (at === -1) break
    matches++
    const before = at === 0 ? undefined : hay[at - 1]
    const after = hay[at + needle.length]
    if (!isWordChar(before) && !isWordChar(after)) exact++
    from = at + needle.length
  }
  return { matches, exact }
}

/**
 * Does this line look like it DEFINES the query, rather than mentioning it?
 *
 * Deliberately a shallow lexical test — no parser, no tree-sitter — covering the
 * declaration keywords of the languages the walker indexes, plus the bare
 * `name(...)` / `name =` / `name:` forms. Used only as a rerank signal, so a
 * false negative costs a little ordering and never a missing result.
 */
export function looksLikeDefinition(line: string, query: string): boolean {
  const idx = line.indexOf(query)
  if (idx === -1) return false
  const before = line.slice(0, idx)
  const after = line.slice(idx + query.length)

  if (/\b(function|class|interface|type|enum|struct|impl|trait|def|fn|const|let|var|export|public|private|protected|static|async)\b[^=]*$/.test(before)) {
    return true
  }
  // `name(` at the head of a line is a definition in most C-family languages,
  // and `name =` / `name:` covers assignment and object/record members.
  if (before.trim() === '' && /^\s*[(:=]/.test(after)) return true
  return false
}

/**
 * The chunk a matching line belongs to.
 *
 * Chunks overlap by design (the chunker keeps 200 chars of context), so a line
 * can fall in two. The LOWEST containing index wins — an arbitrary rule, but a
 * fixed one, and a fixed rule is what keeps ids stable across runs.
 */
export function chunkForLine(file: GraphFile, line: number): GraphChunk | null {
  if (file.chunks.length === 0) return null
  for (const chunk of file.chunks) {
    if (line >= chunk.startLine && line <= chunk.endLine) return chunk
  }
  // Off the end (a file that grew since the graph was built): attribute to the
  // last chunk that starts at or before the line rather than lose the hit.
  let best = file.chunks[0]!
  for (const chunk of file.chunks) {
    if (chunk.startLine <= line) best = chunk
  }
  return best
}

interface HitAccumulator {
  file: GraphFile
  chunk: GraphChunk
  matches: number
  exactMatches: number
  matchLines: number
  firstLine: number
  preview: string
  definition: boolean
}

function accumulate(
  acc: Map<string, HitAccumulator>,
  file: GraphFile,
  line: number,
  text: string,
  query: string,
  ignoreCase: boolean
): void {
  const counted = countMatches(text, query, ignoreCase)
  if (counted.matches === 0) return
  const chunk = chunkForLine(file, line)
  if (chunk === null) return

  const id = `${file.path}#${chunk.index}`
  const existing = acc.get(id)
  const definition = looksLikeDefinition(text, query)

  if (existing === undefined) {
    acc.set(id, {
      file,
      chunk,
      matches: counted.matches,
      exactMatches: counted.exact,
      matchLines: 1,
      firstLine: line,
      preview: text.slice(0, PREVIEW_CHARS),
      definition,
    })
    return
  }

  existing.matches += counted.matches
  existing.exactMatches += counted.exact
  existing.matchLines += 1
  existing.definition = existing.definition || definition
  if (line < existing.firstLine) {
    existing.firstLine = line
    existing.preview = text.slice(0, PREVIEW_CHARS)
  }
}

/**
 * Lexical score: `3 * exact + 1 * loose`.
 *
 * Hand-rolled on purpose. `packages/core` has zero runtime dependencies, so
 * there is no BM25 package to reach for; and for the query this channel actually
 * exists to serve — one exact identifier — term saturation and document-length
 * normalisation would change almost nothing while adding a dependency and a
 * pile of tuning constants.
 */
function lexicalScore(matches: number, exact: number): number {
  return 3 * exact + (matches - exact)
}

/**
 * Deterministic order for lexical hits: score, then definition-ness, then path,
 * then chunk index. Never insertion order — the scanner and ripgrep discover
 * files in different orders and must still rank identically.
 */
function compareHits(a: LexicalHit, b: LexicalHit): number {
  if (b.score !== a.score) return b.score - a.score
  if (a.definition !== b.definition) return a.definition ? -1 : 1
  if (a.path !== b.path) return a.path < b.path ? -1 : 1
  return a.chunkIndex - b.chunkIndex
}

function finishHits(acc: Map<string, HitAccumulator>, maxHits: number): { hits: LexicalHit[]; truncated: boolean } {
  const hits: LexicalHit[] = []
  for (const [id, entry] of acc) {
    hits.push({
      id,
      path: entry.file.path,
      chunkIndex: entry.chunk.index,
      startLine: entry.chunk.startLine,
      endLine: entry.chunk.endLine,
      matches: entry.matches,
      exactMatches: entry.exactMatches,
      matchLines: entry.matchLines,
      score: lexicalScore(entry.matches, entry.exactMatches),
      firstLine: entry.firstLine,
      preview: entry.preview,
      definition: entry.definition,
    })
  }
  hits.sort(compareHits)
  const truncated = hits.length > maxHits
  return { hits: truncated ? hits.slice(0, maxHits) : hits, truncated }
}

/** Project-relative, POSIX separators, no `./` prefix — the graph's spelling. */
function normalizeRipgrepPath(raw: string): string {
  let path = raw.replace(/\\/g, '/')
  while (path.startsWith('./')) path = path.slice(2)
  return path
}

/**
 * Parse one `path:line:text` record.
 *
 * A path can itself contain a colon, so every `:<digits>:` boundary is tried and
 * the first one whose prefix is a KNOWN file wins. Falling back to the first
 * boundary keeps a hit from being dropped when the graph and the working tree
 * have drifted.
 */
export function parseRipgrepLine(
  raw: string,
  known: (path: string) => boolean
): { path: string; line: number; text: string } | null {
  if (raw === '') return null
  const pattern = /:(\d+):/g
  let fallback: { path: string; line: number; text: string } | null = null

  for (let m = pattern.exec(raw); m !== null; m = pattern.exec(raw)) {
    const path = normalizeRipgrepPath(raw.slice(0, m.index))
    const lineNo = Number.parseInt(m[1]!, 10)
    if (path === '' || !Number.isFinite(lineNo)) continue
    // ripgrep counts lines from 1; the chunker counts from 0.
    const candidate = { path, line: lineNo - 1, text: raw.slice(m.index + m[0].length) }
    if (known(path)) return candidate
    if (fallback === null) fallback = candidate
  }
  return fallback
}

async function ripgrepSearch(
  options: LexicalSearchOptions,
  byPath: Map<string, GraphFile>
): Promise<{ result: LexicalResult } | { failure: string }> {
  const ignoreCase = options.ignoreCase === true
  const command = {
    name: 'lexical-search',
    cmd: options.binary ?? RIPGREP_BINARY,
    // The query travels as ONE element of this array. There is no string here to
    // interpolate it into, which is the whole point.
    args: ripgrepArgs(options.query, { ignoreCase }),
    cwd: options.root,
    timeoutMs: 20_000,
  }

  const run = await runCommand(command, { signal: options.signal })

  // ripgrep: 0 = matches, 1 = no matches, 2+ = a real error.
  if (run.exitCode !== 0 && run.exitCode !== 1) {
    const detail = run.stderr.trim()
    return { failure: detail === '' ? `ripgrep exited with ${run.exitCode}` : detail }
  }

  const acc = new Map<string, HitAccumulator>()
  const files = new Set<string>()
  for (const raw of run.stdout.split('\n')) {
    const parsed = parseRipgrepLine(raw.replace(/\r$/, ''), path => byPath.has(path))
    if (parsed === null) continue
    const file = byPath.get(parsed.path)
    // Restrict to the graph's file list so both engines see one universe: the
    // walker already applied `.gitignore`, the skip list and the size cap.
    if (file === undefined) continue
    files.add(file.path)
    accumulate(acc, file, parsed.line, parsed.text, options.query, ignoreCase)
  }

  const { hits, truncated } = finishHits(acc, options.maxHits ?? MAX_LEXICAL_HITS)
  return {
    result: {
      engine: 'ripgrep',
      hits,
      degraded: false,
      reason: null,
      filesScanned: files.size,
      truncated,
    },
  }
}

async function scannerSearch(
  options: LexicalSearchOptions,
  reason: string
): Promise<LexicalResult> {
  const ignoreCase = options.ignoreCase === true
  const limit = options.maxFilesScanned ?? MAX_SCANNED_FILES
  const acc = new Map<string, HitAccumulator>()
  let scanned = 0
  let truncated = false

  for (const file of options.graph.files) {
    if (options.signal?.aborted === true) {
      truncated = true
      break
    }
    if (scanned >= limit) {
      truncated = true
      break
    }
    scanned++

    let content: string
    try {
      content = await readFile(join(options.root, file.path), 'utf8')
    } catch {
      // Indexed, gone now. One unreadable file is not a reason to fail a search.
      continue
    }

    const lines = content.split('\n')
    let perFile = 0
    for (let i = 0; i < lines.length; i++) {
      const text = lines[i]!.replace(/\r$/, '')
      if (!hasMatch(text, options.query, ignoreCase)) continue
      accumulate(acc, file, i, text, options.query, ignoreCase)
      if (++perFile >= MAX_MATCHES_PER_FILE) break
    }
  }

  const { hits, truncated: overflow } = finishHits(acc, options.maxHits ?? MAX_LEXICAL_HITS)
  return {
    engine: 'scanner',
    hits,
    degraded: true,
    reason,
    filesScanned: scanned,
    truncated: truncated || overflow,
  }
}

function hasMatch(line: string, query: string, ignoreCase: boolean): boolean {
  if (query === '') return false
  return ignoreCase
    ? line.toLowerCase().includes(query.toLowerCase())
    : line.includes(query)
}

/**
 * The lexical channel. ripgrep when it is there, the scanner when it is not, and
 * it always says which one ran.
 */
export async function lexicalSearch(options: LexicalSearchOptions): Promise<LexicalResult> {
  if (options.query.trim() === '') {
    return { engine: 'scanner', hits: [], degraded: false, reason: 'empty query', filesScanned: 0, truncated: false }
  }

  const byPath = new Map<string, GraphFile>()
  for (const file of options.graph.files) byPath.set(file.path, file)

  if (options.preferRipgrep === false) {
    return scannerSearch(options, 'ripgrep skipped by configuration')
  }

  const probe = await detectRipgrep({ binary: options.binary, cwd: options.root })
  if (!probe.available) {
    return scannerSearch(options, `${probe.reason}; scanning the indexed file list instead`)
  }

  const attempt = await ripgrepSearch(options, byPath)
  if ('failure' in attempt) {
    return scannerSearch(options, `ripgrep failed: ${attempt.failure}; scanning the indexed file list instead`)
  }
  return attempt.result
}

// ── vector channel ──────────────────────────────────────────────────────────

export interface VectorChannel {
  embedder: Embedder
  store: VectorStore
}

export interface VectorHit {
  id: string
  path: string
  chunkIndex: number
  startLine: number
  endLine: number
  score: number
  content: string
}

/**
 * Nearest neighbours for the query.
 *
 * Re-sorted here rather than trusting the store's order: two chunks with an
 * identical cosine must not swap places because of map insertion order.
 */
export async function vectorSearch(
  channel: VectorChannel,
  query: string,
  topK: number
): Promise<VectorHit[]> {
  const [vector] = await channel.embedder.embed([query])
  if (vector === undefined) return []
  const results = await channel.store.search(vector, topK)
  const hits = results.map(r => ({
    id: r.chunk.id,
    path: r.chunk.path,
    chunkIndex: r.chunk.index,
    startLine: r.chunk.startLine,
    endLine: r.chunk.endLine,
    score: r.score,
    content: r.chunk.content,
  }))
  hits.sort((a, b) => (b.score !== a.score ? b.score - a.score : a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return hits.slice(0, topK)
}

// ── reciprocal rank fusion ──────────────────────────────────────────────────

export interface RankedItem {
  id: string
  path: string
  chunkIndex: number
  startLine: number
  endLine: number
}

export interface RankedList {
  channel: ChannelName
  /** Already in this channel's own order; position 0 is rank 1. */
  items: RankedItem[]
}

export interface FusedCandidate extends RankedItem {
  /** 1-based rank per channel that returned this candidate. */
  ranks: Partial<Record<ChannelName, number>>
  channels: ChannelName[]
  /** `Σ 1/(k + rank_i)`. */
  rrf: number
  /** The best (numerically lowest) rank across channels. First tie-break. */
  bestRank: number
}

/**
 * Tie-break order, in full, because "sorted by score" is not a specification:
 *
 *   1. higher RRF score
 *   2. better single-channel rank — one channel's #1 beats two channels' #40s
 *      when the arithmetic happens to coincide
 *   3. path, ascending, byte order (never `localeCompare`: that varies by host
 *      locale and would make ordering machine-dependent)
 *   4. chunk index, ascending
 *
 * (3) and (4) together are total: no two candidates share a path AND a chunk
 * index, because that pair IS the id. So the order never depends on the order
 * the candidates arrived in.
 */
export function compareFused(a: FusedCandidate, b: FusedCandidate): number {
  if (b.rrf !== a.rrf) return b.rrf - a.rrf
  if (a.bestRank !== b.bestRank) return a.bestRank - b.bestRank
  if (a.path !== b.path) return a.path < b.path ? -1 : 1
  return a.chunkIndex - b.chunkIndex
}

/** Fuse ranked lists by reciprocal rank. `score(d) = Σ 1/(k + rank_i(d))`. */
export function reciprocalRankFusion(lists: readonly RankedList[], k: number = RRF_K): FusedCandidate[] {
  const merged = new Map<string, FusedCandidate>()

  for (const list of lists) {
    for (let i = 0; i < list.items.length; i++) {
      const item = list.items[i]!
      const rank = i + 1
      const contribution = 1 / (k + rank)

      const existing = merged.get(item.id)
      if (existing === undefined) {
        merged.set(item.id, {
          id: item.id,
          path: item.path,
          chunkIndex: item.chunkIndex,
          startLine: item.startLine,
          endLine: item.endLine,
          ranks: { [list.channel]: rank },
          channels: [list.channel],
          rrf: contribution,
          bestRank: rank,
        })
        continue
      }

      // A channel listing the same id twice would double-count it.
      if (existing.ranks[list.channel] !== undefined) continue
      existing.ranks[list.channel] = rank
      existing.channels.push(list.channel)
      existing.rrf += contribution
      existing.bestRank = Math.min(existing.bestRank, rank)
    }
  }

  const fused = [...merged.values()]
  for (const candidate of fused) candidate.channels.sort()
  fused.sort(compareFused)
  return fused
}

// ── rerank ──────────────────────────────────────────────────────────────────

/** Weights of the rerank signals. They sum to `MAX_RERANK_BOOST`. */
export const RERANK_WEIGHTS = Object.freeze({
  /** A matching line that declares the query rather than mentioning it. */
  definition: 0.5,
  /** Both channels found it. Independent agreement is the strongest cheap signal. */
  agreement: 0.2,
  /** Per identifier-boundary occurrence, up to four. */
  exactMatch: 0.05,
  /** The query appears in the file path. */
  pathMatch: 0.1,
})

/** Rerank can at most double a fused score. See `rerankScore`. */
export const MAX_RERANK_BOOST = 1

export interface HybridHit extends RankedItem {
  channels: ChannelName[]
  ranks: Partial<Record<ChannelName, number>>
  /** Fused score before reranking. */
  rrfScore: number
  /** `rrf * (1 + boost)`. Equal to `rrfScore` when rerank is off. */
  score: number
  /** The boost applied, for explainability. Zero when rerank is off. */
  boost: number
  /** The first matching line, when the lexical channel found this chunk. */
  preview: string
  definition: boolean
}

/**
 * MULTIPLICATIVE, and capped: `score = rrf * (1 + boost)` with `boost <= 1`.
 *
 * That is the deliberate design. An additive rerank on a different scale to RRF
 * (whose maximum here is 2/61 ≈ 0.033) would drown the fusion entirely and turn
 * this into a keyword heuristic wearing fusion's clothes. Capping the multiplier
 * at 2× means the rerank REORDERS a neighbourhood — it cannot lift a candidate
 * that both channels ranked 50th above one they both ranked 1st.
 */
export function rerankScore(rrf: number, boost: number): number {
  return rrf * (1 + Math.min(boost, MAX_RERANK_BOOST))
}

function boostFor(
  candidate: FusedCandidate,
  lexical: LexicalHit | undefined,
  query: string
): number {
  let boost = 0
  if (lexical?.definition === true) boost += RERANK_WEIGHTS.definition
  if (candidate.channels.length > 1) boost += RERANK_WEIGHTS.agreement
  if (lexical !== undefined) boost += RERANK_WEIGHTS.exactMatch * Math.min(lexical.exactMatches, 4)
  if (query !== '' && candidate.path.includes(query)) boost += RERANK_WEIGHTS.pathMatch
  return boost
}

/**
 * Rerank the fused candidates.
 *
 * Same tie-break discipline as fusion: score, then the fused score, then path,
 * then chunk index. Nothing here reads insertion order.
 */
export function rerank(
  candidates: readonly FusedCandidate[],
  lexicalById: Map<string, LexicalHit>,
  query: string,
  enabled = true
): HybridHit[] {
  const hits: HybridHit[] = candidates.map(candidate => {
    const lexical = lexicalById.get(candidate.id)
    const boost = enabled ? boostFor(candidate, lexical, query) : 0
    return {
      id: candidate.id,
      path: candidate.path,
      chunkIndex: candidate.chunkIndex,
      startLine: candidate.startLine,
      endLine: candidate.endLine,
      channels: [...candidate.channels],
      ranks: { ...candidate.ranks },
      rrfScore: candidate.rrf,
      score: enabled ? rerankScore(candidate.rrf, boost) : candidate.rrf,
      boost: Math.min(boost, MAX_RERANK_BOOST),
      preview: lexical?.preview ?? '',
      definition: lexical?.definition ?? false,
    }
  })

  hits.sort((a, b) => {
    if (b.score !== a.score) return b.score - a.score
    if (b.rrfScore !== a.rrfScore) return b.rrfScore - a.rrfScore
    if (a.path !== b.path) return a.path < b.path ? -1 : 1
    return a.chunkIndex - b.chunkIndex
  })
  return hits
}

// ── the whole thing ─────────────────────────────────────────────────────────

export interface ChannelReport {
  channel: ChannelName
  ran: boolean
  /** `ripgrep` / `scanner` for lexical, `vector-store` for vector. */
  engine: string | null
  hits: number
  /** True when this channel ran weaker than its preferred implementation. */
  degraded: boolean
  reason: string | null
}

export interface HybridSearchOptions {
  root: string
  query: string
  /** Where `.sketch/` lives. Defaults to `root`. */
  baseDir?: string
  /** Omitted loads the persisted graph; null forces a fresh, unpersisted build. */
  graph?: RepoGraph | null
  config?: Partial<SearchConfig>
  /** The vector channel's collaborators. Absent means the channel cannot run. */
  vector?: VectorChannel
  topK?: number
  ignoreCase?: boolean
  /** Binary probed for the fast lexical path. */
  ripgrepBinary?: string
  preferRipgrep?: boolean
  events?: { emit(event: EventInput): Promise<void> | void }
  runId?: string
  signal?: AbortSignal
}

export interface HybridSearchResult {
  hits: HybridHit[]
  config: SearchConfig
  channels: ChannelReport[]
  /** Which engine carried the lexical channel, when it ran. */
  lexicalEngine: LexicalEngine | null
  /** True when this run retrieved with embeddings alone. Never the default. */
  vectorOnly: boolean
  /** True when any channel ran weaker than intended, or could not run. */
  degraded: boolean
  reranked: boolean
  /** Candidates that survived fusion, before top-k. */
  fusedCount: number
}

export const DEFAULT_TOP_K = 12

/**
 * Retrieve. Hybrid by default (Requirement 18.2).
 *
 * The event is `context_assembled` carrying `component: "hybrid-search"`. There
 * is no retrieval EventKind in the contract and inventing one is not allowed, so
 * the payload carries the discriminator and the gap is recorded in the handoff.
 */
export async function hybridSearch(options: HybridSearchOptions): Promise<HybridSearchResult> {
  const config = resolveSearchConfig(options.config)
  const topK = Math.max(1, options.topK ?? DEFAULT_TOP_K)
  const baseDir = options.baseDir ?? options.root
  const graph = await resolveGraph(options, baseDir)

  const channels: ChannelReport[] = []
  const lists: RankedList[] = []
  const lexicalById = new Map<string, LexicalHit>()
  let lexicalEngine: LexicalEngine | null = null

  if (config.lexical) {
    const result = await lexicalSearch({
      root: options.root,
      query: options.query,
      graph,
      ignoreCase: options.ignoreCase,
      binary: options.ripgrepBinary,
      preferRipgrep: options.preferRipgrep,
      signal: options.signal,
    })
    lexicalEngine = result.engine
    for (const hit of result.hits) lexicalById.set(hit.id, hit)
    lists.push({ channel: 'lexical', items: result.hits.map(toRankedItem) })
    channels.push({
      channel: 'lexical',
      ran: true,
      engine: result.engine,
      hits: result.hits.length,
      degraded: result.degraded,
      reason: result.reason,
    })
  } else {
    channels.push({
      channel: 'lexical',
      ran: false,
      engine: null,
      hits: 0,
      // Disabling the lexical channel is a downgrade, and it is reported as one
      // even when a caller asked for it.
      degraded: true,
      reason: 'lexical channel disabled by configuration',
    })
  }

  if (config.vector && options.vector !== undefined) {
    const hits = await vectorSearch(options.vector, options.query, Math.max(topK, DEFAULT_TOP_K))
    lists.push({ channel: 'vector', items: hits.map(toRankedItem) })
    channels.push({
      channel: 'vector',
      ran: true,
      engine: 'vector-store',
      hits: hits.length,
      degraded: false,
      reason: null,
    })
  } else {
    channels.push({
      channel: 'vector',
      ran: false,
      engine: null,
      hits: 0,
      degraded: true,
      reason: config.vector
        ? 'no embedder or vector store supplied'
        : 'vector channel disabled by configuration',
    })
  }

  const fused = reciprocalRankFusion(lists, config.rrfK)
  const ranked = rerank(fused, lexicalById, options.query, config.rerank)
  const hits = ranked.slice(0, topK)

  const result: HybridSearchResult = {
    hits,
    config,
    channels,
    lexicalEngine,
    vectorOnly: isVectorOnly(config),
    degraded: channels.some(c => c.degraded),
    reranked: config.rerank,
    fusedCount: fused.length,
  }

  await options.events?.emit({
    runId: options.runId ?? 'search',
    kind: 'context_assembled',
    payload: {
      component: 'hybrid-search',
      // WHICH CHANNEL RAN. The point of the payload: a degraded retriever must be
      // visible in the log, not inferred from disappointing results.
      channels: channels.map(c => ({
        channel: c.channel,
        ran: c.ran,
        engine: c.engine,
        hits: c.hits,
        degraded: c.degraded,
        reason: c.reason,
      })),
      lexicalEngine,
      vectorOnly: result.vectorOnly,
      degraded: result.degraded,
      reranked: result.reranked,
      rrfK: config.rrfK,
      fused: fused.length,
      returned: hits.length,
      paths: [...new Set(hits.map(h => h.path))],
      // The query itself is not logged: it can carry whatever the user typed.
      queryLength: options.query.length,
    },
  })

  return result
}

function toRankedItem(hit: LexicalHit | VectorHit): RankedItem {
  return {
    id: hit.id,
    path: hit.path,
    chunkIndex: hit.chunkIndex,
    startLine: hit.startLine,
    endLine: hit.endLine,
  }
}

/**
 * The file universe. A persisted graph is preferred; if there is none, one is
 * built on demand and NOT persisted, because a search should not silently write
 * an index the caller never asked for.
 */
async function resolveGraph(options: HybridSearchOptions, baseDir: string): Promise<RepoGraph> {
  if (options.graph !== undefined && options.graph !== null) return options.graph
  if (options.graph === undefined) {
    const persisted = await loadRepoGraph(baseDir)
    if (persisted !== null) return persisted
  }
  const built = await buildRepoGraph({ root: options.root, baseDir, previous: null, persist: false })
  return built.graph
}
