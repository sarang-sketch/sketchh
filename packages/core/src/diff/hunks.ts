// Unified-diff parsing and subset application.
//
// ---------------------------------------------------------------------------
// WHY THIS LIVES IN THE CORE AND NOT IN THE UI
// ---------------------------------------------------------------------------
// Per-hunk accept/reject is pure, deterministic string work. It needs unit tests
// that do not boot React, and it must be reachable from the engine as well as the
// review surface. So the parser and the applier live here; the desktop package
// owns only the rendering and the click handlers.
//
// ---------------------------------------------------------------------------
// THREE THINGS THAT ARE EASY TO GET WRONG
// ---------------------------------------------------------------------------
//  1. SUBSET OFFSETS. Accepting hunks 1 and 3 while rejecting 2 must land hunk 3
//     at the right line. This module never tracks a running "drift" against the
//     new-side numbering. It walks the ORIGINAL file with a cursor in ORIGINAL
//     coordinates and builds the output separately, so a rejected hunk simply
//     never advances the cursor and cannot shift anything after it. See THE
//     SUBSET-OFFSET GUARD in `applyHunks`.
//  2. LINE ENDINGS. This repo is on Windows and git rewrites endings on commit. A
//     applier that assumes '\n' corrupts every CRLF file it touches. Lines that
//     survive from the original keep their OWN terminator, so a mixed-ending file
//     is never silently normalised; only lines the patch ADDS take the file's
//     dominant ending.
//  3. FAILURE IS DATA. A hunk that does not match the original is not an
//     exception, it is a typed diagnostic, so the review surface can say which
//     hunk failed and why instead of dying inside a render.
//
// Nothing here writes to disk. Rejecting every hunk returns a byte-identical
// string, and the caller is expected to skip the write entirely.
//
// Validates: Requirements 16.1, 16.2, 16.3, 16.5

// ---------------------------------------------------------------------------
// Shapes
// ---------------------------------------------------------------------------

/** What a diff line does to the file. */
export type DiffLineKind = 'context' | 'add' | 'remove'

/** One line inside a hunk. `text` never carries a line terminator. */
export interface DiffLine {
  kind: DiffLineKind
  text: string
  /**
   * True when the patch marked this line with `\ No newline at end of file`.
   * On a `context` or `add` line this means the produced file must not end with
   * a terminator.
   */
  noNewlineAtEof?: boolean
}

/**
 * One hunk. `oldStart`/`oldLines` are 1-based old-side coordinates exactly as the
 * `@@` header states them; `oldLines: 0` means a pure insertion after old line
 * `oldStart`.
 */
export interface Hunk {
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  /** The trailing section label on the `@@` header, trimmed. `''` when absent. */
  heading: string
  lines: DiffLine[]
}

/** Every way this module can refuse. Codes are stable; messages are for humans. */
export type DiffErrorCode =
  | 'no-hunk-header'
  | 'malformed-hunk-header'
  | 'unexpected-line'
  | 'hunk-count-mismatch'
  | 'orphan-no-newline-marker'
  | 'hunk-out-of-order'
  | 'hunk-out-of-range'
  | 'context-mismatch'
  | 'unknown-hunk-index'

/** A refusal, naming the problem and where it is. */
export interface DiffDiagnostic {
  code: DiffErrorCode
  message: string
  /** 1-based line number within the patch text, when the problem is located there. */
  patchLine?: number
  /** 0-based index into the hunk array, when the problem is located in a hunk. */
  hunkIndex?: number
}

export type ParseDiffResult =
  | { ok: true; hunks: Hunk[] }
  | { ok: false; error: DiffDiagnostic }

export type ApplyHunksResult =
  | { ok: true; content: string }
  | { ok: false; error: DiffDiagnostic }

// ---------------------------------------------------------------------------
// Line endings
// ---------------------------------------------------------------------------

export type LineEnding = '\r\n' | '\n' | '\r'

export interface LineEndingReport {
  /** The ending used for lines the patch ADDS. */
  dominant: LineEnding
  crlf: number
  /** Line feeds that are not part of a CRLF pair. */
  lf: number
  /** Carriage returns that are not part of a CRLF pair. */
  cr: number
  /** True when more than one style occurs in the file. */
  mixed: boolean
}

/**
 * Count the ending styles in `text` and pick the dominant one. Ties break
 * CRLF > LF > CR, which keeps a Windows checkout Windows. A file with no
 * terminator at all reports LF, since something has to be chosen for added lines.
 */
export function detectLineEnding(text: string): LineEndingReport {
  let crlf = 0
  let lf = 0
  let cr = 0

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\r') {
      if (text[i + 1] === '\n') {
        crlf++
        i++
      } else {
        cr++
      }
    } else if (ch === '\n') {
      lf++
    }
  }

  let dominant: LineEnding = '\n'
  if (crlf >= lf && crlf >= cr && crlf > 0) dominant = '\r\n'
  else if (lf >= cr && lf > 0) dominant = '\n'
  else if (cr > 0) dominant = '\r'

  const styles = (crlf > 0 ? 1 : 0) + (lf > 0 ? 1 : 0) + (cr > 0 ? 1 : 0)
  return { dominant, crlf, lf, cr, mixed: styles > 1 }
}

/** A source line plus the exact terminator that followed it (`''` at a bare EOF). */
interface SourceLine {
  text: string
  eol: string
}

/**
 * Split text into lines, REMEMBERING each terminator. `join` of the result is the
 * input, byte for byte — that exactness is what makes "reject everything leaves
 * the file untouched" provable rather than hopeful.
 */
function splitSourceLines(text: string): SourceLine[] {
  const out: SourceLine[] = []
  let start = 0

  for (let i = 0; i < text.length; i++) {
    const ch = text[i]
    if (ch === '\r' && text[i + 1] === '\n') {
      out.push({ text: text.slice(start, i), eol: '\r\n' })
      i++
      start = i + 1
    } else if (ch === '\n' || ch === '\r') {
      out.push({ text: text.slice(start, i), eol: ch })
      start = i + 1
    }
  }

  if (start < text.length) out.push({ text: text.slice(start), eol: '' })
  return out
}

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

const HUNK_HEADER = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@ ?(.*)$/

const NO_NEWLINE_MARKER = '\\ No newline at end of file'

function fail(error: DiffDiagnostic): { ok: false; error: DiffDiagnostic } {
  return { ok: false, error }
}

/** Old-side and new-side line counts a hunk body actually contains. */
function bodyCounts(lines: readonly DiffLine[]): { old: number; new: number } {
  let oldCount = 0
  let newCount = 0
  for (const line of lines) {
    if (line.kind !== 'add') oldCount++
    if (line.kind !== 'remove') newCount++
  }
  return { old: oldCount, new: newCount }
}

function isSatisfied(hunk: Hunk): boolean {
  const counts = bodyCounts(hunk.lines)
  return counts.old >= hunk.oldLines && counts.new >= hunk.newLines
}

function checkCounts(hunk: Hunk, index: number, patchLine: number): DiffDiagnostic | null {
  const counts = bodyCounts(hunk.lines)
  if (counts.old === hunk.oldLines && counts.new === hunk.newLines) return null
  return {
    code: 'hunk-count-mismatch',
    message:
      `hunk ${index + 1} header @@ -${hunk.oldStart},${hunk.oldLines} ` +
      `+${hunk.newStart},${hunk.newLines} @@ promises ${hunk.oldLines} old and ` +
      `${hunk.newLines} new lines, but the body holds ${counts.old} old and ` +
      `${counts.new} new`,
    hunkIndex: index,
    patchLine,
  }
}

/**
 * Parse a unified diff into hunks.
 *
 * Handles the standard `@@ -a,b +c,d @@` header, the omitted-count form
 * `@@ -a +c @@` (which means exactly one line), `\ No newline at end of file`,
 * multiple hunks, and multi-file patches — `diff --git`, `index`, `---`, `+++`
 * and other inter-hunk noise is skipped rather than mistaken for content, because
 * a completed hunk stops consuming lines until the next header.
 *
 * Returns a diagnostic instead of throwing. An empty or whitespace-only patch is
 * a legitimate zero-hunk diff; a patch with content but no `@@` header is not.
 */
export function parseUnifiedDiff(text: string): ParseDiffResult {
  const hunks: Hunk[] = []
  if (text.trim() === '') return { ok: true, hunks }

  const rawLines = splitSourceLines(text).map((line) => line.text)
  let current: Hunk | null = null
  let currentIndex = -1
  let currentHeaderLine = 0

  for (let i = 0; i < rawLines.length; i++) {
    const raw = rawLines[i]!
    const patchLine = i + 1

    if (raw.startsWith('@@')) {
      if (current) {
        const problem = checkCounts(current, currentIndex, currentHeaderLine)
        if (problem) return fail(problem)
      }

      const match = HUNK_HEADER.exec(raw)
      if (!match) {
        return fail({
          code: 'malformed-hunk-header',
          message:
            `unreadable hunk header on patch line ${patchLine}: ${JSON.stringify(raw)}. ` +
            'Expected the form "@@ -oldStart,oldLines +newStart,newLines @@".',
          patchLine,
        })
      }

      const oldStart = Number(match[1])
      const oldLines = match[2] === undefined ? 1 : Number(match[2])
      const newStart = Number(match[3])
      const newLines = match[4] === undefined ? 1 : Number(match[4])

      if (oldLines > 0 && oldStart < 1) {
        return fail({
          code: 'malformed-hunk-header',
          message:
            `hunk header on patch line ${patchLine} starts the old side at line ` +
            `${oldStart} while claiming ${oldLines} lines; line numbers are 1-based ` +
            'and only an empty range may start at 0',
          patchLine,
        })
      }
      if (newLines > 0 && newStart < 1) {
        return fail({
          code: 'malformed-hunk-header',
          message:
            `hunk header on patch line ${patchLine} starts the new side at line ` +
            `${newStart} while claiming ${newLines} lines; line numbers are 1-based ` +
            'and only an empty range may start at 0',
          patchLine,
        })
      }

      current = {
        oldStart,
        oldLines,
        newStart,
        newLines,
        heading: (match[5] ?? '').trim(),
        lines: [],
      }
      currentIndex = hunks.length
      currentHeaderLine = patchLine
      hunks.push(current)
      continue
    }

    if (!current) continue

    // The marker is checked BEFORE the "hunk already filled" skip below: it does
    // not count toward either side's line count, so it commonly arrives after the
    // final counted line and would otherwise be dropped.
    if (raw === NO_NEWLINE_MARKER || raw.startsWith('\\ No newline')) {
      const last = current.lines[current.lines.length - 1]
      if (!last) {
        return fail({
          code: 'orphan-no-newline-marker',
          message:
            `"\\ No newline at end of file" on patch line ${patchLine} does not ` +
            'follow a diff line, so there is nothing for it to describe',
          patchLine,
          hunkIndex: currentIndex,
        })
      }
      last.noNewlineAtEof = true
      continue
    }

    // Once a hunk holds every line its header promised, the rest is patch
    // furniture: git trailers, or the next file's `diff --git`/`---`/`+++` block.
    if (isSatisfied(current)) continue

    const prefix = raw[0]
    if (raw === '') {
      // Some tools strip the trailing space from an empty context line.
      current.lines.push({ kind: 'context', text: '' })
    } else if (prefix === ' ') {
      current.lines.push({ kind: 'context', text: raw.slice(1) })
    } else if (prefix === '+') {
      current.lines.push({ kind: 'add', text: raw.slice(1) })
    } else if (prefix === '-') {
      current.lines.push({ kind: 'remove', text: raw.slice(1) })
    } else {
      return fail({
        code: 'unexpected-line',
        message:
          `patch line ${patchLine} starts with ${JSON.stringify(prefix)} inside an ` +
          `unfinished hunk; hunk body lines must start with " ", "+", "-", or "\\"`,
        patchLine,
        hunkIndex: currentIndex,
      })
    }
  }

  if (current) {
    const problem = checkCounts(current, currentIndex, currentHeaderLine)
    if (problem) return fail(problem)
  }

  if (hunks.length === 0) {
    return fail({
      code: 'no-hunk-header',
      message:
        'no "@@" hunk header found: the text has content but is not a unified diff',
    })
  }

  return { ok: true, hunks }
}

// ---------------------------------------------------------------------------
// Applying a subset
// ---------------------------------------------------------------------------

function preview(text: string): string {
  const clipped = text.length > 60 ? `${text.slice(0, 60)}…` : text
  return JSON.stringify(clipped)
}

/**
 * Apply the hunks named by `selected` to `original`, leaving the rest alone.
 *
 * `selected` holds indexes into `hunks`. Passing every index yields the proposed
 * content; passing none returns `original` byte for byte, including its trailing
 * newline and any mixed line endings.
 *
 * Never throws. A hunk whose context does not match the file comes back as a
 * `context-mismatch` diagnostic naming the hunk and the line, so the review
 * surface can report a stale proposal instead of writing garbage.
 */
export function applyHunks(
  original: string,
  hunks: readonly Hunk[],
  selected: Iterable<number>,
): ApplyHunksResult {
  const ending = detectLineEnding(original)
  const source = splitSourceLines(original)

  const unique = [...new Set(selected)]
  for (const index of unique) {
    if (!Number.isInteger(index) || index < 0 || index >= hunks.length) {
      return fail({
        code: 'unknown-hunk-index',
        message:
          `selection names hunk index ${index}, but the diff has ` +
          `${hunks.length} hunk${hunks.length === 1 ? '' : 's'}`,
      })
    }
  }

  const chosen = unique
    .map((index) => ({ index, hunk: hunks[index]! }))
    .sort((a, b) => a.hunk.oldStart - b.hunk.oldStart || a.index - b.index)

  const out: SourceLine[] = []
  let cursor = 0

  for (const { index, hunk } of chosen) {
    // ---------------------------------------------------------------------
    // THE SUBSET-OFFSET GUARD
    // ---------------------------------------------------------------------
    // Positions are read in ORIGINAL coordinates (`oldStart`), and the output is
    // accumulated separately. A rejected hunk never advances `cursor`, so it
    // cannot displace an accepted hunk that follows it. Recompute this from
    // `newStart` and "accept 1 and 3, reject 2" lands hunk 3 at the wrong line;
    // there is a test that says so.
    const target = hunk.oldLines === 0 ? hunk.oldStart : hunk.oldStart - 1

    if (target < cursor) {
      return fail({
        code: 'hunk-out-of-order',
        message:
          `hunk ${index + 1} starts at old line ${hunk.oldStart}, which is at or ` +
          `before line ${cursor + 1} already consumed by an earlier hunk; ` +
          'overlapping hunks cannot both be accepted',
        hunkIndex: index,
      })
    }
    if (target > source.length) {
      return fail({
        code: 'hunk-out-of-range',
        message:
          `hunk ${index + 1} starts at old line ${hunk.oldStart}, past the end of ` +
          `a ${source.length}-line file`,
        hunkIndex: index,
      })
    }

    for (; cursor < target; cursor++) out.push(source[cursor]!)

    for (const line of hunk.lines) {
      if (line.kind === 'add') {
        out.push({ text: line.text, eol: line.noNewlineAtEof ? '' : ending.dominant })
        continue
      }

      const record = source[cursor]
      if (!record) {
        return fail({
          code: 'hunk-out-of-range',
          message:
            `hunk ${index + 1} expects a line at old line ${cursor + 1}, but the ` +
            `file has only ${source.length}`,
          hunkIndex: index,
        })
      }
      if (record.text !== line.text) {
        return fail({
          code: 'context-mismatch',
          message:
            `hunk ${index + 1} does not match the file at old line ${cursor + 1}: ` +
            `expected ${preview(line.text)}, found ${preview(record.text)}`,
          hunkIndex: index,
        })
      }

      if (line.kind === 'context') {
        // The surviving line keeps its OWN terminator, so a mixed-ending file
        // stays mixed. A final line that had none gains the dominant ending only
        // when the patch no longer says it is last.
        out.push({
          text: record.text,
          eol: line.noNewlineAtEof ? '' : record.eol === '' ? ending.dominant : record.eol,
        })
      }
      cursor++
    }
  }

  for (; cursor < source.length; cursor++) out.push(source[cursor]!)

  // Only the final line may lack a terminator. If content now follows what used
  // to be the last line, it needs one.
  for (let i = 0; i < out.length - 1; i++) {
    const line = out[i]!
    if (line.eol === '') out[i] = { text: line.text, eol: ending.dominant }
  }

  let content = ''
  for (const line of out) content += line.text + line.eol
  return { ok: true, content }
}

/** `[0, 1, 2, …]` — every hunk, for the accept-all path. */
export function allHunkIndexes(hunks: readonly unknown[]): number[] {
  return hunks.map((_, index) => index)
}
