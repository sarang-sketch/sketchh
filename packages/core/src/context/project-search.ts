// Project text search, as a surface asks for it.
//
// ── WHY THIS IS NOT A SECOND SEARCH ─────────────────────────────────────────
//
// The desktop Search panel used to have its own retriever: `git grep` through the
// Tauri command policy, with a `read_dir`/`read_file` folder walk behind it, and its
// own matcher built on JavaScript regular expressions. The retrieval stack had this
// package's lexical channel. Two engines, two match dialects, two containment
// stories — and the same query over the same file could highlight one thing in the
// panel while the retriever scored another.
//
// So the panel's engine is gone and this module is what replaced it. It adds NO
// matching of its own. It resolves the file universe, calls `lexicalSearch`, and
// reshapes chunk-ranked hits into the file → lines → spans a result list renders.
// Every span it returns came out of `matchSpans`, which is also what the ranking
// counted (see hybrid-search.ts).
//
// ── WHAT ENFORCES THE PROJECT BOUNDARY ──────────────────────────────────────
//
// Three things, in order, and none of them is the caller:
//
//   1. THE UNIVERSE. Hits can only come from files the walker returned for `root`,
//      which means `.gitignore`, the skip list and the size cap have already been
//      applied. `lexicalSearch` drops any path ripgrep reports that is not in that
//      list, so a symlink or a `../` spelling in the output cannot become a hit.
//   2. `containedProjectPath`, below. Every path that survives step 1 is resolved
//      against `root` and refused if it lands outside — an explicit check, so the
//      boundary does not depend on the walker having been careful.
//   3. THE QUERY IS NEVER A PATH. It is one argv element after a `--` terminator
//      (ripgrep) or an `indexOf` needle (the scanner). `../../etc/passwd` as a query
//      searches for that text; it does not read that file.
//
// ── NO EVENT, AND NO WRITE ──────────────────────────────────────────────────
//
// A search is a read, like `git-status`: it emits nothing and appends nothing to the
// run log. When no persisted graph exists the walk happens in memory
// (`persist: false`), so typing in a search box never writes to `.sketch/`.
//
// Validates: Requirements 18.2, 27.4, 27.5

import { stat } from 'node:fs/promises'
import { isAbsolute, relative, resolve, sep } from 'node:path'

import {
  MAX_LEXICAL_HITS,
  lexicalSearch,
  type LexicalEngine,
  type MatchSpan,
} from './hybrid-search.js'
import { buildRepoGraph, graphPath, loadRepoGraph, type RepoGraph } from './repo-graph.js'

/** One rendered match: a 1-based line, its text, and where to highlight. */
export interface ProjectSearchHit {
  /** 1-BASED, the way every editor and `grep` counts. Converted exactly once, here. */
  line: number
  /** The line's text, clipped around the first match. */
  text: string
  /** Offsets into `text`. Non-overlapping, left to right. */
  spans: MatchSpan[]
}

/** One file's matches, in line order. */
export interface ProjectSearchGroup {
  /** Project-relative, POSIX separators — the graph's spelling. */
  path: string
  hits: ProjectSearchHit[]
}

/** Where the searched file list came from. Reported, because it changes coverage. */
export type ProjectSearchUniverse = 'graph' | 'walk'

export interface ProjectSearchResult {
  /** The project, as this call resolved it. */
  root: string
  query: string
  /** What the query was reduced to. A surface explains a miss with this. */
  terms: string[]
  /** `ripgrep` or `scanner`. Never silently swapped. */
  engine: LexicalEngine
  /** True when the weaker scanner ran. */
  degraded: boolean
  /** Why the scanner ran, or why ripgrep's output was incomplete. Null otherwise. */
  reason: string | null
  universe: ProjectSearchUniverse
  /** `<root>/.sketch/index/graph.json`, so a surface can name what it would reuse. */
  graphPath: string
  /** Files in the searched universe. */
  fileCount: number
  filesScanned: number
  /**
   * True when a cap stopped the search early. A truncated empty-looking result and
   * "there are no matches" are different answers and must never share a message.
   */
  truncated: boolean
  hitCount: number
  /** Paths the engine reported that were refused for leaving the project. */
  refused: number
  groups: ProjectSearchGroup[]
}

export interface ProjectSearchOptions {
  root: string
  query: string
  /**
   * Case-sensitive matching. Omitted keeps smart case (a lower-case term folds, a
   * term spelled with capitals does not) — the same rule the retrieval path uses.
   */
  matchCase?: boolean
  /** Keep only identifier-boundary occurrences. */
  wholeWord?: boolean
  maxHits?: number
  /** Supply the universe directly. Omitted resolves it from `root`. */
  graph?: RepoGraph | null
  /** Binary name to probe. Point it at nothing to force the scanner. */
  binary?: string
  /** Set false to skip detection entirely and scan. */
  preferRipgrep?: boolean
  signal?: AbortSignal
}

/**
 * `candidate` as a project-relative POSIX path, or null when it is outside `root`.
 *
 * Refuses a `..` climb, an absolute path elsewhere on the disk, and the root itself
 * (which is a directory, not a result). Exported so the refusal is directly
 * testable rather than only observable through a search that returned nothing.
 */
export function containedProjectPath(root: string, candidate: string): string | null {
  const raw = candidate.trim()
  if (raw === '' || raw.includes('\0')) return null

  const base = resolve(root)
  const absolute = isAbsolute(raw) ? resolve(raw) : resolve(base, raw)
  const rel = relative(base, absolute)
  if (rel === '' || rel.startsWith('..') || isAbsolute(rel)) return null
  return rel.split(sep).join('/')
}

/**
 * Fail loudly when `root` is not a directory this process can read.
 *
 * THE WALKER CANNOT DO THIS FOR US. It swallows a `readdir` failure by design —
 * one unreadable subdirectory must not fail a whole index — so a root that does not
 * exist, or that permission denies, produces an EMPTY FILE LIST rather than an
 * error. Handed to a search surface unchecked, that renders as "no matches", which
 * tells the user their word is not in their project when the truth is that nothing
 * was searched at all. The panel's deleted implementation reported this ("Cannot
 * search <root>: …") and the replacement must not be worse.
 */
async function assertSearchable(root: string): Promise<void> {
  let info: Awaited<ReturnType<typeof stat>>
  try {
    info = await stat(root)
  } catch (error) {
    const reason = error instanceof Error ? error.message : String(error)
    throw new Error(`cannot search ${root}: ${reason}`)
  }
  if (!info.isDirectory()) throw new Error(`cannot search ${root}: not a directory`)
}

/**
 * Resolve the file universe for `root`.
 *
 * The persisted graph when there is one — it is already incremental, and reusing it
 * means a search does not re-hash the project. Otherwise a walk that is NOT
 * persisted: a project with no index must still be searchable, and a search box is
 * not consent to write an index.
 */
async function resolveUniverse(
  root: string,
  supplied: RepoGraph | null | undefined
): Promise<{ graph: RepoGraph; universe: ProjectSearchUniverse }> {
  if (supplied !== undefined && supplied !== null) return { graph: supplied, universe: 'graph' }
  const persisted = supplied === null ? null : await loadRepoGraph(root)
  if (persisted !== null) return { graph: persisted, universe: 'graph' }
  const built = await buildRepoGraph({ root, persist: false, previous: null })
  return { graph: built.graph, universe: 'walk' }
}

/**
 * Search a project's text. One lexical implementation, reshaped for a result list.
 */
export async function projectSearch(options: ProjectSearchOptions): Promise<ProjectSearchResult> {
  const root = resolve(options.root)
  // Only when the universe has to be resolved from the disk. A caller that supplied
  // the graph has already decided what the universe is.
  if (options.graph === undefined || options.graph === null) await assertSearchable(root)
  const { graph, universe } = await resolveUniverse(root, options.graph)

  const lexical = await lexicalSearch({
    root,
    query: options.query,
    graph,
    // `matchCase: false` is NOT `ignoreCase: true`: leaving it off keeps smart case,
    // which is what makes a lower-case query find a SCREAMING_CASE constant.
    ...(options.matchCase === true ? { ignoreCase: false } : {}),
    ...(options.wholeWord === true ? { wholeWord: true } : {}),
    ...(options.maxHits !== undefined ? { maxHits: options.maxHits } : {}),
    ...(options.binary !== undefined ? { binary: options.binary } : {}),
    ...(options.preferRipgrep !== undefined ? { preferRipgrep: options.preferRipgrep } : {}),
    ...(options.signal !== undefined ? { signal: options.signal } : {}),
  })

  // Chunks are a retrieval unit, not a display unit: a file's matches can arrive as
  // several hits, and the panel shows one row per file. Grouped in first-appearance
  // order, so the ranking's order of files survives.
  const byPath = new Map<string, Map<number, ProjectSearchHit>>()
  let refused = 0
  let hitCount = 0
  const cap = options.maxHits ?? MAX_LEXICAL_HITS

  for (const hit of lexical.hits) {
    const contained = containedProjectPath(root, hit.path)
    if (contained === null) {
      refused++
      continue
    }
    let lines = byPath.get(contained)
    if (lines === undefined) {
      lines = new Map()
      byPath.set(contained, lines)
    }
    for (const match of hit.matchedLines) {
      // Overlapping chunks mean the same line can arrive twice. One row per line.
      const line = match.line + 1
      if (lines.has(line)) continue
      if (hitCount >= cap) break
      lines.set(line, { line, text: match.text, spans: match.spans })
      hitCount++
    }
  }

  const groups: ProjectSearchGroup[] = []
  for (const [path, lines] of byPath) {
    const hits = [...lines.values()].sort((a, b) => a.line - b.line)
    if (hits.length > 0) groups.push({ path, hits })
  }

  return {
    root,
    query: options.query,
    terms: lexical.terms,
    engine: lexical.engine,
    degraded: lexical.degraded,
    reason: lexical.reason,
    universe,
    graphPath: graphPath(root),
    fileCount: graph.files.length,
    filesScanned: lexical.filesScanned,
    truncated: lexical.truncated || hitCount >= cap,
    hitCount,
    refused,
    groups,
  }
}
