// Source control beyond stage and commit, against real repositories.
//
// In user terms: Discard throws away edits to a file and nothing else; branches can be
// listed, created and switched; History shows the commits; Push publishes a new branch
// and sets its upstream; Pull fast-forwards and never merges; and the AI commit message
// is drafted from the staged diff without committing anything.

import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdtemp, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { GitTool, validBranchName } from '../src/tools/git.js'
import { createEngineExtensionRegistry } from '../src/extensions/index.js'
import { METHODS } from '../src/rpc/methods.js'
import { createMethodContext } from '../src/rpc/server.js'
import type { ChatAdapter, Message, ProviderConfig } from '../src/types.js'

const roots: string[] = []
afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true }).catch(() => {})
})

async function temp(prefix: string): Promise<string> {
  const dir = await realpath(await mkdtemp(join(tmpdir(), prefix)))
  roots.push(dir)
  return dir
}

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] })
}

/** A repository with one commit on `main` and a committer identity of its own. */
async function repo(): Promise<string> {
  const root = await temp('sketch-git-')
  git(root, 'init', '-q', '-b', 'main')
  git(root, 'config', 'user.email', 'test@example.com')
  git(root, 'config', 'user.name', 'Sketch Test')
  git(root, 'config', 'commit.gpgsign', 'false')
  await writeFile(join(root, 'a.txt'), 'one\n')
  git(root, 'add', 'a.txt')
  git(root, 'commit', '-q', '-m', 'Add a.txt')
  return root
}

describe('discard', () => {
  it('restores a modified file and leaves what is staged alone', async () => {
    const root = await repo()
    await writeFile(join(root, 'b.txt'), 'staged\n')
    git(root, 'add', 'b.txt')
    await writeFile(join(root, 'a.txt'), 'edited\n')

    const tool = new GitTool({ root })
    await tool.discard(['a.txt'])
    expect((await readFile(join(root, 'a.txt'), 'utf8')).replace(/\r\n/g, '\n')).toBe('one\n')
    const status = await tool.status()
    expect(status.staged.map((c) => c.path)).toEqual(['b.txt'])
    expect(status.unstaged).toEqual([])
  })

  it('refuses a path that would be read as an option', async () => {
    const tool = new GitTool({ root: await repo() })
    await expect(tool.discard(['--source=HEAD~1'])).rejects.toThrow(/read it as an option/)
  })
})

describe('branches', () => {
  it('lists, creates and switches branches', async () => {
    const root = await repo()
    const tool = new GitTool({ root })
    expect(await tool.branches()).toEqual({ current: 'main', branches: [{ name: 'main', current: true, upstream: null }] })

    await tool.switchBranch('feature/login', { create: true })
    const after = await tool.branches()
    expect(after.current).toBe('feature/login')
    expect(after.branches.map((b) => b.name).sort()).toEqual(['feature/login', 'main'])

    await tool.switchBranch('main')
    expect((await tool.status()).branch).toBe('main')
  })

  it('refuses names git would reject or read as options', async () => {
    for (const bad of ['', '-x', '--orphan', 'a..b', 'has space', 'end.', 'x.lock', 'a//b', '.hidden', 'a/.b', 'q?', '@']) {
      expect(validBranchName(bad), bad).toBeNull()
    }
    expect(validBranchName('feature/new-ui_2')).toBe('feature/new-ui_2')
    const tool = new GitTool({ root: await repo() })
    await expect(tool.switchBranch('-c', { create: true })).rejects.toThrow(/not a valid branch name/)
  })
})

describe('history', () => {
  it('lists commits newest first, and an empty repository has none', async () => {
    const root = await repo()
    await writeFile(join(root, 'a.txt'), 'two\n')
    git(root, 'commit', '-q', '-am', 'Change a.txt')
    const log = await new GitTool({ root }).log(10)
    expect(log.map((c) => c.subject)).toEqual(['Change a.txt', 'Add a.txt'])
    expect(log[0]!.author).toBe('Sketch Test')

    const empty = await temp('sketch-git-empty-')
    git(empty, 'init', '-q')
    expect(await new GitTool({ root: empty }).log()).toEqual([])
  })
})

describe('push and pull', () => {
  it('publishes a new branch with an upstream, then pulls a fast-forward', async () => {
    const remote = await temp('sketch-git-remote-')
    git(remote, 'init', '-q', '--bare', '-b', 'main')
    const root = await repo()
    git(root, 'remote', 'add', 'origin', remote)

    const tool = new GitTool({ root })
    await tool.push()
    const status = await tool.status()
    expect(status.upstream).toBe('origin/main')

    // Someone else pushes a commit; pull brings it in without a merge commit.
    const other = await temp('sketch-git-other-')
    git(other, 'clone', '-q', remote, '.')
    git(other, 'config', 'user.email', 'other@example.com')
    git(other, 'config', 'user.name', 'Other')
    await writeFile(join(other, 'c.txt'), 'theirs\n')
    git(other, 'add', 'c.txt')
    git(other, 'commit', '-q', '-m', 'Add c.txt')
    git(other, 'push', '-q', 'origin', 'main')

    await tool.pull()
    expect((await readFile(join(root, 'c.txt'), 'utf8')).replace(/\r\n/g, '\n')).toBe('theirs\n')
    expect((await tool.log(5)).map((c) => c.subject)).toEqual(['Add c.txt', 'Add a.txt'])
  }, 30_000)

  it('says plainly when there is nowhere to push', async () => {
    const tool = new GitTool({ root: await repo() })
    await expect(tool.push()).rejects.toThrow(/no remote to push to/)
  })
})

describe('the AI commit message', () => {
  const descriptor = {
    id: 'commit-probe',
    name: 'Commit Probe',
    kind: 'openai-compatible' as const,
    defaultBaseUrl: 'https://commit.invalid/v1',
    needsKey: false,
    serverless: false,
  }
  const provider = { id: descriptor.id, kind: descriptor.kind, baseUrl: '', model: 'probe' }

  function ctxWith(reply: string, seen: Message[][]) {
    const factory = (_config: ProviderConfig): ChatAdapter => ({
      id: descriptor.id,
      model: 'probe',
      chat: async (messages) => {
        seen.push(messages)
        return { text: reply, usage: { in: 1, out: 1 } }
      },
    })
    return createMethodContext('commit-msg', {
      writeFrame: () => {},
      writeErr: () => {},
      env: {},
      cwd: () => process.cwd(),
      secrets: new Set(),
      extensions: createEngineExtensionRegistry({ providers: [{ descriptor, factory }] }),
    })
  }

  it('drafts from the staged diff and commits nothing', async () => {
    const root = await repo()
    await writeFile(join(root, 'a.txt'), 'one\nfixed the retry bug\n')
    git(root, 'add', 'a.txt')
    const seen: Message[][] = []
    const result = (await METHODS['git-commit-message']!({ root, provider }, ctxWith('"Fix the retry bug in a.txt"', seen))) as {
      message: string
      source: string
    }
    expect(result).toMatchObject({ message: 'Fix the retry bug in a.txt', source: 'staged' })
    // The model saw the diff and the repository's own subjects for style.
    const user = seen[0]!.find((m) => m.role === 'user')!.content
    expect(user).toContain('+fixed the retry bug')
    expect(user).toContain('- Add a.txt')
    // Nothing was committed.
    expect(git(root, 'log', '--oneline').trim().split('\n')).toHaveLength(1)
  })

  it('refuses when there is nothing to describe', async () => {
    const root = await repo()
    await expect(METHODS['git-commit-message']!({ root, provider }, ctxWith('x', []))).rejects.toThrow(/no changes/)
  })
})
