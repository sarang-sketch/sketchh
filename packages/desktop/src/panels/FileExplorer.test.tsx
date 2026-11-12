// The Explorer, driven against a REAL directory tree on disk.
//
// The file layer here is not a stand-in for the filesystem: it is `node:fs` reading
// directories that `mkdtempSync` created, so a row on screen exists because a real
// entry exists, and clicking one reads real bytes. What it stands in for is the Tauri
// `read_dir` command, which has no implementation under jsdom — so this double
// reproduces its SHAPE deliberately: the same containment refusal, the same skip list
// (dotfiles, `node_modules`, `target`, `dist`) and the same ordering as
// src-tauri/src/main.rs. Filtering and sorting are the backend's decisions and are
// not re-made in the panel, so a double that invented its own would prove nothing.
//
// What is REAL in every test below: `listForExplorer`, `describeFileFailure`,
// `flattenTree`, `directoriesToRead`, `useFileActions.openPath`, `readForEditor` and
// the `AppState` reducer.
//
// Validates: Requirements 14.4, 14.6, 27.1, 27.3, 27.4

import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { StrictMode } from 'react'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { FileExplorer } from './FileExplorer'
import { announceDiskChanged } from '../editor/diskSync'
import { READING } from '../explorer/fileTree'
import { FileIoProvider } from '../editor/FileIoProvider'
import type { FileIo, FsEntry } from '../editor/fileIo'
import { canonicalPath, isWithinRoot, toAbsolutePath } from '../editor/paths'
import { AppStateProvider, makeFileEntry, useAppState, type AppState } from '../state/AppState'

// ── a real directory on disk, behind the real seam ───────────────────────────

const tmpDirs: string[] = []

function makeDir(): string {
  // Canonical, because that is the spelling `SET_PROJECT_ROOT` would store.
  const dir = canonicalPath(mkdtempSync(join(tmpdir(), 'sketch-explorer-')))
  tmpDirs.push(dir)
  return dir
}

/** Skipped by the backend, and therefore by this double. Same list, one place. */
const SKIPPED = ['node_modules', 'target', 'dist']

interface RecordingIo {
  io: FileIo
  /** Every directory listed, in order. The lazy-loading assertions read this. */
  listed: string[]
}

function nodeIo(overrides: Partial<FileIo> = {}): RecordingIo {
  const listed: string[] = []
  const io: FileIo = {
    async readDir(root, path) {
      listed.push(canonicalPath(path))
      const target = toAbsolutePath(root, path)
      if (!isWithinRoot(root, target)) {
        throw new Error(`This directory is outside the folder you have open in Sketch, so it cannot be reached from here:\n  directory: ${path}\n  open folder: ${root}`)
      }
      const entries: FsEntry[] = readdirSync(target, { withFileTypes: true })
        .filter((e) => !e.name.startsWith('.') && !SKIPPED.includes(e.name))
        .map((e) => ({ name: e.name, path: join(target, e.name), isDir: e.isDirectory() }))
      return entries.sort((a, b) =>
        a.isDir === b.isDir
          ? a.name.toLowerCase().localeCompare(b.name.toLowerCase())
          : a.isDir
            ? -1
            : 1,
      )
    },
    async readFile(root, path) {
      const target = toAbsolutePath(root, path)
      if (!isWithinRoot(root, target)) {
        throw new Error(`This file is outside the folder you have open in Sketch, so it cannot be reached from here:\n  file: ${path}\n  open folder: ${root}`)
      }
      return readFileSync(target, 'utf8')
    },
    async writeFile() {
      throw new Error('the Explorer never writes a file')
    },
    async pickFolder() {
      return null
    },
    ...overrides,
  }
  return { io, listed }
}

/** Reads the one authoritative record of what is open, so the test does not guess. */
function OpenFileProbe() {
  const state = useAppState()
  const active = state.activeFile
  return (
    <div>
      <span data-testid="active">{active ?? 'none'}</span>
      <span data-testid="content">{active ? (state.files[active]?.content ?? '') : ''}</span>
    </div>
  )
}

function mount(root: string | null, io: FileIo, initial: Partial<AppState> = {}) {
  return render(
    <AppStateProvider initial={{ projectRoot: root, ...initial }}>
      <FileIoProvider io={io}>
        <FileExplorer />
        <OpenFileProbe />
      </FileIoProvider>
    </AppStateProvider>,
  )
}

afterEach(() => {
  cleanup()
})

// ── 1. the fixture is gone ──────────────────────────────────────────────────

describe('FileExplorer — the fixture is gone', () => {
  /**
   * The panel's CODE, comments removed. The file documents what it replaced, and a
   * raw-text check cannot tell an explanation of a removal from the removal itself.
   */
  const code = readFileSync(
    join(dirname(fileURLToPath(import.meta.url)), 'FileExplorer.tsx'),
    'utf8',
  )
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')

  it('declares no MOCK_ fixture (Requirement 14.6)', () => {
    expect(code).not.toMatch(/const MOCK_/)
    expect(code).not.toMatch(/MOCK_TREE/)
  })

  it('holds no second opinion about the active file and no invented project name', () => {
    // The highlight is `AppState.activeFile`, never local state.
    expect(code).not.toMatch(/useState\(\s*['"]/)
    expect(code).not.toContain('sketch-desktop')
    expect(code).toContain('state.activeFile')
  })

  it('never sets HTML directly', () => {
    expect(code).not.toContain('dangerouslySetInnerHTML')
  })
})

// ── 2. real entries, lazily ─────────────────────────────────────────────────

describe('FileExplorer against a real directory', () => {
  it('lists the folder under React StrictMode, as the app runs in development', async () => {
    // StrictMode mounts, unmounts and mounts again with refs kept; a "still mounted"
    // flag that is only ever cleared then drops every listing and shows "Reading…".
    const dir = makeDir()
    writeFileSync(join(dir, 'strict.ts'), 'x\n', 'utf8')
    const recording = nodeIo()
    render(
      <StrictMode>
        <AppStateProvider initial={{ projectRoot: dir }}>
          <FileIoProvider io={recording.io}>
            <FileExplorer />
          </FileIoProvider>
        </AppStateProvider>
      </StrictMode>,
    )
    expect(await screen.findByText('strict.ts')).toBeDefined()
    expect(screen.queryByText(READING)).toBeNull()
  })

  it('shows what a terminal command created or deleted, without a refresh click or a flicker', async () => {
    const dir = makeDir()
    writeFileSync(join(dir, 'keep.ts'), 'keep\n', 'utf8')
    writeFileSync(join(dir, 'old.ts'), 'old\n', 'utf8')
    const recording = nodeIo()
    mount(dir, recording.io)
    expect(await screen.findByText('old.ts')).toBeDefined()

    writeFileSync(join(dir, 'generated.ts'), 'new\n', 'utf8')
    rmSync(join(dir, 'old.ts'))
    act(() => announceDiskChanged('terminal'))
    // The rows already on screen stay while the folder is re-read: no "Reading…" gap.
    expect(screen.getByText('keep.ts')).toBeDefined()
    expect(screen.queryByText(READING)).toBeNull()

    expect(await screen.findByText('generated.ts')).toBeDefined()
    await waitFor(() => expect(screen.queryByText('old.ts')).toBeNull())
    expect(screen.getByText('keep.ts')).toBeDefined()
  })

  it('does not lose a change announced while the folder is still being re-read', async () => {
    const dir = makeDir()
    writeFileSync(join(dir, 'keep.ts'), 'keep\n', 'utf8')
    const recording = nodeIo()
    // A re-read that is slow to come back: it lists the folder as it was when it
    // started, then waits until the test lets it finish.
    let hold: Promise<void> | null = null
    let release = () => {}
    const reads: string[] = []
    const io: FileIo = {
      ...recording.io,
      async readDir(root, path) {
        const listing = await recording.io.readDir(root, path)
        reads.push(path)
        if (hold !== null) await hold
        return listing
      },
    }
    mount(dir, io)
    expect(await screen.findByText('keep.ts')).toBeDefined()

    hold = new Promise<void>((resolve) => {
      release = resolve
    })
    const before = reads.length
    act(() => announceDiskChanged('terminal'))
    await waitFor(() => expect(reads.length).toBeGreaterThan(before))

    // While that read is out, a command creates a file and says so.
    writeFileSync(join(dir, 'late.ts'), 'late\n', 'utf8')
    act(() => announceDiskChanged('terminal'))
    await act(async () => {
      await new Promise((resolve) => setTimeout(resolve, 300))
    })

    hold = null
    await act(async () => release())
    expect(await screen.findByText('late.ts')).toBeDefined()
  })

  it('lists what is on disk, folders first, and names the real project', async () => {
    const dir = makeDir()
    mkdirSync(join(dir, 'src'))
    writeFileSync(join(dir, 'README.md'), '# real\n', 'utf8')
    writeFileSync(join(dir, 'package.json'), '{}\n', 'utf8')

    mount(dir, nodeIo().io)

    expect(await screen.findByText('src')).toBeDefined()
    expect(screen.getByText('README.md')).toBeDefined()
    expect(screen.getByText('package.json')).toBeDefined()
    // The header names the folder the user opened.
    expect(screen.getByText(dir.slice(dir.lastIndexOf('/') + 1))).toBeDefined()

    const names = screen
      .getAllByRole('treeitem')
      .map((row) => row.textContent?.trim())
    expect(names).toEqual(['src', 'package.json', 'README.md'])
  })

  it('reads one directory on mount and one more per expansion, never a walk', async () => {
    const dir = makeDir()
    mkdirSync(join(dir, 'src', 'nested', 'deeper'), { recursive: true })
    writeFileSync(join(dir, 'src', 'nested', 'deeper', 'buried.ts'), 'export {}\n', 'utf8')
    writeFileSync(join(dir, 'src', 'main.ts'), 'export const a = 1\n', 'utf8')

    const { io, listed } = nodeIo()
    mount(dir, io)

    expect(await screen.findByText('src')).toBeDefined()
    // Nothing below the root has been touched, so nothing below it is on screen.
    expect(listed).toEqual([dir])
    expect(screen.queryByText('main.ts')).toBeNull()
    expect(screen.queryByText('buried.ts')).toBeNull()

    fireEvent.click(screen.getByText('src'))
    expect(await screen.findByText('main.ts')).toBeDefined()
    expect(listed).toEqual([dir, `${dir}/src`])
    expect(screen.queryByText('buried.ts')).toBeNull()

    fireEvent.click(screen.getByText('nested'))
    expect(await screen.findByText('deeper')).toBeDefined()
    expect(listed).toEqual([dir, `${dir}/src`, `${dir}/src/nested`])

    // Collapsing does not re-read, and does not lose the listing.
    fireEvent.click(screen.getByText('src'))
    await waitFor(() => expect(screen.queryByText('main.ts')).toBeNull())
    fireEvent.click(screen.getByText('src'))
    expect(await screen.findByText('nested')).toBeDefined()
    expect(listed).toEqual([dir, `${dir}/src`, `${dir}/src/nested`])
  })

  it('opens a real file with real content when it is clicked (Requirement 27.3)', async () => {
    const dir = makeDir()
    writeFileSync(join(dir, 'hello.ts'), 'export const hello = "on disk"\n', 'utf8')

    mount(dir, nodeIo().io)

    fireEvent.click(await screen.findByText('hello.ts'))

    // The single state owner is what proves it opened, not the row's styling.
    await waitFor(() =>
      expect(screen.getByTestId('active').textContent).toBe(`${dir}/hello.ts`),
    )
    expect(screen.getByTestId('content').textContent).toBe('export const hello = "on disk"\n')
  })

  it('takes the highlight from AppState.activeFile, not from a click of its own', async () => {
    const dir = makeDir()
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n', 'utf8')
    writeFileSync(join(dir, 'b.ts'), 'export const b = 2\n', 'utf8')
    const b = canonicalPath(join(dir, 'b.ts'))

    // Opened by something other than this panel — the engine, a tab, a restore.
    mount(dir, nodeIo().io, {
      openFiles: [b],
      activeFile: b,
      files: { [b]: makeFileEntry(b, 'export const b = 2\n') },
    })

    const selected = () =>
      screen
        .getAllByRole('treeitem')
        .filter((row) => row.getAttribute('aria-selected') === 'true')
        .map((row) => row.textContent?.trim())

    await waitFor(() => expect(selected()).toEqual(['b.ts']))

    fireEvent.click(screen.getByText('a.ts'))
    await waitFor(() => expect(selected()).toEqual(['a.ts']))
  })
})

// ── 3. three distinct nothings ──────────────────────────────────────────────

describe('FileExplorer — honest states', () => {
  it('says no folder is opened, and lists nothing at all', async () => {
    mount(null, nodeIo().io)

    expect(await screen.findByText('No folder opened')).toBeDefined()
    expect(screen.queryByRole('tree')).toBeNull()
    expect(screen.queryByRole('treeitem')).toBeNull()
  })

  it('says an empty directory is empty', async () => {
    mount(makeDir(), nodeIo().io)

    expect(await screen.findByText('This folder is empty.')).toBeDefined()
    expect(screen.queryByRole('alert')).toBeNull()
  })

  it('names a failed read and its reason instead of drawing an empty folder', async () => {
    const dir = makeDir()
    const { io } = nodeIo({
      async readDir(_root, path) {
        throw new Error(`failed to read '${path}': Access is denied. (os error 5)`)
      },
    })

    mount(dir, io)

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('permission denied by the operating system')
    // A failure is not an empty folder.
    expect(screen.queryByText('This folder is empty.')).toBeNull()
    expect(screen.queryByRole('treeitem')).toBeNull()
  })

  it('names a failed read of one subfolder without losing the rest of the tree', async () => {
    const dir = makeDir()
    mkdirSync(join(dir, 'gone'))
    writeFileSync(join(dir, 'kept.ts'), 'export const kept = 1\n', 'utf8')
    const real = nodeIo()
    const { io } = nodeIo({
      async readDir(root, path) {
        if (canonicalPath(path).endsWith('/gone')) {
          throw new Error(`failed to read '${path}': The system cannot find the path (os error 3)`)
        }
        return real.io.readDir(root, path)
      },
    })

    mount(dir, io)

    fireEvent.click(await screen.findByText('gone'))

    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('no longer exists on disk')
    // The rest of the tree is still there.
    expect(screen.getByText('kept.ts')).toBeDefined()
  })

  it('re-reads from disk when refreshed, showing what changed', async () => {
    const dir = makeDir()
    writeFileSync(join(dir, 'first.ts'), 'export const a = 1\n', 'utf8')

    const { io, listed } = nodeIo()
    mount(dir, io)

    expect(await screen.findByText('first.ts')).toBeDefined()
    writeFileSync(join(dir, 'second.ts'), 'export const b = 2\n', 'utf8')
    expect(screen.queryByText('second.ts')).toBeNull()

    fireEvent.click(screen.getByLabelText('Refresh the file tree'))

    expect(await screen.findByText('second.ts')).toBeDefined()
    expect(screen.getByText('first.ts')).toBeDefined()
    expect(listed).toEqual([dir, dir])
  })
})

afterAll(() => {
  for (const dir of tmpDirs) {
    try {
      rmSync(dir, { recursive: true, force: true })
    } catch {
      // A locked temp directory is not a test failure.
    }
  }
})
