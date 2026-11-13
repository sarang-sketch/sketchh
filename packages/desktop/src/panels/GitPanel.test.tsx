// The Git panel, driven against a REAL repository through the REAL engine.
//
// The client here is not a stand-in for the engine: it dispatches the same
// `METHODS` table the sidecar and the dev bridge dispatch, in process instead of
// over a pipe. So the repository is built by `git init`, the porcelain is parsed by
// packages/core/src/tools/git.ts, and a stage or a commit in these tests is a real
// stage or a real commit on disk. That matters more here than anywhere else in the
// desktop package: the thing being replaced was three fixtures and three dead
// buttons, and a fixture-shaped test would have passed against those too.
//
// Skipped with a stated reason when git is absent, never silently.
//
// Validates: Requirements 14.6, 27.1, 27.3, 27.5

import { afterAll, afterEach, describe, expect, it } from 'vitest'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { spawnSync } from 'node:child_process'
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

import { METHODS, type MethodContext } from '@sketch/core'

import { GitPanel } from './GitPanel'
import { StatusBar } from '../components/StatusBar'
import { GitProvider } from '../git/GitProvider'
import { SketchClientProvider } from '../lib/ClientProvider'
import { createEventBus, type EventHandler, type PingResult, type SketchClient } from '../lib/client'
import type { GitStatusResult } from '../lib/contracts'
import { AppStateProvider } from '../state/AppState'

// ── git availability ────────────────────────────────────────────────────────

function gitVersion(): string | null {
  try {
    const probe = spawnSync('git', ['--version'], { encoding: 'utf8', shell: false })
    return probe.status === 0 ? probe.stdout.trim() : null
  } catch {
    return null
  }
}

const GIT = gitVersion()
const describeRepo = GIT ? describe : describe.skip
const SKIP_NOTE = GIT
  ? ` [git present: ${GIT}]`
  : ' [SKIPPED: git is not on PATH, so the real-repository tests cannot run]'

const tmpDirs: string[] = []

/** Runs git for test SETUP and ASSERTION only. The panel never uses this. */
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false })
  if (result.status !== 0) {
    throw new Error(`test git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout
}

function makeDir(): string {
  const dir = mkdtempSync(join(tmpdir(), 'sketch-gitpanel-'))
  tmpDirs.push(dir)
  return dir
}

function initRepo(): string {
  const dir = makeDir()
  git(dir, 'init', '--quiet')
  git(dir, 'config', 'user.email', 'test@sketch.invalid')
  git(dir, 'config', 'user.name', 'Sketch Test')
  git(dir, 'checkout', '-q', '-b', 'main')
  return dir
}

// ── the client: the real engine, in process ─────────────────────────────────

function methodContext(): MethodContext {
  return {
    emitEvent: () => {},
    log: () => {},
    rememberSecret: () => {},
    secrets: () => [],
    env: {},
    cwd: () => process.cwd(),
  }
}

/**
 * `transport` says 'stdio' because that is what this stands in for: the sidecar
 * dispatching `METHODS`. Nothing in the panel branches on it, and calling it 'mock'
 * would be the more misleading of the two.
 */
class EngineClient implements SketchClient {
  readonly transport = 'stdio' as const
  private readonly bus = createEventBus()
  private readonly ctx = methodContext()

  ping(): Promise<PingResult> {
    return Promise.resolve({ ok: true, version: 'test', transport: 'stdio' })
  }

  run(): Promise<never> {
    return Promise.reject(new Error('the Git panel never starts a run'))
  }

  /** This panel starts no run, so it has none to stop. */
  
/** This surface starts no interactive run, so nothing awaits an answer. */

reply(): Promise<never> {
  return Promise.reject(new Error('this surface never answers a question'))
}

cancel(): Promise<never> {
    return Promise.reject(new Error('this surface never cancels a run'))
  }

  eval(): Promise<never[]> {
    return Promise.resolve([])
  }

  subscribe(handler: EventHandler) {
    return this.bus.subscribe(handler)
  }

  private call<T>(method: string, params: Record<string, unknown>): Promise<T> {
    return METHODS[method]!(params, this.ctx) as Promise<T>
  }

  gitStatus(params: { root: string }): Promise<GitStatusResult> {
    return this.call<GitStatusResult>('git-status', params)
  }

  async gitDiff(params: { root: string; path?: string; staged?: boolean }): Promise<string> {
    const result = await this.call<{ diff: string }>('git-diff', { ...params })
    return result.diff
  }

  gitStage(params: { root: string; paths: string[] }): Promise<GitStatusResult> {
    return this.call<GitStatusResult>('git-stage', params)
  }

  gitUnstage(params: { root: string; paths: string[] }): Promise<GitStatusResult> {
    return this.call<GitStatusResult>('git-unstage', params)
  }

  gitCommit(params: {
    root: string
    message: string
  }): Promise<{ output: string; status: GitStatusResult }> {
    return this.call<{ output: string; status: GitStatusResult }>('git-commit', params)
  }

  gitInit(params: { root: string }): Promise<GitStatusResult> {
    return this.call<GitStatusResult>('git-init', params)
  }

  // Provider settings reach the same `METHODS` table, but nothing in the Git panel
  // calls them. Rejecting says so instead of answering with an invented catalog.
  providerCatalog(): Promise<never> {
    return Promise.reject(new Error('the Git panel never reads provider settings'))
  }

  saveProviderSettings(): Promise<never> {
    return Promise.reject(new Error('the Git panel never writes provider settings'))
  }

  testProvider(): Promise<never> {
    return Promise.reject(new Error('the Git panel never tests a provider'))
  }
}

/** A client whose git calls fail, for the "name the tool and the reason" case. */
class BrokenGitClient extends EngineClient {
  override gitStatus(): Promise<never> {
    return Promise.reject(new Error('is not available on this machine: ENOENT'))
  }
}

function mount(root: string | null, client: SketchClient = new EngineClient()) {
  return render(
    <SketchClientProvider client={client}>
      <AppStateProvider initial={{ projectRoot: root }}>
        <GitProvider>
          <GitPanel />
        </GitProvider>
      </AppStateProvider>
    </SketchClientProvider>,
  )
}

afterEach(() => {
  cleanup()
})

// ── 1. no fixtures left ─────────────────────────────────────────────────────

describe('GitPanel — the fixtures are gone', () => {
  /**
   * The panel's CODE, comments removed. The file documents what it replaced and
   * why, and a raw-text check cannot tell an explanation of a removal from the
   * removal itself — it fails on the very comment that records the fix.
   */
  const code = readFileSync(join(dirname(fileURLToPath(import.meta.url)), 'GitPanel.tsx'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^[ \t]*\/\/.*$/gm, '')

  it('declares no MOCK_ fixture and no hardcoded branch (Requirement 14.6)', () => {
    expect(code).not.toMatch(/MOCK_STAGED|MOCK_CHANGES|MOCK_UNTRACKED/)
    expect(code).not.toMatch(/const MOCK_/)
    expect(code).not.toContain('feature/new-ui')
  })

  it('shows an honest empty state with no folder open, and no invented branch', async () => {
    mount(null)
    expect(await screen.findByText('No folder open')).toBeDefined()
    expect(screen.queryByText('main')).toBeNull()
    expect(screen.queryByText('feature/new-ui')).toBeNull()
  })

  it('names git and the reason when the call fails, instead of showing an empty list', async () => {
    mount(makeDir(), new BrokenGitClient())
    const alert = await screen.findByRole('alert')
    expect(alert.textContent).toContain('git')
    expect(alert.textContent).toContain('is not available on this machine')
    // A failure is not "no changes".
    expect(screen.queryByText('No changes')).toBeNull()
  })
})

// ── 2. against a real repository ────────────────────────────────────────────

describeRepo(`GitPanel against a real repository${SKIP_NOTE}`, () => {
  it('lists the real branch and the real working tree', async () => {
    const dir = initRepo()
    writeFileSync(join(dir, 'tracked.ts'), 'export const a = 1\n', 'utf8')
    git(dir, 'add', 'tracked.ts')
    git(dir, 'commit', '--quiet', '-m', 'initial')
    writeFileSync(join(dir, 'tracked.ts'), 'export const a = 2\n', 'utf8')
    writeFileSync(join(dir, 'added.ts'), 'export const b = 1\n', 'utf8')
    git(dir, 'add', 'added.ts')
    writeFileSync(join(dir, 'fresh.ts'), 'export const c = 1\n', 'utf8')

    mount(dir)

    expect(await screen.findByText('main')).toBeDefined()
    expect(await screen.findByText('Staged Changes')).toBeDefined()
    expect(screen.getByText('Changes')).toBeDefined()
    expect(screen.getByText('Untracked')).toBeDefined()
    expect(screen.getByText('added.ts')).toBeDefined()
    expect(screen.getByText('tracked.ts')).toBeDefined()
    expect(screen.getByText('fresh.ts')).toBeDefined()
  })

  it('stages and unstages for real through the row buttons', async () => {
    const dir = initRepo()
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n', 'utf8')

    mount(dir)

    fireEvent.click(await screen.findByLabelText('Stage a.ts'))
    await waitFor(() => expect(screen.getByLabelText('Unstage a.ts')).toBeDefined())
    // Real index, not just a re-render.
    expect(git(dir, 'diff', '--cached', '--name-only')).toContain('a.ts')

    fireEvent.click(screen.getByLabelText('Unstage a.ts'))
    await waitFor(() => expect(screen.getByLabelText('Stage a.ts')).toBeDefined())
    expect(git(dir, 'diff', '--cached', '--name-only')).not.toContain('a.ts')
  })

  it('refuses an empty commit message, then commits for real', async () => {
    const dir = initRepo()
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n', 'utf8')

    mount(dir)

    fireEvent.click(await screen.findByLabelText('Stage a.ts'))
    await waitFor(() => expect(screen.getByLabelText('Unstage a.ts')).toBeDefined())

    const commit = screen.getByRole('button', { name: /Commit/ })
    expect(commit.hasAttribute('disabled')).toBe(true)
    expect(screen.getByText('a commit message is required')).toBeDefined()

    // Whitespace is not a message either.
    fireEvent.change(screen.getByLabelText('Commit message'), { target: { value: '   ' } })
    expect(screen.getByRole('button', { name: /Commit/ }).hasAttribute('disabled')).toBe(true)
    // Nothing was committed while the message was blank.
    expect(spawnSync('git', ['log', '--oneline'], { cwd: dir, encoding: 'utf8' }).stdout).toBe('')

    fireEvent.change(screen.getByLabelText('Commit message'), { target: { value: 'add a' } })
    const enabled = screen.getByRole('button', { name: /Commit/ })
    expect(enabled.hasAttribute('disabled')).toBe(false)
    fireEvent.click(enabled)

    // The commit is on disk, and the panel now reports the clean tree honestly.
    await waitFor(() => expect(git(dir, 'log', '--oneline')).toContain('add a'))
    expect(await screen.findByText('No changes')).toBeDefined()
  })

  it('shows a real diff for the clicked row', async () => {
    const dir = initRepo()
    writeFileSync(join(dir, 'a.ts'), 'export const a = 1\n', 'utf8')
    git(dir, 'add', '.')
    git(dir, 'commit', '--quiet', '-m', 'initial')
    writeFileSync(join(dir, 'a.ts'), 'export const a = 99\n', 'utf8')

    mount(dir)

    fireEvent.click(await screen.findByText('a.ts'))
    await waitFor(() =>
      expect(screen.getByText(/\+export const a = 99/)).toBeDefined(),
    )
  })

  it('tells a clean repository apart from a folder that is not a repository', async () => {
    const clean = initRepo()
    writeFileSync(join(clean, 'a.ts'), 'export const a = 1\n', 'utf8')
    git(clean, 'add', '.')
    git(clean, 'commit', '--quiet', '-m', 'initial')

    mount(clean)
    expect(await screen.findByText('No changes')).toBeDefined()
    expect(screen.queryByText('Not a git repository')).toBeNull()
    // A clean repository still has a branch.
    expect(screen.getByText('main')).toBeDefined()
    cleanup()

    mount(makeDir())
    expect(await screen.findByText('Not a git repository')).toBeDefined()
    expect(screen.queryByText('No changes')).toBeNull()
    expect(screen.queryByText('main')).toBeNull()
  })

  it('initialises a folder that is not a repository from the panel', async () => {
    mount(makeDir())
    expect(await screen.findByText('Not a git repository')).toBeDefined()
    fireEvent.click(screen.getByRole('button', { name: /Initialise repository/ }))
    // The fresh repository is clean, with no commits yet — and the panel says so.
    expect(await screen.findByText('No changes')).toBeDefined()
    expect(screen.queryByText('Not a git repository')).toBeNull()
  })
})

// ── 3. the status bar reads the same branch ─────────────────────────────────

describeRepo(`StatusBar branch${SKIP_NOTE}`, () => {
  it('shows the real branch of the open repository, not a hardcoded one', async () => {
    const dir = initRepo()
    git(dir, 'checkout', '-q', '-b', 'feature/real-branch')

    render(
      <SketchClientProvider client={new EngineClient()}>
        <AppStateProvider initial={{ projectRoot: dir }}>
          <GitProvider>
            <StatusBar />
          </GitProvider>
        </AppStateProvider>
      </SketchClientProvider>,
    )

    expect(await screen.findByText('feature/real-branch')).toBeDefined()
    expect(screen.queryByText('main')).toBeNull()
  })

  it('says nothing about a branch when no project is open', async () => {
    render(
      <SketchClientProvider client={new EngineClient()}>
        <AppStateProvider initial={{ projectRoot: null }}>
          <GitProvider>
            <StatusBar />
          </GitProvider>
        </AppStateProvider>
      </SketchClientProvider>,
    )

    // The rest of the bar is there; the branch chip is not.
    //
    // This used to probe for the text `Anthropic`, which was itself a fixture — the bar
    // claimed a provider whether or not one was configured, and task 8.4 deleted it. The
    // probe now uses the Cost button, which is unconditionally rendered. The GUARANTEE
    // being tested is unchanged: no branch name is invented when no repository is open.
    expect(await screen.findByRole('button', { name: /Cost/ })).toBeDefined()
    expect(screen.queryByText('main')).toBeNull()
    // And no provider is claimed either, now that nothing is configured.
    expect(screen.queryByText('Anthropic')).toBeNull()
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
