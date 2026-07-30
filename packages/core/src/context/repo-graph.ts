// The persisted repository graph — `<project>/.sketch/index/graph.json`.
//
// This is the one place the pre-existing context modules are composed into a
// durable artifact: `walkProject` decides what files exist and hashes them,
// `chunkFile` cuts each file into retrievable spans, and the dependency-graph
// extractor turns imports into edges. Nothing here re-implements any of the
// three; a second walker or a second import parser is how two indexes start
// disagreeing about the same repository.
//
// ── INCREMENTAL BY CONTENT HASH ──────────────────────────────────────────────
//
// The walk hashes every file's bytes (that is unavoidable — a hash is how you
// know something changed). Everything *after* the hash is skipped for a file
// whose hash matches the persisted graph: no re-read of the content for
// chunking, no re-chunk, no re-parse of imports. `RepoGraphStats` counts the
// work actually performed (`chunked`, `parsed`, `reused`), so "the skip
// happened" is an assertion a test can make about behaviour rather than a guess
// from identical output.
//
// Two invalidation rules differ and are treated differently:
//   * CHUNKS and SPECIFIERS depend only on a file's own bytes → cached, reused
//     verbatim while the hash holds.
//   * RESOLVED IMPORTS depend on the whole file set → recomputed every build
//     from the cached specifiers. Adding `src/b.ts` must make `./b` in an
//     untouched `src/a.ts` resolve, and deleting it must make the edge vanish.
//     Resolution is pure string work over an in-memory set, so this costs
//     nothing and removes the entire class of stale-edge bugs.
//
// A file that disappeared from the tree leaves the graph entirely — otherwise
// search keeps returning paths that no longer exist, forever.
//
// ── DETERMINISM ──────────────────────────────────────────────────────────────
//
// For a fixed tree, `graph.json` is byte-identical across rebuilds: every array
// is sorted, keys are written in a fixed order, no timestamp and no absolute
// path is stored, and the walk itself is order-stable. A graph that churns makes
// its own diff useless and makes every downstream test flaky.
//
// Validates: Requirements 18.1

import { mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import type { EventInput } from '../events/store.js'
import { ensureStateDir } from '../workspace/state-dir.js'
import { chunkFile, type ChunkOptions } from './chunker.js'
import { extractImportSpecifiers, resolveImportSpecifier } from './dependency-graph.js'
import { walkProjectDetailed, DEFAULT_MAX_FILES, type WalkedFile } from './walker.js'

/** Bumped whenever the persisted shape changes; a mismatch forces a full rebuild. */
export const GRAPH_VERSION = 1

/** `<baseDir>/.sketch/index/graph.json`, per the `.sketch/` layout. */
export function graphPath(baseDir: string): string {
  return join(baseDir, '.sketch', 'index', 'graph.json')
}

/** A retrievable span of a file. Content is not persisted — the file is the store. */
export interface GraphChunk {
  index: number
  startLine: number
  endLine: number
  chars: number
}

export interface GraphFile {
  /** Project-relative, POSIX separators. */
  path: string
  size: number
  /** Content hash from the walk. The incremental key. */
  hash: string
  extension: string
  chunks: GraphChunk[]
  /** Raw import specifiers as written in the source, sorted and deduplicated. */
  specifiers: string[]
  /** Specifiers resolved to project-relative paths, sorted. External deps drop out. */
  imports: string[]
}

export interface RepoGraph {
  version: number
  fileCount: number
  chunkCount: number
  /** The cap in force when this graph was built. */
  maxFiles: number
  /** True when the cap stopped the walk before the tree was exhausted. */
  truncated: boolean
  files: GraphFile[]
}

/** What the build actually did. The evidence for the incremental claim. */
export interface RepoGraphStats {
  /** Files the walk returned. */
  walked: number
  /** Files in the resulting graph. */
  indexed: number
  /** New files, chunked and parsed for the first time. */
  added: number
  /** Files whose hash moved, re-chunked and re-parsed. */
  changed: number
  /** Files whose hash held: content not re-read, not re-chunked, not re-parsed. */
  reused: number
  /** Files in the previous graph that no longer exist. */
  removed: number
  /** `chunkFile` calls. Counted at the call site, not inferred. */
  chunked: number
  /** Import-extraction calls. Counted at the call site, not inferred. */
  parsed: number
  /** File reads performed by the indexer itself, beyond the walk's hashing. */
  contentReads: number
  chunks: number
  truncated: boolean
}

export interface BuildRepoGraphOptions {
  /** Project root to walk. */
  root: string
  /** Where `.sketch/` lives. Defaults to `root`. */
  baseDir?: string
  /**
   * Previous graph to build incrementally from. Omitted means "load the
   * persisted one"; `null` forces a full rebuild.
   */
  previous?: RepoGraph | null
  /** File cap. Defaults to the walker's `DEFAULT_MAX_FILES`. */
  maxFiles?: number
  /** Passed straight to `chunkFile`. */
  chunk?: ChunkOptions
  /** Write `graph.json`. Default true. */
  persist?: boolean
  /** Optional event sink; see the note on `kind` below. */
  events?: { emit(event: EventInput): Promise<void> | void }
  runId?: string
}

export interface RepoGraphBuildResult {
  graph: RepoGraph
  stats: RepoGraphStats
  /** Where the graph was (or would be) persisted. */
  path: string
}

/**
 * Read the persisted graph. Returns null when it is absent, unparseable, or
 * from a different version — every one of those means "rebuild from scratch",
 * which is always safe. A corrupt index must never be fatal.
 */
export async function loadRepoGraph(baseDir: string): Promise<RepoGraph | null> {
  let text: string
  try {
    text = await readFile(graphPath(baseDir), 'utf8')
  } catch {
    return null
  }

  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return null
  }
  return isRepoGraph(parsed) ? parsed : null
}

/**
 * Serialize deterministically and write. `JSON.stringify` preserves insertion
 * order, and `normalizeGraph` fixes that order, so the bytes are a pure
 * function of the graph.
 */
export async function saveRepoGraph(baseDir: string, graph: RepoGraph): Promise<string> {
  const target = graphPath(baseDir)
  // `.sketch/` gets its self-ignore marker before anything lands inside it, so
  // the index never shows up as an untracked change in the user's git status.
  await ensureStateDir(baseDir)
  await mkdir(join(baseDir, '.sketch', 'index'), { recursive: true })
  await writeFile(target, serializeRepoGraph(graph), 'utf8')
  return target
}

/** The exact bytes written to `graph.json`. */
export function serializeRepoGraph(graph: RepoGraph): string {
  return `${JSON.stringify(graph, null, 2)}\n`
}

/**
 * Build (or incrementally rebuild) the repository graph.
 *
 * The event, when a sink is supplied, is `context_loaded` carrying
 * `component: "repo-graph"`. There is no indexing EventKind in the contract and
 * one must not be invented; the discriminator is the documented workaround and
 * the gap is recorded in the handoff.
 */
export async function buildRepoGraph(
  options: BuildRepoGraphOptions
): Promise<RepoGraphBuildResult> {
  const baseDir = options.baseDir ?? options.root
  const maxFiles = options.maxFiles ?? DEFAULT_MAX_FILES
  const previous =
    options.previous === undefined ? await loadRepoGraph(baseDir) : options.previous

  const prior = new Map<string, GraphFile>()
  if (previous !== null && previous.version === GRAPH_VERSION) {
    for (const file of previous.files) prior.set(file.path, file)
  }

  const walk = await walkProjectDetailed(options.root, { maxFiles })
  const stats: RepoGraphStats = {
    walked: walk.files.length,
    indexed: 0,
    added: 0,
    changed: 0,
    reused: 0,
    removed: 0,
    chunked: 0,
    parsed: 0,
    contentReads: 0,
    chunks: 0,
    truncated: walk.truncated,
  }

  const files: GraphFile[] = []
  const seen = new Set<string>()

  for (const walked of walk.files) {
    seen.add(walked.relativePath)
    const cached = prior.get(walked.relativePath)

    if (cached !== undefined && cached.hash === walked.hash) {
      // THE SKIP. No read, no chunk, no parse — the hash is the proof.
      stats.reused++
      files.push({
        ...cached,
        // Trust the walk for the cheap metadata; it just stat'd the file.
        size: walked.size,
        extension: walked.extension,
      })
      continue
    }

    const indexed = await indexFile(walked, options.chunk, stats)
    if (indexed === null) continue
    if (cached === undefined) stats.added++
    else stats.changed++
    files.push(indexed)
  }

  for (const path of prior.keys()) {
    // A file that vanished leaves the graph. Otherwise retrieval returns dead
    // paths for the rest of the index's life.
    if (!seen.has(path)) stats.removed++
  }

  const graph = normalizeGraph(files, maxFiles, walk.truncated)
  stats.indexed = graph.fileCount
  stats.chunks = graph.chunkCount

  const path = graphPath(baseDir)
  if (options.persist !== false) await saveRepoGraph(baseDir, graph)

  await options.events?.emit({
    runId: options.runId ?? 'index',
    kind: 'context_loaded',
    payload: {
      component: 'repo-graph',
      path,
      files: stats.indexed,
      chunks: stats.chunks,
      added: stats.added,
      changed: stats.changed,
      reused: stats.reused,
      removed: stats.removed,
      truncated: stats.truncated,
      maxFiles,
    },
  })

  return { graph, stats, path }
}

/** Read, chunk and parse one changed file. The only expensive path. */
async function indexFile(
  walked: WalkedFile,
  chunkOptions: ChunkOptions | undefined,
  stats: RepoGraphStats
): Promise<GraphFile | null> {
  let content: string
  try {
    stats.contentReads++
    content = await readFile(walked.path, 'utf8')
  } catch {
    // Readable during the walk, gone now. Leave it out rather than fail the build.
    return null
  }

  stats.chunked++
  const chunks = chunkFile(walked.relativePath, content, chunkOptions).map(c => ({
    index: c.index,
    startLine: c.startLine,
    endLine: c.endLine,
    chars: c.content.length,
  }))

  stats.parsed++
  const specifiers = extractImportSpecifiers(walked.relativePath, content)

  return {
    path: walked.relativePath,
    size: walked.size,
    hash: walked.hash,
    extension: walked.extension,
    chunks,
    specifiers: sortedUnique(specifiers),
    imports: [],
  }
}

/**
 * Impose the canonical form: files sorted by path, chunks by index, every array
 * sorted and deduplicated, imports resolved against the final file set, and a
 * fixed key order. Everything downstream — the byte-identical guarantee, the
 * architecture generator's stable diagrams — rests on this function.
 */
function normalizeGraph(files: GraphFile[], maxFiles: number, truncated: boolean): RepoGraph {
  const sorted = [...files].sort((a, b) => comparePaths(a.path, b.path))
  const known = new Set(sorted.map(f => f.path))

  let chunkCount = 0
  const normalized: GraphFile[] = sorted.map(file => {
    const chunks = [...file.chunks].sort((a, b) => a.index - b.index)
    chunkCount += chunks.length

    const resolved = new Set<string>()
    for (const spec of file.specifiers) {
      const target = resolveImportSpecifier(file.path, spec, known)
      if (target !== null) resolved.add(target)
    }

    return {
      path: file.path,
      size: file.size,
      hash: file.hash,
      extension: file.extension,
      chunks: chunks.map(c => ({
        index: c.index,
        startLine: c.startLine,
        endLine: c.endLine,
        chars: c.chars,
      })),
      specifiers: sortedUnique(file.specifiers),
      imports: [...resolved].sort(comparePaths),
    }
  })

  return {
    version: GRAPH_VERSION,
    fileCount: normalized.length,
    chunkCount,
    maxFiles,
    truncated,
    files: normalized,
  }
}

/**
 * Locale-independent ordering. `Array.prototype.sort`'s default and
 * `localeCompare` both vary with the host locale, which would make the bytes
 * machine-dependent.
 */
function comparePaths(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0
}

function sortedUnique(values: readonly string[]): string[] {
  return [...new Set(values)].sort(comparePaths)
}

/** Structural check on a graph read from disk. Anything off means rebuild. */
function isRepoGraph(value: unknown): value is RepoGraph {
  if (typeof value !== 'object' || value === null) return false
  const g = value as Partial<RepoGraph>
  if (g.version !== GRAPH_VERSION) return false
  if (!Array.isArray(g.files)) return false
  return g.files.every(
    f =>
      typeof f === 'object' &&
      f !== null &&
      typeof f.path === 'string' &&
      typeof f.hash === 'string' &&
      Array.isArray(f.chunks) &&
      Array.isArray(f.specifiers)
  )
}
