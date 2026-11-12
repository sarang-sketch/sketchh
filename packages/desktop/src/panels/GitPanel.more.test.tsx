// Source Control's new controls, against a REAL repository through the REAL engine
// methods (in process). In user terms: Discard restores a file after asking; Commit
// with nothing staged offers to stage everything and commit; the sparkle button fills
// the message box from the model without committing; a new branch can be created from
// the branch picker; recent commits are listed.

import { afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { spawnSync } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GitPanel } from './GitPanel'
import { ConfirmProvider } from '../components/ConfirmDialog'
import { announceDiskChanged } from '../editor/diskSync'
import { FileIoProvider } from '../editor/FileIoProvider'
import { GitProvider } from '../git/GitProvider'
import { SketchClientProvider } from '../lib/ClientProvider'
import type { SketchClient } from '../lib/client'
import { AppStateProvider } from '../state/AppState'
import { canonical, engineClient, nodeFileIo } from '../test/engineHarness'

const HAS_GIT = spawnSync('git', ['--version'], { encoding: 'utf8' }).status === 0
const describeRepo = HAS_GIT ? describe : describe.skip

const dirs: string[] = []
afterEach(async () => {
  cleanup()
  while (dirs.length > 0) await rm(dirs.pop()!, { recursive: true, force: true }).catch(() => {})
})

function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8' })
  if (result.status !== 0) throw new Error(`git ${args.join(' ')}: ${result.stderr}`)
  return result.stdout
}

async function repo(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sketch-gitmore-')))
  dirs.push(root)
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 'test@sketch.invalid')
  git(root, 'config', 'user.name', 'Sketch Test')
  git(root, 'config', 'commit.gpgsign', 'false')
  await writeFile(join(root, 'a.txt'), 'one\n')
  git(root, 'add', 'a.txt')
  git(root, 'commit', '-q', '-m', 'Add a.txt')
  return root
}

const provider = { id: 'p', kind: 'openai-compatible' as const, baseUrl: 'https://p.invalid/v1', model: 'm', label: 'Probe' }

function mount(root: string, client: SketchClient = engineClient()) {
  return render(
    <SketchClientProvider client={client}>
      <AppStateProvider initial={{ projectRoot: canonical(root), providers: [provider], selectedProvider: 'p', selectedModel: 'm' }}>
        <FileIoProvider io={nodeFileIo()}>
          <ConfirmProvider>
            <GitProvider>
              <GitPanel />
            </GitProvider>
          </ConfirmProvider>
        </FileIoProvider>
      </AppStateProvider>
    </SketchClientProvider>,
  )
}

describeRepo('Source Control, beyond stage and commit', () => {
  it('discards a file’s edits after asking', async () => {
    const root = await repo()
    await writeFile(join(root, 'a.txt'), 'changed\n')
    mount(root)
    fireEvent.click(await screen.findByRole('button', { name: 'Discard changes to a.txt' }))
    fireEvent.click(await screen.findByRole('button', { name: 'Discard' }))
    await waitFor(async () => expect((await readFile(join(root, 'a.txt'), 'utf8')).replace(/\r\n/g, '\n')).toBe('one\n'))
  })

  it('offers to stage everything when committing with nothing staged', async () => {
    const root = await repo()
    await writeFile(join(root, 'a.txt'), 'two\n')
    await writeFile(join(root, 'new.txt'), 'new\n')
    mount(root)
    await screen.findByRole('button', { name: 'Stage a.txt' })
    fireEvent.change(screen.getByLabelText('Commit message'), { target: { value: 'Update a and add new' } })
    fireEvent.click(screen.getByRole('button', { name: /Commit All/ }))
    fireEvent.click(await screen.findByRole('button', { name: 'Stage All and Commit' }))
    // A real commit spawns git; the default 1s budget is tight when the whole suite runs.
    await waitFor(() => expect(git(root, 'log', '-1', '--pretty=%s').trim()).toBe('Update a and add new'), { timeout: 5000 })
    expect(git(root, 'show', '--name-only', '--pretty=', 'HEAD').trim().split(/\r?\n/).sort()).toEqual(['a.txt', 'new.txt'])
  })

  it('fills the message from the model and commits nothing', async () => {
    const root = await repo()
    await writeFile(join(root, 'a.txt'), 'three\n')
    git(root, 'add', 'a.txt')
    const asked: unknown[] = []
    const client = engineClient({
      gitCommitMessage: async (params) => {
        asked.push(params)
        return { message: 'Change a.txt to three', source: 'staged' as const }
      },
    })
    mount(root, client)
    await screen.findByRole('button', { name: 'Unstage a.txt' })
    fireEvent.click(screen.getByRole('button', { name: 'Write the commit message with AI' }))
    await waitFor(() => expect((screen.getByLabelText('Commit message') as HTMLTextAreaElement).value).toBe('Change a.txt to three'))
    expect(asked[0]).toMatchObject({ root: canonical(root), provider: { id: 'p', model: 'm' } })
    expect(git(root, 'log', '--oneline').trim().split(/\r?\n/)).toHaveLength(1)
  })

  it('creates a branch from the branch picker, and lists recent commits', async () => {
    const root = await repo()
    mount(root)
    expect(await screen.findByText('Add a.txt')).toBeTruthy()
    fireEvent.click(screen.getByRole('button', { name: /main/ }))
    fireEvent.click(await screen.findByRole('menuitem', { name: /Create New Branch/ }))
    const input = await screen.findByLabelText('New branch name')
    fireEvent.change(input, { target: { value: 'feature/login' } })
    fireEvent.submit(input.closest('form')!)
    await waitFor(() => expect(git(root, 'branch', '--show-current').trim()).toBe('feature/login'), { timeout: 5000 })
    expect(await screen.findByText('feature/login')).toBeTruthy()
  })

  it('lists a commit that leaves other changes behind, on a branch with no upstream', async () => {
    const root = await repo()
    await writeFile(join(root, 'a.txt'), 'two\n')
    await writeFile(join(root, 'b.txt'), 'bee\n')
    git(root, 'add', 'b.txt')
    mount(root)
    await screen.findByRole('button', { name: 'Unstage b.txt' })
    expect(await screen.findByText('Add a.txt')).toBeTruthy()
    // Committed in the terminal. a.txt is still modified and there is no upstream, so
    // the branch, ahead/behind and "clean" are all as they were.
    git(root, 'commit', '-q', '-m', 'Add b.txt on its own')
    announceDiskChanged('terminal')
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Unstage b.txt' })).toBeNull())
    expect(await screen.findByText('Add b.txt on its own')).toBeTruthy()
  })

  it('a discard tells open tabs and the Explorer to read the disk again', async () => {
    const root = await repo()
    await writeFile(join(root, 'a.txt'), 'changed\n')
    const heard: string[] = []
    const listen = (event: Event) => heard.push(String((event as CustomEvent<{ reason?: string }>).detail?.reason))
    window.addEventListener('sketch:disk-changed', listen)
    try {
      mount(root)
      fireEvent.click(await screen.findByRole('button', { name: 'Discard changes to a.txt' }))
      fireEvent.click(await screen.findByRole('button', { name: 'Discard' }))
      await waitFor(() => expect(heard).toContain('git'))
    } finally {
      window.removeEventListener('sketch:disk-changed', listen)
    }
  })

  it('follows a commit typed in the terminal, without a refresh click', async () => {
    const root = await repo()
    await writeFile(join(root, 'a.txt'), 'edited in the terminal session\n')
    mount(root)
    await screen.findByRole('button', { name: 'Stage a.txt' })
    // What the user did in the terminal panel; the terminal announces when it finishes.
    git(root, 'commit', '-q', '-am', 'Commit from the terminal')
    announceDiskChanged('terminal')
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Stage a.txt' })).toBeNull())
    expect(await screen.findByText('Commit from the terminal')).toBeTruthy()
  })
})
