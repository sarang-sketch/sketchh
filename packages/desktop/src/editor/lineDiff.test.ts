// The arithmetic behind Ctrl+K's preview, the gutter's change markers and Revert Change.
//
// What these pin, in user terms:
//   * a change is shown as the lines it touched, not as the whole file;
//   * an added, a changed and a deleted line each get the right marker on the right line,
//     CRLF files included;
//   * Revert Change puts back exactly what the last commit had — checked by reverting
//     every change of hundreds of random edits and comparing with the original text;
//   * an inline edit replaces whole lines, and a selection that ends at the start of a
//     line does not take that line.

import { describe, expect, it } from 'vitest'

import { changeAt, changeLine, diffLines, lineChanges, splitLines } from './lineDiff'
import {
  applyEdit,
  eolOf,
  isEmptyRange,
  lineRange,
  lineTable,
  maxColumn,
  offsetAt,
  revertEdit,
  sliceAround,
  wholeLines,
  withEol,
} from './inlineEditing'
import { diffRows } from './InlineEditWidget'

describe('diffLines', () => {
  it('keeps the common head and tail and diffs only the island between', () => {
    const ops = diffLines(['a', 'b', 'c', 'd'], ['a', 'B', 'c', 'd'])
    expect(ops).toEqual([
      { kind: 'equal', lines: ['a'] },
      { kind: 'delete', lines: ['b'] },
      { kind: 'insert', lines: ['B'] },
      { kind: 'equal', lines: ['c', 'd'] },
    ])
  })

  it('finds the longest common run inside a reordered island', () => {
    const ops = diffLines(['x', 'a', 'b', 'y'], ['x', 'b', 'a', 'b', 'y'])
    const rebuilt = ops.filter((op) => op.kind !== 'delete').flatMap((op) => op.lines)
    expect(rebuilt).toEqual(['x', 'b', 'a', 'b', 'y'])
    expect(ops.filter((op) => op.kind === 'insert').flatMap((op) => op.lines)).toEqual(['b'])
  })

  it('reports an island too large for the budget as one replaced block, still correct', () => {
    const a = Array.from({ length: 50 }, (_, i) => `a${i}`)
    const b = Array.from({ length: 50 }, (_, i) => `b${i}`)
    const ops = diffLines(a, b, 100)
    expect(ops).toEqual([
      { kind: 'delete', lines: a },
      { kind: 'insert', lines: b },
    ])
  })
})

describe('lineChanges', () => {
  it('marks added, modified and deleted lines in the new text', () => {
    const base = 'one\ntwo\nthree\nfour\nfive\n'
    const current = 'one\nTWO\nthree\nfive\nsix\n'
    expect(lineChanges(base, current)).toEqual([
      { kind: 'modified', start: 2, end: 2, removed: ['two'] },
      { kind: 'deleted', after: 3, removed: ['four'] },
      { kind: 'added', start: 5, end: 5 },
    ])
  })

  it('treats CRLF on disk and LF in git as the same text', () => {
    expect(lineChanges('a\nb\n', 'a\r\nb\r\n')).toEqual([])
    expect(lineChanges('a\nb\n', 'a\r\nB\r\n')).toEqual([{ kind: 'modified', start: 2, end: 2, removed: ['b'] }])
  })

  it('marks a deletion at the very top', () => {
    expect(lineChanges('gone\nkept\n', 'kept\n')).toEqual([{ kind: 'deleted', after: 0, removed: ['gone'] }])
  })

  it('finds the change under the caret, and where each one starts', () => {
    const changes = lineChanges('a\nb\nc\nd\n', 'a\nB\nc\n')
    expect(changeAt(changes, 2)).toMatchObject({ kind: 'modified', start: 2 })
    expect(changeAt(changes, 1)).toBeNull()
    // A deletion has no line of its own: the lines around it find it.
    expect(changeAt(changes, 3)).toMatchObject({ kind: 'deleted', after: 3 })
    expect(changes.map(changeLine)).toEqual([2, 3])
  })
})

describe('line table', () => {
  it('numbers CRLF, CR and LF lines like Monaco and finds offsets inside them', () => {
    const text = 'ab\r\ncd\nef\rg'
    const table = lineTable(text)
    expect(table.starts).toEqual([0, 4, 7, 10])
    expect(table.lengths).toEqual([2, 2, 2, 1])
    expect(maxColumn(table, 2)).toBe(3)
    expect(text.slice(offsetAt(table, 2, 1), offsetAt(table, 2, 3))).toBe('cd')
    // A column past the end of a line stops at the line ending.
    expect(offsetAt(table, 1, 99)).toBe(2)
    expect(eolOf(text)).toBe('\r\n')
    expect(withEol('a\nb\r\nc', '\r\n')).toBe('a\r\nb\r\nc')
  })
})

describe('inline edit ranges', () => {
  const text = 'function f() {\n  const a = 1\n  return a\n}\n'
  const table = lineTable(text)

  it('grows a partial selection to whole lines', () => {
    const range = wholeLines({ startLineNumber: 2, startColumn: 9, endLineNumber: 3, endColumn: 5 }, table)
    expect(range).toEqual({ startLineNumber: 2, startColumn: 1, endLineNumber: 3, endColumn: 11 })
    expect(sliceAround(text, range).inside).toBe('  const a = 1\n  return a')
  })

  it('does not take a line the selection only touched at its start', () => {
    const range = wholeLines({ startLineNumber: 2, startColumn: 1, endLineNumber: 4, endColumn: 1 }, table)
    expect(range.endLineNumber).toBe(3)
  })

  it('handles a selection made bottom-up', () => {
    const range = wholeLines({ startLineNumber: 3, startColumn: 4, endLineNumber: 2, endColumn: 3 }, table)
    expect(range).toMatchObject({ startLineNumber: 2, endLineNumber: 3 })
  })

  it('clamps explicit line ranges into the file, and knows an empty range', () => {
    expect(lineRange(table, 0, 99)).toEqual({ startLineNumber: 1, startColumn: 1, endLineNumber: 5, endColumn: 1 })
    expect(isEmptyRange({ startLineNumber: 2, startColumn: 3, endLineNumber: 2, endColumn: 3 })).toBe(true)
  })

  it('splits the buffer into what is before, inside and after a range', () => {
    const parts = sliceAround(text, { startLineNumber: 3, startColumn: 1, endLineNumber: 3, endColumn: 11 })
    expect(parts.before + parts.inside + parts.after).toBe(text)
    expect(parts.inside).toBe('  return a')
  })
})

describe('Revert Change', () => {
  const revertAll = (base: string, current: string, eol = '\n') => {
    let text = current
    // From the last change to the first, so earlier line numbers stay valid.
    for (const change of [...lineChanges(base, current)].reverse()) {
      text = applyEdit(text, revertEdit(change, lineTable(text), eol))
    }
    return text
  }

  it('puts back a modified, an added and a deleted line', () => {
    expect(revertAll('a\nb\nc\n', 'a\nB\nc\n')).toBe('a\nb\nc\n')
    expect(revertAll('a\nc\n', 'a\nb\nc\n')).toBe('a\nc\n')
    expect(revertAll('a\nb\nc\n', 'a\nc\n')).toBe('a\nb\nc\n')
  })

  it('handles the edges: first line, last line, no final line break, the whole file', () => {
    expect(revertAll('x\na\n', 'a\n')).toBe('x\na\n')
    expect(revertAll('a', 'a\nb')).toBe('a')
    expect(revertAll('a\nb', 'a')).toBe('a\nb')
    expect(revertAll('', 'new\nfile\n')).toBe('')
  })

  it('writes the restored lines with the file’s own line ending', () => {
    expect(revertAll('a\nb\nc\n', 'a\r\nB\r\nc\r\n', '\r\n')).toBe('a\r\nb\r\nc\r\n')
  })

  it('restores the original from hundreds of random edits', () => {
    let seed = 20261008
    const random = () => {
      seed = (seed * 1103515245 + 12345) % 2147483648
      return seed / 2147483648
    }
    const pick = <T,>(items: readonly T[]) => items[Math.floor(random() * items.length)]!
    const words = ['alpha', 'beta', 'gamma', 'delta', '', 'return x', '}', '  if (a) {']
    for (let round = 0; round < 300; round++) {
      const base = Array.from({ length: 1 + Math.floor(random() * 12) }, () => pick(words))
      const current = [...base]
      for (let edit = Math.floor(random() * 5); edit > 0; edit--) {
        const at = Math.floor(random() * (current.length + 1))
        const roll = random()
        if (roll < 0.33) current.splice(at, 0, pick(words))
        else if (roll < 0.66 && current.length > 0) current.splice(Math.min(at, current.length - 1), 1)
        else if (current.length > 0) current[Math.min(at, current.length - 1)] = `${pick(words)}!`
      }
      const ending = random() < 0.5 ? '\n' : ''
      const baseText = base.join('\n') + ending
      const currentText = current.join('\n') + ending
      expect(revertAll(baseText, currentText), `round ${round}: ${JSON.stringify([baseText, currentText])}`).toBe(baseText)
    }
  })
})

describe('the inline edit preview', () => {
  it('shows removed and added lines and folds long unchanged runs', () => {
    const original = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'].join('\n')
    const proposed = ['a', 'B', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'J'].join('\n')
    const rows = diffRows(original, proposed)
    expect(rows).toEqual([
      { kind: 'equal', text: 'a' },
      { kind: 'delete', text: 'b' },
      { kind: 'insert', text: 'B' },
      { kind: 'equal', text: 'c' },
      { kind: 'equal', text: 'd' },
      { kind: 'fold', count: 3 },
      { kind: 'equal', text: 'h' },
      { kind: 'equal', text: 'i' },
      { kind: 'delete', text: 'j' },
      { kind: 'insert', text: 'J' },
    ])
  })

  it('shows an insertion as all added lines', () => {
    expect(diffRows('', 'x\ny')).toEqual([
      { kind: 'insert', text: 'x' },
      { kind: 'insert', text: 'y' },
    ])
    expect(splitLines('')).toEqual([''])
  })
})
