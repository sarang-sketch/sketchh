// Find in Files and Replace in Files, through the real method table.
//
// What a person relies on: the search finds EXACTLY what was typed (or the regular
// expression), the toggles and the include/exclude boxes mean what they say, Replace
// rewrites exactly the matches that were shown, keeps line endings, never reaches a
// file outside the project or outside what was searched, refuses a line that changed
// since the search, and can be undone in one call.
//
// Real temp projects, the real walker, the real writers. Nothing is mocked.

import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { METHODS, type MethodContext } from '../src/rpc/methods.js'
import {
  compileGlobs,
  compileQuery,
  expandReplacement,
  lineMatches,
  replaceInText,
  type FindResult,
  type ReplaceResult,
} from '../src/tools/findReplace.js'

const dirs: string[] = []
afterEach(async () => {
  while (dirs.length) await rm(dirs.pop()!, { recursive: true, force: true }).catch(() => {})
})

async function project(files: Record<string, string>): Promise<string> {
  const base = await mkdtemp(join(tmpdir(), 'sketch-find-'))
  dirs.push(base)
  const root = join(base, 'project')
  await mkdir(root, { recursive: true })
  for (const [path, content] of Object.entries(files)) {
    const full = join(root, path)
    await mkdir(dirname(full), { recursive: true })
    await writeFile(full, content, 'utf8')
  }
  return root
}

function ctx(root: string): MethodContext {
  return { emitEvent: () => {}, log: () => {}, rememberSecret: () => {}, secrets: () => [], env: {}, cwd: () => root }
}

async function find(root: string, params: Record<string, unknown>): Promise<FindResult & { cancelled: boolean }> {
  return (await METHODS['find-in-files']!({ root, ...params }, ctx(root))) as FindResult & { cancelled: boolean }
}

async function replace(root: string, params: Record<string, unknown>): Promise<ReplaceResult> {
  return (await METHODS['replace-in-files']!({ root, ...params }, ctx(root))) as ReplaceResult
}

function where(result: FindResult): string[] {
  return result.groups.flatMap((group) => group.hits.map((hit) => `${group.path}:${hit.line}`))
}

describe('the matcher', () => {
  it('is literal by default: punctuation is text, and a space is searchable', () => {
    const literal = compileQuery({ query: 'a.b(' })
    expect(lineMatches('a.b( axb(', literal).map((m) => m.start)).toEqual([0])
    expect(lineMatches('x y', compileQuery({ query: ' ' })).map((m) => m.start)).toEqual([1])
  })

  it('folds case unless Match Case is on, and Whole Word respects identifiers', () => {
    expect(lineMatches('Name name NAME', compileQuery({ query: 'name' }))).toHaveLength(3)
    expect(lineMatches('Name name NAME', compileQuery({ query: 'name', matchCase: true }))).toHaveLength(1)
    const word = compileQuery({ query: 'id', wholeWord: true })
    expect(lineMatches('id userId id_x (id)', word).map((m) => m.start)).toEqual([0, 16])
  })

  it('compiles a regular expression, and explains one that is broken', () => {
    expect(lineMatches('v1 v22 v', compileQuery({ query: 'v\\d+', isRegex: true })).map((m) => m.length)).toEqual([2, 3])
    expect(() => compileQuery({ query: '(unclosed', isRegex: true })).toThrow(/not a valid regular expression/)
    // The reason, without the pattern echoed back at the person who just typed it.
    expect(() => compileQuery({ query: '(unclosed', isRegex: true })).toThrow(/\(Unterminated group\)$/)
  })

  it('ignores empty matches instead of looping on them', () => {
    expect(lineMatches('abc', compileQuery({ query: 'x*', isRegex: true }))).toEqual([])
  })

  it('expands $1, $<name>, $& and \\n in regex mode only', () => {
    const matcher = compileQuery({ query: '(?<k>\\w+)=(\\d+)', isRegex: true })
    const match = matcher.regex.exec('port=80')!
    expect(expandReplacement('$2:$<k> [$&] $$ $9', match, true)).toBe('80:port [port=80] $ $9')
    expect(expandReplacement('a\\nb', match, true)).toBe('a\nb')
    expect(expandReplacement('$1\\n', match, false)).toBe('$1\\n')
  })

  it('keeps CRLF line endings when replacing', () => {
    const out = replaceInText('foo = 1\r\nfoo = 2\r\n', compileQuery({ query: 'foo' }), 'bar')
    expect(out).toEqual({ text: 'bar = 1\r\nbar = 2\r\n', replaced: 2 })
  })

  it('reads the include and exclude boxes as editors do', () => {
    const ts = compileGlobs('*.ts, src/lib/', false)!
    expect(ts('a.ts')).toBe(true)
    expect(ts('deep/x/b.ts')).toBe(true)
    expect(ts('src/lib/x.js')).toBe(true)
    expect(ts('src/app.js')).toBe(false)
    const anchored = compileGlobs('./docs', false)!
    expect(anchored('docs/a.md')).toBe(true)
    expect(anchored('pkg/docs/a.md')).toBe(false)
    const braces = compileGlobs('**/*.{test,spec}.ts', false)!
    expect(braces('a/b.test.ts')).toBe(true)
    expect(braces('a/b.ts')).toBe(false)
    const mixed = compileGlobs('*.{ts,tsx}, docs', false)!
    expect(mixed('src/App.tsx')).toBe(true)
    expect(mixed('docs/guide.md')).toBe(true)
    expect(mixed('src/app.js')).toBe(false)
    // Braces inside braces: each alternative, and nothing else.
    const nested = compileGlobs('src/{a,{b,c}}/*.ts', false)!
    expect(['src/a/x.ts', 'src/b/x.ts', 'src/c/x.ts'].map(nested)).toEqual([true, true, true])
    expect(nested('src/d/x.ts')).toBe(false)
    expect(compileGlobs('  ,  ')).toBeNull()
  })
})

describe('find-in-files', () => {
  it('finds exactly what was typed, in every text file, with 1-based lines and columns', async () => {
    const root = await project({
      'src/app.ts': 'const user = getUser()\nif (user.id === 1) {}\n',
      'src/legacy.rb': 'user.id === nil\n',
      'README.md': 'the user id is a number\n',
    })
    const result = await find(root, { query: 'user.id ===' })
    expect(where(result).sort()).toEqual(['src/app.ts:2', 'src/legacy.rb:1'])
    const hit = result.groups.find((g) => g.path === 'src/app.ts')!.hits[0]!
    expect(hit.textStart + hit.spans[0]!.start + 1).toBe(5)
    expect(result.matchCount).toBe(2)
    expect(result.truncated).toBe(false)
  })

  it('honours .gitignore, skips node_modules and binary files, and applies the globs', async () => {
    const root = await project({
      '.gitignore': 'generated/\n',
      'generated/out.ts': 'TOKEN\n',
      'node_modules/pkg/index.js': 'TOKEN\n',
      'src/a.ts': 'TOKEN\n',
      'src/a.test.ts': 'TOKEN\n',
      'docs/b.md': 'TOKEN\n',
      'img.bin': 'TOKEN\u0000\u0001',
    })
    expect(where(await find(root, { query: 'TOKEN' })).sort()).toEqual(['docs/b.md:1', 'src/a.test.ts:1', 'src/a.ts:1'])
    expect(where(await find(root, { query: 'TOKEN', include: 'src' })).sort()).toEqual(['src/a.test.ts:1', 'src/a.ts:1'])
    expect(where(await find(root, { query: 'TOKEN', include: 'src', exclude: '*.test.ts' }))).toEqual(['src/a.ts:1'])
    const all = await find(root, { query: 'TOKEN' })
    expect(all.skipped.binary).toBe(1)
  })

  it('previews each replacement with the same matcher Replace uses', async () => {
    const root = await project({ 'a.ts': 'let width = 10; let height = 20\n' })
    const result = await find(root, { query: '(\\w+) = (\\d+)', isRegex: true, replacement: '$1: $2' })
    expect(result.groups[0]!.hits[0]!.spans.map((s) => s.replacement)).toEqual(['width: 10', 'height: 20'])
  })

  it('stops at the cap and says so', async () => {
    const root = await project({ 'a.txt': 'x\n'.repeat(50) })
    const result = await find(root, { query: 'x', maxHits: 10 })
    expect(result.matchCount).toBe(10)
    expect(result.truncated).toBe(true)
  })

  it('clips a very long line around the first match without losing the column', async () => {
    const line = `${'a'.repeat(5000)}NEEDLE${'b'.repeat(5000)}`
    const root = await project({ 'min.js': `${line}\n` })
    const hit = (await find(root, { query: 'NEEDLE' })).groups[0]!.hits[0]!
    expect(hit.text.length).toBeLessThanOrEqual(240)
    expect(hit.text.slice(hit.spans[0]!.start, hit.spans[0]!.start + 6)).toBe('NEEDLE')
    expect(hit.textStart + hit.spans[0]!.start).toBe(5000)
  })

  it('refuses an invalid pattern and a missing folder with a sentence, not a crash', async () => {
    const root = await project({ 'a.ts': 'x\n' })
    await expect(find(root, { query: '[', isRegex: true })).rejects.toThrow(/not a valid regular expression/)
    await expect(find(join(root, 'nope'), { query: 'x' })).rejects.toThrow(/cannot search/)
    await expect(find(root, { query: '' })).rejects.toThrow(/non-empty/)
  })
})

describe('replace-in-files', () => {
  it('rewrites every shown match, keeps the rest of the file, and can be undone', async () => {
    const root = await project({
      'src/a.ts': 'oldName()\nconst x = oldName\n',
      'src/b.ts': 'import { oldName } from "./a"\r\n',
      'src/c.ts': 'nothing here\n',
    })
    const result = await replace(root, { query: 'oldName', replacement: 'newName' })
    expect(result.replaced).toBe(3)
    expect(result.files.map((f) => f.path).sort()).toEqual(['src/a.ts', 'src/b.ts'])
    expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toBe('newName()\nconst x = newName\n')
    expect(await readFile(join(root, 'src/b.ts'), 'utf8')).toBe('import { newName } from "./a"\r\n')
    expect(result.snapshotId).toMatch(/^replace-/)

    const undone = (await METHODS['undo-run']!({ root, runId: result.snapshotId }, ctx(root))) as { restored: string[] }
    expect(undone.restored.sort()).toEqual(['src/a.ts', 'src/b.ts'])
    expect(await readFile(join(root, 'src/a.ts'), 'utf8')).toBe('oldName()\nconst x = oldName\n')
  })

  it('limits itself to the named files and refuses anything outside what was searched', async () => {
    const root = await project({ 'a.ts': 'X\n', 'b.ts': 'X\n', 'node_modules/m/i.js': 'X\n' })
    const result = await replace(root, { query: 'X', replacement: 'Y', paths: ['b.ts', '../outside.ts', 'node_modules/m/i.js'] })
    expect(result.files).toEqual([{ path: 'b.ts', replaced: 1 }])
    expect(result.skipped.map((s) => s.path).sort()).toEqual(['../outside.ts', 'node_modules/m/i.js'])
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('X\n')
    expect(await readFile(join(root, 'node_modules/m/i.js'), 'utf8')).toBe('X\n')
  })

  it('replaces one line only while it still reads as it did when found', async () => {
    const root = await project({ 'a.ts': 'foo 1\nfoo 2\n' })
    const found = await find(root, { query: 'foo' })
    const second = found.groups[0]!.hits[1]!
    const only = { path: 'a.ts', line: second.line, text: second.text, textStart: second.textStart }
    expect((await replace(root, { query: 'foo', replacement: 'bar', only })).replaced).toBe(1)
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('foo 1\nbar 2\n')

    // The file changed since: refused, nothing written.
    await writeFile(join(root, 'a.ts'), 'foo 1\nfoo 2 edited\n', 'utf8')
    const stale = await replace(root, { query: 'foo', replacement: 'bar', only: { ...only, text: 'foo 2' } })
    expect(stale.replaced).toBe(0)
    expect(stale.skipped[0]!.reason).toMatch(/changed since the search/)
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('foo 1\nfoo 2 edited\n')
  })

  it('an empty replacement deletes the matches; regex groups are expanded', async () => {
    const root = await project({ 'a.ts': 'console.log(1); keep(); console.log(2);\n', 'b.ts': 'v1.2.3\n' })
    await replace(root, { query: 'console.log\\(\\d\\);\\s?', isRegex: true, replacement: '', paths: ['a.ts'] })
    expect(await readFile(join(root, 'a.ts'), 'utf8')).toBe('keep(); \n')
    await replace(root, { query: 'v(\\d+)\\.(\\d+)\\.(\\d+)', isRegex: true, replacement: 'v$1.$2.$3-next' })
    expect(await readFile(join(root, 'b.ts'), 'utf8')).toBe('v1.2.3-next\n')
  })

  it('reports nothing changed, with no snapshot, when there is nothing to replace', async () => {
    const root = await project({ 'a.ts': 'x\n' })
    expect(await replace(root, { query: 'missing', replacement: 'y' })).toMatchObject({ replaced: 0, snapshotId: null, files: [] })
    await expect(replace(root, { query: 'x' })).rejects.toThrow(/replacement must be a string/)
  })
})
