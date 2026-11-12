// The editor's IDE features, through the real EditorArea, CodeEditor, reducer and
// file actions, with only Monaco replaced by its double (the one seam, as in
// editor.test.tsx). In user terms:
//   * a setting changed in Settings reaches the open editor at once;
//   * a search result or a problem puts the caret on its line;
//   * middle-click closes a tab; the tab menu's Close Others does what it says;
//   * a Markdown file can be previewed (as text nodes, never HTML);
//   * format on save writes the formatted text;
//   * "save on focus change" saves when the editor loses focus.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import EditorArea from '../components/EditorArea'
import { ConfirmProvider } from '../components/ConfirmDialog'
import { FileIoProvider } from './FileIoProvider'
import { createFakeDisk, type FakeDisk } from './fakeDisk'
import { createMonacoDouble, type MonacoDouble } from './monacoDouble'
import { useFileActions } from './useFileActions'
import { MockSketchClient } from '../lib/mockClient'
import { SketchClientProvider } from '../lib/ClientProvider'
import { AppStateProvider, useAppDispatch, useAppState, type AppState } from '../state/AppState'

const holder = vi.hoisted(() => ({ double: null as { api: unknown } | null }))
vi.mock('./monacoSetup', () => ({
  loadMonaco: () => Promise.resolve({ api: holder.double!.api, theme: 'test-theme' }),
}))

const ROOT = 'C:/app'
const A = 'C:/app/src/a.ts'
const B = 'C:/app/src/b.ts'
const C = 'C:/app/src/c.ts'
const MD = 'C:/app/README.md'

let monaco: MonacoDouble
let disk: FakeDisk

function Harness() {
  const actions = useFileActions()
  const dispatch = useAppDispatch()
  const state = useAppState()
  return (
    <>
      <EditorArea />
      {[A, B, C, MD].map((path) => (
        <button key={path} onClick={() => void actions.openPath(path)}>{`open:${path}`}</button>
      ))}
      <button onClick={() => dispatch({ type: 'SET_EDITOR_SETTINGS', payload: { fontSize: 18, wordWrap: true, minimap: false } })}>settings</button>
      <button onClick={() => dispatch({ type: 'REVEAL_IN_EDITOR', payload: { path: A, line: 3, column: 5 } })}>reveal</button>
      <button onClick={() => void actions.save(A)}>save-a</button>
      <div data-testid="tabs">{state.openFiles.join('|')}</div>
      <div data-testid="dirty">{state.openFiles.filter((p) => state.files[p]?.isDirty).join('|')}</div>
    </>
  )
}

function mount(initial: Partial<AppState> = {}) {
  render(
    <SketchClientProvider client={new MockSketchClient()}>
      <AppStateProvider initial={{ mode: 'ide', projectRoot: ROOT, ...initial }}>
        <FileIoProvider io={disk.io}>
          <ConfirmProvider>
            <Harness />
          </ConfirmProvider>
        </FileIoProvider>
      </AppStateProvider>
    </SketchClientProvider>,
  )
}

async function open(path: string) {
  fireEvent.click(screen.getByText(`open:${path}`))
  await waitFor(() => expect(screen.getByTestId('tabs').textContent).toContain(path))
}

const tabs = () => (screen.getByTestId('tabs').textContent ?? '').split('|').filter(Boolean)

beforeEach(() => {
  monaco = createMonacoDouble()
  holder.double = monaco
  disk = createFakeDisk({
    [A]: 'line 1\nline 2\nline 3 has text\n',
    [B]: 'b',
    [C]: 'c',
    [MD]: '# Title\n\nSome <b>bold</b> words\n',
  })
})

afterEach(() => {
  cleanup()
  holder.double = null
})

describe('settings reach the open editor', () => {
  it('creates the editor with the chosen settings and updates it when they change', async () => {
    mount({ editorSettings: { ...(await import('../state/AppState')).DEFAULT_EDITOR_SETTINGS, fontSize: 15 } })
    await open(A)
    await waitFor(() => expect(monaco.editors.length).toBe(1))
    const editor = monaco.lastEditor()
    expect(editor.options).toMatchObject({ fontSize: 15 })

    fireEvent.click(screen.getByText('settings'))
    await waitFor(() =>
      expect(editor.optionUpdates.at(-1)).toMatchObject({ fontSize: 18, wordWrap: 'on', minimap: { enabled: false } }),
    )
  })
})

describe('reveal', () => {
  it('moves the caret to the requested line and scrolls it into view, once', async () => {
    mount()
    await open(A)
    await waitFor(() => expect(monaco.editors.length).toBe(1))
    fireEvent.click(screen.getByText('reveal'))
    const editor = monaco.lastEditor()
    await waitFor(() => expect(editor.revealedLines).toEqual([3]))
    expect(editor.getPosition()).toEqual({ lineNumber: 3, column: 5 })
  })
})

describe('tabs', () => {
  it('closes a tab on middle-click and with Close Others', async () => {
    mount()
    await open(A)
    await open(B)
    await open(C)
    const middle = screen.getByRole('tab', { name: /b\.ts/ })
    fireEvent(middle, new MouseEvent('auxclick', { bubbles: true, cancelable: true, button: 1 }))
    await waitFor(() => expect(tabs()).toEqual([A, C]))

    fireEvent.contextMenu(screen.getByRole('tab', { name: /c\.ts/ }))
    fireEvent.click(screen.getByRole('menuitem', { name: 'Close Others' }))
    await waitFor(() => expect(tabs()).toEqual([C]))
  })
})

describe('Markdown preview', () => {
  it('renders the file as Markdown, with markup in the text kept as text', async () => {
    mount()
    await open(MD)
    fireEvent.click(await screen.findByRole('button', { name: /Preview/ }))
    const preview = await screen.findByLabelText('Markdown preview')
    expect(preview.querySelector('h1')?.textContent).toBe('Title')
    expect(preview.querySelector('b')).toBeNull()
    expect(preview.textContent).toContain('<b>bold</b>')
    fireEvent.click(screen.getByRole('button', { name: /Edit/ }))
    await waitFor(() => expect(screen.queryByLabelText('Markdown preview')).toBeNull())
  })
})

describe('saving', () => {
  it('formats before saving when format on save is on', async () => {
    const { DEFAULT_EDITOR_SETTINGS } = await import('../state/AppState')
    mount({ editorSettings: { ...DEFAULT_EDITOR_SETTINGS, formatOnSave: true } })
    await open(A)
    await waitFor(() => expect(monaco.editors.length).toBe(1))
    // Formatting needs the file on screen; the editor exists a render before it shows it.
    await waitFor(() => expect(monaco.lastEditor().getModel()).not.toBeNull())
    const editor = monaco.lastEditor()
    // A formatter that rewrites the model, as Monaco's formatDocument action does.
    editor.actions.set('editor.action.formatDocument', { runs: 0, supported: true })
    const action = editor.actions.get('editor.action.formatDocument')!
    const original = editor.getAction!.bind(editor)
    editor.getAction = (id: string) => {
      const real = original(id)
      if (id !== 'editor.action.formatDocument' || real === null) return real
      return {
        isSupported: real.isSupported,
        run: async () => {
          await real.run()
          ;(editor.getModel() as unknown as { typeText(v: string): void }).typeText('FORMATTED\n')
        },
      }
    }
    fireEvent.click(screen.getByText('save-a'))
    await waitFor(() => expect(disk.read(A)).toBe('FORMATTED\n'))
    expect(action.runs).toBe(1)
    expect(screen.getByTestId('dirty').textContent).toBe('')
  })

  it('auto-save after a delay waits until typing stops, even through edits that keep the length', async () => {
    const { DEFAULT_EDITOR_SETTINGS } = await import('../state/AppState')
    mount({ editorSettings: { ...DEFAULT_EDITOR_SETTINGS, autoSave: 'afterDelay' } })
    await open(B)
    await waitFor(() => expect(monaco.live.has(B)).toBe(true))
    act(() => monaco.model(B).typeText('x1'))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 800))
    })
    // Same length as before, as replacing a selected character is.
    act(() => monaco.model(B).typeText('x2'))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 400))
    })
    // 1.2 s after the first edit, but only 0.4 s after the last: not saved yet.
    expect(disk.read(B)).toBe('b')
    await waitFor(() => expect(disk.read(B)).toBe('x2'), { timeout: 2500 })
  })

  it('auto-save after a delay does not format; the user has only paused', async () => {
    const { DEFAULT_EDITOR_SETTINGS } = await import('../state/AppState')
    mount({ editorSettings: { ...DEFAULT_EDITOR_SETTINGS, autoSave: 'afterDelay', formatOnSave: true } })
    await open(A)
    await waitFor(() => expect(monaco.editors.length).toBe(1))
    await waitFor(() => expect(monaco.lastEditor().getModel()).not.toBeNull())
    const editor = monaco.lastEditor()
    editor.actions.set('editor.action.formatDocument', { runs: 0, supported: true })
    const action = editor.actions.get('editor.action.formatDocument')!
    act(() => monaco.model(A).typeText('typed, then a pause\n'))
    await waitFor(() => expect(disk.read(A)).toBe('typed, then a pause\n'), { timeout: 3000 })
    expect(action.runs).toBe(0)
  })

  it('saves when the editor loses focus, with "save on focus change"', async () => {
    const { DEFAULT_EDITOR_SETTINGS } = await import('../state/AppState')
    mount({ editorSettings: { ...DEFAULT_EDITOR_SETTINGS, autoSave: 'onFocusChange' } })
    await open(A)
    await waitFor(() => expect(monaco.editors.length).toBe(1))
    // The editor exists a render before it shows the file; type once the file's model is there.
    await waitFor(() => expect(monaco.live.has(A)).toBe(true))
    act(() => monaco.model(A).typeText('typed then left\n'))
    await waitFor(() => expect(screen.getByTestId('dirty').textContent).toBe(A))
    act(() => monaco.lastEditor().blur())
    await waitFor(() => expect(disk.read(A)).toBe('typed then left\n'))
    await waitFor(() => expect(screen.getByTestId('dirty').textContent).toBe(''))
  })
})
