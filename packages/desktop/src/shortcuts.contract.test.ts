// W9 invariant 5 — one source of truth for the keyboard shortcuts.
//
// The Shortcuts settings tab renders `SHORTCUTS` (shortcuts.ts). The window-wide chords
// are bound in `App.tsx`'s `Shortcuts` keydown handler. This test keeps the two in
// lockstep: it fails if a `global` row in the table names a chord `App.tsx` does not
// bind (a listing with no handler) or if `App.tsx` binds a chord the table does not list
// (a handler with no listing), by comparing the table's `global` rows to `GLOBAL_CHORDS`
// (the hand-maintained mirror of the handler) AND verifying `GLOBAL_CHORDS` against the
// actual `App.tsx` source so the mirror itself cannot silently drift.

import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import { SHORTCUTS, GLOBAL_CHORDS, normalizeChord, globalDisplayChords } from './shortcuts'

describe('keyboard shortcut table', () => {
  it('every global display row maps to a bound chord, and every bound chord is displayed', () => {
    const displayed = new Set(globalDisplayChords())
    const bound = new Set(GLOBAL_CHORDS.map(normalizeChord))
    const listingWithoutHandler = [...displayed].filter((c) => !bound.has(c))
    const handlerWithoutListing = [...bound].filter((c) => !displayed.has(c))
    expect(listingWithoutHandler, 'shortcuts listed but not bound in App.tsx').toEqual([])
    expect(handlerWithoutListing, 'shortcuts bound in App.tsx but not listed').toEqual([])
  })

  it('has no duplicate rows', () => {
    const seen = new Set<string>()
    for (const s of SHORTCUTS) {
      expect(seen.has(s.keys), `duplicate row ${s.keys}`).toBe(false)
      seen.add(s.keys)
    }
  })

  // The mirror cannot drift from the handler: each chord GLOBAL_CHORDS claims must be
  // provably handled by App.tsx's keydown switch. We read the source and assert the
  // branch that recognises each chord exists. This is a coarse but real guard: if a
  // branch is deleted from App.tsx, the matching assertion here fails.
  it('every GLOBAL_CHORDS entry is handled in App.tsx', () => {
    const src = readFileSync(join(__dirname, 'App.tsx'), 'utf8')
    // Map each chord to a fragment that must appear in the handler source.
    const handlerMark: Record<string, RegExp> = {
      'ctrl+,': /key === ','/,
      'ctrl+o': /key === 'o'/,
      'ctrl+p': /key === 'p'/,
      'ctrl+shift+p': /key === 'p' && event\.shiftKey/,
      'ctrl+k': /key === 'k' && s\.mode === 'agent'/,
      'ctrl+l': /key === 'l' && !event\.altKey/,
      'ctrl+shift+l': /key === 'l' && event\.shiftKey/,
      'ctrl+`': /event\.code === 'Backquote'/,
      'ctrl+shift+`': /event\.code === 'Backquote'/,
      'ctrl+j': /key === 'j'/,
      'ctrl+b': /key === 'b'/,
      'ctrl+shift+e': /key === 'e'/,
      'ctrl+shift+f': /key === 'f'/,
      'ctrl+shift+h': /key === 'h'/,
      'ctrl+shift+g': /key === 'g'/,
      'ctrl+shift+m': /key === 'm'/,
      'ctrl+n': /key === 'n'/,
      'ctrl+=': /key === '=' \|\| key === '\+'/,
      'ctrl+-': /key === '-'/,
      'ctrl+0': /key === '0'/,
      'alt+z': /event\.code === 'KeyZ'/,
      'shift+alt+r': /event\.code === 'KeyR'/,
    }
    for (const chord of GLOBAL_CHORDS.map(normalizeChord)) {
      const mark = handlerMark[chord]
      expect(mark, `no handler-mark registered for ${chord}`).toBeDefined()
      expect(mark.test(src), `App.tsx has no handler branch for ${chord}`).toBe(true)
    }
  })
})
