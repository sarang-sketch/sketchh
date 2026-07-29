// The editor as it actually runs: real EditorArea, real CodeEditor, real
// ModelRegistry, real AppState reducer, real useFileActions, real reconciler.
//
// TWO THINGS ARE DOUBLED, both because they cannot exist under jsdom, and neither of
// them is logic this phase is about:
//   * Monaco's text buffer  (./monacoDouble.ts — measures a real DOM, spawns workers)
//   * the Tauri file layer  (./fakeDisk.ts — `invoke` has no implementation here)
// Containment is NOT doubled away: the fake disk reproduces Rust's refusal messages,
// so a refused read or write is exercised exactly as a user would meet it.
//
// THE CENTRAL ASSERTION is `expectOneCache`, called after every kind of change: a
// disk load, a keystroke, an engine write, a conflict reload, a save. It reads the
// authoritative text out of `AppState` and the model's text out of Monaco and
// requires them equal. Requirement 15.2's "two independent caches SHALL NOT exist"
// cannot be proven by counting objects — a model must hold text. What can be proven
// is that the two cannot DISAGREE, and a bug that broke either direction of the
// projection would fail this helper.
//
// Validates: Requirements 15.1, 15.2, 15.3, 15.4, 15.6, 14.6, 27.3

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { readdirSync, readFileSync, statSync } from 'node:fs'
import { join } from 'node:path'
import EditorArea from '../components/EditorArea'
import { SketchClientProvider } from '../lib/ClientProvider'
import { createEventBus, type PingResult, type SketchClient } from '../lib/client'
import type { RunResult, SketchEvent } from '../lib/contracts'
import { AppStateProvider, useAppState, type AppState } from '../state/AppState'
import { FileIoProvider } from './FileIoProvider'
import { createFakeDisk, type FakeDisk } from './fakeDisk'
import { createMonacoDouble, type MonacoDouble } from './monacoDouble'
import { useFileActions } from './useFileActions'

// The seam this file replaces, and the only one: `loadMonaco`. Everything below it
// runs for real. The double is swapped per test through the holder.
const holder = vi.hoisted(() => ({ double: null as { api: unknown } | null }))
vi.mock('./monacoSetup', () => ({
  loadMonaco: () => Promise.resolve({ api: holder.double!.api, theme: 'test-theme' }),
}))

const ROOT = 'C:/app'
const A = 'C:/app/src/App.tsx'
const B = 'C:/app/src/styles.css'
const OUTSIDE = 'C:/elsewhere/id_rsa'

/** A client that emits nothing until a test says so. */
class FakeEventClient implements SketchClient {
  readonly transport = 'mock' as const
  private readonly bus = createEventBus()
  private seq = 0

  ping(): Promise<PingResult> {
    return Promise.resolve({ ok: true, version: 'test', transport: 'mock' })
  }

  run(): Promise<RunResult> {
    throw new Error('the editor never starts a run')
  }

  eval(): Promise<never[]> {
    return Promise.resolve([])
  }

  subscribe(handler: (event: SketchEvent) => void) {
    return this.bus.subscribe(handler)
  }

  /** What the engine's file writer produces after it writes a file. */
  editAccepted(path: string, bytes: number): void {
    this.seq += 1
    this.bus.emit({
      id: `evt-${this.seq}`,
      ts: 1_700_000_000_000 + this.seq,
      runId: 'run-1',
      kind: 'edit_accepted',
      payload: { path, bytes, created: false },
    })
  }
}

/**
 * Stands in for the FileExplorer, which is task 3.4's job. It calls the same
 * `useFileActions` the Explorer will, so nothing here is a shortcut around the state
 * owner — every button dispatches through the reducer.
 */
function Harness() {
  const actions = useFileActions()
  const state = useAppState()
  const files = Object.fromEntries(
    Object.entries(state.files).map(([path, entry]) => [
      path,
      { content: entry.content, isDirty: entry.isDirty, conflict: entry.conflict !== null && entry.conflict !== undefined },
    ]),
  )
  return (
    <>
      <EditorArea />
      {[A, B, OUTSIDE].map((path) => (
        <button key={path} onClick={() => void actions.openPath(path)}>{`open:${path}`}</button>
      ))}
      <div data-testid="probe">
        {JSON.stringify({ openFiles: state.openFiles, activeFile: state.activeFile, files })}
      </div>
    </>
  )
}

interface Snapshot {
  openFiles: string[]
  activeFile: string | null
  files: Record<string, { content: string; isDirty: boolean; conflict: boolean }>
}

function snapshot(): Snapshot {
  return JSON.parse(screen.getByTestId('probe').textContent ?? '{}') as Snapshot
}

let monaco: MonacoDouble
let disk: FakeDisk
let client: FakeEventClient

function mount(initial: Partial<AppState> = {}) {
  render(
    <SketchClientProvider client={client}>
      <AppStateProvider initial={{ mode: 'ide', projectRoot: ROOT, ...initial }}>
        <FileIoProvider io={disk.io}>
          <Harness />
        </FileIoProvider>
      </AppStateProvider>
    </SketchClientProvider>,
  )
}

/** Open a file the way the Explorer will, and wait for its model to exist. */
async function open(path: string): Promise<void> {
  fireEvent.click(screen.getByText(`open:${path}`))
  await waitFor(() => {
    expect(monaco.live.has(path)).toBe(true)
  })
}

/** The whole point: state's text and Monaco's text cannot disagree (Req 15.2). */
function expectOneCache(path: string): void {
  const entry = snapshot().files[path]
  expect(entry).toBeDefined()
  expect(monaco.model(path).getValue()).toBe(entry!.content)
}

beforeEach(() => {
  monaco = createMonacoDouble()
  holder.double = monaco
  disk = createFakeDisk({ [A]: 'const a = 1', [B]: 'body {}', [OUTSIDE]: 'ssh-rsa AAAA' })
  client = new FakeEventClient()
})

afterEach(cleanup)

describe('EditorArea — everything on screen comes from state', () => {
  it('starts with no tabs and no fabricated files', () => {
    mount()

    expect(screen.getByText('No file is open.')).toBeDefined()
    expect(screen.queryAllByRole('tab')).toEqual([])
    // The two hardcoded tabs that used to ship here.
    expect(screen.queryByText('App.tsx')).toBeNull()
    expect(screen.queryByText('styles.css')).toBeNull()
    expect(snapshot().files).toEqual({})
  })

  it('opens a folder through the real OS picker, not a hardcoded path', async () => {
    disk.pickResult = 'C:\\Users\\me\\project'
    mount({ projectRoot: null })

    fireEvent.click(screen.getByText('Open Folder'))
    // The welcome screen gives way to the editor for the folder the user picked, at
    // the canonical spelling of the path the picker returned.
    await waitFor(() => {
      expect(screen.getByText('No file is open.')).toBeDefined()
    })
    expect(disk.pickCalls).toBe(1)
    expect(screen.queryByText('Open Folder')).toBeNull()
  })

  it('treats a cancelled picker as nothing happening', async () => {
    disk.pickResult = null
    mount({ projectRoot: null })

    fireEvent.click(screen.getByText('Open Folder'))
    await waitFor(() => {
      expect(disk.pickCalls).toBe(1)
    })
    expect(screen.getByText('Open Folder')).toBeDefined()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('builds a tab per open file, loading the bytes from the filesystem seam', async () => {
    mount()
    await open(A)
    await open(B)

    const tabs = screen.getAllByRole('tab')
    expect(tabs.map((tab) => tab.getAttribute('title'))).toEqual([A, B])
    // Read through the seam, with the project root attached to every call — Rust
    // requires it and contains against it (Requirement 15.4, 15.6).
    expect(disk.reads).toEqual([
      { root: ROOT, path: A },
      { root: ROOT, path: B },
    ])
    expect(monaco.model(A).getValue()).toBe('const a = 1')
    expect(monaco.model(A).language).toBe('typescript')
    expect(monaco.model(B).language).toBe('css')
    expectOneCache(A)
    expectOneCache(B)
  })

  it('shows a refused open as a specific error, not an empty buffer', async () => {
    mount()
    fireEvent.click(screen.getByText(`open:${OUTSIDE}`))

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('outside the open project')
    })
    expect(snapshot().openFiles).toEqual([])
    expect(monaco.live.size).toBe(0)
  })

  it('reads the caret from Monaco instead of printing a fixed position', async () => {
    mount()
    await open(A)
    expect(screen.getByLabelText('cursor position').textContent).toBe('Ln 1, Col 1')

    // The readout used to say "Ln 12, Col 4" no matter where the caret was.
    act(() => {
      monaco.lastEditor().moveTo(12, 4)
    })
    expect(screen.getByLabelText('cursor position').textContent).toBe('Ln 12, Col 4')
  })
})

describe('one authoritative cache — Requirement 15.2', () => {
  it('carries a keystroke into state and marks the file dirty', async () => {
    mount()
    await open(A)

    act(() => {
      monaco.model(A).typeText('const a = 2')
    })

    const entry = snapshot().files[A]!
    expect(entry.content).toBe('const a = 2')
    expect(entry.isDirty).toBe(true)
    expectOneCache(A)
    // The buffer is dirty, so disk still holds the old bytes.
    expect(disk.read(A)).toBe('const a = 1')
  })

  it('never creates a second model for a file, however it is re-opened', async () => {
    mount()
    await open(A)
    act(() => {
      monaco.model(A).typeText('typed by hand')
    })

    // Re-opening focuses the tab; it must not re-read the file over the edits.
    fireEvent.click(screen.getByText(`open:${A}`))
    await waitFor(() => {
      expect(snapshot().activeFile).toBe(A)
    })

    expect(monaco.created.size).toBe(1)
    expect(snapshot().files[A]!.content).toBe('typed by hand')
    expect(disk.reads).toHaveLength(1)
    expectOneCache(A)
  })

  it('disposes the model when the tab closes, leaving no orphan text', async () => {
    mount()
    await open(A)
    await open(B)

    fireEvent.click(screen.getByLabelText('Close App.tsx'))

    await waitFor(() => {
      expect(monaco.model(A).isDisposed()).toBe(true)
    })
    expect(monaco.live.size).toBe(1)
    expect(snapshot().files[A]).toBeUndefined()
    expect(snapshot().activeFile).toBe(B)
    expectOneCache(B)
  })
})

describe('engine writes — Requirement 15.3', () => {
  it('updates a CLEAN buffer, in the model as well as in state', async () => {
    mount()
    await open(A)

    // What the engine did: it wrote the file. The event only says so.
    disk.set(A, 'const a = 99 // by the engine')
    act(() => {
      client.editAccepted('src/App.tsx', 29)
    })

    await waitFor(() => {
      expect(snapshot().files[A]!.content).toBe('const a = 99 // by the engine')
    })
    expect(snapshot().files[A]!.isDirty).toBe(false)
    expect(snapshot().files[A]!.conflict).toBe(false)
    expectOneCache(A)
    expect(screen.queryByText('Reload from disk')).toBeNull()
  })

  it('does NOT lose a DIRTY buffer; it surfaces a conflict', async () => {
    mount()
    await open(A)
    act(() => {
      monaco.model(A).typeText('mine, unsaved')
    })

    disk.set(A, 'theirs, on disk')
    act(() => {
      client.editAccepted('src/App.tsx', 15)
    })

    await waitFor(() => {
      expect(screen.getByText('Reload from disk')).toBeDefined()
    })
    // The user's text is still here, in state and in the model.
    expect(snapshot().files[A]!.content).toBe('mine, unsaved')
    expect(snapshot().files[A]!.isDirty).toBe(true)
    expect(snapshot().files[A]!.conflict).toBe(true)
    expectOneCache(A)
  })

  it('resolves a conflict only when the user chooses, either way', async () => {
    mount()
    await open(A)
    act(() => {
      monaco.model(A).typeText('mine')
    })
    disk.set(A, 'theirs')
    act(() => {
      client.editAccepted('src/App.tsx', 6)
    })
    await waitFor(() => {
      expect(screen.getByText('Keep my version')).toBeDefined()
    })

    // Keep mine: the conflict goes away, the text does not.
    fireEvent.click(screen.getByText('Keep my version'))
    await waitFor(() => {
      expect(snapshot().files[A]!.conflict).toBe(false)
    })
    expect(snapshot().files[A]!.content).toBe('mine')
    expect(snapshot().files[A]!.isDirty).toBe(true)
    expectOneCache(A)

    // And the other branch: take what is on disk.
    act(() => {
      client.editAccepted('src/App.tsx', 6)
    })
    await waitFor(() => {
      expect(screen.getByText('Reload from disk')).toBeDefined()
    })
    fireEvent.click(screen.getByText('Reload from disk'))
    await waitFor(() => {
      expect(snapshot().files[A]!.content).toBe('theirs')
    })
    expect(snapshot().files[A]!.isDirty).toBe(false)
    // The reload reached the model too, and was not reported back as a user edit.
    expect(monaco.model(A).getValue()).toBe('theirs')
    expectOneCache(A)
  })

  it('ignores a write to a file that is not open', async () => {
    mount()
    await open(A)
    disk.set(B, 'engine output')
    act(() => {
      client.editAccepted('src/styles.css', 13)
    })

    await waitFor(() => {
      expect(disk.reads).toHaveLength(1)
    })
    expect(snapshot().files[B]).toBeUndefined()
  })
})

describe('saving — Ctrl/Cmd+S', () => {
  async function typeAndSave(key: { ctrlKey?: boolean; metaKey?: boolean }) {
    mount()
    await open(A)
    act(() => {
      monaco.model(A).typeText('const a = saved')
    })
    fireEvent.keyDown(window, { key: 's', ...key })
  }

  it('writes the buffer through the seam and clears the dirty flag', async () => {
    await typeAndSave({ ctrlKey: true })

    await waitFor(() => {
      expect(snapshot().files[A]!.isDirty).toBe(false)
    })
    expect(disk.writes).toEqual([{ root: ROOT, path: A, content: 'const a = saved' }])
    expect(disk.read(A)).toBe('const a = saved')
    expectOneCache(A)
  })

  it('accepts Cmd+S as well', async () => {
    await typeAndSave({ metaKey: true })
    await waitFor(() => {
      expect(disk.writes).toHaveLength(1)
    })
  })

  it('shows a refused write and keeps the file dirty, never a silent no-op', async () => {
    disk.writeError = new Error(
      `file '${A}' is outside the open project root ${ROOT}`,
    )
    await typeAndSave({ ctrlKey: true })

    await waitFor(() => {
      expect(screen.getByRole('alert').textContent).toContain('outside the open project')
    })
    expect(screen.getByRole('alert').textContent).toContain('App.tsx')
    // Still dirty: the tab does not get to look saved when nothing was written.
    expect(snapshot().files[A]!.isDirty).toBe(true)
    expect(disk.writes).toEqual([])
  })
})

describe('the test doubles stay in the tests', () => {
  it('is not imported by anything that ships', () => {
    // The whole of src/, so a double reaching production is caught wherever it
    // lands. Vitest runs with the package directory as cwd; the assertion below
    // makes a wrong cwd fail as a wrong cwd instead of as a silent pass.
    const root = join(process.cwd(), 'src')
    expect(readdirSync(root)).toContain('editor')
    const offenders: string[] = []

    const walk = (dir: string): void => {
      for (const name of readdirSync(dir)) {
        const full = join(dir, name)
        if (statSync(full).isDirectory()) {
          walk(full)
          continue
        }
        if (!/\.tsx?$/.test(name)) continue
        if (/\.test\.tsx?$/.test(name)) continue
        if (name === 'monacoDouble.ts' || name === 'fakeDisk.ts') continue
        const source = readFileSync(full, 'utf8')
        if (/from '\.{1,2}[^']*\/?(monacoDouble|fakeDisk)'/.test(source)) offenders.push(full)
      }
    }
    walk(root)

    expect(offenders).toEqual([])
  })
})
