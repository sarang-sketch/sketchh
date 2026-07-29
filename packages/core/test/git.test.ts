// tools/git.ts — the porcelain parser and the tool around it.
//
// TWO LAYERS, DELIBERATELY:
//
//   1. `parseStatus` against canned porcelain. Cheap, and the only practical way to
//      reach a detached HEAD, an `[ahead 1, behind 2]` line, or an unmerged pair
//      without building the repository state that produces them.
//   2. THE SAME PARSER against a REAL repository built by `git init`. Canned strings
//      only ever contain the cases somebody already thought of; the real thing is
//      what proves the quoting rules, the rename detection, and the exit codes are
//      the ones git actually produces on this machine. Skipped with a stated reason
//      when git is not installed, never silently.
//
// Validates: Requirements 14.6, 27.1, 27.3, 27.5

import { afterAll, describe, expect, it } from 'vitest'
import { spawnSync } from 'node:child_process'
import { mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  GitError,
  GitTool,
  parseStatus,
  unquotePath,
  type GitExec,
} from '../src/tools/git.js'
import { JsonlEventStore, MemoryEventStore } from '../src/events/index.js'
import { InvalidParamsError, METHODS } from '../src/rpc/methods.js'
import type { MethodContext } from '../src/rpc/methods.js'

// ── git availability ─────────────────────────────────────────────────────────

function gitVersion(): string | null {
  try {
    const probe = spawnSync('git', ['--version'], { encoding: 'utf8', shell: false })
    if (probe.status !== 0) return null
    return probe.stdout.trim()
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

async function makeRepoDir(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sketch-git-'))
  tmpDirs.push(dir)
  return dir
}

/** Run git for test SETUP only. The tool under test never uses this. */
function git(cwd: string, ...args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', shell: false })
  if (result.status !== 0) {
    throw new Error(`test setup: git ${args.join(' ')} failed: ${result.stderr || result.stdout}`)
  }
  return result.stdout
}

async function initRepo(): Promise<string> {
  const dir = await makeRepoDir()
  git(dir, 'init', '--quiet')
  // Identity and a fixed default branch, so the assertions do not depend on the
  // developer's global git config.
  git(dir, 'config', 'user.email', 'test@sketch.invalid')
  git(dir, 'config', 'user.name', 'Sketch Test')
  git(dir, 'checkout', '-q', '-b', 'main')
  return dir
}

// ── 1. the parser, against canned porcelain ──────────────────────────────────

describe('parseStatus — the branch header', () => {
  it('reads a branch with an upstream and divergence', () => {
    const status = parseStatus('## main...origin/main [ahead 2, behind 3]\n')
    expect(status.branch).toBe('main')
    expect(status.upstream).toBe('origin/main')
    expect(status.ahead).toBe(2)
    expect(status.behind).toBe(3)
    expect(status.detached).toBe(false)
    expect(status.clean).toBe(true)
  })

  it('reads a branch with NO upstream', () => {
    const status = parseStatus('## feature/new-ui\n')
    expect(status.branch).toBe('feature/new-ui')
    expect(status.upstream).toBeNull()
    expect(status.ahead).toBe(0)
    expect(status.behind).toBe(0)
  })

  it('reads a DETACHED HEAD as detached rather than as a branch named "HEAD (no branch)"', () => {
    const status = parseStatus('## HEAD (no branch)\n M src/app.ts\n')
    expect(status.detached).toBe(true)
    expect(status.branch).toBeNull()
    // The rest of the status still parses.
    expect(status.unstaged.map((c) => c.path)).toEqual(['src/app.ts'])
  })

  it('reads a repository with no commits yet', () => {
    const status = parseStatus('## No commits yet on main\nA  new.ts\n')
    expect(status.initialCommit).toBe(true)
    expect(status.branch).toBe('main')
    expect(status.staged.map((c) => c.path)).toEqual(['new.ts'])
  })

  it('reads an upstream that is gone', () => {
    const status = parseStatus('## topic...origin/topic [gone]\n')
    expect(status.branch).toBe('topic')
    expect(status.upstream).toBe('origin/topic')
    expect(status.upstreamGone).toBe(true)
  })
})

describe('parseStatus — entries', () => {
  it('separates staged, unstaged, and untracked, including a path in both lists', () => {
    const status = parseStatus(
      ['## main', 'M  staged-only.ts', ' M worktree-only.ts', 'MM both.ts', '?? new.ts', ''].join(
        '\n',
      ),
    )

    expect(status.staged.map((c) => c.path)).toEqual(['staged-only.ts', 'both.ts'])
    expect(status.unstaged.map((c) => c.path)).toEqual(['worktree-only.ts', 'both.ts'])
    expect(status.untracked.map((c) => c.path)).toEqual(['new.ts'])
    expect(status.clean).toBe(false)
  })

  it('reads a RENAME as two paths, not as one path called "old -> new"', () => {
    const status = parseStatus('## main\nR  src/old.ts -> src/new.ts\n')
    expect(status.staged).toHaveLength(1)
    expect(status.staged[0]!.path).toBe('src/new.ts')
    expect(status.staged[0]!.origPath).toBe('src/old.ts')
    // Nothing that a later `git add`/`git diff` could not act on.
    expect(status.staged[0]!.path).not.toContain('->')
  })

  it('reads a rename that was modified again afterwards', () => {
    const status = parseStatus('## main\nRM old name.ts -> new name.ts\n')
    expect(status.staged[0]!.path).toBe('new name.ts')
    expect(status.unstaged[0]!.path).toBe('new name.ts')
    expect(status.staged[0]!.origPath).toBe('old name.ts')
  })

  it('keeps a path containing a space intact', () => {
    const status = parseStatus('## main\n M src/my file.ts\n')
    expect(status.unstaged.map((c) => c.path)).toEqual(['src/my file.ts'])
  })

  it('decodes a QUOTED, octal-escaped non-ASCII path', () => {
    // What git prints for `café.txt` with the default core.quotepath.
    const status = parseStatus('## main\n?? "caf\\303\\251.txt"\n')
    expect(status.untracked.map((c) => c.path)).toEqual(['café.txt'])
  })

  it('decodes a quoted rename on both sides', () => {
    const status = parseStatus('## main\nR  "caf\\303\\251 old.txt" -> "caf\\303\\251 new.txt"\n')
    expect(status.staged[0]!.origPath).toBe('café old.txt')
    expect(status.staged[0]!.path).toBe('café new.txt')
  })

  it('lists an unmerged path as conflicted and nowhere else', () => {
    const status = parseStatus('## main\nUU both-edited.ts\nAA both-added.ts\n')
    expect(status.conflicted.map((c) => c.path)).toEqual(['both-edited.ts', 'both-added.ts'])
    expect(status.staged).toEqual([])
    expect(status.unstaged).toEqual([])
    expect(status.clean).toBe(false)
  })

  it('reports a CLEAN repository as clean, with no fabricated rows', () => {
    const status = parseStatus('## main...origin/main\n')
    expect(status.clean).toBe(true)
    expect(status.staged).toEqual([])
    expect(status.unstaged).toEqual([])
    expect(status.untracked).toEqual([])
    expect(status.conflicted).toEqual([])
    expect(status.isRepo).toBe(true)
  })

  it('ignores an --ignored line and a truncated line rather than inventing a path', () => {
    const status = parseStatus('## main\n!! dist/\nM\n M real.ts\n')
    expect(status.staged).toEqual([])
    expect(status.unstaged.map((c) => c.path)).toEqual(['real.ts'])
  })
})

describe('unquotePath', () => {
  it('leaves an unquoted path alone', () => {
    expect(unquotePath('src/app.ts')).toBe('src/app.ts')
    expect(unquotePath('src/my file.ts')).toBe('src/my file.ts')
  })

  it('decodes a multi-byte octal run as ONE character', () => {
    expect(unquotePath('"\\303\\251"')).toBe('é')
    expect(unquotePath('"\\346\\227\\245\\346\\234\\254.md"')).toBe('日本.md')
  })

  it('decodes the simple C escapes', () => {
    expect(unquotePath('"a\\tb"')).toBe('a\tb')
    expect(unquotePath('"a\\nb"')).toBe('a\nb')
    expect(unquotePath('"say \\"hi\\""')).toBe('say "hi"')
    expect(unquotePath('"back\\\\slash"')).toBe('back\\slash')
  })
})

// ── 2. the tool, with an injected exec ───────────────────────────────────────

/** Records what was asked for and answers from a script. */
function stubExec(
  answers: Array<{ exitCode?: number; stdout?: string; stderr?: string }>,
): { exec: GitExec; calls: string[][] } {
  const calls: string[][] = []
  let at = 0
  const exec: GitExec = async (args) => {
    calls.push(args)
    const answer = answers[at] ?? {}
    at += 1
    return { exitCode: answer.exitCode ?? 0, stdout: answer.stdout ?? '', stderr: answer.stderr ?? '' }
  }
  return { exec, calls }
}

describe('GitTool refusals', () => {
  it('refuses a commit with an EMPTY message without spawning anything', async () => {
    const { exec, calls } = stubExec([])
    const events = new MemoryEventStore()
    const tool = new GitTool({ root: process.cwd(), exec, events })

    for (const message of ['', '   ', '\n\t']) {
      await expect(tool.commit(message)).rejects.toThrow(/commit message is required/)
    }

    // Nothing reached git: the refusal is the UI's, not a failed process.
    expect(calls).toEqual([])
    const denied = (await events.readAll()).filter((e) => e.kind === 'tool_denied')
    expect(denied).toHaveLength(3)
    expect(denied[0]!.payload['tool']).toBe('git')
    expect(denied[0]!.payload['action']).toBe('commit')
  })

  it('refuses a pathspec that git would read as an option', async () => {
    const { exec, calls } = stubExec([])
    const tool = new GitTool({ root: process.cwd(), exec })

    for (const path of ['--output=/tmp/pwned', '-O/tmp/pwned', '--no-index']) {
      await expect(tool.stage([path])).rejects.toThrow(/would read it as an option/)
      await expect(tool.diff({ path })).rejects.toThrow(/would read it as an option/)
    }
    expect(calls).toEqual([])
  })

  it('refuses a pathspec outside the repository', async () => {
    const { exec, calls } = stubExec([])
    const tool = new GitTool({ root: join(tmpdir(), 'sketch-git-root'), exec })

    for (const path of ['../escape.ts', 'src/../../escape.ts', join(tmpdir(), 'elsewhere.ts')]) {
      await expect(tool.stage([path])).rejects.toThrow(/outside the repository/)
    }
    await expect(tool.stage([])).rejects.toThrow(/at least one path/)
    expect(calls).toEqual([])
  })

  it('names git itself when the binary cannot be started', async () => {
    // 127 is what the runner reports for a command it could not spawn.
    const { exec } = stubExec([{ exitCode: 127, stderr: "[failed to spawn 'git'] ENOENT" }])
    const tool = new GitTool({ root: process.cwd(), exec })
    await expect(tool.status()).rejects.toThrow(/git is not available/)
  })

  it('puts -- before a pathspec so option parsing is already over', async () => {
    const { exec, calls } = stubExec([{ stdout: 'diff --git a/x b/x\n' }])
    const tool = new GitTool({ root: process.cwd(), exec })
    await tool.diff({ path: 'src/app.ts', staged: true })
    expect(calls[0]).toEqual(['diff', '--no-color', '--staged', '--', 'src/app.ts'])
  })
})

// ── 3. the same tool against a REAL repository ───────────────────────────────

describeRepo(`GitTool against a real repository${SKIP_NOTE}`, () => {
  it('reports a directory that is not a repository as such, without failing', async () => {
    const dir = await makeRepoDir()
    const status = await new GitTool({ root: dir }).status()

    expect(status.isRepo).toBe(false)
    expect(status.branch).toBeNull()
    expect(status.staged).toEqual([])
    expect(status.untracked).toEqual([])
  })

  it('reports a freshly initialized repository as clean and on its branch', async () => {
    const dir = await initRepo()
    const status = await new GitTool({ root: dir }).status()

    expect(status.isRepo).toBe(true)
    expect(status.branch).toBe('main')
    expect(status.clean).toBe(true)
    expect(status.initialCommit).toBe(true)
    expect(status.upstream).toBeNull()
  })

  it('reads modified, staged, and untracked paths off a real work tree', async () => {
    const dir = await initRepo()
    await writeFile(join(dir, 'tracked.ts'), 'export const a = 1\n', 'utf8')
    git(dir, 'add', 'tracked.ts')
    git(dir, 'commit', '--quiet', '-m', 'initial')

    await writeFile(join(dir, 'tracked.ts'), 'export const a = 2\n', 'utf8')
    await writeFile(join(dir, 'staged.ts'), 'export const b = 1\n', 'utf8')
    git(dir, 'add', 'staged.ts')
    await writeFile(join(dir, 'untracked.ts'), 'export const c = 1\n', 'utf8')

    const status = await new GitTool({ root: dir }).status()

    expect(status.clean).toBe(false)
    expect(status.branch).toBe('main')
    expect(status.initialCommit).toBe(false)
    expect(status.staged.map((c) => c.path)).toEqual(['staged.ts'])
    expect(status.unstaged.map((c) => c.path)).toEqual(['tracked.ts'])
    expect(status.untracked.map((c) => c.path)).toEqual(['untracked.ts'])
  })

  it('reads a REAL rename and a REAL non-ASCII path as git actually prints them', async () => {
    const dir = await initRepo()
    await writeFile(join(dir, 'old name.ts'), 'export const a = 1\n', 'utf8')
    git(dir, 'add', '.')
    git(dir, 'commit', '--quiet', '-m', 'initial')

    git(dir, 'mv', 'old name.ts', 'new name.ts')
    await writeFile(join(dir, 'café.txt'), 'unicode\n', 'utf8')

    const status = await new GitTool({ root: dir }).status()

    const renamed = status.staged.find((c) => c.origPath !== undefined)
    expect(renamed, `staged: ${JSON.stringify(status.staged)}`).toBeDefined()
    expect(renamed!.path).toBe('new name.ts')
    expect(renamed!.origPath).toBe('old name.ts')
    // Whether git quoted this or not depends on core.quotepath; either way the
    // parser must hand back the real filename.
    expect(status.untracked.map((c) => c.path)).toContain('café.txt')
  })

  it('stages, unstages, and commits for real, recording the mutations', async () => {
    const dir = await initRepo()
    await writeFile(join(dir, 'a.ts'), 'export const a = 1\n', 'utf8')
    await writeFile(join(dir, 'b.ts'), 'export const b = 1\n', 'utf8')

    const events = new MemoryEventStore()
    const tool = new GitTool({ root: dir, events })

    await tool.stage(['a.ts', 'b.ts'])
    let status = await tool.status()
    expect(status.staged.map((c) => c.path).sort()).toEqual(['a.ts', 'b.ts'])
    expect(status.untracked).toEqual([])

    // Unstaging before the first commit has no HEAD to restore from; the tool
    // probes for HEAD instead of guessing.
    await tool.unstage(['b.ts'])
    status = await tool.status()
    expect(status.staged.map((c) => c.path)).toEqual(['a.ts'])
    expect(status.untracked.map((c) => c.path)).toEqual(['b.ts'])

    await tool.commit('add a')
    status = await tool.status()
    expect(status.staged).toEqual([])
    expect(status.initialCommit).toBe(false)
    expect(git(dir, 'log', '--oneline')).toContain('add a')

    // Unstaging WITH a HEAD present takes the restore path.
    await writeFile(join(dir, 'a.ts'), 'export const a = 2\n', 'utf8')
    await tool.stage(['a.ts'])
    await tool.unstage(['a.ts'])
    status = await tool.status()
    expect(status.staged).toEqual([])
    expect(status.unstaged.map((c) => c.path)).toEqual(['a.ts'])

    // Mutations are on the stream; the polled reads are not.
    const recorded = await events.readAll()
    const actions = recorded.map((e) => e.payload['action'])
    expect(recorded.every((e) => e.kind === 'tool_called')).toBe(true)
    expect(recorded.every((e) => e.payload['tool'] === 'git')).toBe(true)
    expect(actions).toEqual(['stage', 'unstage', 'commit', 'stage', 'unstage'])
    expect(actions).not.toContain('status')
    expect(actions).not.toContain('diff')
  })

  it('produces a real diff for one path and refuses one outside the repository', async () => {
    const dir = await initRepo()
    await writeFile(join(dir, 'a.ts'), 'export const a = 1\n', 'utf8')
    git(dir, 'add', '.')
    git(dir, 'commit', '--quiet', '-m', 'initial')
    await writeFile(join(dir, 'a.ts'), 'export const a = 99\n', 'utf8')

    const tool = new GitTool({ root: dir })
    const diff = await tool.diff({ path: 'a.ts' })
    expect(diff).toContain('--- a/a.ts')
    expect(diff).toContain('+export const a = 99')

    // Staged diff is empty until something is staged, and that is not an error.
    expect(await tool.diff({ staged: true })).toBe('')

    await expect(tool.diff({ path: '../elsewhere.ts' })).rejects.toBeInstanceOf(GitError)
  })

  it('surfaces git\u2019s own reason when a commit cannot be made', async () => {
    const dir = await initRepo()
    const tool = new GitTool({ root: dir })
    // Nothing staged: git refuses, and the reason has to reach the caller.
    await expect(tool.commit('nothing to see')).rejects.toThrow(/git commit failed/)
  })

})

// ── 4. the same tool over the protocol the panel actually uses ───────────────

/** A MethodContext with no transport behind it. */
function testCtx(): { ctx: MethodContext; streamed: string[] } {
  const streamed: string[] = []
  const ctx: MethodContext = {
    emitEvent: (event) => streamed.push(`${event.kind}:${String(event.payload['action'] ?? '')}`),
    log: () => {},
    rememberSecret: () => {},
    secrets: () => [],
    env: {},
    cwd: () => process.cwd(),
  }
  return { ctx, streamed }
}

describeRepo(`the git-* RPC methods${SKIP_NOTE}`, () => {
  it('requires a root rather than silently using the server cwd', async () => {
    const { ctx } = testCtx()
    for (const method of ['git-status', 'git-diff', 'git-stage', 'git-unstage', 'git-commit']) {
      await expect(METHODS[method]!({}, ctx)).rejects.toBeInstanceOf(InvalidParamsError)
    }
  })

  it('answers git-status with the parsed status and git-diff with a diff string', async () => {
    const dir = await initRepo()
    await writeFile(join(dir, 'a.ts'), 'export const a = 1\n', 'utf8')
    git(dir, 'add', '.')
    git(dir, 'commit', '--quiet', '-m', 'initial')
    await writeFile(join(dir, 'a.ts'), 'export const a = 2\n', 'utf8')

    const { ctx, streamed } = testCtx()
    const status = (await METHODS['git-status']!({ root: dir }, ctx)) as { branch: string }
    expect(status.branch).toBe('main')

    const diff = (await METHODS['git-diff']!({ root: dir, path: 'a.ts' }, ctx)) as { diff: string }
    expect(diff.diff).toContain('+export const a = 2')

    // Reads stream nothing: no timeline noise from a polled panel.
    expect(streamed).toEqual([])
  })

  it('stages through the protocol, streams the mutation, and returns a fresh status', async () => {
    const dir = await initRepo()
    await writeFile(join(dir, 'a.ts'), 'export const a = 1\n', 'utf8')

    const { ctx, streamed } = testCtx()
    const staged = (await METHODS['git-stage']!({ root: dir, paths: ['a.ts'] }, ctx)) as {
      staged: Array<{ path: string }>
    }
    expect(staged.staged.map((c) => c.path)).toEqual(['a.ts'])
    expect(streamed).toEqual(['tool_called:stage'])

    // An empty commit message is refused over the wire too.
    await expect(METHODS['git-commit']!({ root: dir, message: '  ' }, ctx)).rejects.toThrow(
      /commit message is required/,
    )
    expect(streamed).toContain('tool_denied:commit')

    const committed = (await METHODS['git-commit']!({ root: dir, message: 'add a' }, ctx)) as {
      status: { clean: boolean }
    }
    expect(committed.status.clean).toBe(true)
    // The mutation is durable, not just streamed.
    const events = await new JsonlEventStore({ baseDir: dir }).readAll()
    expect(events.map((e) => e.payload['action'])).toContain('commit')
  })
})

afterAll(async () => {
  for (const dir of tmpDirs) await rm(dir, { recursive: true, force: true })
})
