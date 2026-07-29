// Unified-diff parser and per-hunk applier tests.
//
// Uses REAL strings only — no filesystem, no mocks. This module is pure, so the
// tests are the specification: if a hunk applies here it applies on disk.
//
// The order of this file is deliberate. "accept hunks 1 and 3, reject 2" comes
// first among the apply tests because it is the test that was written before the
// applier existed, and it is the one that fails the moment the subset-offset
// guard in `applyHunks` is weakened.
//
// Validates: Requirements 16.1, 16.2, 16.3, 16.5

import { describe, it, expect } from 'vitest'

import {
  parseUnifiedDiff,
  applyHunks,
  detectLineEnding,
  allHunkIndexes,
} from '../src/diff/index.js'
import type { Hunk } from '../src/diff/index.js'

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Parse, or fail the test with the diagnostic rather than a null-deref later. */
function parseOk(patch: string): Hunk[] {
  const result = parseUnifiedDiff(patch)
  if (!result.ok) throw new Error(`expected a parse, got: ${result.error.message}`)
  return result.hunks
}

/** Apply, or fail the test with the diagnostic. */
function applyOk(original: string, hunks: readonly Hunk[], selected: Iterable<number>): string {
  const result = applyHunks(original, hunks, selected)
  if (!result.ok) throw new Error(`expected an apply, got: ${result.error.message}`)
  return result.content
}

/** Join with an explicit ending, always with a trailing terminator. */
function file(lines: readonly string[], eol = '\n'): string {
  return lines.map((line) => line + eol).join('')
}

// ---------------------------------------------------------------------------
// The three-hunk fixture the subset test hangs on
// ---------------------------------------------------------------------------

const TWELVE = [
  'one',
  'two',
  'three',
  'four',
  'five',
  'six',
  'seven',
  'eight',
  'nine',
  'ten',
  'eleven',
  'twelve',
]

const ORIGINAL = file(TWELVE)

// Hunk 2 is a net +1 line, which is exactly what makes hunk 3's placement a real
// question: its new-side start (10) differs from its old-side start (9).
const THREE_HUNK_PATCH = [
  '@@ -1,3 +1,3 @@',
  ' one',
  '-two',
  '+TWO',
  ' three',
  '@@ -5,3 +5,4 @@',
  ' five',
  '-six',
  '+SIX',
  '+six-and-a-half',
  ' seven',
  '@@ -9,3 +10,3 @@',
  ' nine',
  '-ten',
  '+TEN',
  ' eleven',
  '',
].join('\n')

const PROPOSED = file([
  'one',
  'TWO',
  'three',
  'four',
  'five',
  'SIX',
  'six-and-a-half',
  'seven',
  'eight',
  'nine',
  'TEN',
  'eleven',
  'twelve',
])

// ---------------------------------------------------------------------------
// Applying a subset
// ---------------------------------------------------------------------------

describe('applyHunks — per-hunk selection', () => {
  it('lands accepted hunk 3 at the right line when hunk 2 is rejected', () => {
    // Requirement 16.2. Hunk 2 adds a line, so anything that positions hunk 3 by
    // its new-side start puts "TEN" on the wrong line — or fails to match at all.
    const hunks = parseOk(THREE_HUNK_PATCH)
    expect(hunks).toHaveLength(3)

    const content = applyOk(ORIGINAL, hunks, [0, 2])

    expect(content).toBe(
      file([
        'one',
        'TWO',
        'three',
        'four',
        'five',
        'six', // hunk 2 rejected: untouched, and no extra line
        'seven',
        'eight',
        'nine',
        'TEN', // hunk 3 accepted: still on line 10
        'eleven',
        'twelve',
      ]),
    )
  })

  it('accepts a middle hunk alone without disturbing its neighbours', () => {
    const hunks = parseOk(THREE_HUNK_PATCH)

    expect(applyOk(ORIGINAL, hunks, [1])).toBe(
      file([
        'one',
        'two',
        'three',
        'four',
        'five',
        'SIX',
        'six-and-a-half',
        'seven',
        'eight',
        'nine',
        'ten',
        'eleven',
        'twelve',
      ]),
    )
  })

  it('is indifferent to the order the selection is given in', () => {
    const hunks = parseOk(THREE_HUNK_PATCH)
    expect(applyOk(ORIGINAL, hunks, [2, 0])).toBe(applyOk(ORIGINAL, hunks, [0, 2]))
  })

  it('applies every hunk to reach the proposed content', () => {
    // Round-trip property, half one. Requirement 16.1.
    const hunks = parseOk(THREE_HUNK_PATCH)
    expect(applyOk(ORIGINAL, hunks, allHunkIndexes(hunks))).toBe(PROPOSED)
  })

  it('returns the original byte-for-byte when every hunk is rejected', () => {
    // Round-trip property, half two. Requirement 16.5: nothing to write means
    // nothing on disk changes.
    const hunks = parseOk(THREE_HUNK_PATCH)
    const content = applyOk(ORIGINAL, hunks, [])
    expect(content).toBe(ORIGINAL)
    expect(Buffer.from(content, 'utf8').equals(Buffer.from(ORIGINAL, 'utf8'))).toBe(true)
  })
})

describe('applyHunks — insertions and deletions at the edges', () => {
  it('inserts a pure-insertion hunk after its old-side start line', () => {
    const hunks = parseOk(
      ['@@ -2,0 +3,2 @@', '+alpha', '+beta', ''].join('\n'),
    )
    expect(hunks[0]!.oldLines).toBe(0)
    expect(applyOk(file(['a', 'b', 'c']), hunks, [0])).toBe(
      file(['a', 'b', 'alpha', 'beta', 'c']),
    )
  })

  it('creates content from an empty file with a -0,0 hunk', () => {
    const hunks = parseOk(['@@ -0,0 +1,2 @@', '+first', '+second', ''].join('\n'))
    expect(applyOk('', hunks, [0])).toBe(file(['first', 'second']))
  })

  it('deletes the whole body of a hunk with no additions', () => {
    const hunks = parseOk(
      ['@@ -1,4 +1,2 @@', ' a', '-b', '-c', ' d', ''].join('\n'),
    )
    expect(applyOk(file(['a', 'b', 'c', 'd']), hunks, [0])).toBe(file(['a', 'd']))
  })
})

// ---------------------------------------------------------------------------
// Line endings — the CRLF trap
// ---------------------------------------------------------------------------

describe('line endings', () => {
  it('reports the dominant ending and whether the file is mixed', () => {
    expect(detectLineEnding('a\r\nb\r\n')).toMatchObject({ dominant: '\r\n', mixed: false })
    expect(detectLineEnding('a\nb\n')).toMatchObject({ dominant: '\n', mixed: false })
    expect(detectLineEnding('a\r\nb\r\nc\n')).toMatchObject({ dominant: '\r\n', mixed: true })
    expect(detectLineEnding('no terminator')).toMatchObject({ dominant: '\n', mixed: false })
  })

  it('keeps a CRLF file on CRLF, including lines the patch adds', () => {
    const crlf = file(['alpha', 'beta', 'gamma'], '\r\n')
    const hunks = parseOk(
      ['@@ -1,3 +1,4 @@', ' alpha', '-beta', '+BETA', '+delta', ' gamma', ''].join('\n'),
    )

    const content = applyOk(crlf, hunks, [0])

    expect(content).toBe(file(['alpha', 'BETA', 'delta', 'gamma'], '\r\n'))
    expect(content).not.toContain('\n\n')
    // No lone LF anywhere: every terminator is a full CRLF pair.
    expect(content.replace(/\r\n/g, '')).not.toContain('\n')
  })

  it('leaves a CRLF file byte-identical when every hunk is rejected', () => {
    const crlf = file(['alpha', 'beta', 'gamma'], '\r\n')
    const hunks = parseOk(
      ['@@ -1,3 +1,4 @@', ' alpha', '-beta', '+BETA', '+delta', ' gamma', ''].join('\n'),
    )
    expect(applyOk(crlf, hunks, [])).toBe(crlf)
  })

  it('does not silently normalise a mixed-ending file', () => {
    // Lines that survive keep their OWN terminator; only the added line takes the
    // dominant one. Rewriting the untouched CRLF lines as LF would be a silent
    // whole-file change the reviewer never asked for.
    const mixed = 'a\r\nb\r\nc\nd\r\n'
    const hunks = parseOk(['@@ -3,1 +3,2 @@', ' c', '+inserted', ''].join('\n'))

    const content = applyOk(mixed, hunks, [0])

    expect(content).toBe('a\r\nb\r\nc\ninserted\r\nd\r\n')
    expect(applyOk(mixed, hunks, [])).toBe(mixed)
  })
})

describe('no newline at end of file', () => {
  it('parses the marker onto the line it describes', () => {
    const hunks = parseOk(
      [
        '@@ -1,2 +1,2 @@',
        ' a',
        '-b',
        '\\ No newline at end of file',
        '+B',
        '\\ No newline at end of file',
        '',
      ].join('\n'),
    )
    expect(hunks[0]!.lines[1]).toMatchObject({ kind: 'remove', noNewlineAtEof: true })
    expect(hunks[0]!.lines[2]).toMatchObject({ kind: 'add', noNewlineAtEof: true })
  })

  it('keeps a file that ends without a terminator ending without one', () => {
    const hunks = parseOk(
      [
        '@@ -1,2 +1,2 @@',
        ' a',
        '-b',
        '\\ No newline at end of file',
        '+B',
        '\\ No newline at end of file',
        '',
      ].join('\n'),
    )
    expect(applyOk('a\nb', hunks, [0])).toBe('a\nB')
  })

  it('gives the old final line a terminator when the patch appends below it', () => {
    const hunks = parseOk(
      [
        '@@ -2,1 +2,2 @@',
        ' b',
        '\\ No newline at end of file',
        '+c',
        '\\ No newline at end of file',
        '',
      ].join('\n'),
    )
    expect(applyOk('a\nb', hunks, [0])).toBe('a\nb\nc')
  })
})

// ---------------------------------------------------------------------------
// Parsing
// ---------------------------------------------------------------------------

describe('parseUnifiedDiff', () => {
  it('reads header coordinates and tags every body line', () => {
    const hunks = parseOk(THREE_HUNK_PATCH)

    expect(hunks[0]).toMatchObject({ oldStart: 1, oldLines: 3, newStart: 1, newLines: 3 })
    expect(hunks[1]).toMatchObject({ oldStart: 5, oldLines: 3, newStart: 5, newLines: 4 })
    expect(hunks[2]).toMatchObject({ oldStart: 9, oldLines: 3, newStart: 10, newLines: 3 })

    expect(hunks[1]!.lines).toEqual([
      { kind: 'context', text: 'five' },
      { kind: 'remove', text: 'six' },
      { kind: 'add', text: 'SIX' },
      { kind: 'add', text: 'six-and-a-half' },
      { kind: 'context', text: 'seven' },
    ])
  })

  it('treats an omitted count as exactly one line', () => {
    const hunks = parseOk(['@@ -4 +4 @@', '-four', '+FOUR', ''].join('\n'))
    expect(hunks[0]).toMatchObject({ oldStart: 4, oldLines: 1, newStart: 4, newLines: 1 })
    expect(applyOk(file(['one', 'two', 'three', 'four']), hunks, [0])).toBe(
      file(['one', 'two', 'three', 'FOUR']),
    )
  })

  it('keeps the section heading and skips git file furniture', () => {
    const patch = [
      'diff --git a/src/app.ts b/src/app.ts',
      'index 83db48f..bf269f4 100644',
      '--- a/src/app.ts',
      '+++ b/src/app.ts',
      '@@ -1,2 +1,2 @@ function main() {',
      ' one',
      '-two',
      '+TWO',
      '',
    ].join('\n')

    const hunks = parseOk(patch)
    expect(hunks).toHaveLength(1)
    expect(hunks[0]!.heading).toBe('function main() {')
  })

  it('reads an empty context line whose trailing space was stripped', () => {
    const hunks = parseOk(['@@ -1,3 +1,3 @@', ' a', '', '-c', '+C', ''].join('\n'))
    expect(hunks[0]!.lines[1]).toEqual({ kind: 'context', text: '' })
    expect(applyOk('a\n\nc\n', hunks, [0])).toBe('a\n\nC\n')
  })

  it('reports zero hunks for an empty patch', () => {
    const result = parseUnifiedDiff('')
    expect(result).toEqual({ ok: true, hunks: [] })
  })
})

describe('parseUnifiedDiff — malformed input names the problem', () => {
  it('refuses text with no hunk header', () => {
    const result = parseUnifiedDiff('this is prose, not a patch\n')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('no-hunk-header')
    expect(result.error.message).toContain('@@')
  })

  it('refuses an unreadable header', () => {
    const result = parseUnifiedDiff('@@ nonsense @@\n one\n')
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('malformed-hunk-header')
    expect(result.error.patchLine).toBe(1)
  })

  it('refuses a header whose counts do not match its body', () => {
    const result = parseUnifiedDiff(['@@ -1,4 +1,4 @@', ' a', '-b', '+B', ''].join('\n'))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('hunk-count-mismatch')
    expect(result.error.hunkIndex).toBe(0)
    expect(result.error.message).toContain('promises 4 old')
  })

  it('refuses a body line with an unknown prefix', () => {
    const result = parseUnifiedDiff(['@@ -1,3 +1,3 @@', ' a', '?b', ' c', ''].join('\n'))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('unexpected-line')
    expect(result.error.patchLine).toBe(3)
  })

  it('refuses a no-newline marker that describes nothing', () => {
    const result = parseUnifiedDiff(
      ['@@ -1,2 +1,2 @@', '\\ No newline at end of file', ' a', '-b', '+B', ''].join('\n'),
    )
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('orphan-no-newline-marker')
  })

  it('refuses a 1-based header that starts a non-empty range at zero', () => {
    const result = parseUnifiedDiff(['@@ -0,2 +1,2 @@', ' a', '-b', '+B', ''].join('\n'))
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('malformed-hunk-header')
  })
})

// ---------------------------------------------------------------------------
// Failure is data, not an exception
// ---------------------------------------------------------------------------

describe('applyHunks — refusals are typed, never thrown', () => {
  it('reports a hunk that does not match the file', () => {
    const hunks = parseOk(['@@ -1,2 +1,2 @@', ' a', '-b', '+B', ''].join('\n'))
    const result = applyHunks(file(['a', 'DIFFERENT']), hunks, [0])

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('context-mismatch')
    expect(result.error.hunkIndex).toBe(0)
    expect(result.error.message).toContain('old line 2')
    expect(result.error.message).toContain('DIFFERENT')
  })

  it('reports a hunk that starts past the end of the file', () => {
    const hunks = parseOk(['@@ -40,1 +40,2 @@', ' x', '+y', ''].join('\n'))
    const result = applyHunks(file(['a', 'b']), hunks, [0])

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('hunk-out-of-range')
  })

  it('reports two accepted hunks that overlap', () => {
    const hunks: Hunk[] = [
      {
        oldStart: 1,
        oldLines: 2,
        newStart: 1,
        newLines: 2,
        heading: '',
        lines: [
          { kind: 'context', text: 'a' },
          { kind: 'remove', text: 'b' },
          { kind: 'add', text: 'B' },
        ],
      },
      {
        oldStart: 2,
        oldLines: 1,
        newStart: 2,
        newLines: 1,
        heading: '',
        lines: [
          { kind: 'remove', text: 'b' },
          { kind: 'add', text: 'BB' },
        ],
      },
    ]

    const result = applyHunks(file(['a', 'b', 'c']), hunks, [0, 1])
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('hunk-out-of-order')
  })

  it('reports a selection naming a hunk that does not exist', () => {
    const hunks = parseOk(['@@ -1,1 +1,1 @@', '-a', '+A', ''].join('\n'))
    const result = applyHunks(file(['a']), hunks, [0, 7])

    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.error.code).toBe('unknown-hunk-index')
    expect(result.error.message).toContain('1 hunk')
  })
})

// ---------------------------------------------------------------------------
// Round-trip properties over generated diffs
// ---------------------------------------------------------------------------
//
// Two assertions, enormous coverage: apply(all) is the proposal, apply(none) is
// the original. Both are checked against content built INDEPENDENTLY of the
// applier — the generator walks its own edit script to produce the proposed text,
// so neither property can pass by tautology.
//
// The generator is a seeded LCG rather than a property-testing library: core is
// dependency-free and the deterministic seed means a failure is reproducible from
// the printed case alone.

/** Deterministic 32-bit LCG. Same seed, same cases, every run and machine. */
function rng(seed: number): () => number {
  let state = seed >>> 0
  return () => {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0
    return state / 0x100000000
  }
}

interface GeneratedCase {
  original: string
  proposed: string
  hunks: Hunk[]
  eol: string
}

/**
 * Build a random file plus a random set of non-overlapping single-line-context
 * hunks, and derive the proposed content directly from the edit script.
 */
function generateCase(random: () => number): GeneratedCase {
  const eol = random() < 0.5 ? '\n' : '\r\n'
  const count = 6 + Math.floor(random() * 20)
  const lines = Array.from({ length: count }, (_, i) => `line ${i + 1}`)

  interface Region {
    start: number // 0-based index of the first changed line
    remove: number
    insert: string[]
  }

  const regions: Region[] = []
  let at = 1 // leave index 0 free as leading context
  while (at < count - 1) {
    let remove = Math.floor(random() * 3)
    const insertCount = Math.floor(random() * 3)
    if (remove === 0 && insertCount === 0) remove = 1
    if (at + remove > count - 1) break

    regions.push({
      start: at,
      remove,
      insert: Array.from({ length: insertCount }, (_, k) => `added ${at}.${k}`),
    })

    // Leave at least one untouched line between hunks so their context windows
    // cannot overlap.
    at += remove + 2 + Math.floor(random() * 3)
  }

  const original = lines.map((line) => line + eol).join('')

  // Proposed content, built by walking the script — not by calling applyHunks.
  const proposedLines: string[] = []
  let index = 0
  for (const region of regions) {
    while (index < region.start) proposedLines.push(lines[index++]!)
    proposedLines.push(...region.insert)
    index += region.remove
  }
  while (index < count) proposedLines.push(lines[index++]!)
  const proposed = proposedLines.map((line) => line + eol).join('')

  // Hunks, with one line of context on each side and new-side numbering carrying
  // the running drift the way git writes it.
  const hunks: Hunk[] = []
  let drift = 0
  for (const region of regions) {
    const before = lines[region.start - 1]!
    const after = lines[region.start + region.remove]!
    const body: Hunk['lines'] = [{ kind: 'context', text: before }]
    for (let k = 0; k < region.remove; k++) {
      body.push({ kind: 'remove', text: lines[region.start + k]! })
    }
    for (const added of region.insert) body.push({ kind: 'add', text: added })
    body.push({ kind: 'context', text: after })

    const oldStart = region.start // 1-based position of `before`
    hunks.push({
      oldStart,
      oldLines: region.remove + 2,
      newStart: oldStart + drift,
      newLines: region.insert.length + 2,
      heading: '',
      lines: body,
    })
    drift += region.insert.length - region.remove
  }

  return { original, proposed, hunks, eol }
}

/** Serialise hunks back to patch text, so the parser is exercised too. */
function serialize(hunks: readonly Hunk[]): string {
  let out = ''
  for (const hunk of hunks) {
    out += `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@\n`
    for (const line of hunk.lines) {
      const prefix = line.kind === 'context' ? ' ' : line.kind === 'add' ? '+' : '-'
      out += `${prefix}${line.text}\n`
      if (line.noNewlineAtEof) out += '\\ No newline at end of file\n'
    }
  }
  return out
}

const CASES = 250

describe('round-trip properties', () => {
  it('property: applying every hunk yields the proposed content', () => {
    const random = rng(0x5ce7c4)
    for (let i = 0; i < CASES; i++) {
      const testCase = generateCase(random)
      if (testCase.hunks.length === 0) continue

      const result = applyHunks(
        testCase.original,
        testCase.hunks,
        allHunkIndexes(testCase.hunks),
      )
      expect(result.ok, `case ${i}: ${JSON.stringify(result)}`).toBe(true)
      if (!result.ok) continue
      expect(result.content, `case ${i}`).toBe(testCase.proposed)
    }
  })

  it('property: applying no hunk yields the original, byte for byte', () => {
    const random = rng(0x5ce7c4)
    for (let i = 0; i < CASES; i++) {
      const testCase = generateCase(random)
      const result = applyHunks(testCase.original, testCase.hunks, [])
      expect(result.ok, `case ${i}`).toBe(true)
      if (!result.ok) continue
      expect(result.content, `case ${i}`).toBe(testCase.original)
    }
  })

  it('property: serialising and reparsing a diff preserves every hunk', () => {
    const random = rng(0x1d0c5)
    for (let i = 0; i < CASES; i++) {
      const testCase = generateCase(random)
      if (testCase.hunks.length === 0) continue

      const result = parseUnifiedDiff(serialize(testCase.hunks))
      expect(result.ok, `case ${i}`).toBe(true)
      if (!result.ok) continue
      expect(result.hunks, `case ${i}`).toEqual(testCase.hunks)
    }
  })

  it('property: any accepted subset is the original outside the accepted hunks', () => {
    // The subset-offset guard, stated generally: whatever subset is accepted, the
    // untouched regions of the file survive in order.
    const random = rng(0x9a3fe1)
    for (let i = 0; i < CASES; i++) {
      const testCase = generateCase(random)
      if (testCase.hunks.length < 2) continue

      // Every other hunk: guarantees at least one rejection between acceptances.
      const selected = allHunkIndexes(testCase.hunks).filter((index) => index % 2 === 0)
      const result = applyHunks(testCase.original, testCase.hunks, selected)
      expect(result.ok, `case ${i}: ${JSON.stringify(result)}`).toBe(true)
      if (!result.ok) continue

      // Expected content, again derived from the script rather than the applier.
      const lines = testCase.original.split(testCase.eol).slice(0, -1)
      const expected: string[] = []
      let index = 0
      for (const selectedIndex of selected) {
        const hunk = testCase.hunks[selectedIndex]!
        const start = hunk.oldStart - 1
        while (index < start) expected.push(lines[index++]!)
        for (const line of hunk.lines) {
          if (line.kind === 'add') expected.push(line.text)
          else if (line.kind === 'context') expected.push(lines[index++]!)
          else index++
        }
      }
      while (index < lines.length) expected.push(lines[index++]!)

      expect(result.content, `case ${i}`).toBe(
        expected.map((line) => line + testCase.eol).join(''),
      )
    }
  })
})
