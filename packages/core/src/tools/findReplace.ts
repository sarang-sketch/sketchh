// Find in Files and Replace in Files, as an editor means them.
//
// ── WHY THIS IS NOT `project-search` ────────────────────────────────────────
//
// `project-search` serves retrieval: it reduces a query to TERMS (dropping short and
// common words) and ranks chunks, which is right for "where is the login handled?"
// and wrong for a person who types `user.id ===` and expects exactly that text. An
// editor's search box is literal by default, can be a regular expression, and its
// matches are what Replace rewrites. So this module has its own dialect — and keeps
// the rule that made the panel trustworthy: ONE matcher. The same `lineMatches` call
// produces the highlight a person sees, the replacement preview, and the edit Replace
// writes. What is shown is exactly what is replaced.
//
// ── THE PROJECT BOUNDARY ────────────────────────────────────────────────────
//
//   * The universe is `walkPlainFiles`: the index walker's containment (symlinks out
//     of the project are skipped), skip list and `.gitignore`, with no extension
//     allowlist. Files over 1 MB and binary files are not searched, and are counted.
//   * A path named by the caller (`paths`, `only`) must be in that universe; anything
//     else is refused, never read.
//   * Writes go through `DiskFileWriter` (real-path containment) wrapped in a
//     `SnapshottingFileWriter`, so a replacement can be undone with `undo-run`.
//   * The query is never a path. It is compiled into a RegExp, and an invalid pattern
//     is a sentence back to the user, not an exception from deep inside a walk.
//
// ── LIMITS ──────────────────────────────────────────────────────────────────
//
// One line at a time (a pattern cannot match across a line break), a pattern that
// matches only empty text finds nothing, and a cap on hits stops a search early —
// reported as `truncated`, never shown as "no more matches".

import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

import { walkPlainFiles } from '../context/walker.js'
import { DiskFileWriter, SnapshottingFileWriter } from '../orchestrator/file-writer.js'

export const DEFAULT_MAX_HITS = 2000
export const MAX_SEARCH_FILE_BYTES = 1024 * 1024
/** Lines longer than this are shown clipped around their first match. */
export const MAX_SHOWN_LINE = 240

export class FindQueryError extends Error {
  override name = 'FindQueryError'
}

export interface FindQuery {
  query: string
  isRegex?: boolean
  matchCase?: boolean
  wholeWord?: boolean
}

export interface FindFilters {
  /** Comma-separated globs; only matching files are searched. Empty means all. */
  include?: string
  /** Comma-separated globs; matching files are skipped. */
  exclude?: string
}

export interface FindSpan {
  /** Offset into the hit's `text`. */
  start: number
  length: number
  /** What Replace would put here, when a replacement was given. */
  replacement?: string
}

export interface FindHit {
  /** 1-based. */
  line: number
  /** The line, or a window of it around the first match when it is long. */
  text: string
  /** Where `text` starts in the full line, so `textStart + span.start + 1` is the column. */
  textStart: number
  spans: FindSpan[]
}

export interface FindGroup {
  /** Project-relative, POSIX separators. */
  path: string
  hits: FindHit[]
  /** Matches on this file's shown lines. */
  matches: number
}

export interface FindResult {
  root: string
  query: string
  groups: FindGroup[]
  matchCount: number
  fileCount: number
  filesSearched: number
  /** A cap stopped the search: there may be more matches. */
  truncated: boolean
  skipped: { tooLarge: number; binary: number }
  durationMs: number
}

// ── the matcher ─────────────────────────────────────────────────────────────

interface Matcher {
  regex: RegExp
  isRegex: boolean
}

function escapeRegex(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/** Compile what the person typed, once. Throws `FindQueryError` with a readable reason. */
export function compileQuery(input: FindQuery): Matcher {
  if (input.query === '') throw new FindQueryError('type something to search for')
  const isRegex = input.isRegex === true
  const body = isRegex ? input.query : escapeRegex(input.query)
  const flags = `g${input.matchCase === true ? '' : 'i'}`
  const wrap = (source: string, unicode: boolean) => {
    if (input.wholeWord !== true) return source
    const word = unicode ? '[\\p{L}\\p{N}_]' : '\\w'
    return `(?<!${word})(?:${source})(?!${word})`
  }
  // Unicode mode first (whole words in any script); a pattern that only compiles in
  // the older mode still works.
  try {
    return { regex: new RegExp(wrap(body, true), `${flags}u`), isRegex }
  } catch {
    try {
      return { regex: new RegExp(wrap(body, false), flags), isRegex }
    } catch (err) {
      const reason =
        err instanceof Error
          ? err.message.replace(/^Invalid regular expression: /, '').replace(/^\/.*\/[a-z]*: /, '')
          : String(err)
      throw new FindQueryError(`that is not a valid regular expression (${reason})`)
    }
  }
}

/**
 * Expand a replacement for one match. Regex mode understands `$&`, `$1`…`$99`,
 * `$<name>`, `$$`, and `\n` / `\t` / `\\`; literal mode inserts the text as typed.
 */
export function expandReplacement(replacement: string, match: RegExpExecArray, isRegex: boolean): string {
  if (!isRegex) return replacement
  let out = ''
  for (let i = 0; i < replacement.length; i++) {
    const c = replacement[i]!
    const next = replacement[i + 1]
    if (c === '\\' && next !== undefined) {
      if (next === 'n') { out += '\n'; i++; continue }
      if (next === 't') { out += '\t'; i++; continue }
      if (next === '\\') { out += '\\'; i++; continue }
    }
    if (c === '$' && next !== undefined) {
      if (next === '$') { out += '$'; i++; continue }
      if (next === '&') { out += match[0]; i++; continue }
      if (next === '<') {
        const close = replacement.indexOf('>', i + 2)
        if (close !== -1) {
          const name = replacement.slice(i + 2, close)
          out += match.groups?.[name] ?? ''
          i = close
          continue
        }
      }
      if (/[0-9]/.test(next)) {
        const two = replacement.slice(i + 1, i + 3)
        if (/^[0-9]{2}$/.test(two) && Number(two) > 0 && Number(two) < match.length) {
          out += match[Number(two)] ?? ''
          i += 2
          continue
        }
        const one = Number(next)
        if (one > 0 && one < match.length) {
          out += match[one] ?? ''
          i++
          continue
        }
      }
    }
    out += c
  }
  return out
}

interface LineMatch {
  start: number
  length: number
  replacement?: string
}

/** Every non-empty match in one line, left to right. THE one place matching happens. */
export function lineMatches(line: string, matcher: Matcher, replacement?: string): LineMatch[] {
  const regex = matcher.regex
  regex.lastIndex = 0
  const out: LineMatch[] = []
  for (;;) {
    const match = regex.exec(line)
    if (match === null) break
    if (match[0].length === 0) {
      // An empty match would never advance; it is also nothing to show or replace.
      regex.lastIndex = match.index + 1
      if (regex.lastIndex > line.length) break
      continue
    }
    out.push({
      start: match.index,
      length: match[0].length,
      ...(replacement !== undefined ? { replacement: expandReplacement(replacement, match, matcher.isRegex) } : {}),
    })
  }
  return out
}

/** The text shown for a matching line: whole when short, else a window around the first match. */
export function shownLine(line: string, matches: readonly LineMatch[]): { text: string; textStart: number } {
  if (line.length <= MAX_SHOWN_LINE) return { text: line, textStart: 0 }
  const first = matches[0]?.start ?? 0
  const textStart = Math.max(0, Math.min(first - 40, line.length - MAX_SHOWN_LINE))
  return { text: line.slice(textStart, textStart + MAX_SHOWN_LINE), textStart }
}

// ── include / exclude ───────────────────────────────────────────────────────

/** The `}` that closes the `{` at `open`, counting nested pairs; -1 when there is none. */
function closingBrace(glob: string, open: number): number {
  let depth = 0
  for (let i = open; i < glob.length; i++) {
    if (glob[i] === '{') depth++
    else if (glob[i] === '}') {
      depth--
      if (depth === 0) return i
    }
  }
  return -1
}

function globToRegex(glob: string, ignoreCase: boolean): RegExp {
  let out = ''
  for (let i = 0; i < glob.length; i++) {
    const c = glob[i]!
    if (c === '*') {
      if (glob[i + 1] === '*') {
        i++
        if (glob[i + 1] === '/') {
          i++
          out += '(?:.*/)?'
        } else {
          out += '.*'
        }
      } else {
        out += '[^/]*'
      }
    } else if (c === '?') {
      out += '[^/]'
    } else if (c === '{') {
      const close = closingBrace(glob, i)
      if (close === -1) {
        out += '\\{'
        continue
      }
      // Alternatives split at this level only, so `{a,{b,c}}` is `a` or `{b,c}`.
      const options = splitPatterns(glob.slice(i + 1, close)).map((part) => globToRegex(part, ignoreCase).source.slice(1, -1))
      out += `(?:${options.join('|')})`
      i = close
    } else if (c === '[') {
      const close = glob.indexOf(']', i + 1)
      if (close === -1) {
        out += '\\['
        continue
      }
      const inner = glob.slice(i + 1, close).replace(/^!/, '^').replace(/\\/g, '\\\\')
      out += `[${inner}]`
      i = close
    } else if ('\\^$.|+()]}'.includes(c)) {
      out += `\\${c}`
    } else {
      out += c
    }
  }
  return new RegExp(`^${out}$`, ignoreCase ? 'i' : '')
}

/** Split on commas that are not inside `{…}`, so `*.{ts,tsx}, docs` is two patterns. */
function splitPatterns(text: string): string[] {
  const out: string[] = []
  let depth = 0
  let current = ''
  for (const c of text) {
    if (c === '{') depth++
    else if (c === '}' && depth > 0) depth--
    if (c === ',' && depth === 0) {
      out.push(current)
      current = ''
      continue
    }
    current += c
  }
  out.push(current)
  return out
}

/**
 * One "files to include" / "files to exclude" box, as editors read it: comma-separated;
 * `*.ts` matches at any depth; a bare name or `src/` means that folder and everything in
 * it; a leading `./` anchors to the project root.
 */
export function compileGlobs(text: string | undefined, ignoreCase = process.platform === 'win32'): ((path: string) => boolean) | null {
  const patterns = splitPatterns(text ?? '')
    .map((part) => part.trim().replace(/\\/g, '/'))
    .filter((part) => part !== '')
  if (patterns.length === 0) return null
  const tests: RegExp[] = []
  for (const raw of patterns) {
    const anchored = raw.startsWith('./') || raw.startsWith('/')
    const pattern = raw.replace(/^\.?\//, '').replace(/\/+$/, '')
    if (pattern === '') continue
    const bases = anchored || pattern.startsWith('**/') ? [pattern] : [pattern, `**/${pattern}`]
    for (const base of bases) {
      tests.push(globToRegex(base, ignoreCase))
      tests.push(globToRegex(`${base}/**`, ignoreCase))
    }
  }
  return (path: string) => tests.some((test) => test.test(path))
}

// ── find ────────────────────────────────────────────────────────────────────

export interface FindOptions extends FindQuery, FindFilters {
  root: string
  replacement?: string
  maxHits?: number
  maxFiles?: number
  signal?: AbortSignal
}

function looksBinaryText(text: string): boolean {
  return text.slice(0, 8000).includes('\u0000')
}

function splitLines(content: string): string[] {
  return content.split('\n').map((line) => (line.endsWith('\r') ? line.slice(0, -1) : line))
}

interface Universe {
  files: Array<{ path: string; relativePath: string }>
  truncated: boolean
  tooLarge: number
}

async function universeFor(root: string, filters: FindFilters, maxFiles?: number): Promise<Universe> {
  const walk = await walkPlainFiles(root, { maxFileBytes: MAX_SEARCH_FILE_BYTES, ...(maxFiles !== undefined ? { maxFiles } : {}) })
  const include = compileGlobs(filters.include)
  const exclude = compileGlobs(filters.exclude)
  const files = walk.files
    .map((file) => ({ path: file.path, relativePath: file.relativePath.replace(/\\/g, '/') }))
    .filter((file) => (include === null || include(file.relativePath)) && (exclude === null || !exclude(file.relativePath)))
  return { files, truncated: walk.truncated, tooLarge: walk.tooLarge }
}

export async function findInFiles(options: FindOptions): Promise<FindResult> {
  const started = Date.now()
  const root = resolve(options.root)
  const matcher = compileQuery(options)
  const cap = Math.max(1, Math.floor(options.maxHits ?? DEFAULT_MAX_HITS))
  const universe = await universeFor(root, options, options.maxFiles)

  const groups: FindGroup[] = []
  let matchCount = 0
  let binary = 0
  let searched = 0
  let truncated = universe.truncated

  outer: for (const file of universe.files) {
    if (options.signal?.aborted === true) break
    let content: string
    try {
      content = await readFile(file.path, 'utf8')
    } catch {
      continue
    }
    if (looksBinaryText(content)) {
      binary++
      continue
    }
    searched++
    const lines = splitLines(content)
    let group: FindGroup | null = null
    for (let index = 0; index < lines.length; index++) {
      const line = lines[index]!
      const matches = lineMatches(line, matcher, options.replacement)
      if (matches.length === 0) continue
      if (matchCount >= cap) {
        truncated = true
        break outer
      }
      if (group === null) {
        group = { path: file.relativePath, hits: [], matches: 0 }
        groups.push(group)
      }
      group.matches += matches.length
      const shown = shownLine(line, matches)
      const spans: FindSpan[] = []
      for (const match of matches) {
        const start = match.start - shown.textStart
        if (start < 0 || start >= shown.text.length) continue
        spans.push({
          start,
          length: Math.min(match.length, shown.text.length - start),
          ...(match.replacement !== undefined ? { replacement: match.replacement } : {}),
        })
      }
      group.hits.push({ line: index + 1, text: shown.text, textStart: shown.textStart, spans })
      matchCount += matches.length
    }
  }

  return {
    root,
    query: options.query,
    groups,
    matchCount,
    fileCount: groups.length,
    filesSearched: searched,
    truncated,
    skipped: { tooLarge: universe.tooLarge, binary },
    durationMs: Date.now() - started,
  }
}

// ── replace ─────────────────────────────────────────────────────────────────

export interface ReplaceOptions extends FindQuery, FindFilters {
  root: string
  replacement: string
  /** Only these project-relative files (still subject to the filters and the universe). */
  paths?: string[]
  /** Only this one line, and only if it still reads as it did when it was found. */
  only?: { path: string; line: number; text: string; textStart: number }
  /** Snapshot id for undo. */
  snapshotId: string
}

export interface ReplaceResult {
  root: string
  /** Files rewritten, with how many matches each had replaced. */
  files: Array<{ path: string; replaced: number }>
  replaced: number
  /** Files that were meant to change and did not, with why. */
  skipped: Array<{ path: string; reason: string }>
  /** Pass to `undo-run` to put every rewritten file back. Null when nothing changed. */
  snapshotId: string | null
}

/** Replace in one file's text with the shared matcher. Exported for tests. */
export function replaceInText(
  content: string,
  matcher: Matcher,
  replacement: string,
  onlyLine?: number,
): { text: string; replaced: number } {
  const parts = content.split('\n')
  let replaced = 0
  for (let index = 0; index < parts.length; index++) {
    if (onlyLine !== undefined && index + 1 !== onlyLine) continue
    const raw = parts[index]!
    const cr = raw.endsWith('\r')
    const line = cr ? raw.slice(0, -1) : raw
    const matches = lineMatches(line, matcher, replacement)
    if (matches.length === 0) continue
    let rebuilt = ''
    let at = 0
    for (const match of matches) {
      rebuilt += line.slice(at, match.start) + (match.replacement ?? '')
      at = match.start + match.length
    }
    rebuilt += line.slice(at)
    parts[index] = cr ? `${rebuilt}\r` : rebuilt
    replaced += matches.length
  }
  return { text: parts.join('\n'), replaced }
}

export async function replaceInFiles(options: ReplaceOptions): Promise<ReplaceResult> {
  const root = resolve(options.root)
  const matcher = compileQuery(options)
  const universe = await universeFor(root, options)
  const fold = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path)
  const known = new Map(universe.files.map((file) => [fold(file.relativePath), file]))
  const skipped: ReplaceResult['skipped'] = []

  let targets = universe.files
  if (options.only !== undefined || options.paths !== undefined) {
    const wanted = options.only !== undefined ? [options.only.path] : options.paths!
    targets = []
    for (const raw of wanted) {
      const file = known.get(fold(raw.replace(/\\/g, '/').replace(/^\.\//, '')))
      if (file === undefined) skipped.push({ path: raw, reason: 'not a searchable file in this project' })
      else targets.push(file)
    }
  }

  const edits: Array<{ path: string; content: string; replaced: number }> = []
  for (const file of targets) {
    let content: string
    try {
      content = await readFile(file.path, 'utf8')
    } catch (err) {
      skipped.push({ path: file.relativePath, reason: err instanceof Error ? err.message : String(err) })
      continue
    }
    if (looksBinaryText(content)) {
      skipped.push({ path: file.relativePath, reason: 'binary file' })
      continue
    }
    if (options.only !== undefined) {
      const line = splitLines(content)[options.only.line - 1]
      const now = line === undefined ? null : shownLine(line, lineMatches(line, matcher))
      if (now === null || now.text !== options.only.text || now.textStart !== options.only.textStart) {
        skipped.push({ path: file.relativePath, reason: 'that line changed since the search; search again' })
        continue
      }
    }
    const result = replaceInText(content, matcher, options.replacement, options.only?.line)
    if (result.replaced === 0 || result.text === content) continue
    edits.push({ path: file.relativePath, content: result.text, replaced: result.replaced })
  }

  if (edits.length === 0) return { root, files: [], replaced: 0, skipped, snapshotId: null }
  const writer = new SnapshottingFileWriter(new DiskFileWriter(), { runId: options.snapshotId })
  await writer.apply(root, edits.map(({ path, content }) => ({ path, content })))
  return {
    root,
    files: edits.map(({ path, replaced }) => ({ path, replaced })),
    replaced: edits.reduce((sum, edit) => sum + edit.replaced, 0),
    skipped,
    snapshotId: options.snapshotId,
  }
}
