// The IDE state the new editor features stand on, through the real reducer.
//
// In user terms: the side bar toggle remembers its panel; Close Others / Close Saved
// keep the right tab active; a renamed file or folder keeps its open tabs and their
// unsaved edits; a deleted folder closes what was open inside it; settings are bounded
// so a corrupted value cannot break the editor; a reveal moves the caret once; terminal
// tabs are independent and their output is capped; layout and tabs survive a restart.

import { afterEach, describe, expect, it } from 'vitest'

import {
  appReducer,
  initialAppState,
  loadPersistedState,
  makeFileEntry,
  MAX_TERMINAL_OUTPUT_CHARS,
  normalizeEditorSettings,
  savePersistedState,
  DEFAULT_EDITOR_SETTINGS,
  type AppState,
} from './AppState'

const ROOT = 'C:/work/app'

function withOpen(paths: string[], dirty: string[] = []): AppState {
  let state: AppState = { ...initialAppState, projectRoot: ROOT }
  for (const path of paths) state = appReducer(state, { type: 'OPEN_FILE', payload: makeFileEntry(path, `// ${path}`) })
  for (const path of dirty) state = appReducer(state, { type: 'UPDATE_FILE_CONTENT', payload: { path, content: 'edited' } })
  return state
}

afterEach(() => window.localStorage.clear())

describe('the side bar toggle', () => {
  it('hides the side panel and brings the same one back', () => {
    let state = appReducer(initialAppState, { type: 'SET_ACTIVE_PANEL', payload: 'git' })
    state = appReducer(state, { type: 'TOGGLE_IDE_SIDE_PANEL' })
    expect(state.ideActivePanel).toBeNull()
    state = appReducer(state, { type: 'TOGGLE_IDE_SIDE_PANEL' })
    expect(state.ideActivePanel).toBe('git')
  })
})

describe('closing and moving tabs', () => {
  const a = `${ROOT}/a.ts`
  const b = `${ROOT}/b.ts`
  const c = `${ROOT}/c.ts`

  it('closes several tabs and activates the nearest survivor', () => {
    let state = withOpen([a, b, c])
    state = appReducer(state, { type: 'SET_ACTIVE_FILE', payload: b })
    state = appReducer(state, { type: 'CLOSE_FILES', payload: [b, c] })
    expect(state.openFiles).toEqual([a])
    expect(state.activeFile).toBe(a)
    expect(state.files[b]).toBeUndefined()
  })

  it('reorders a tab', () => {
    const state = appReducer(withOpen([a, b, c]), { type: 'MOVE_TAB', payload: { path: c, toIndex: 0 } })
    expect(state.openFiles).toEqual([c, a, b])
  })
})

describe('rename and delete on disk', () => {
  it('retargets an open tab under a renamed folder and keeps its unsaved edits', () => {
    const inner = `${ROOT}/src/lib/util.ts`
    let state = withOpen([inner, `${ROOT}/README.md`], [inner])
    state = appReducer(state, { type: 'PATHS_RENAMED', payload: { from: `${ROOT}/src/lib`, to: `${ROOT}/src/helpers` } })
    const moved = `${ROOT}/src/helpers/util.ts`
    expect(state.openFiles).toEqual([moved, `${ROOT}/README.md`])
    expect(state.files[moved]).toMatchObject({ path: moved, name: 'util.ts', content: 'edited', isDirty: true })
    expect(state.files[inner]).toBeUndefined()
  })

  it('renames a single file, including its language', () => {
    const before = `${ROOT}/notes.txt`
    let state = withOpen([before])
    state = appReducer(state, { type: 'PATHS_RENAMED', payload: { from: before, to: `${ROOT}/notes.md` } })
    expect(state.activeFile).toBe(`${ROOT}/notes.md`)
    expect(state.files[`${ROOT}/notes.md`]!.language).toBe('markdown')
  })

  it('does not touch a sibling whose name only starts the same', () => {
    let state = withOpen([`${ROOT}/src/lib2/x.ts`])
    state = appReducer(state, { type: 'PATHS_RENAMED', payload: { from: `${ROOT}/src/lib`, to: `${ROOT}/src/other` } })
    expect(state.openFiles).toEqual([`${ROOT}/src/lib2/x.ts`])
  })

  it('closes every tab inside a deleted folder', () => {
    let state = withOpen([`${ROOT}/old/a.ts`, `${ROOT}/old/deep/b.ts`, `${ROOT}/keep.ts`])
    state = appReducer(state, { type: 'PATHS_DELETED', payload: `${ROOT}/old` })
    expect(state.openFiles).toEqual([`${ROOT}/keep.ts`])
  })
})

describe('saving', () => {
  it('keeps a buffer dirty when the user typed while the save was being written', () => {
    const path = `${ROOT}/a.ts`
    let state = withOpen([path], [path]) // buffer: 'edited'
    state = appReducer(state, { type: 'UPDATE_FILE_CONTENT', payload: { path, content: 'edited more' } })
    // The write that finishes carried the older text.
    state = appReducer(state, { type: 'FILE_SAVED', payload: { path, content: 'edited' } })
    expect(state.files[path]!.isDirty).toBe(true)
    state = appReducer(state, { type: 'FILE_SAVED', payload: { path, content: 'edited more' } })
    expect(state.files[path]!.isDirty).toBe(false)
  })
})

describe('editor settings', () => {
  it('bounds and validates every field', () => {
    expect(normalizeEditorSettings({ fontSize: 400, tabSize: 0, lineNumbers: 'sideways' as never, autoSave: 'always' as never })).toMatchObject({
      fontSize: 32,
      tabSize: 1,
      lineNumbers: 'on',
      autoSave: 'off',
    })
    expect(normalizeEditorSettings(null)).toEqual(DEFAULT_EDITOR_SETTINGS)
  })

  it('changes one setting and keeps the rest', () => {
    const state = appReducer(initialAppState, { type: 'SET_EDITOR_SETTINGS', payload: { wordWrap: true } })
    expect(state.editorSettings).toEqual({ ...DEFAULT_EDITOR_SETTINGS, wordWrap: true })
  })
})

describe('reveal requests', () => {
  it('carries a fresh nonce every time, even for the same line', () => {
    const first = appReducer(initialAppState, { type: 'REVEAL_IN_EDITOR', payload: { path: `${ROOT}/a.ts`, line: 12 } })
    const second = appReducer(first, { type: 'REVEAL_IN_EDITOR', payload: { path: `${ROOT}/a.ts`, line: 12 } })
    expect(first.revealRequest).toMatchObject({ line: 12, column: 1 })
    expect(second.revealRequest!.nonce).toBeGreaterThan(first.revealRequest!.nonce)
  })
})

describe('terminal tabs', () => {
  it('opens, selects and closes terminals, always keeping one', () => {
    let state = appReducer(initialAppState, { type: 'TERMINAL_NEW' })
    expect(state.terminals.map((t) => t.id)).toEqual(['term-1', 'term-2'])
    expect(state.activeTerminalId).toBe('term-2')
    state = appReducer(state, { type: 'TERMINAL_CLOSE', payload: 'term-2' })
    state = appReducer(state, { type: 'TERMINAL_CLOSE', payload: 'term-1' })
    expect(state.terminals).toHaveLength(1)
  })

  it('streams output into a run and caps it from the head', () => {
    let state = appReducer(initialAppState, {
      type: 'TERMINAL_RUN_STARTED',
      payload: { id: 'r1', line: 'x', program: 'x', args: [], status: 'running', exitCode: null, stdout: '', stderr: '', message: null },
    })
    state = appReducer(state, { type: 'TERMINAL_RUN_OUTPUT', payload: { id: 'r1', stdout: 'a'.repeat(MAX_TERMINAL_OUTPUT_CHARS) } })
    state = appReducer(state, { type: 'TERMINAL_RUN_OUTPUT', payload: { id: 'r1', stdout: 'TAIL' } })
    const run = state.terminalHistory[0]!
    expect(run.stdout.length).toBe(MAX_TERMINAL_OUTPUT_CHARS)
    expect(run.stdout.endsWith('TAIL')).toBe(true)
    // Settling a streamed run keeps what it printed.
    state = appReducer(state, { type: 'TERMINAL_RUN_SETTLED', payload: { id: 'r1', status: 'exited', exitCode: 0 } })
    expect(state.terminalHistory[0]!.stdout.endsWith('TAIL')).toBe(true)
  })

  it('clears one tab without stopping what is running in it', () => {
    const running = { id: 'r1', line: 'dev', program: 'npm', args: [], status: 'running' as const, exitCode: null, stdout: '', stderr: '', message: null, terminalId: 'term-1' }
    const done = { ...running, id: 'r2', status: 'exited' as const, exitCode: 0 }
    let state = appReducer(initialAppState, { type: 'TERMINAL_RUN_STARTED', payload: running })
    state = appReducer(state, { type: 'TERMINAL_RUN_STARTED', payload: done })
    state = appReducer(state, { type: 'TERMINAL_CLEARED', payload: 'term-1' })
    expect(state.terminalHistory.map((r) => r.id)).toEqual(['r1'])
  })
})

describe('what survives a restart', () => {
  it('keeps editor settings, layout and the paths of open tabs — never their content', () => {
    let state = withOpen([`${ROOT}/a.ts`, `${ROOT}/b.ts`])
    state = appReducer(state, { type: 'SET_EDITOR_SETTINGS', payload: { fontSize: 16, minimap: false } })
    state = appReducer(state, { type: 'SET_ACTIVE_PANEL', payload: 'search' })
    state = appReducer(state, { type: 'SET_BOTTOM_PANEL_HEIGHT', payload: 333 })
    savePersistedState(state)

    const stored = window.localStorage.getItem('sketch.ui.v1') ?? ''
    expect(stored).not.toContain('// C:/work/app/a.ts')

    const restored = loadPersistedState()
    expect(restored.editorSettings).toMatchObject({ fontSize: 16, minimap: false })
    expect(restored.ideActivePanel).toBe('search')
    expect(restored.bottomPanelHeight).toBe(333)
    expect(restored.restoreTabs).toEqual({ root: ROOT, paths: [`${ROOT}/a.ts`, `${ROOT}/b.ts`], active: `${ROOT}/b.ts` })
  })
})
