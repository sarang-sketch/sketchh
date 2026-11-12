// Open tabs stay in step with the disk.
//
// The bug this covers: a tab kept showing a file's old text after something other than
// the editor changed it — a `git switch` or pull, a formatter run in the terminal,
// another program — and the next save wrote the old text back, undoing that change
// without a word.
//
// Real reducer, real `useFileActions`, real disk sync, real EditorArea. Doubled only
// where jsdom has nothing: Monaco's buffer and the Tauri file layer.

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'

import EditorArea, { AUTO_SAVE_DELAY_MS } from '../components/EditorArea'
import { SketchClientProvider } from '../lib/ClientProvider'
import { createEventBus, type PingResult, type SketchClient } from '../lib/client'
import type { RunResult, SketchEvent } from '../lib/contracts'
import { AppStateProvider, appReducer, initialAppState, makeFileEntry, useAppState, type AppState } from '../state/AppState'
import { FileIoProvider } from './FileIoProvider'
import { announceDiskChanged } from './diskSync'
import { createFakeDisk, type FakeDisk } from './fakeDisk'
import { createMonacoDouble, type MonacoDouble } from './monacoDouble'
import { useFileActions } from './useFileActions'

const holder = vi.hoisted(() => ({ double: null as { api: unknown } | null }))
vi.mock('./monacoSetup', () => ({
  loadMonaco: () => Promise.resolve({ api: holder.double!.api, theme: 'test-theme' }),
}))

const ROOT = 'C:/app'
const A = 'C:/app/src/App.tsx'
const B = 'C:/app/src/util.ts'

// ── the reducer's rules, on their own ───────────────────────────────────────

function opened(content = 'v1'): AppState {
  let state: AppState = { ...initialAppState, projectRoot: ROOT }
  state = appReducer(state, { type: 'OPEN_FILE', payload: makeFileEntry(A, content) })
  return state
}

describe('DISK_CHANGED / DISK_DELETED', () => {
  it('a clean tab takes the new text from disk', () => {
    const state = appReducer(opened(), { type: 'DISK_CHANGED', payload: { path: A, content: 'v2', version: 0 } })
    expect(state.files[A]).toMatchObject({ content: 'v2', isDirty: false, diskContent: 'v2', conflict: null })
  })

  it('an unchanged disk changes nothing at all', () => {
    const before = opened()
    expect(appReducer(before, { type: 'DISK_CHANGED', payload: { path: A, content: 'v1', version: 0 } })).toBe(before)
  })

  it('a tab with unsaved edits keeps them and is flagged instead', () => {
    let state = appReducer(opened(), { type: 'UPDATE_FILE_CONTENT', payload: { path: A, content: 'mine' } })
    state = appReducer(state, { type: 'DISK_CHANGED', payload: { path: A, content: 'theirs', version: 0, at: 5 } })
    expect(state.files[A]).toMatchObject({ content: 'mine', isDirty: true, diskContent: 'theirs' })
    expect(state.files[A]!.conflict).toEqual({ detectedAt: 5, engineBytes: 0, source: 'disk' })
    // Looking again finds the same disk: no second alarm, and "Keep my version" sticks.
    const kept = appReducer(state, { type: 'DISMISS_CONFLICT', payload: A })
    const again = appReducer(kept, { type: 'DISK_CHANGED', payload: { path: A, content: 'theirs', version: kept.files[A]!.diskVersion } })
    expect(again).toBe(kept)
  })

  it('drops a read that started before a save, so it cannot put old text back', () => {
    let state = appReducer(opened(), { type: 'UPDATE_FILE_CONTENT', payload: { path: A, content: 'saved text' } })
    const versionWhenTheReadStarted = state.files[A]!.diskVersion
    state = appReducer(state, { type: 'FILE_SAVED', payload: { path: A, content: 'saved text' } })
    // The slow read saw the disk from before the save.
    const after = appReducer(state, { type: 'DISK_CHANGED', payload: { path: A, content: 'v1', version: versionWhenTheReadStarted } })
    expect(after).toBe(state)
    expect(after.files[A]).toMatchObject({ content: 'saved text', isDirty: false })
  })

  it('a save while typing moves the baseline, so the next look raises no false conflict', () => {
    let state = appReducer(opened(), { type: 'UPDATE_FILE_CONTENT', payload: { path: A, content: 'edited' } })
    state = appReducer(state, { type: 'UPDATE_FILE_CONTENT', payload: { path: A, content: 'edited more' } })
    state = appReducer(state, { type: 'FILE_SAVED', payload: { path: A, content: 'edited' } })
    expect(state.files[A]).toMatchObject({ isDirty: true, diskContent: 'edited' })
    const looked = appReducer(state, { type: 'DISK_CHANGED', payload: { path: A, content: 'edited', version: state.files[A]!.diskVersion } })
    expect(looked).toBe(state)
  })

  it('typing back to what is on disk is clean again', () => {
    let state = appReducer(opened('abc'), { type: 'UPDATE_FILE_CONTENT', payload: { path: A, content: 'abcd' } })
    expect(state.files[A]!.isDirty).toBe(true)
    state = appReducer(state, { type: 'UPDATE_FILE_CONTENT', payload: { path: A, content: 'abc' } })
    expect(state.files[A]!.isDirty).toBe(false)
  })

  it('a deleted file keeps its tab and text; its return clears the mark', () => {
    let state = appReducer(opened(), { type: 'DISK_DELETED', payload: { path: A, version: 0 } })
    expect(state.files[A]).toMatchObject({ content: 'v1', deletedOnDisk: true })
    expect(state.openFiles).toEqual([A])
    state = appReducer(state, { type: 'DISK_CHANGED', payload: { path: A, content: 'v1', version: state.files[A]!.diskVersion } })
    expect(state.files[A]).toMatchObject({ content: 'v1', deletedOnDisk: false, isDirty: false })
  })

  it('an engine write that matches the unsaved buffer is no conflict', () => {
    let state = appReducer(opened(), { type: 'UPDATE_FILE_CONTENT', payload: { path: A, content: 'same' } })
    state = appReducer(state, { type: 'ENGINE_WROTE_FILE', payload: { path: A, content: 'same' } })
    expect(state.files[A]).toMatchObject({ isDirty: false, conflict: null, diskContent: 'same' })
  })
})

// ── the editor, against a fake disk ─────────────────────────────────────────

class QuietClient implements SketchClient {
  readonly transport = 'mock' as const
  private readonly bus = createEventBus()
  ping(): Promise<PingResult> {
    return Promise.resolve({ ok: true, version: 'test', transport: 'mock' })
  }
  run(): Promise<RunResult> {
    throw new Error('no runs here')
  }
  reply(): Promise<never> {
    return Promise.reject(new Error('no runs here'))
  }
  cancel(): Promise<never> {
    return Promise.reject(new Error('no runs here'))
  }
  eval(): Promise<never[]> {
    return Promise.resolve([])
  }
  subscribe(handler: (event: SketchEvent) => void) {
    return this.bus.subscribe(handler)
  }
  gitStatus(): Promise<never> {
    return Promise.reject(new Error('no repository'))
  }
  gitDiff(): Promise<never> {
    return Promise.reject(new Error('no repository'))
  }
  gitStage(): Promise<never> {
    return Promise.reject(new Error('no repository'))
  }
  gitUnstage(): Promise<never> {
    return Promise.reject(new Error('no repository'))
  }
  gitCommit(): Promise<never> {
    return Promise.reject(new Error('no repository'))
  }
  providerCatalog(): Promise<never> {
    return Promise.reject(new Error('no providers'))
  }
  saveProviderSettings(): Promise<never> {
    return Promise.reject(new Error('no providers'))
  }
  testProvider(): Promise<never> {
    return Promise.reject(new Error('no providers'))
  }
}

function Harness() {
  const actions = useFileActions()
  const state = useAppState()
  return (
    <>
      <EditorArea />
      {[A, B].map((path) => (
        <button key={path} onClick={() => void actions.openPath(path)}>{`open:${path}`}</button>
      ))}
      <div data-testid="probe">{JSON.stringify({ openFiles: state.openFiles, files: state.files })}</div>
    </>
  )
}

let monaco: MonacoDouble
let disk: FakeDisk

function probe(): { openFiles: string[]; files: AppState['files'] } {
  return JSON.parse(screen.getByTestId('probe').textContent ?? '{}')
}

function mount(initial: Partial<AppState> = {}) {
  render(
    <SketchClientProvider client={new QuietClient()}>
      <AppStateProvider initial={{ mode: 'ide', projectRoot: ROOT, ...initial }}>
        <FileIoProvider io={disk.io}>
          <Harness />
        </FileIoProvider>
      </AppStateProvider>
    </SketchClientProvider>,
  )
}

async function open(path: string) {
  fireEvent.click(screen.getByText(`open:${path}`))
  await waitFor(() => expect(monaco.live.has(path)).toBe(true))
}

beforeEach(() => {
  monaco = createMonacoDouble()
  holder.double = monaco
  disk = createFakeDisk({ [A]: 'const a = 1', [B]: 'export const b = 2' })
})

afterEach(cleanup)

describe('open tabs follow the disk', () => {
  it('a watcher report re-reads only the tabs it names, matching paths across spellings', async () => {
    mount()
    await open(A)
    await open(B)
    const reads = vi.spyOn(disk.io, 'readFile')
    disk.set(A, 'const a = 3 // saved in another editor')
    disk.set(B, 'export const b = 99 // not reported')
    reads.mockClear()
    // The engine reports native paths: backslashes and the disk's own case.
    act(() => announceDiskChanged('watcher', { paths: ['c:\\APP\\src\\App.tsx'] }))
    await waitFor(() => expect(probe().files[A]!.content).toBe('const a = 3 // saved in another editor'))
    expect(reads.mock.calls.map((call) => call[1])).toEqual([A])
    expect(probe().files[B]!.content).toBe('export const b = 2')
  })

  it('a watcher overflow (no paths) re-reads every tab', async () => {
    mount()
    await open(A)
    await open(B)
    disk.set(A, 'a2')
    disk.set(B, 'b2')
    act(() => announceDiskChanged('watcher', { git: true }))
    await waitFor(() => expect(probe().files[B]!.content).toBe('b2'))
    expect(probe().files[A]!.content).toBe('a2')
  })

  it('a clean tab shows what a terminal command wrote, in the editor as well as in state', async () => {
    mount()
    await open(A)
    disk.set(A, 'const a = 2 // formatted')
    act(() => announceDiskChanged('terminal'))
    await waitFor(() => expect(monaco.model(A).getValue()).toBe('const a = 2 // formatted'))
    expect(probe().files[A]).toMatchObject({ content: 'const a = 2 // formatted', isDirty: false })
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('coming back to the window is enough: another program changed the file meanwhile', async () => {
    mount()
    await open(A)
    disk.set(A, 'changed in another editor')
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })
    await waitFor(() => expect(probe().files[A]!.content).toBe('changed in another editor'))
  })

  it('a tab with unsaved edits keeps them, says so, and saving no longer overwrites silently', async () => {
    mount()
    await open(A)
    act(() => monaco.model(A).typeText('mine, unsaved'))
    disk.set(A, 'pulled from origin')
    act(() => announceDiskChanged('git'))

    await waitFor(() => expect(screen.getByText(/changed on disk while you had unsaved edits/)).toBeDefined())
    expect(monaco.model(A).getValue()).toBe('mine, unsaved')
    expect(disk.read(A)).toBe('pulled from origin')
    // Auto-save must not decide this for the user either.
    expect(disk.writes).toEqual([])

    fireEvent.click(screen.getByText('Reload from disk'))
    await waitFor(() => expect(monaco.model(A).getValue()).toBe('pulled from origin'))
    expect(probe().files[A]).toMatchObject({ isDirty: false, conflict: null })
  })

  it('a file deleted on disk keeps its tab; Save recreates it', async () => {
    mount()
    await open(A)
    disk.files.delete(A)
    act(() => announceDiskChanged('git'))
    await waitFor(() => expect(screen.getByText(/was deleted on disk/)).toBeDefined())
    expect(probe().openFiles).toEqual([A])
    expect(monaco.model(A).getValue()).toBe('const a = 1')

    fireEvent.click(screen.getByText('Save to recreate'))
    await waitFor(() => expect(disk.read(A)).toBe('const a = 1'))
    await waitFor(() => expect(screen.queryByText(/was deleted on disk/)).toBeNull())
    expect(probe().files[A]).toMatchObject({ deletedOnDisk: false, isDirty: false })
  })

  it('auto-save never resurrects a file a branch switch removed', async () => {
    mount({ editorSettings: { ...initialAppState.editorSettings, autoSave: 'afterDelay' } })
    await open(A)
    disk.files.delete(A)
    act(() => announceDiskChanged('git'))
    await waitFor(() => expect(probe().files[A]!.deletedOnDisk).toBe(true))
    act(() => monaco.model(A).typeText('typed after the switch'))
    expect(probe().files[A]!.isDirty).toBe(true)
    // Past the auto-save delay, in real time.
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, AUTO_SAVE_DELAY_MS + 300))
    })
    expect(disk.read(A)).toBeUndefined()
    expect(disk.writes).toEqual([])
  })

  it('a look during a save does not mistake the half-written file for a change', async () => {
    let release: () => void = () => {}
    const gate = new Promise<void>((resolve) => {
      release = resolve
    })
    const write = disk.io.writeFile
    disk.io.writeFile = async (root, path, content) => {
      // The disk is mid-write: truncated, as a real write is for a moment.
      disk.set(path, '')
      await gate
      return write(root, path, content)
    }
    mount()
    await open(A)
    act(() => monaco.model(A).typeText('final text'))
    fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    act(() => announceDiskChanged('terminal'))
    // Long enough for the coalesced look to have run against the truncated file.
    await new Promise((resolve) => setTimeout(resolve, 300))
    expect(probe().files[A]!.conflict ?? null).toBeNull()
    expect(monaco.model(A).getValue()).toBe('final text')

    release()
    await waitFor(() => expect(probe().files[A]!.isDirty).toBe(false))
    expect(disk.read(A)).toBe('final text')
    expect(probe().files[A]!.conflict ?? null).toBeNull()
  })

  it('only open tabs are read; nothing else on disk is touched', async () => {
    mount()
    await open(A)
    disk.reads.length = 0
    act(() => announceDiskChanged('agent'))
    await waitFor(() => expect(disk.reads.length).toBeGreaterThan(0))
    expect(disk.reads.map((r) => r.path)).toEqual([A])
  })
})
