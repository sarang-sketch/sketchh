// Inline edit (Ctrl+K) and the change markers, through the real editor area, reducer and
// file actions — only Monaco is replaced by its double. In user terms:
//   * select code, say what should change, see the diff, Ctrl+Enter applies it as one
//     edit, and the tab is marked unsaved;
//   * code that changed while the model was writing is never overwritten;
//   * Esc stops a request (the engine is told) and closes the widget;
//   * with no selection, the code goes on a new line below the caret;
//   * Problems → Fix opens the file and asks at once;
//   * no connected model is a sentence that says what to do, not a silent nothing;
//   * lines changed since the last commit are marked in the gutter, and Next Change /
//     Revert Change work on them.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'

import EditorArea from '../components/EditorArea'
import { ConfirmProvider } from '../components/ConfirmDialog'
import { FileIoProvider } from './FileIoProvider'
import { createFakeDisk, type FakeDisk } from './fakeDisk'
import { createMonacoDouble, type MonacoDouble } from './monacoDouble'
import { useFileActions } from './useFileActions'
import { MockSketchClient } from '../lib/mockClient'
import { SketchClientProvider } from '../lib/ClientProvider'
import type { InlineEditResult } from '../lib/client'
import type { ProviderSettingsEntry } from '../lib/contracts'
import { AppStateProvider, useAppState, type AppState } from '../state/AppState'
import { requestInlineEdit } from './inlineEditing'
import { insertEditorText, runEditorAction } from './editorBridge'
import { Markdown } from '../components/Markdown'

const resolveApiKeyForRun = vi.hoisted(() => vi.fn(async () => null as string | null))
vi.mock('../lib/secrets', () => ({ resolveApiKeyForRun }))

const holder = vi.hoisted(() => ({ double: null as { api: unknown } | null }))
vi.mock('./monacoSetup', () => ({
  loadMonaco: () => Promise.resolve({ api: holder.double!.api, theme: 'test-theme' }),
}))

const ROOT = 'C:/app'
const A = 'C:/app/src/a.ts'
const B = 'C:/app/src/b.ts'
const TEXT = 'line 1\nline 2\nline 3 has text\n'

const model: ProviderSettingsEntry = {
  id: 'ollama-local',
  kind: 'openai-compatible',
  baseUrl: 'http://127.0.0.1:11434/v1',
  model: 'qwen2.5-coder:7b',
  label: 'Local Ollama',
}

type EditCall = { params: Record<string, unknown>; signal: AbortSignal | undefined }

class EditClient extends MockSketchClient {
  calls: EditCall[] = []
  respond: (call: EditCall) => Promise<InlineEditResult> = async () => ({ text: '' })
  head: string | null = null
  inlineEdit = async (params: Record<string, unknown>, options: { signal?: AbortSignal } = {}) => {
    const call = { params, signal: options.signal }
    this.calls.push(call)
    return this.respond(call)
  }
  gitShow = async () => ({ content: this.head })
}

let monaco: MonacoDouble
let disk: FakeDisk
let client: EditClient

function Harness() {
  const actions = useFileActions()
  const state = useAppState()
  return (
    <>
      <EditorArea />
      <button onClick={() => void actions.openPath(A)}>open-a</button>
      <button onClick={() => void actions.openPath(B)}>open-b</button>
      <div data-testid="dirty">{state.openFiles.filter((p) => state.files[p]?.isDirty).join('|')}</div>
      <div data-testid="content">{state.files[A]?.content ?? ''}</div>
    </>
  )
}

function mount(initial: Partial<AppState> = {}) {
  render(
    <SketchClientProvider client={client}>
      <AppStateProvider
        initial={{ mode: 'ide', projectRoot: ROOT, providers: [model], selectedProvider: model.id, ...initial }}
      >
        <FileIoProvider io={disk.io}>
          <ConfirmProvider>
            <Harness />
          </ConfirmProvider>
        </FileIoProvider>
      </AppStateProvider>
    </SketchClientProvider>,
  )
}

async function openA() {
  fireEvent.click(screen.getByText('open-a'))
  await waitFor(() => expect(monaco.editors.length).toBe(1))
  await waitFor(() => expect(monaco.lastEditor().getModel()?.getValue()).toBe(TEXT))
  return monaco.lastEditor()
}

async function ask(instruction: string) {
  const input = await screen.findByLabelText('What should change')
  fireEvent.change(input, { target: { value: instruction } })
  fireEvent.click(screen.getByRole('button', { name: /Generate|Regenerate/ }))
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((r) => {
    resolve = r
  })
  return { promise, resolve }
}

beforeEach(() => {
  monaco = createMonacoDouble()
  holder.double = monaco
  disk = createFakeDisk({ [A]: TEXT, [B]: 'other file\n' })
  client = new EditClient()
  resolveApiKeyForRun.mockClear()
})

afterEach(() => {
  cleanup()
  holder.double = null
})

describe('inline edit (Ctrl+K)', () => {
  it('rewrites the selected lines after the user accepts the diff', async () => {
    client.respond = async () => ({ text: 'LINE 2\nLINE 3 HAS TEXT' })
    mount()
    const editor = await openA()
    // A partial selection is grown to whole lines.
    editor.select({ startLineNumber: 2, startColumn: 3, endLineNumber: 3, endColumn: 4 })
    act(() => {
      expect(runEditorAction('sketch.inlineEdit')).toBe(true)
    })
    expect(await screen.findByText('Lines 2–3 · a.ts')).toBeTruthy()

    await ask('upper-case these lines')
    await screen.findByRole('region', { name: 'Proposed change' })
    expect(client.calls).toHaveLength(1)
    expect(client.calls[0]!.params).toMatchObject({
      provider: model,
      path: 'src/a.ts',
      before: 'line 1\n',
      selection: 'line 2\nline 3 has text',
      after: '\n',
      instruction: 'upper-case these lines',
    })
    expect(resolveApiKeyForRun).toHaveBeenCalledWith(model.id)

    // Nothing is written until the user accepts.
    expect(editor.getModel()!.getValue()).toBe(TEXT)
    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Edit with AI' }), { key: 'Enter', ctrlKey: true })

    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit with AI' })).toBeNull())
    expect(editor.getModel()!.getValue()).toBe('line 1\nLINE 2\nLINE 3 HAS TEXT\n')
    expect(editor.appliedEdits.map((edit) => edit.source)).toEqual(['sketch.inlineEdit'])
    await waitFor(() => expect(screen.getByTestId('dirty').textContent).toBe(A))
    expect(screen.getByTestId('content').textContent).toBe('line 1\nLINE 2\nLINE 3 HAS TEXT\n')
  })

  it('never overwrites code that changed while the model was writing', async () => {
    const answer = deferred<InlineEditResult>()
    client.respond = () => answer.promise
    mount()
    const editor = await openA()
    editor.select({ startLineNumber: 2, startColumn: 1, endLineNumber: 2, endColumn: 7 })
    act(() => requestInlineEdit())
    await ask('rename')
    await screen.findByText('Writing the change…')

    act(() => monaco.model(A).typeText('line 1\nline 2 edited by hand\nline 3 has text\n'))
    await act(async () => answer.resolve({ text: 'renamed 2' }))
    await screen.findByRole('region', { name: 'Proposed change' })
    fireEvent.click(screen.getByRole('button', { name: /Accept/ }))

    expect((await screen.findByRole('alert')).textContent).toMatch(/changed while the edit was being written/)
    expect(editor.getModel()!.getValue()).toBe('line 1\nline 2 edited by hand\nline 3 has text\n')
    expect(editor.appliedEdits).toHaveLength(0)
  })

  it('Esc stops a running request — the engine is told — and Esc again closes', async () => {
    client.respond = () => new Promise<InlineEditResult>(() => {})
    mount()
    await openA()
    act(() => requestInlineEdit({ lines: { start: 1, end: 1 } }))
    await ask('anything')
    await screen.findByText('Writing the change…')

    const dialog = screen.getByRole('dialog', { name: 'Edit with AI' })
    fireEvent.keyDown(dialog, { key: 'Escape' })
    await waitFor(() => expect(client.calls[0]!.signal?.aborted).toBe(true))
    expect(screen.queryByText('Writing the change…')).toBeNull()

    fireEvent.keyDown(screen.getByRole('dialog', { name: 'Edit with AI' }), { key: 'Escape' })
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Edit with AI' })).toBeNull())
  })

  it('with no selection on a line of code, writes the new code on a line below', async () => {
    client.respond = async () => ({ text: 'inserted()' })
    mount()
    const editor = await openA()
    act(() => editor.moveTo(1, 3))
    act(() => requestInlineEdit())
    expect(await screen.findByText('New code below line 1 · a.ts')).toBeTruthy()
    await ask('call inserted')
    await screen.findByRole('region', { name: 'Proposed change' })
    expect(client.calls[0]!.params).toMatchObject({ selection: '', before: 'line 1\n', after: '\nline 2\nline 3 has text\n' })

    fireEvent.click(screen.getByRole('button', { name: /Accept/ }))
    await waitFor(() => expect(editor.getModel()!.getValue()).toBe('line 1\ninserted()\nline 2\nline 3 has text\n'))
  })

  it('Problems → Fix opens the file and asks at once, on the problem’s lines', async () => {
    client.respond = async () => ({ text: 'line 3 is fixed' })
    mount()
    // Another file is on screen when the request arrives: it waits for a.ts.
    fireEvent.click(screen.getByText('open-b'))
    await waitFor(() => expect(monaco.lastEditor().getModel()?.getValue()).toBe('other file\n'))
    act(() => requestInlineEdit({ path: A, lines: { start: 3, end: 3 }, instruction: 'Fix: unused text', autoRun: true }))
    expect(screen.queryByRole('dialog', { name: 'Edit with AI' })).toBeNull()
    fireEvent.click(screen.getByText('open-a'))
    await screen.findByRole('region', { name: 'Proposed change' })
    const editor = monaco.lastEditor()
    expect(client.calls[0]!.params).toMatchObject({ selection: 'line 3 has text', instruction: 'Fix: unused text' })
    fireEvent.click(screen.getByRole('button', { name: /Accept/ }))
    await waitFor(() => expect(editor.getModel()!.getValue()).toBe('line 1\nline 2\nline 3 is fixed\n'))
  })

  it('says how to connect a model instead of failing silently', async () => {
    mount({ providers: [], selectedProvider: null })
    await openA()
    act(() => requestInlineEdit({ lines: { start: 1, end: 1 } }))
    await ask('anything')
    expect((await screen.findByRole('alert')).textContent).toMatch(/Connect a model first/)
    expect(client.calls).toHaveLength(0)
  })
})

describe('change markers', () => {
  const markers = (editor: ReturnType<MonacoDouble['lastEditor']>) =>
    editor.decorations.map((d) => `${d.options.linesDecorationsClassName}@${d.range.startLineNumber}`)

  it('marks what changed since the last commit, and follows typing', async () => {
    client.head = 'line 1\nline two\nline 3 has text\n'
    mount()
    const editor = await openA()
    await waitFor(() => expect(markers(editor)).toEqual(['sketch-change-modified@2']))

    act(() => monaco.model(A).typeText(`${TEXT}line 4 is new\n`))
    await waitFor(() => expect(markers(editor)).toEqual(['sketch-change-modified@2', 'sketch-change-added@4']))
  })

  it('shows nothing for a file git does not have', async () => {
    client.head = null
    mount()
    const editor = await openA()
    await new Promise((resolve) => setTimeout(resolve, 400))
    expect(markers(editor)).toEqual([])
  })

  it('Next Change moves to it and Revert Change puts the committed line back', async () => {
    client.head = 'line 1\nline two\nline 3 has text\n'
    mount()
    const editor = await openA()
    await waitFor(() => expect(markers(editor)).toEqual(['sketch-change-modified@2']))

    act(() => {
      runEditorAction('sketch.git.nextChange')
    })
    expect(editor.getPosition()).toEqual({ lineNumber: 2, column: 1 })

    act(() => {
      runEditorAction('sketch.git.revertChange')
    })
    expect(editor.getModel()!.getValue()).toBe('line 1\nline two\nline 3 has text\n')
    expect(editor.appliedEdits.map((edit) => edit.source)).toEqual(['sketch.revertChange'])
    await waitFor(() => expect(markers(editor)).toEqual([]))
  })
})


describe('insert at the cursor (code from a chat reply)', () => {
  it('puts the code at the caret as one undoable edit', async () => {
    mount()
    const editor = await openA()
    act(() => editor.moveTo(2, 1))
    let inserted = false
    act(() => {
      inserted = insertEditorText('// added\n')
    })
    expect(inserted).toBe(true)
    expect(editor.getModel()!.getValue()).toBe('line 1\n// added\nline 2\nline 3 has text\n')
    expect(editor.appliedEdits.map((edit) => edit.source)).toEqual(['sketch.insert'])
    await waitFor(() => expect(screen.getByTestId('dirty').textContent).toBe(A))
  })

  it('replaces the selection when there is one', async () => {
    mount()
    const editor = await openA()
    act(() => editor.select({ startLineNumber: 1, startColumn: 1, endLineNumber: 1, endColumn: 7 }))
    act(() => {
      insertEditorText('first')
    })
    expect(editor.getModel()!.getValue()).toBe('first\nline 2\nline 3 has text\n')
  })

  it("offers Insert on a reply's code block only when the host gives it somewhere to go", () => {
    const onInsert = vi.fn()
    const { unmount } = render(<Markdown text={'Try:\n\n```ts\nconst x = 1\n```'} onInsertCode={onInsert} />)
    fireEvent.click(screen.getByRole('button', { name: 'Insert code at the cursor' }))
    expect(onInsert).toHaveBeenCalledWith('const x = 1')
    unmount()
    render(<Markdown text={'```ts\nconst x = 1\n```'} />)
    expect(screen.queryByRole('button', { name: 'Insert code at the cursor' })).toBeNull()
  })

  it('reports nothing inserted when no editor is on screen', () => {
    expect(insertEditorText('x')).toBe(false)
  })
})


describe('breadcrumbs', () => {
  it('reveal the folder they name in the Explorer', async () => {
    mount()
    await openA()
    const heard: string[] = []
    const listen = (event: Event) => heard.push(String((event as CustomEvent<{ path?: string }>).detail?.path))
    window.addEventListener('sketch:reveal-in-explorer', listen)
    try {
      const path = screen.getByRole('navigation', { name: 'File path' })
      fireEvent.click(within(path).getByRole('button', { name: 'src' }))
      fireEvent.click(within(path).getByRole('button', { name: 'app' }))
      expect(heard).toEqual(['C:/app/src', 'C:/app'])
      // The file itself is the current page, not a button.
      expect(within(path).getByText('a.ts').getAttribute('aria-current')).toBe('page')
    } finally {
      window.removeEventListener('sketch:reveal-in-explorer', listen)
    }
  })
})
