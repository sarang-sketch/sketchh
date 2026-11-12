// Ranges and edits for the editor's AI and git actions, computed from the buffer text.
//
// Pure, so the arithmetic that decides WHICH characters an inline edit replaces or a
// Revert Change restores is pinned by tests rather than trusted to the editor. Lines
// and columns are 1-based like Monaco's, and every line ending counts as one line break
// (`\r\n` included), which is how Monaco numbers the lines of a CRLF file.

import type { EditorEdit, SelectionRange } from './monacoApi'
import type { LineChange } from './lineDiff'

/** Ask the editor to open inline edit (Ctrl+K) — from a menu, the palette, or Problems. */
export const INLINE_EDIT_EVENT = 'sketch:inline-edit'

export interface InlineEditRequestDetail {
  /** Only for this file; ignored until it is the one on screen. */
  path?: string
  /** Lines to edit (1-based, inclusive). Default: the selection, or the caret's line. */
  lines?: { start: number; end: number }
  instruction?: string
  /** Generate at once (the instruction is already known). */
  autoRun?: boolean
}

export function requestInlineEdit(detail: InlineEditRequestDetail = {}): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(INLINE_EDIT_EVENT, { detail }))
}

/** Where each line starts in the text, and how long it is without its line ending. */
export interface LineTable {
  starts: number[]
  lengths: number[]
}

export function lineTable(text: string): LineTable {
  const starts = [0]
  const lengths: number[] = []
  let lineStart = 0
  let i = 0
  while (i < text.length) {
    const ch = text.charCodeAt(i)
    if (ch === 10 || ch === 13) {
      lengths.push(i - lineStart)
      i += ch === 13 && text.charCodeAt(i + 1) === 10 ? 2 : 1
      lineStart = i
      starts.push(lineStart)
    } else {
      i++
    }
  }
  lengths.push(text.length - lineStart)
  return { starts, lengths }
}

export function lineCount(table: LineTable): number {
  return table.starts.length
}

/** The column just past the last character of `line`. */
export function maxColumn(table: LineTable, line: number): number {
  return (table.lengths[line - 1] ?? 0) + 1
}

/** Character offset of a (line, column) position, clamped into the text. */
export function offsetAt(table: LineTable, line: number, column: number): number {
  const index = Math.min(Math.max(line, 1), table.starts.length) - 1
  return table.starts[index]! + Math.min(Math.max(column, 1) - 1, table.lengths[index]!)
}

export function isEmptyRange(range: SelectionRange): boolean {
  return range.startLineNumber === range.endLineNumber && range.startColumn === range.endColumn
}

/**
 * A selection grown to whole lines, as inline edit rewrites them: from the first
 * column of its first line to the end of its last. A selection that ends at the very
 * start of a line (a drag that stopped just past a line break) does not take that line.
 */
export function wholeLines(selection: SelectionRange, table: LineTable): SelectionRange {
  const start = Math.min(selection.startLineNumber, selection.endLineNumber)
  let end = Math.max(selection.startLineNumber, selection.endLineNumber)
  const endColumn = selection.endLineNumber >= selection.startLineNumber ? selection.endColumn : selection.startColumn
  if (end > start && endColumn === 1) end -= 1
  return { startLineNumber: start, startColumn: 1, endLineNumber: end, endColumn: maxColumn(table, end) }
}

/** Lines `start`–`end` (1-based, inclusive) as a range, clamped into the text. */
export function lineRange(table: LineTable, start: number, end: number): SelectionRange {
  const count = lineCount(table)
  const first = Math.min(Math.max(start, 1), count)
  const last = Math.min(Math.max(end, first), count)
  return { startLineNumber: first, startColumn: 1, endLineNumber: last, endColumn: maxColumn(table, last) }
}

/** The text before, inside and after `range`. */
export function sliceAround(text: string, range: SelectionRange): { before: string; inside: string; after: string } {
  const table = lineTable(text)
  const from = offsetAt(table, range.startLineNumber, range.startColumn)
  const to = offsetAt(table, range.endLineNumber, range.endColumn)
  return { before: text.slice(0, from), inside: text.slice(from, to), after: text.slice(to) }
}

/** The line ending a buffer uses: CRLF if it has any, LF otherwise. */
export function eolOf(text: string): '\r\n' | '\n' {
  return text.includes('\r\n') ? '\r\n' : '\n'
}

/** `text` with every line ending made `eol`. */
export function withEol(text: string, eol: string): string {
  return text.replace(/\r\n|\r|\n/g, eol)
}

/** Apply one edit to a text, as Monaco would. For tests and previews. */
export function applyEdit(text: string, edit: EditorEdit): string {
  const { before, after } = sliceAround(text, edit.range)
  return `${before}${edit.text}${after}`
}

/**
 * The edit that puts one change back the way HEAD has it (Revert Change).
 *
 * A modification puts back the lines it replaced; an addition removes its lines along
 * with one line break, so no blank line is left behind; a deletion re-inserts the lines
 * it removed where they were.
 */
export function revertEdit(change: LineChange, table: LineTable, eol: string): EditorEdit {
  const count = lineCount(table)
  if (change.kind === 'modified') {
    return {
      range: { startLineNumber: change.start, startColumn: 1, endLineNumber: change.end, endColumn: maxColumn(table, change.end) },
      text: change.removed.join(eol),
    }
  }
  if (change.kind === 'added') {
    if (change.end < count) {
      return { range: { startLineNumber: change.start, startColumn: 1, endLineNumber: change.end + 1, endColumn: 1 }, text: '' }
    }
    if (change.start > 1) {
      return {
        range: {
          startLineNumber: change.start - 1,
          startColumn: maxColumn(table, change.start - 1),
          endLineNumber: change.end,
          endColumn: maxColumn(table, change.end),
        },
        text: '',
      }
    }
    return { range: { startLineNumber: 1, startColumn: 1, endLineNumber: change.end, endColumn: maxColumn(table, change.end) }, text: '' }
  }
  const restored = change.removed.join(eol)
  if (change.after >= 1) {
    const column = maxColumn(table, change.after)
    return {
      range: { startLineNumber: change.after, startColumn: column, endLineNumber: change.after, endColumn: column },
      text: `${eol}${restored}`,
    }
  }
  return { range: { startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 1 }, text: `${restored}${eol}` }
}
