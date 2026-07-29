// ANSI parsing is data-only. These invariants keep hostile process output away
// from any HTML-producing path.
// Validates: Requirements 27.1, 27.4

import { describe, expect, it } from 'vitest'
import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { parseAnsi, toAnsiLines } from './ansi'

const source = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'ansi.ts'), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/^[ \t]*\/\/.*$/gm, '')

describe('ANSI parser guard', () => {
  it('returns literal markup-shaped text, never markup', () => {
    const hostile = '<img src=x onerror="window.pwned=true"><script>alert(1)</script>'
    expect(parseAnsi(hostile)).toEqual([{ text: hostile, color: null, bold: false }])
  })

  it('interprets SGR while dropping cursor, hyperlink, and control sequences', () => {
    const input =
      '\u001b[31mred\u001b[1m!\u001b[0m plain' +
      '\u001b[2J\u001b]8;;https://invalid.example\u0007link\u001b]8;;\u0007\u0000'
    expect(parseAnsi(input)).toEqual([
      { text: 'red', color: 'red', bold: false },
      { text: '!', color: 'red', bold: true },
      { text: ' plainlink', color: null, bold: false },
    ])
  })

  it('splits lines without inventing a trailing blank row', () => {
    expect(toAnsiLines('\u001b[32ma\nb\n')).toEqual([
      [{ text: 'a', color: 'green', bold: false }],
      [{ text: 'b', color: 'green', bold: false }],
    ])
  })

  it('contains no DOM or HTML rendering API', () => {
    expect(source).not.toContain('dangerouslySetInnerHTML')
    expect(source).not.toContain('innerHTML')
    expect(source).not.toContain('document.')
    expect(source).not.toContain('DOMParser')
  })
})
