// Inline edit (Ctrl+K) and the editor's change markers, engine side.
//
// What these pin, in user terms:
//   * Whatever shape a chat model answers in — a fenced block, prose around a block,
//     reasoning tags, echoed selection markers, dropped indentation — the editor gets
//     back exactly the code that replaces the selection.
//   * A Markdown selection that itself contains a fence keeps it.
//   * The method refuses an empty instruction and an oversized selection, and a
//     request the user stopped answers "cancelled", not an error.
//   * `git-show` returns a file as committed, and "nothing to compare with" (a new
//     file, no repository) as null rather than an error.

import { afterEach, describe, expect, it } from 'vitest'
import { execFileSync } from 'node:child_process'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { createEngineExtensionRegistry } from '../src/extensions/index.js'
import { METHODS } from '../src/rpc/methods.js'
import { createMethodContext } from '../src/rpc/server.js'
import {
  INLINE_EDIT_MAX_SELECTION,
  buildInlineEditMessages,
  cleanInlineEdit,
} from '../src/assist/index.js'
import { GitTool } from '../src/tools/git.js'
import type { ChatAdapter, Message, ProviderConfig } from '../src/types.js'

const roots: string[] = []
afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true })
})

async function tempRoot(prefix = 'sketch-inline-'): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), prefix))
  roots.push(root)
  return root
}

const descriptor = {
  id: 'inline-probe',
  name: 'Inline Probe',
  kind: 'openai-compatible' as const,
  defaultBaseUrl: 'https://inline.invalid/v1',
  needsKey: false,
  serverless: false,
}
const provider = { id: descriptor.id, kind: descriptor.kind, baseUrl: '', model: 'probe' }

function scripted(reply: string | ((messages: Message[], signal?: AbortSignal) => Promise<string>)) {
  const seen: Message[][] = []
  const factory = (_config: ProviderConfig): ChatAdapter => ({
    id: descriptor.id,
    model: 'probe',
    chat: async (messages, options) => {
      seen.push(messages.map((m) => ({ ...m })))
      const text = typeof reply === 'string' ? reply : await reply(messages, options?.signal)
      return { text, usage: { in: 1, out: 1 } }
    },
  })
  return { seen, factory }
}

function contextFor(root: string, factory: (config: ProviderConfig) => ChatAdapter) {
  return createMethodContext('inline-test', {
    writeFrame: () => {},
    writeErr: () => {},
    env: {},
    cwd: () => root,
    secrets: new Set(),
    extensions: createEngineExtensionRegistry({ providers: [{ descriptor, factory }] }),
  })
}

describe('cleanInlineEdit', () => {
  const selection = '  return a + b'

  it('keeps a plain answer as it is', () => {
    expect(cleanInlineEdit('  return a - b', { selection })).toBe('  return a - b')
  })

  it('takes the code out of a fence, with or without prose around it', () => {
    expect(cleanInlineEdit('```ts\n  return a - b\n```', { selection })).toBe('  return a - b')
    expect(cleanInlineEdit('Here you go:\n```ts\n  return a - b\n```\nThis subtracts.', { selection })).toBe('  return a - b')
  })

  it('drops reasoning and echoed selection markers', () => {
    expect(cleanInlineEdit('<think>they want minus</think><selection>  return a - b</selection>', { selection })).toBe(
      '  return a - b',
    )
  })

  it('puts back the indentation a model dropped', () => {
    const block = '    if (ok) {\n      run()\n    }'
    expect(cleanInlineEdit('if (ok) {\n  run()\n  log()\n}', { selection: block })).toBe(
      '    if (ok) {\n      run()\n      log()\n    }',
    )
    // An answer that kept its indentation is not indented twice.
    expect(cleanInlineEdit('    if (ok) {\n      go()\n    }', { selection: block })).toBe('    if (ok) {\n      go()\n    }')
  })

  it('ends the way the selection ended', () => {
    expect(cleanInlineEdit('b()\n\n\n', { selection: 'a()\n' })).toBe('b()\n')
    expect(cleanInlineEdit('b()\n', { selection: 'a()' })).toBe('b()')
  })

  it('keeps a fence that is content, in a Markdown selection that has one', () => {
    const md = 'Run:\n\n```sh\nnpm test\n```'
    const reply = 'Run the tests:\n\n```sh\nnpm test -- --run\n```'
    expect(cleanInlineEdit(reply, { selection: md })).toBe(reply)
  })

  it('normalizes Windows line endings and returns nothing for an empty answer', () => {
    expect(cleanInlineEdit('a\r\nb\r\n', { selection: 'x\r\ny' })).toBe('a\nb')
    expect(cleanInlineEdit('<think>no idea</think>\n\n', { selection })).toBe('')
  })
})

describe('buildInlineEditMessages', () => {
  it('marks the selection inside the file and states the instruction', () => {
    const [system, user] = buildInlineEditMessages({
      path: 'src/math.ts',
      language: 'typescript',
      before: 'export function add(a: number, b: number) {\n',
      selection: '  return a + b',
      after: '\n}\n',
      instruction: 'guard against NaN',
    })
    expect(system!.role).toBe('system')
    expect(user!.content).toContain('File: src/math.ts (typescript)')
    expect(user!.content).toContain('{\n<selection>  return a + b</selection>\n}')
    expect(user!.content).toContain('Instruction: guard against NaN')
  })

  it('clips long context from the far ends, keeping the code next to the selection', () => {
    const before = `${'// filler\n'.repeat(2_000)}const nearBefore = 1\n`
    const after = `\nconst nearAfter = 2\n${'// tail\n'.repeat(2_000)}`
    const [, user] = buildInlineEditMessages({ path: 'a.ts', before, selection: 'x', after, instruction: 'y' })
    expect(user!.content.length).toBeLessThan(before.length + after.length)
    expect(user!.content).toContain('const nearBefore = 1\n<selection>x</selection>\nconst nearAfter = 2')
  })
})

describe('the inline-edit method', () => {
  it('returns the cleaned replacement, and the model saw the marked selection', async () => {
    const root = await tempRoot()
    const model = scripted('```ts\nreturn Number.isNaN(a + b) ? 0 : a + b\n```')
    const result = (await METHODS['inline-edit']!(
      {
        provider,
        path: 'math.ts',
        language: 'typescript',
        before: 'function add(a, b) {\n',
        selection: '  return a + b',
        after: '\n}\n',
        instruction: 'return 0 instead of NaN',
        requestId: 'edit-1',
      },
      contextFor(root, model.factory),
    )) as { text: string; cancelled?: boolean }
    expect(result.text).toBe('  return Number.isNaN(a + b) ? 0 : a + b')
    expect(result.cancelled).toBeUndefined()
    expect(model.seen[0]![1]!.content).toContain('<selection>  return a + b</selection>')
  })

  it('refuses an empty instruction and an oversized selection before calling a model', async () => {
    const root = await tempRoot()
    const model = scripted('unused')
    const ctx = contextFor(root, model.factory)
    await expect(METHODS['inline-edit']!({ provider, selection: 'x', instruction: '   ' }, ctx)).rejects.toThrow(/instruction/)
    await expect(
      METHODS['inline-edit']!({ provider, selection: 'x'.repeat(INLINE_EDIT_MAX_SELECTION + 1), instruction: 'shorten' }, ctx),
    ).rejects.toThrow(/Ask the agent/)
    expect(model.seen).toHaveLength(0)
  })

  it('answers "cancelled" when the user stops it through cancel', async () => {
    const root = await tempRoot()
    const model = scripted(
      (_messages, signal) =>
        new Promise<string>((_resolve, reject) => {
          signal?.addEventListener('abort', () => reject(new Error('aborted by the caller')))
        }),
    )
    const ctx = contextFor(root, model.factory)
    const pending = METHODS['inline-edit']!({ provider, selection: 'a', instruction: 'b', requestId: 'edit-stop' }, ctx)
    await new Promise((resolve) => setTimeout(resolve, 20))
    const stopped = (await METHODS.cancel!({ runId: 'edit-stop' }, ctx)) as { cancelled: boolean }
    expect(stopped.cancelled).toBe(true)
    await expect(pending).resolves.toMatchObject({ text: '', cancelled: true })
  })
})

function git(cwd: string, ...args: string[]) {
  execFileSync('git', args, { cwd, stdio: 'pipe' })
}

describe('git-show: a file as it is in HEAD', () => {
  it('returns the committed text while the working copy differs', async () => {
    const root = await tempRoot('sketch-gitshow-')
    git(root, 'init', '-q')
    git(root, 'config', 'user.email', 'test@example.com')
    git(root, 'config', 'user.name', 'Test')
    git(root, 'config', 'core.autocrlf', 'false')
    await writeFile(join(root, 'a.txt'), 'one\ntwo\n')
    git(root, 'add', 'a.txt')
    git(root, 'commit', '-q', '-m', 'first')
    await writeFile(join(root, 'a.txt'), 'one\nTWO\nthree\n')
    await writeFile(join(root, 'new.txt'), 'brand new\n')

    const ctx = contextFor(root, scripted('unused').factory)
    expect(await METHODS['git-show']!({ root, path: 'a.txt' }, ctx)).toEqual({ content: 'one\ntwo\n' })
    // An absolute path inside the repository works the same.
    expect(await METHODS['git-show']!({ root, path: join(root, 'a.txt') }, ctx)).toEqual({ content: 'one\ntwo\n' })
    // Untracked: nothing to compare with.
    expect(await METHODS['git-show']!({ root, path: 'new.txt' }, ctx)).toEqual({ content: null })
    // Outside the repository: refused, never read.
    await expect(new GitTool({ root }).showHead('../outside.txt')).rejects.toThrow(/outside the repository/)
    await expect(METHODS['git-show']!({ root }, ctx)).rejects.toThrow(/path is required/)
  })

  it("reads the index with ref 'index': staged text, HEAD's when nothing is staged", async () => {
    const root = await tempRoot('sketch-gitshow-index-')
    git(root, 'init', '-q')
    git(root, 'config', 'user.email', 'test@example.com')
    git(root, 'config', 'user.name', 'Test')
    git(root, 'config', 'core.autocrlf', 'false')
    await writeFile(join(root, 'a.txt'), 'committed\n')
    await writeFile(join(root, 'b.txt'), 'only committed\n')
    git(root, 'add', 'a.txt', 'b.txt')
    git(root, 'commit', '-q', '-m', 'first')
    // Three different versions of a.txt: HEAD, the index and the working tree.
    await writeFile(join(root, 'a.txt'), 'staged\n')
    git(root, 'add', 'a.txt')
    await writeFile(join(root, 'a.txt'), 'working\n')
    // Staged but never committed, and new and never staged.
    await writeFile(join(root, 'added.txt'), 'staged new file\n')
    git(root, 'add', 'added.txt')
    await writeFile(join(root, 'loose.txt'), 'untracked\n')

    const ctx = contextFor(root, scripted('unused').factory)
    const show = (path: string, ref?: string) =>
      METHODS['git-show']!({ root, path, ...(ref !== undefined ? { ref } : {}) }, ctx)
    expect(await show('a.txt', 'index')).toEqual({ content: 'staged\n' })
    expect(await show('a.txt', 'HEAD')).toEqual({ content: 'committed\n' })
    expect(await show('a.txt')).toEqual({ content: 'committed\n' })
    // Nothing staged: the index holds HEAD's copy.
    expect(await show('b.txt', 'index')).toEqual({ content: 'only committed\n' })
    expect(await show('added.txt', 'index')).toEqual({ content: 'staged new file\n' })
    expect(await show('added.txt', 'HEAD')).toEqual({ content: null })
    // Not in the index (untracked), and not anywhere: nothing to compare with, not an error.
    expect(await show('loose.txt', 'index')).toEqual({ content: null })
    expect(await show('missing.txt', 'index')).toEqual({ content: null })
    // A deleted working file is still in the index.
    await rm(join(root, 'b.txt'))
    expect(await show('b.txt', 'index')).toEqual({ content: 'only committed\n' })
    await expect(show('a.txt', 'main')).rejects.toThrow(/ref must be 'HEAD' or 'index'/)
    await expect(new GitTool({ root }).showIndex('../outside.txt')).rejects.toThrow(/outside the repository/)
  })

  it('reads the right file when the opened folder is inside a larger repository', async () => {
    const repo = await tempRoot('sketch-gitshow-mono-')
    git(repo, 'init', '-q')
    git(repo, 'config', 'user.email', 'test@example.com')
    git(repo, 'config', 'user.name', 'Test')
    git(repo, 'config', 'core.autocrlf', 'false')
    await mkdir(join(repo, 'pkg'))
    await writeFile(join(repo, 'a.txt'), 'top level\n')
    await writeFile(join(repo, 'pkg', 'a.txt'), 'inside pkg\n')
    git(repo, 'add', '.')
    git(repo, 'commit', '-q', '-m', 'first')
    expect(await new GitTool({ root: join(repo, 'pkg') }).showHead('a.txt')).toBe('inside pkg\n')
  })

  it('is null in a repository with no commit yet, and in a folder that is not a repository', async () => {
    const fresh = await tempRoot('sketch-gitshow-fresh-')
    git(fresh, 'init', '-q')
    await writeFile(join(fresh, 'a.txt'), 'x\n')
    expect(await new GitTool({ root: fresh }).showHead('a.txt')).toBeNull()

    const plain = await tempRoot('sketch-gitshow-plain-')
    await writeFile(join(plain, 'a.txt'), 'x\n')
    expect(await new GitTool({ root: plain }).showHead('a.txt')).toBeNull()
  })
})
