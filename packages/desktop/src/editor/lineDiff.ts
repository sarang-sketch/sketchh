// A line diff for the editor: the inline-edit preview (what Ctrl+K would change) and the
// gutter's change markers (what changed since the last commit).
//
// Both run in the window on every request or pause in typing, so the algorithm is
// bounded: the common head and tail are matched first (an edit is almost always a small
// island in a large file), and only the island in between gets a real LCS. An island
// too big for that within the budget is reported as one replaced block — coarser, never
// wrong — instead of freezing the window on a 20,000-line rewrite.
//
// Line endings are not content here: `\r\n`, `\r` and `\n` all split lines, so a file
// checked out with CRLF compares equal to the LF text git stores.

export type DiffOpKind = 'equal' | 'insert' | 'delete'

/** A run of lines that are the same, only in the new text, or only in the old one. */
export interface DiffOp {
  kind: DiffOpKind
  lines: string[]
}

/** A change as the gutter shows it, in the NEW text's 1-based line numbers. */
export type LineChange =
  | { kind: 'added'; start: number; end: number }
  | { kind: 'modified'; start: number; end: number; removed: string[] }
  | { kind: 'deleted'; after: number; removed: string[] }

/** LCS cells allowed for the island between the common head and tail. */
export const DIFF_CELL_BUDGET = 4_000_000

export function splitLines(text: string): string[] {
  return text.split(/\r\n|\r|\n/)
}

function push(ops: DiffOp[], kind: DiffOpKind, lines: string[]): void {
  if (lines.length === 0) return
  const last = ops[ops.length - 1]
  if (last !== undefined && last.kind === kind) last.lines.push(...lines)
  else ops.push({ kind, lines: [...lines] })
}

/** The line-level edit from `a` to `b`, as runs of equal, inserted and deleted lines. */
export function diffLines(a: string[], b: string[], budget = DIFF_CELL_BUDGET): DiffOp[] {
  let head = 0
  while (head < a.length && head < b.length && a[head] === b[head]) head++
  let tail = 0
  while (tail < a.length - head && tail < b.length - head && a[a.length - 1 - tail] === b[b.length - 1 - tail]) tail++

  const ops: DiffOp[] = []
  push(ops, 'equal', a.slice(0, head))
  const midA = a.slice(head, a.length - tail)
  const midB = b.slice(head, b.length - tail)
  const n = midA.length
  const m = midB.length

  if (n === 0 || m === 0 || n * m > budget) {
    push(ops, 'delete', midA)
    push(ops, 'insert', midB)
  } else {
    // Intern lines so the table compares integers, not strings.
    const ids = new Map<string, number>()
    const idOf = (line: string) => {
      let id = ids.get(line)
      if (id === undefined) {
        id = ids.size
        ids.set(line, id)
      }
      return id
    }
    const x = midA.map(idOf)
    const y = midB.map(idOf)
    // lcs[i][j] = length of the LCS of x[i..] and y[j..], row-major in one typed array.
    const width = m + 1
    const lcs = new Uint32Array((n + 1) * width)
    for (let i = n - 1; i >= 0; i--) {
      for (let j = m - 1; j >= 0; j--) {
        lcs[i * width + j] =
          x[i] === y[j] ? lcs[(i + 1) * width + j + 1]! + 1 : Math.max(lcs[(i + 1) * width + j]!, lcs[i * width + j + 1]!)
      }
    }
    let i = 0
    let j = 0
    while (i < n && j < m) {
      if (x[i] === y[j]) {
        push(ops, 'equal', [midA[i]!])
        i++
        j++
      } else if (lcs[(i + 1) * width + j]! >= lcs[i * width + j + 1]!) {
        push(ops, 'delete', [midA[i]!])
        i++
      } else {
        push(ops, 'insert', [midB[j]!])
        j++
      }
    }
    push(ops, 'delete', midA.slice(i))
    push(ops, 'insert', midB.slice(j))
  }

  push(ops, 'equal', a.slice(a.length - tail))
  return ops
}

/**
 * What changed from `base` (the committed text) to `current` (the buffer), as gutter
 * markers. A removal next to an insertion is one modification, as in every editor.
 */
export function lineChanges(base: string, current: string, budget = DIFF_CELL_BUDGET): LineChange[] {
  if (base === current) return []
  const ops = diffLines(splitLines(base), splitLines(current), budget)
  const changes: LineChange[] = []
  let line = 1
  let index = 0
  while (index < ops.length) {
    const op = ops[index]!
    if (op.kind === 'equal') {
      line += op.lines.length
      index++
      continue
    }
    // A block of adjacent deletes and inserts, in either order.
    const removed: string[] = []
    let added = 0
    while (index < ops.length && ops[index]!.kind !== 'equal') {
      const block = ops[index]!
      if (block.kind === 'delete') removed.push(...block.lines)
      else added += block.lines.length
      index++
    }
    if (added > 0 && removed.length > 0) changes.push({ kind: 'modified', start: line, end: line + added - 1, removed })
    else if (added > 0) changes.push({ kind: 'added', start: line, end: line + added - 1 })
    else changes.push({ kind: 'deleted', after: line - 1, removed })
    line += added
  }
  return changes
}

/** The change a caret on `lineNumber` is in or right next to (a deletion has no lines of its own). */
export function changeAt(changes: readonly LineChange[], lineNumber: number): LineChange | null {
  for (const change of changes) {
    if (change.kind === 'deleted') {
      if (lineNumber === change.after || lineNumber === change.after + 1 || (change.after === 0 && lineNumber === 1)) return change
    } else if (lineNumber >= change.start && lineNumber <= change.end) {
      return change
    }
  }
  return null
}

/** The first line of a change, for "go to next change". */
export function changeLine(change: LineChange): number {
  return change.kind === 'deleted' ? Math.max(1, change.after) : change.start
}
