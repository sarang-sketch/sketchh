// The single file-state owner, driven through the real reducer with nothing mocked.
//
// Validates: Requirements 15.2, 15.3, 15.4, 27.3

import { describe, it, expect } from 'vitest'
import {
  appReducer,
  initialAppState,
  makeFileEntry,
  type AppAction,
  type AppState,
} from './AppState'

const ROOT = 'C:/app'
const A = 'C:/app/src/App.tsx'
const B = 'C:/app/src/styles.css'
const C = 'C:/app/README.md'

function reduce(state: AppState, ...actions: AppAction[]): AppState {
  return actions.reduce(appReducer, state)
}

const opened = (): AppState =>
  reduce(
    { ...initialAppState, projectRoot: ROOT },
    { type: 'OPEN_FILE', payload: makeFileEntry(A, 'const a = 1') },
    { type: 'OPEN_FILE', payload: makeFileEntry(B, 'body {}') },
  )

describe('initial state', () => {
  it('opens with no project, no tabs and no fabricated workspaces', () => {
    // A hardcoded project root and three seeded workspaces used to ship here. Both
    // are fabricated data in a real panel (Requirements 14.6, 27.3).
    expect(initialAppState.projectRoot).toBeNull()
    expect(initialAppState.workspaces).toEqual([])
    expect(initialAppState.openFiles).toEqual([])
    expect(initialAppState.files).toEqual({})
    expect(initialAppState.activeFile).toBeNull()
  })
})

describe('OPEN_FILE', () => {
  it('adds a tab, focuses it, and stores the record once', () => {
    const state = opened()

    expect(state.openFiles).toEqual([A, B])
    expect(state.activeFile).toBe(B)
    expect(state.files[A]!.content).toBe('const a = 1')
    expect(state.files[A]!.language).toBe('typescript')
    expect(state.files[A]!.isDirty).toBe(false)
  })

  it('canonicalizes the key so one file cannot occupy two tabs', () => {
    const state = reduce(
      { ...initialAppState, projectRoot: ROOT },
      { type: 'OPEN_FILE', payload: makeFileEntry('c:\\app\\src\\App.tsx', 'x') },
      { type: 'OPEN_FILE', payload: makeFileEntry('C:/app/src/./App.tsx', 'x') },
    )
    expect(state.openFiles).toEqual([A])
  })

  it('re-opening an already-open file only focuses it, keeping unsaved edits', () => {
    const state = reduce(
      opened(),
      { type: 'UPDATE_FILE_CONTENT', payload: { path: A, content: 'typed by hand' } },
      { type: 'OPEN_FILE', payload: makeFileEntry(A, 'stale content from disk') },
    )

    expect(state.activeFile).toBe(A)
    expect(state.files[A]!.content).toBe('typed by hand')
    expect(state.files[A]!.isDirty).toBe(true)
  })
})

describe('SET_ACTIVE_FILE', () => {
  it('switches between open tabs', () => {
    expect(reduce(opened(), { type: 'SET_ACTIVE_FILE', payload: A }).activeFile).toBe(A)
  })

  it('refuses a file that is not open', () => {
    const state = reduce(opened(), { type: 'SET_ACTIVE_FILE', payload: C })
    expect(state.activeFile).toBe(B)
  })
})

describe('CLOSE_FILE', () => {
  it('removes the tab and drops the record, leaving one cache with no orphans', () => {
    const state = reduce(opened(), { type: 'CLOSE_FILE', payload: A })

    expect(state.openFiles).toEqual([B])
    expect(state.files[A]).toBeUndefined()
    expect(Object.keys(state.files)).toEqual([B])
  })

  it('activates the tab that took the closed tab’s place', () => {
    const three = reduce(opened(), { type: 'OPEN_FILE', payload: makeFileEntry(C, '# readme') })

    // Closing the middle tab focuses its right-hand neighbour.
    const middle = reduce(three, { type: 'SET_ACTIVE_FILE', payload: B }, { type: 'CLOSE_FILE', payload: B })
    expect(middle.activeFile).toBe(C)

    // Closing the last tab falls back to the left.
    const last = reduce(three, { type: 'CLOSE_FILE', payload: C })
    expect(last.activeFile).toBe(B)

    // Closing everything leaves nothing active, not a dangling path.
    const empty = reduce(last, { type: 'CLOSE_FILE', payload: B }, { type: 'CLOSE_FILE', payload: A })
    expect(empty.openFiles).toEqual([])
    expect(empty.activeFile).toBeNull()
  })

  it('closing an inactive tab does not move focus', () => {
    expect(reduce(opened(), { type: 'CLOSE_FILE', payload: A }).activeFile).toBe(B)
  })
})

describe('isDirty', () => {
  it('is set by an edit and cleared by a save', () => {
    const edited = reduce(opened(), {
      type: 'UPDATE_FILE_CONTENT',
      payload: { path: A, content: 'const a = 2' },
    })
    expect(edited.files[A]!.isDirty).toBe(true)
    expect(edited.files[A]!.content).toBe('const a = 2')

    const saved = reduce(edited, { type: 'FILE_SAVED', payload: A })
    expect(saved.files[A]!.isDirty).toBe(false)
    expect(saved.files[A]!.content).toBe('const a = 2')
  })

  it('is not set by an edit that changes nothing', () => {
    const state = reduce(opened(), {
      type: 'UPDATE_FILE_CONTENT',
      payload: { path: A, content: 'const a = 1' },
    })
    expect(state.files[A]!.isDirty).toBe(false)
  })

  it('ignores an edit for a file that is not open', () => {
    const state = reduce(opened(), { type: 'UPDATE_FILE_CONTENT', payload: { path: C, content: 'x' } })
    expect(state.files[C]).toBeUndefined()
    expect(state.openFiles).toEqual([A, B])
  })
})

describe('ENGINE_WROTE_FILE — Requirement 15.3', () => {
  it('updates a CLEAN buffer in place and leaves it clean', () => {
    const state = reduce(opened(), {
      type: 'ENGINE_WROTE_FILE',
      payload: { path: A, content: 'written by the engine', bytes: 21 },
    })

    expect(state.files[A]!.content).toBe('written by the engine')
    expect(state.files[A]!.isDirty).toBe(false)
    expect(state.files[A]!.conflict).toBeNull()
  })

  it('never discards a DIRTY buffer; it flags the conflict instead', () => {
    const state = reduce(
      opened(),
      { type: 'UPDATE_FILE_CONTENT', payload: { path: A, content: 'mine, unsaved' } },
      { type: 'ENGINE_WROTE_FILE', payload: { path: A, content: 'theirs', bytes: 6, at: 1234 } },
    )

    expect(state.files[A]!.content).toBe('mine, unsaved')
    expect(state.files[A]!.isDirty).toBe(true)
    expect(state.files[A]!.conflict).toEqual({ detectedAt: 1234, engineBytes: 6 })
  })

  it('ignores a write to a file the editor does not have open', () => {
    const state = reduce(opened(), {
      type: 'ENGINE_WROTE_FILE',
      payload: { path: C, content: 'engine output' },
    })
    expect(state.files[C]).toBeUndefined()
  })

  it('resolves the conflict only on an explicit choice', () => {
    const conflicted = reduce(
      opened(),
      { type: 'UPDATE_FILE_CONTENT', payload: { path: A, content: 'mine' } },
      { type: 'ENGINE_WROTE_FILE', payload: { path: A, content: 'theirs' } },
    )

    const reloaded = reduce(conflicted, { type: 'RELOAD_FILE', payload: { path: A, content: 'theirs' } })
    expect(reloaded.files[A]!.content).toBe('theirs')
    expect(reloaded.files[A]!.isDirty).toBe(false)
    expect(reloaded.files[A]!.conflict).toBeNull()

    const kept = reduce(conflicted, { type: 'DISMISS_CONFLICT', payload: A })
    expect(kept.files[A]!.content).toBe('mine')
    expect(kept.files[A]!.isDirty).toBe(true)
    expect(kept.files[A]!.conflict).toBeNull()
  })

  it('a save clears a stale conflict, since disk now matches the buffer', () => {
    const state = reduce(
      opened(),
      { type: 'UPDATE_FILE_CONTENT', payload: { path: A, content: 'mine' } },
      { type: 'ENGINE_WROTE_FILE', payload: { path: A, content: 'theirs' } },
      { type: 'FILE_SAVED', payload: A },
    )
    expect(state.files[A]!.conflict).toBeNull()
    expect(state.files[A]!.isDirty).toBe(false)
  })
})

describe('SET_PROJECT_ROOT', () => {
  it('records the folder and canonicalizes it', () => {
    const state = appReducer(initialAppState, {
      type: 'SET_PROJECT_ROOT',
      payload: 'C:\\Users\\me\\app',
    })
    expect(state.projectRoot).toBe('C:/Users/me/app')
    expect(state.workspaces).toEqual([{ name: 'app', path: 'C:/Users/me/app' }])
  })

  it('closes the previous project’s buffers when the root changes', () => {
    // Leaving them open would leave tabs the file layer must refuse (Req 15.6).
    const switched = reduce(opened(), { type: 'SET_PROJECT_ROOT', payload: 'C:/other' })
    expect(switched.openFiles).toEqual([])
    expect(switched.files).toEqual({})
    expect(switched.activeFile).toBeNull()
  })

  it('re-selecting the same root keeps the buffers open', () => {
    const same = reduce(opened(), { type: 'SET_PROJECT_ROOT', payload: 'c:\\app' })
    expect(same.openFiles).toEqual([A, B])
  })
})

describe('editorNotice', () => {
  it('carries a failure to the surface and can be dismissed', () => {
    const shown = appReducer(initialAppState, {
      type: 'SET_EDITOR_NOTICE',
      payload: { level: 'error', message: 'refused' },
    })
    expect(shown.editorNotice).toEqual({ level: 'error', message: 'refused' })
    expect(appReducer(shown, { type: 'SET_EDITOR_NOTICE', payload: null }).editorNotice).toBeNull()
  })
})
