// The agent's read tools, its tolerant edit matcher, and undo without Git.
//
// Uses REAL: temp directories, the real filesystem, the real ToolDispatcher (the one
// authorisation point), real symlinks where the platform permits them, and the real
// agent loop driven by the scripted offline adapter.

import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { ToolDispatcher } from '../src/capabilities/index.js'
import { MemoryEventStore } from '../src/events/index.js'
import { runTask } from '../src/loop/index.js'
import { locateEdit, prepareEdit } from '../src/loop/edits.js'
import {
  DiskFileWriter,
  SnapshottingFileWriter,
  restoreSnapshot,
} from '../src/orchestrator/file-writer.js'
import { PlanWriter } from '../src/plan/index.js'
import { FakeChatAdapter } from '../src/providers/fake.js'
import { globToRegExp, projectToolDescriptors } from '../src/tools/index.js'

const dirs: string[] = []
async function tmp(prefix = 'sketch-tools-'): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix))
  dirs.push(dir)
  return dir
}
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true }).catch(() => {})
})

async function project(): Promise<string> {
  const root = await tmp()
  await mkdir(join(root, 'src', 'lib'), { recursive: true })
  await mkdir(join(root, 'node_modules', 'dep'), { recursive: true })
  await writeFile(join(root, 'src', 'app.ts'), 'export const retryCount = 3\nexport function run() {\n  return retryCount\n}\n')
  await writeFile(join(root, 'src', 'lib', 'util.test.ts'), 'test("x", () => {})\n')
  await writeFile(join(root, 'README.md'), '# Demo\n')
  await writeFile(join(root, 'node_modules', 'dep', 'index.js'), 'module.exports = 1\n')
  return root
}

function dispatcher(root: string, granted: readonly ('fs:read:project' | 'git:read')[] = ['fs:read:project']) {
  return new ToolDispatcher({ tools: projectToolDescriptors(), granted: [...granted], root })
}

describe('read_file', () => {
  it('returns numbered lines, framed as data', async () => {
    const root = await project()
    const out = await dispatcher(root).call('read_file', { path: 'src/app.ts' })
    expect(out.ok).toBe(true)
    expect(out.output).toContain('FILE src/app.ts — 5 lines')
    expect(out.output).toContain('1 | export const retryCount = 3')
    expect(out.output).toContain('--- begin tool output ---')
  })

  it('pages with start_line/end_line and says what remains', async () => {
    const root = await project()
    const out = await dispatcher(root).call('read_file', { path: 'src/app.ts', start_line: 2, end_line: 3 })
    expect(out.output).toContain('lines 2-3 of 5')
    expect(out.output).toContain('start_line 4')
    expect(out.output).not.toContain('retryCount = 3')
  })

  it('refuses a path outside the project, however it is spelled', async () => {
    const root = await project()
    const outside = await tmp('sketch-outside-')
    await writeFile(join(outside, 'secret.txt'), 'TOP SECRET')
    for (const path of ['../secret.txt', join(outside, 'secret.txt')]) {
      const out = await dispatcher(root).call('read_file', { path })
      expect(out.ok).toBe(false)
      expect(out.output).not.toContain('TOP SECRET')
    }
  })

  it('does not follow a link that points outside the project', async () => {
    const root = await project()
    const outside = await tmp('sketch-outside-')
    await writeFile(join(outside, 'secret.txt'), 'TOP SECRET')
    try {
      await symlink(join(outside, 'secret.txt'), join(root, 'src', 'leak.txt'))
    } catch {
      console.log('SKIPPED (file symlink): this platform refused to create it')
      return
    }
    const out = await dispatcher(root).call('read_file', { path: 'src/leak.txt' })
    expect(out.ok).toBe(false)
    expect(out.output).toContain('outside the project')
    expect(out.output).not.toContain('TOP SECRET')
  })

  it('is denied entirely without fs:read:project — the one gate decides', async () => {
    const root = await project()
    const out = await dispatcher(root, ['git:read']).call('read_file', { path: 'src/app.ts' })
    expect(out.ok).toBe(false)
    expect(out.denied).toBe('capability_denied')
  })
})

describe('list_dir, find_files, search_code', () => {
  it('lists a folder, folders first, without dependency noise', async () => {
    const root = await project()
    const out = await dispatcher(root).call('list_dir', {})
    expect(out.ok).toBe(true)
    expect(out.output).toContain('src/')
    expect(out.output).toContain('README.md')
    expect(out.output).not.toContain('node_modules/')
    expect(out.output).toContain('dependency/build folder')
  })

  it('finds files by glob and by name fragment', async () => {
    const root = await project()
    const byGlob = await dispatcher(root).call('find_files', { pattern: '*.test.ts' })
    expect(byGlob.output).toContain('src/lib/util.test.ts')
    const byName = await dispatcher(root).call('find_files', { pattern: 'app' })
    expect(byName.output).toContain('src/app.ts')
    expect(byName.output).not.toContain('node_modules')
  })

  it('searches contents and reports path:line', async () => {
    const root = await project()
    const out = await dispatcher(root).call('search_code', { query: 'retryCount' })
    expect(out.ok).toBe(true)
    expect(out.output).toMatch(/src\/app\.ts:1: export const retryCount = 3/)
  })

  it('translates globs the way a person means them', () => {
    expect(globToRegExp('**/*.ts').test('a/b/c.ts')).toBe(true)
    expect(globToRegExp('**/*.ts').test('c.ts')).toBe(true)
    expect(globToRegExp('src/*.ts').test('src/a/b.ts')).toBe(false)
    expect(globToRegExp('src/?.ts').test('src/a.ts')).toBe(true)
  })
})

describe('the tolerant edit matcher', () => {
  it('matches exactly first', () => {
    const at = locateEdit('a\nb\nc\n', 'b', 'B')
    expect(at).toMatchObject({ start: 2, end: 3, replacement: 'B', normalized: null })
  })

  it('accepts an LF edit against a CRLF file and keeps CRLF', () => {
    const file = 'one\r\ntwo\r\nthree\r\n'
    const at = locateEdit(file, 'one\ntwo', 'uno\ndos')!
    expect(at).not.toBeNull()
    const out = file.slice(0, at.start) + at.replacement + file.slice(at.end)
    expect(out).toBe('uno\r\ndos\r\nthree\r\n')
  })

  it('strips read_file line-number prefixes the model copied', () => {
    const file = 'alpha\nbeta\n'
    const at = locateEdit(file, '1 | alpha\n2 | beta', '1 | ALPHA\n2 | beta')!
    const out = file.slice(0, at.start) + at.replacement + file.slice(at.end)
    expect(out).toBe('ALPHA\nbeta\n')
  })

  it('tolerates indentation drift and re-indents the replacement', () => {
    const file = 'function f() {\n    if (x) {\n        go()\n    }\n}\n'
    const at = locateEdit(file, 'if (x) {\n    go()\n}', 'if (x) {\n    stop()\n}')!
    const out = file.slice(0, at.start) + at.replacement + file.slice(at.end)
    expect(out).toBe('function f() {\n    if (x) {\n        stop()\n    }\n}\n')
  })

  it('refuses an ambiguous whitespace match rather than guessing', () => {
    const file = '  x = 1\n\n x = 1\n'
    expect(locateEdit(file, 'x = 1 ', 'x = 2')).toBeNull()
  })

  it('still reports a search that matches nothing', async () => {
    const root = await project()
    const result = await prepareEdit({ path: 'src/app.ts', search: 'nope', replace: 'x' }, { root })
    expect(result.ok).toBe(false)
  })
})

describe('writes and undo', () => {
  it('refuses to write through a link that leaves the project', async () => {
    const root = await project()
    const outside = await tmp('sketch-outside-')
    try {
      await symlink(outside, join(root, 'escape'), 'junction')
    } catch {
      console.log('SKIPPED (directory link): this platform refused to create it')
      return
    }
    await expect(
      new DiskFileWriter().apply(root, [{ path: 'escape/pwned.txt', content: 'x' }]),
    ).rejects.toThrow(/outside project directory/)
    await expect(readFile(join(outside, 'pwned.txt'), 'utf8')).rejects.toThrow()
  })

  it('journals originals and restores them; a created file is removed', async () => {
    const root = await project()
    const writer = new SnapshottingFileWriter(new DiskFileWriter(), { runId: 'run-undo-1' })
    await writer.apply(root, [
      { path: 'src/app.ts', content: 'changed\n' },
      { path: 'src/new.ts', content: 'brand new\n' },
    ])
    expect(await readFile(join(root, 'src', 'app.ts'), 'utf8')).toBe('changed\n')

    const undone = await restoreSnapshot(root, 'run-undo-1')
    expect(undone.found).toBe(true)
    expect(undone.restored).toEqual(['src/app.ts'])
    expect(undone.removed).toEqual(['src/new.ts'])
    expect(await readFile(join(root, 'src', 'app.ts'), 'utf8')).toContain('retryCount = 3')
    await expect(readFile(join(root, 'src', 'new.ts'), 'utf8')).rejects.toThrow()
    // Single-use: the journal is spent.
    expect((await restoreSnapshot(root, 'run-undo-1')).found).toBe(false)
  })

  it('never overwrites a file someone changed after the run wrote it', async () => {
    const root = await project()
    const writer = new SnapshottingFileWriter(new DiskFileWriter(), { runId: 'run-undo-2' })
    await writer.apply(root, [{ path: 'README.md', content: '# Agent wrote this\n' }])
    await writeFile(join(root, 'README.md'), '# I edited it afterwards\n')
    const undone = await restoreSnapshot(root, 'run-undo-2')
    expect(undone.restored).toEqual([])
    expect(undone.skipped).toEqual([{ path: 'README.md', reason: 'changed after the run wrote it' }])
    expect(await readFile(join(root, 'README.md'), 'utf8')).toBe('# I edited it afterwards\n')
  })
})

describe('a run that reads before it edits', () => {
  it('reads through the gate, plans, edits with an LF search on a CRLF file, and finishes', async () => {
    const root = await tmp()
    await writeFile(join(root, 'greet.ts'), 'export const greet = () => "hi"\r\n')
    const events = new MemoryEventStore({ secrets: [] })
    const adapter = new FakeChatAdapter({
      script: [
        JSON.stringify({ action: 'tool', name: 'read_file', args: { path: 'greet.ts' } }),
        JSON.stringify({ action: 'plan', artifacts: { prd: 'say hello' } }),
        JSON.stringify({
          action: 'edit',
          edits: [{ path: 'greet.ts', search: 'export const greet = () => "hi"\n', replace: 'export const greet = () => "hello"\n' }],
        }),
        JSON.stringify({ action: 'done', text: 'Changed the greeting.' }),
      ],
    })
    const tools = new ToolDispatcher({
      tools: projectToolDescriptors(),
      granted: ['fs:read:project'],
      root,
      events,
    })
    const result = await runTask(
      { id: 't', prompt: 'make greet say hello', verify: [] },
      {
        adapter,
        events,
        plan: new PlanWriter({ baseDir: root, events }),
        files: new DiskFileWriter(),
        root,
        tools,
        maxIterations: 8,
      },
    )
    expect(result.ok).toBe(true)
    expect(result.finalText).toBe('Changed the greeting.')
    // The model saw the file's real contents because it asked for them.
    expect(adapter.calls[1]!.map((m) => m.content).join('\n')).toContain('1 | export const greet = () => "hi"')
    expect(await readFile(join(root, 'greet.ts'), 'utf8')).toBe('export const greet = () => "hello"\r\n')
    const called = result.events.filter((e) => e.kind === 'tool_called')
    expect(called.map((e) => e.payload['phase'])).toEqual(['start', 'result'])
    // No file content on the durable log: paths and counts only.
    expect(JSON.stringify(called)).not.toContain('"hi"')
  })
})
