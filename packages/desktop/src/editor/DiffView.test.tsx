// The diff view, end to end: a real git repository, the real engine methods (git-status,
// git-show, git-stage…), the real Source Control panel, reducer, model registry and file
// actions — only Monaco is replaced by its double. In user terms:
//   * double-clicking a changed file in Source Control opens it side by side, with the
//     last staged or committed version on the left and the user's own file on the right;
//   * the right side IS the tab: typing there marks it unsaved and Ctrl+S saves the file;
//   * a staged change compares the last commit with what is staged, read-only, and
//     follows the index when more is staged;
//   * a new file compares with nothing, a deleted one has nothing left to edit;
//   * closing the comparison (its ✕, a tab, the Changes toggle) leaves the tab, its
//     model and its undo history exactly as they were;
//   * the layout toggles stick, and a failure to read git is said, not hidden.

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { METHODS, type MethodContext } from '@sketch/core'

import EditorArea from '../components/EditorArea'
import { ConfirmProvider } from '../components/ConfirmDialog'
import { GitPanel } from '../panels/GitPanel'
import { GitProvider } from '../git/GitProvider'
import { SketchClientProvider } from '../lib/ClientProvider'
import { MockSketchClient } from '../lib/mockClient'
import type { SketchClient } from '../lib/client'
import { AppStateProvider, useAppState } from '../state/AppState'
import { canonical, engineClient, nodeFileIo } from '../test/engineHarness'
import { FileIoProvider } from './FileIoProvider'
import { createFakeDisk } from './fakeDisk'
import { createMonacoDouble, type FakeDiffEditor, type FakeTextModel, type MonacoDouble } from './monacoDouble'
import { requestDiff } from './DiffView'
import { announceDiskChanged } from './diskSync'
import { useFileActions } from './useFileActions'

const holder = vi.hoisted(() => ({ double: null as { api: unknown } | null }))
vi.mock('./monacoSetup', () => ({
  loadMonaco: () => Promise.resolve({ api: holder.double!.api, theme: 'test-theme' }),
}))

const HAS_GIT = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0
const describeRepo = HAS_GIT ? describe : describe.skip

let monaco: MonacoDouble
const dirs: string[] = []

beforeEach(() => {
  monaco = createMonacoDouble()
  holder.double = monaco
  window.localStorage.clear()
})

afterEach(async () => {
  cleanup()
  holder.double = null
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true }).catch(() => {})
})

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

async function repo(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sketch-diffview-')))
  dirs.push(root)
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 'test@sketch.invalid')
  git(root, 'config', 'user.name', 'Sketch Test')
  git(root, 'config', 'commit.gpgsign', 'false')
  git(root, 'config', 'core.autocrlf', 'false')
  await writeFile(join(root, 'a.txt'), 'one\n')
  git(root, 'add', 'a.txt')
  git(root, 'commit', '-q', '-m', 'Add a.txt')
  return root
}

/** The real engine, with `git-show` too (the shared harness leaves it out). */
function realEngine(): SketchClient {
  const ctx: MethodContext = {
    emitEvent: () => {},
    log: () => {},
    rememberSecret: () => {},
    secrets: () => [],
    env: process.env,
    cwd: () => process.cwd(),
  }
  return engineClient({
    gitShow: (params) => METHODS['git-show']!(params, ctx) as Promise<{ content: string | null }>,
  })
}

function Status() {
  const state = useAppState()
  const actions = useFileActions()
  return (
    <>
      <div data-testid="dirty">{state.openFiles.filter((p) => state.files[p]?.isDirty).join('|')}</div>
      <div data-testid="tabs">{state.openFiles.join('|')}</div>
      <div data-testid="active">{state.activeFile ?? ''}</div>
      <button onClick={() => void actions.openPath(`${state.projectRoot}/b.txt`)}>open-b</button>
    </>
  )
}

function mountRepo(root: string, client: SketchClient = realEngine()) {
  return render(
    <SketchClientProvider client={client}>
      <AppStateProvider initial={{ mode: 'ide', projectRoot: canonical(root) }}>
        <FileIoProvider io={nodeFileIo()}>
          <ConfirmProvider>
            <GitProvider>
              <GitPanel />
              <EditorArea />
              <Status />
            </GitProvider>
          </ConfirmProvider>
        </FileIoProvider>
      </AppStateProvider>
    </SketchClientProvider>,
  )
}

const lf = (text: string) => text.replace(/\r\n/g, '\n')

async function onlyDiff(): Promise<FakeDiffEditor> {
  await waitFor(() => expect(monaco.diffEditors.filter((d) => !d.disposed)).toHaveLength(1))
  return monaco.diffEditors.find((d) => !d.disposed)!
}

describeRepo('the diff view, against a real repository', () => {
  it('opens a changed file side by side, with the tab’s own buffer on the right', async () => {
    const root = await repo()
    const file = `${canonical(root)}/a.txt`
    await writeFile(join(root, 'a.txt'), 'one\ntwo\n')
    mountRepo(root)

    // Double-click the row, as in every source-control view.
    await screen.findByRole('button', { name: 'Stage a.txt' })
    fireEvent.doubleClick(screen.getByTitle('a.txt — double-click to compare side by side'))

    const diff = await onlyDiff()
    await waitFor(() => expect(lf(diff.model!.original.getValue())).toBe('one\n'))
    expect(screen.getByTestId('active').textContent).toBe(file)
    // The right side is the very model the tab edits, not a copy of it.
    expect(diff.model!.modified).toBe(monaco.model(file))
    expect(diff.options.readOnly).toBe(false)
    expect(diff.options.originalEditable).toBe(false)
    expect(screen.getByText('Staged or committed ↔ Working tree (editable)')).toBeTruthy()
    expect(await screen.findByText('1 change')).toBeTruthy()

    // Typing on the right is editing the file: unsaved, then saved with Ctrl+S.
    ;(diff.model!.modified as FakeTextModel).typeText('one\ntwo\nthree\n')
    await waitFor(() => expect(screen.getByTestId('dirty').textContent).toBe(file))
    fireEvent.keyDown(window, { key: 's', ctrlKey: true })
    await waitFor(async () => expect(lf(await readFile(join(root, 'a.txt'), 'utf8'))).toBe('one\ntwo\nthree\n'))
    await waitFor(() => expect(screen.getByTestId('dirty').textContent).toBe(''))

    // The Changes toggle above the editor shows the state and closes the comparison…
    const toggle = screen.getByRole('button', { name: 'Compare changes' })
    expect(toggle.getAttribute('aria-pressed')).toBe('true')
    fireEvent.click(toggle)
    await waitFor(() => expect(diff.disposed).toBe(true))
    // …leaving the tab and its model untouched: only the left-hand snapshot is gone.
    const tabModel = monaco.model(file)
    expect(tabModel.isDisposed()).toBe(false)
    expect(tabModel.listenerCount).toBe(1)
    expect(monaco.scratch.every((model) => model.isDisposed())).toBe(true)
    expect(screen.getByTestId('tabs').textContent).toBe(file)

    // …and opens it again.
    fireEvent.click(screen.getByRole('button', { name: 'Compare changes' }))
    const again = await onlyDiff()
    expect(again.model!.modified).toBe(tabModel)
  })

  it('compares a staged change with the last commit, read-only, and follows the index', async () => {
    const root = await repo()
    await writeFile(join(root, 'a.txt'), 'staged\n')
    git(root, 'add', 'a.txt')
    await writeFile(join(root, 'a.txt'), 'working\n')
    mountRepo(root)

    await screen.findByRole('button', { name: 'Unstage a.txt' })
    // Two rows name a.txt; Staged Changes is listed first.
    fireEvent.click(screen.getAllByRole('button', { name: 'Open changes to a.txt' })[0]!)

    const diff = await onlyDiff()
    await waitFor(() => expect(lf(diff.model!.modified.getValue())).toBe('staged\n'))
    expect(lf(diff.model!.original.getValue())).toBe('one\n')
    expect(diff.options.readOnly).toBe(true)
    expect(screen.getByText('Last commit (HEAD) ↔ Staged')).toBeTruthy()
    // A snapshot comparison opens no tab and touches no file model.
    expect(screen.getByTestId('tabs').textContent).toBe('')
    expect(monaco.live.size).toBe(0)

    // Staging the working version changes what is staged; the comparison follows.
    fireEvent.click(screen.getByRole('button', { name: 'Stage a.txt' }))
    await waitFor(() => expect(lf(diff.model!.modified.getValue())).toBe('working\n'))
    expect(git(root, 'status', '--porcelain')).toMatch(/^M {2}a\.txt/m)
  })

  it('shows a new file against nothing, and a deleted one with nothing left to edit', async () => {
    const root = await repo()
    await writeFile(join(root, 'new.txt'), 'fresh\n')
    mountRepo(root)

    fireEvent.click(await screen.findByRole('button', { name: 'Open changes to new.txt' }))
    const fresh = await onlyDiff()
    await screen.findByText('New file ↔ Working tree (editable)')
    expect(fresh.model!.original.getValue()).toBe('')
    expect(lf(fresh.model!.modified.getValue())).toBe('fresh\n')
    fireEvent.click(screen.getByRole('button', { name: 'Close changes' }))
    await waitFor(() => expect(fresh.disposed).toBe(true))

    await rm(join(root, 'a.txt'))
    // What a terminal command deleting the file announces; Source Control re-reads.
    act(() => announceDiskChanged('terminal'))
    // A file deleted on disk can be compared but not opened.
    fireEvent.click(await screen.findByRole('button', { name: 'Open changes to a.txt' }))
    expect(screen.queryByRole('button', { name: 'Open a.txt' })).toBeNull()
    const gone = await onlyDiff()
    await waitFor(() => expect(lf(gone.model!.original.getValue())).toBe('one\n'))
    expect(gone.model!.modified.getValue()).toBe('')
    expect(gone.options.readOnly).toBe(true)
    expect(screen.getByText('Staged or committed ↔ Deleted')).toBeTruthy()
    expect(screen.queryByRole('button', { name: 'Open file' })).toBeNull()
  })
})

// ── The view's own controls, over a scripted client ─────────────────────────

const ROOT = 'C:/proj'
const A = 'C:/proj/a.txt'
const B = 'C:/proj/b.txt'

class ShowClient extends MockSketchClient {
  asked: Array<{ path: string; ref?: string }> = []
  fail: string | null = null
  gitShow = async (params: { root: string; path: string; ref?: 'HEAD' | 'index' }) => {
    this.asked.push({ path: params.path, ...(params.ref !== undefined ? { ref: params.ref } : {}) })
    if (this.fail !== null) throw new Error(this.fail)
    return { content: 'base\n' }
  }
}

function mountScripted(client: ShowClient) {
  const disk = createFakeDisk({ [A]: 'base\nmore\n', [B]: 'other\n' })
  return render(
    <SketchClientProvider client={client}>
      <AppStateProvider initial={{ mode: 'ide', projectRoot: ROOT }}>
        <FileIoProvider io={disk.io}>
          <ConfirmProvider>
            <EditorArea />
            <Status />
          </ConfirmProvider>
        </FileIoProvider>
      </AppStateProvider>
    </SketchClientProvider>,
  )
}

describe('the diff view’s controls', () => {
  it('switches layout and folding, remembers both, and moves between changes', async () => {
    const client = new ShowClient()
    mountScripted(client)
    requestDiff({ path: A, kind: 'changes' })
    const diff = await onlyDiff()
    expect(diff.options.renderSideBySide).toBe(true)
    expect(diff.options.hideUnchangedRegions).toEqual({ enabled: false })
    expect(client.asked).toContainEqual({ path: A, ref: 'index' })

    fireEvent.click(screen.getByRole('button', { name: 'Side by side' }))
    await waitFor(() => expect(diff.optionUpdates.at(-1)).toMatchObject({ renderSideBySide: false }))
    fireEvent.click(screen.getByRole('button', { name: 'Hide unchanged lines' }))
    await waitFor(() => expect(diff.optionUpdates.at(-1)).toMatchObject({ hideUnchangedRegions: { enabled: true } }))
    expect(window.localStorage.getItem('sketch.diff.sideBySide')).toBe('0')
    expect(window.localStorage.getItem('sketch.diff.hideUnchanged')).toBe('1')

    await screen.findByText('1 change')
    fireEvent.click(screen.getByRole('button', { name: 'Next change' }))
    fireEvent.click(screen.getByRole('button', { name: 'Previous change' }))
    expect(diff.navigations).toEqual(['next', 'previous'])

    // The next comparison starts the way the user left the last one.
    fireEvent.click(screen.getByRole('button', { name: 'Close changes' }))
    requestDiff({ path: A, kind: 'changes' })
    await waitFor(() => expect(monaco.diffEditors).toHaveLength(2))
    expect(monaco.diffEditors[1]!.options.renderSideBySide).toBe(false)
    expect(monaco.diffEditors[1]!.options.hideUnchangedRegions).toEqual({ enabled: true })
  })

  it('closes when another tab is shown, and keeps the file’s undo history', async () => {
    const client = new ShowClient()
    mountScripted(client)
    fireEvent.click(screen.getByText('open-b'))
    await waitFor(() => expect(screen.getByTestId('active').textContent).toBe(B))
    requestDiff({ path: A, kind: 'changes' })
    const diff = await onlyDiff()
    await waitFor(() => expect(screen.getByTestId('active').textContent).toBe(A))

    fireEvent.click(screen.getByRole('tab', { name: /b\.txt/ }))
    await waitFor(() => expect(diff.disposed).toBe(true))
    expect(screen.getByTestId('active').textContent).toBe(B)
    expect(monaco.model(A).isDisposed()).toBe(false)
    expect(screen.queryByLabelText(/Changes in/)).toBeNull()
  })

  it('says when git cannot be read instead of showing an empty comparison', async () => {
    const client = new ShowClient()
    client.fail = 'git is not installed'
    mountScripted(client)
    requestDiff({ path: A, kind: 'staged' })
    expect((await screen.findByRole('alert')).textContent).toContain('git is not installed')
    expect(screen.queryByText(/\d+ changes?$/)).toBeNull()
  })
})
