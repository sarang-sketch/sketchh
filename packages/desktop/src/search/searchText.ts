// Matching, one implementation, shared by both search channels.
//
// The search panel has two ways to find text — `git grep` when it can, a folder walk
// when it cannot (see runSearch.ts) — and they must AGREE. So neither of them owns
// what a match is: this module does. `git grep` decides which lines are interesting;
// `findInLine` then decides where inside those lines the highlight goes, using the
// same matcher the walker uses. One notion of a match, two ways of reaching it.
//
// WHICH FLAGS TRANSLATE, AND WHICH DO NOT. `-i` (case) and `-w` (whole word) mean
// the same thing in git grep and in a JavaScript RegExp, so a plain-text search can
// use either channel and get identical results. A user-supplied REGULAR EXPRESSION
// does not translate: git grep speaks POSIX ERE (or PCRE, if this git was built with
// it), and JavaScript speaks its own dialect. Rather than ship a search whose
// semantics depend on which channel happened to run, regex mode always uses the
// walker — one dialect, stated in the UI (Requirement 27.4).
//
// Pure string work: no React, no I/O, no filesystem.
//
// Validates: Requirements 14.6, 27.1, 27.3, 27.4

/** The three toggles the panel offers, in the order they appear. */
export interface SearchOptions {
  matchCase: boolean
  wholeWord: boolean
  regex: boolean
}

export const DEFAULT_SEARCH_OPTIONS: SearchOptions = {
  matchCase: false,
  wholeWord: false,
  regex: false,
}

/** Where a match sits inside one line. */
export interface Span {
  start: number
  length: number
}

export interface Matcher {
  /** Every match in `line`, left to right, never overlapping. */
  find(line: string): Span[]
}

export type MatcherOutcome =
  | { ok: true; matcher: Matcher }
  /** A regular expression the engine will not accept, in its own words. */
  | { ok: false; message: string }

/** Escape a literal so a RegExp treats it as text. */
function escapeLiteral(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
}

/**
 * The matcher for a query. Never throws: an invalid regular expression is an
 * outcome the panel renders, because "no matches" would be a lie about a query
 * that was never run.
 */
export function buildMatcher(query: string, options: SearchOptions): MatcherOutcome {
  if (query === '') return { ok: false, message: 'Type something to search for.' }

  const body = options.regex ? query : escapeLiteral(query)
  // `\b` is a word boundary in both dialects, which is what makes `-w` portable.
  const source = options.wholeWord ? `\\b(?:${body})\\b` : body

  let regex: RegExp
  try {
    regex = new RegExp(source, options.matchCase ? 'g' : 'gi')
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err)
    return { ok: false, message: `That regular expression is not valid: ${detail}` }
  }

  return {
    ok: true,
    matcher: {
      find(line) {
        const spans: Span[] = []
        // A fresh index per call: one matcher is reused across every line of every
        // file, and a shared `lastIndex` would silently skip matches.
        regex.lastIndex = 0
        let match = regex.exec(line)
        while (match !== null) {
          if (match[0].length > 0) {
            spans.push({ start: match.index, length: match[0].length })
          } else {
            // A pattern that can match nothing (`a*`, `^`) would loop forever on a
            // zero-length match. Step over it instead of reporting it.
            regex.lastIndex += 1
          }
          if (spans.length >= MAX_HITS_PER_LINE) break
          match = regex.exec(line)
        }
        return spans
      },
    },
  }
}

/** A single line cannot contribute more highlights than this. */
export const MAX_HITS_PER_LINE = 50

/** One match, as the panel renders it. */
export interface SearchHit {
  /** 1-based, as every editor and git grep count. */
  line: number
  /** The line's text, clipped. */
  text: string
  /** Where the match sits in `text`. */
  start: number
  length: number
}

/** Matches in one file's text, with their line numbers. */
export function findInText(text: string, matcher: Matcher, limit: number): SearchHit[] {
  const hits: SearchHit[] = []
  const lines = text.split('\n')

  for (let index = 0; index < lines.length; index += 1) {
    // `\r` would otherwise land in the rendered text of every CRLF file.
    const raw = lines[index].replace(/\r$/, '')
    for (const span of matcher.find(raw)) {
      const clipped = clipAround(raw, span)
      hits.push({ line: index + 1, text: clipped.text, start: clipped.start, length: span.length })
      if (hits.length >= limit) return hits
    }
  }
  return hits
}

/** The longest line fragment a result row will show. */
export const MAX_LINE_CHARS = 200

/**
 * Keep a long line's match visible. A minified bundle is one 200 kB line, and
 * rendering it whole would freeze the panel while showing nothing useful.
 */
export function clipAround(line: string, span: Span): { text: string; start: number } {
  if (line.length <= MAX_LINE_CHARS) return { text: line, start: span.start }

  const leading = 40
  const from = Math.max(0, span.start - leading)
  const text = line.slice(from, from + MAX_LINE_CHARS)
  const prefix = from > 0 ? '…' : ''
  const suffix = from + MAX_LINE_CHARS < line.length ? '…' : ''
  return { text: `${prefix}${text}${suffix}`, start: span.start - from + prefix.length }
}

/** One `git grep -n` output line, split into its three parts. */
export interface GitGrepLine {
  /** Repo-relative, forward-slashed, exactly as git spelled it. */
  path: string
  line: number
  text: string
}

/**
 * Parse `path:12:the line`.
 *
 * A path may itself contain a colon on Linux, so the split is anchored on the
 * `:<digits>:` that git puts between the path and the text, taken from the LEFT —
 * the first such run cannot be inside the line's own text without a path before it.
 */
export function parseGitGrepLine(raw: string): GitGrepLine | null {
  const line = raw.replace(/\r$/, '')
  if (line === '') return null

  const match = /^(.*?):(\d+):/.exec(line)
  if (match === null) return null
  const [, path, number] = match
  if (path === '') return null

  const lineNumber = Number.parseInt(number, 10)
  if (!Number.isFinite(lineNumber) || lineNumber <= 0) return null

  return { path, line: lineNumber, text: line.slice(match[0].length) }
}

/**
 * The argument VECTOR for the fast path. Not a command line — nothing here is
 * re-parsed by a shell, because there is no shell (Requirement 22.6).
 *
 *   --no-color       we do our own rendering; escape codes in a result row are noise
 *   -n               line numbers, which the result rows need
 *   -I               skip binary files, the way the walker does
 *   -F               the query is a literal. Regex mode never reaches this channel.
 *   --untracked      a file that is new but not yet committed is still in the project
 *   -e               terminates option parsing for the pattern, so a query starting
 *                    with `-` is a query and not a flag
 */
export function gitGrepArgs(query: string, options: SearchOptions): string[] {
  const args = ['grep', '--no-color', '-n', '-I', '-F', '--untracked']
  if (!options.matchCase) args.push('-i')
  if (options.wholeWord) args.push('-w')
  args.push('-e', query)
  return args
}
