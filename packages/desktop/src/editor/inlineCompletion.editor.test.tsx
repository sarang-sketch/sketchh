// Native ghost text and editor actions, through the real CodeEditor.
//
// The real Monaco cannot run under jsdom, so these tests extend the double with the
// two OPTIONAL seams production uses — `registerInlineCompletions` and
// `addEditorAction` — and drive them exactly as Monaco would: ask for a suggestion
// at an offset, run an action with a selection. What is under test is CodeEditor's
// wiring: it registers ONE provider, asks the completion source only while
// Autocomplete is on, never writes a suggestion into the file, and hands a context
// menu action the file, the selection and its lines.
// **Validates: Requirements 15.5**

import { afterEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, render, screen } from '@testing-library/react'

import { AppStateProvider, makeFileEntry, useAppDispatch, useAppState } from '../state/AppState'
import CodeEditor, { type EditorAgentRequest } from './CodeEditor'
import { createMonacoDouble } from './monacoDouble'
import type { CodeEditor as Editor, EditorActionDescriptor, InlineCompletionRequest, MonacoApi } from './monacoApi'
import type { GhostCompletionRequest } from './ghostCompletion'

const FILE = 'C:/app/a.ts'

function withNativeSeams(api: MonacoApi) {
  const providers: Array<(request: InlineCompletionRequest) => Promise<string | null>> = []
  const actions: Array<{ editor: Editor; action: EditorActionDescriptor }> = []
  const extended: MonacoApi = {
    ...api,
    languages: {
      ...api.languages,
      registerInlineCompletions: (provide) => {
        providers.push(provide)
        return { dispose: () => providers.splice(providers.indexOf(provide), 1) }
      },
    },
    addEditorAction: (editor, action) => {
      actions.push({ editor, action })
      return { dispose: () => {} }
    },
    keys: { ctrlCmd: 2048, shift: 1024, alt: 512, keyL: 42, keyK: 41, keyI: 39, backslash: 93 },
  }
  return { extended, providers, actions }
}

function Toggle() {
  const dispatch = useAppDispatch()
  const state = useAppState()
  return (
    <>
      <button onClick={() => dispatch({ type: 'SET_GHOST_COMPLETIONS', payload: !state.ghostCompletionsEnabled })}>toggle</button>
      <span data-testid="content">{state.files[FILE]?.content}</span>
    </>
  )
}

afterEach(() => cleanup())

describe('CodeEditor with Monaco\'s native inline-suggest widget', () => {
  it('registers one provider and asks the source only while Autocomplete is on', async () => {
    const double = createMonacoDouble()
    const { extended, providers } = withNativeSeams(double.api)
    const seen: GhostCompletionRequest[] = []
    const source = vi.fn(async (request: GhostCompletionRequest) => {
      seen.push(request)
      return 'return a + b'
    })
    render(
      <AppStateProvider
        initial={{ mode: 'ide', projectRoot: 'C:/app', openFiles: [FILE], activeFile: FILE, files: { [FILE]: makeFileEntry(FILE, 'function add(a, b) {\n  \n}') }, ghostCompletionsEnabled: false }}
      >
        <CodeEditor loader={async () => ({ api: extended, theme: 'sketch' })} completionProvider={source} />
        <Toggle />
      </AppStateProvider>,
    )
    await act(async () => {
      await Promise.resolve()
    })
    expect(providers).toHaveLength(1)
    // The overlay of the fallback path is not used when the native widget exists.
    expect(screen.queryByLabelText('Ghost completion')).toBeNull()

    const ask = () =>
      providers[0]!({ path: FILE, language: 'typescript', content: 'function add(a, b) {\n  \n}', cursorOffset: 23, signal: new AbortController().signal })

    // Off: Monaco may ask, but no model call is made.
    expect(await ask()).toBeNull()
    expect(source).not.toHaveBeenCalled()

    act(() => screen.getByText('toggle').click())
    expect(await ask()).toBe('return a + b')
    expect(seen[0]!.cursorOffset).toBe(23)
    expect(seen[0]!.language).toBe('typescript')
    // A suggestion is view state: the file record is untouched.
    expect(screen.getByTestId('content').textContent).toBe('function add(a, b) {\n  \n}')
  })

  it('hands a context-menu action the file, the selected code and its lines', async () => {
    const double = createMonacoDouble()
    const { extended, actions } = withNativeSeams(double.api)
    const requests: EditorAgentRequest[] = []
    render(
      <AppStateProvider
        initial={{ mode: 'ide', projectRoot: 'C:/app', openFiles: [FILE], activeFile: FILE, files: { [FILE]: makeFileEntry(FILE, 'line one\nline two\nline three') } }}
      >
        <CodeEditor loader={async () => ({ api: extended, theme: 'sketch' })} onAgentAction={(r) => requests.push(r)} />
      </AppStateProvider>,
    )
    await act(async () => {
      await Promise.resolve()
    })
    const labels = actions.map((a) => a.action.label)
    expect(labels).toEqual(expect.arrayContaining(['Sketch: Explain This Code', 'Sketch: Find and Fix Bugs Here', 'Sketch: Write Tests for This', 'Sketch: Edit With Instructions…']))

    const explain = actions.find((a) => a.action.id === 'sketch.explain')!
    const editor = explain.editor as Editor & { getSelection?: () => unknown }
    editor.getSelection = () => ({ startLineNumber: 2, startColumn: 1, endLineNumber: 3, endColumn: 6 })
    const model = editor.getModel()!
    ;(model as { getValueInRange?: (range: unknown) => string }).getValueInRange = () => 'line two\nline '
    explain.action.run()
    expect(requests).toEqual([{ kind: 'explain', path: FILE, lines: { start: 2, end: 3 }, code: 'line two\nline ' }])
  })
})
