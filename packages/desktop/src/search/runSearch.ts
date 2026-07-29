// Project search: `git grep` when it can run, a folder walk when it cannot.
//
// ── NO SEARCH LIBRARY, AND NO NEW ALLOWLIST ENTRY ───────────────────────────
//
// Nothing is added to `packages/core` for this, and nothing is added to the Rust
// terminal allowlist for it either. `ripgrep` would be the obvious fast path, but
// `rg` is NOT on `command_policy::ALLOWED_PROGRAMS` and widening that list to make a
// search box faster would trade a security boundary for a convenience. `git` IS on
// the list, and `git grep` is a real content search: it is written in C, it skips
// what `.gitignore` skips, and it already runs with a cwd the backend contains. So
// the fast path is `git grep`, spawned through the one seam that can spawn anything
// (src/terminal/commandIo.ts), and the fallback is a walk over the same `read_dir`
// and `read_file` the Explorer uses.
//
// ── WHEN EACH CHANNEL RUNS, AND WHY THE UI SAYS WHICH ───────────────────────
//
//   git grep   plain-text queries in a git repository, when the backend can spawn
//   walker     regex queries (dialects differ — see searchText.ts), folders that are
//              not repositories, a git that is missing or refuses, and any browser
//              session where the native bridge is absent
//
// The panel NAMES the channel that ran. Silent degradation to the slower, narrower
// retriever is the failure mode to avoid: a walk that quietly stops at its file cap
// looks exactly like "no matches" unless it says otherwise (Requirement 27.5).
//
// ── CANCELLATION IS THE CALLER'S TOKEN ──────────────────────────────────────
//
// Every request carries `{ cancelled: boolean }`, checked between reads. The panel
// flips it when the query changes, so a walk in flight stops instead of finishing
// and rendering results for a query the user has already replaced. A cancelled
// search resolves to `{ cancelled: true }` — never to data the caller must remember
// to ignore.
//
// Validates: Requirements 14.6, 22.6, 27.1, 27.3, 27.4, 27.5

import { byteLength, looksBinary, type FileIo } from '../editor/fileIo'
import { canonicalPath, relativeToRoot, toAbsolutePath } from '../editor/paths'
import type { CommandIo } from '../terminal/commandIo'
import {
  buildMatcher,
  clipAround,
  findInText,
  gitGrepArgs,
  parseGitGrepLine,
  type Matcher,
  type SearchHit,
  type SearchOptions,
} from './searchText'

/** Which channel produced the results. Rendered, not merely logged. */
export type SearchChannel = 'git-grep' | 'walker'

/** Matches in one file. */
export interface SearchGroup {
  /** Canonical absolute path — what `openPath` is called with. */
  path: string
  /** Project-relative, for the row label. */
  relativePath: string
  hits: SearchHit[]
}

export interface SearchResult {
  groups: SearchGroup[]
  hitCount: number
  channel: SearchChannel
  /** True when a cap stopped the search early. The UI must say so. */
  truncated: boolean
  /** Folders the walk could not read. Zero for the git channel. */
  unreadable: number
  /** Why the fast path was not used, when it was not. Null when it was. */
  fallbackReason: string | null
}

export type SearchOutcome =
  | ({ ok: true } & SearchResult)
  | { ok: false; message: string }
  /** The caller replaced this query. There is nothing to render. */
  | { cancelled: true }

export interface SearchToken {
  cancelled: boolean
}

export interface SearchDeps {
  files: FileIo
  command: CommandIo
}

export interface SearchRequest {
  root: string
  query: string
  options: SearchOptions
  token: SearchToken
}

/** Total matches a single search will report. */
export const MAX_HITS = 200
/** Files the walker will open. A repository is not an excuse to read all of it. */
export const MAX_FILES = 1500
/** A file larger than this is not searched by the walker. */
export const MAX_FILE_BYTES = 512_000

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** Group flat hits by file, preserving the order files were discovered in. */
function group(root: string, rows: Array<{ path: string; hit: SearchHit }>): SearchGroup[] {
  const byPath = new Map<string, SearchGroup>()
  for (const { path, hit } of rows) {
    const key = canonicalPath(path)
    let entry = byPath.get(key)
    if (entry === undefined) {
      entry = { path: key, relativePath: relativeToRoot(root, key), hits: [] }
      byPath.set(key, entry)
    }
    entry.hits.push(hit)
  }
  return [...byPath.values()]
}

/**
 * The whole search. Resolves an outcome; never throws, because a failure has to
 * reach the screen as a sentence (Requirement 27.5).
 */
export async function runSearch(deps: SearchDeps, request: SearchRequest): Promise<SearchOutcome> {
  const built = buildMatcher(request.query, request.options)
  if (!built.ok) return { ok: false, message: built.message }

  if (request.options.regex) {
    // Stated, not silent: the user chose a dialect, so they get the channel that
    // speaks it.
    return walk(deps, request, built.matcher, 'regular expressions use this app’s own dialect')
  }

  const fast = await gitGrep(deps, request, built.matcher)
  if (fast.kind === 'result') return fast.outcome
  if (request.token.cancelled) return { cancelled: true }
  return walk(deps, request, built.matcher, fast.reason)
}

type FastPath =
  | { kind: 'result'; outcome: SearchOutcome }
  /** The fast path did not run. The reason is shown next to the results. */
  | { kind: 'fallback'; reason: string }

async function gitGrep(
  deps: SearchDeps,
  request: SearchRequest,
  matcher: Matcher,
): Promise<FastPath> {
  let output
  try {
    output = await deps.command.run({
      projectRoot: request.root,
      cwd: '',
      program: 'git',
      args: gitGrepArgs(request.query, request.options),
      // The user asked for this search by typing it, and the arguments are built
      // here from a fixed vector — the program is never taken from input. The
      // backend still refuses an unconfirmed call, so this flag cannot widen
      // anything a caller could not already do (Requirement 22.6).
      confirmed: true,
    })
  } catch (err) {
    return { kind: 'fallback', reason: messageOf(err) }
  }

  if (request.token.cancelled) return { kind: 'result', outcome: { cancelled: true } }

  // git grep: 0 found something, 1 found nothing, anything else is an error —
  // "not a git repository" being by far the most common.
  if (output.exitCode !== 0 && output.exitCode !== 1) {
    const detail = output.stderr.trim()
    return {
      kind: 'fallback',
      reason: detail === '' ? `git grep exited with ${output.exitCode}` : detail,
    }
  }

  const rows: Array<{ path: string; hit: SearchHit }> = []
  let truncated = false

  for (const raw of output.stdout.split('\n')) {
    const parsed = parseGitGrepLine(raw)
    if (parsed === null) continue

    // git found the LINE; where the highlight goes is decided by the one matcher,
    // so both channels highlight identically.
    const spans = matcher.find(parsed.text)
    if (spans.length === 0) continue
    const absolute = toAbsolutePath(request.root, parsed.path)
    for (const span of spans) {
      const clipped = clipAround(parsed.text, span)
      rows.push({
        path: absolute,
        hit: { line: parsed.line, text: clipped.text, start: clipped.start, length: span.length },
      })
      if (rows.length >= MAX_HITS) {
        truncated = true
        break
      }
    }
    if (truncated) break
  }

  return {
    kind: 'result',
    outcome: {
      ok: true,
      groups: group(request.root, rows),
      hitCount: rows.length,
      channel: 'git-grep',
      truncated,
      unreadable: 0,
      fallbackReason: null,
    },
  }
}

async function walk(
  deps: SearchDeps,
  request: SearchRequest,
  matcher: Matcher,
  fallbackReason: string | null,
): Promise<SearchOutcome> {
  const rows: Array<{ path: string; hit: SearchHit }> = []
  let scanned = 0
  let unreadable = 0
  let truncated = false

  // The root's own listing failing is different from a subfolder's: there is
  // nothing to search at all, so it is an error rather than a partial result.
  let rootEntries
  try {
    rootEntries = await deps.files.readDir(request.root, request.root)
  } catch (err) {
    return {
      ok: false,
      message: `Cannot search ${request.root}: ${messageOf(err)}`,
    }
  }
  if (request.token.cancelled) return { cancelled: true }

  // Breadth-first, so the shallow files a user is most likely to want are found
  // before a cap can stop the search.
  const queue: Array<typeof rootEntries> = [rootEntries]
  const seen = new Set([canonicalPath(request.root)])

  while (queue.length > 0 && !truncated) {
    const listing = queue.shift()
    if (listing === undefined) break

    const subdirectories: string[] = []
    for (const entry of listing) {
      if (request.token.cancelled) return { cancelled: true }

      if (entry.isDir) {
        // A symlinked directory can point at an ancestor; a visited set is what
        // makes that terminate.
        const key = canonicalPath(entry.path)
        if (seen.has(key)) continue
        seen.add(key)
        subdirectories.push(entry.path)
        continue
      }

      if (scanned >= MAX_FILES) {
        truncated = true
        break
      }
      scanned += 1

      let content: string
      try {
        content = await deps.files.readFile(request.root, entry.path)
      } catch {
        // One unreadable file is not worth a sentence of its own; the count is
        // reported so the total is never presented as complete.
        unreadable += 1
        continue
      }
      if (looksBinary(content) || byteLength(content) > MAX_FILE_BYTES) continue

      for (const hit of findInText(content, matcher, MAX_HITS - rows.length)) {
        rows.push({ path: entry.path, hit })
      }
      if (rows.length >= MAX_HITS) {
        truncated = true
        break
      }
    }

    for (const dir of subdirectories) {
      if (request.token.cancelled) return { cancelled: true }
      try {
        queue.push(await deps.files.readDir(request.root, dir))
      } catch {
        unreadable += 1
      }
    }
  }

  return {
    ok: true,
    groups: group(request.root, rows),
    hitCount: rows.length,
    channel: 'walker',
    truncated,
    unreadable,
    fallbackReason,
  }
}
