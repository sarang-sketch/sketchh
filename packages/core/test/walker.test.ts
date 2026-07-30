// File walker tests — the foundation of the context phase, previously untested.
//
// Uses REAL: temp directories with real files, real subdirectories, real
// `.gitignore` files, and real symlinks where the platform allows them. Nothing
// is mocked. A walker asserted against a fake filesystem proves nothing about
// the three failures that actually matter: descending into `node_modules`,
// following a link out of the project, and looping forever on a link that points
// at an ancestor.
//
// Validates: Requirements 18.1

import { describe, it, expect, afterEach } from 'vitest'
import { mkdtemp, mkdir, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'
import { walkProject, walkProjectDetailed } from '../src/context/walker.js'

const tmpDirs: string[] = []

async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), 'sketch-walker-'))
  tmpDirs.push(dir)
  return dir
}

afterEach(async () => {
  while (tmpDirs.length) {
    const dir = tmpDirs.pop()!
    await rm(dir, { recursive: true, force: true }).catch(() => {})
  }
})

/** Write a file, creating its parent directories. Real bytes, real tree. */
async function write(root: string, relative: string, content: string): Promise<void> {
  const full = join(root, relative)
  await mkdir(dirname(full), { recursive: true })
  await writeFile(full, content, 'utf8')
}

async function paths(root: string): Promise<string[]> {
  return (await walkProject(root)).map(f => f.relativePath)
}

/**
 * Symlink creation needs Developer Mode or elevation on Windows. Follow the
 * project's existing convention: print SKIPPED and return rather than pass
 * vacuously.
 */
async function canSymlink(root: string): Promise<boolean> {
  const target = join(root, '.symlink-probe-target')
  await mkdir(target, { recursive: true })
  try {
    await symlink(target, join(root, '.symlink-probe-link'), 'junction')
    return true
  } catch {
    return false
  }
}

describe('walkProject', () => {
  it('returns indexable files with size, hash and POSIX relative paths', async () => {
    const root = await makeTmp()
    await write(root, 'src/app.ts', 'export const app = 1\n')
    await write(root, 'README.md', '# hi\n')

    const files = await walkProject(root)
    expect(files.map(f => f.relativePath)).toEqual(['README.md', 'src/app.ts'])

    const app = files.find(f => f.relativePath === 'src/app.ts')!
    expect(app.extension).toBe('.ts')
    expect(app.size).toBe('export const app = 1\n'.length)
    expect(app.hash).toMatch(/^[0-9a-f]{16}$/)
    expect(app.path).toBe(join(root, 'src', 'app.ts'))
  })

  it('hashes content, so an edit changes the hash and a rename does not', async () => {
    const root = await makeTmp()
    await write(root, 'a.ts', 'const a = 1\n')
    const [before] = await walkProject(root)

    await write(root, 'b.ts', 'const a = 1\n')
    await write(root, 'a.ts', 'const a = 2\n')
    const after = await walkProject(root)

    expect(after.find(f => f.relativePath === 'b.ts')!.hash).toBe(before!.hash)
    expect(after.find(f => f.relativePath === 'a.ts')!.hash).not.toBe(before!.hash)
  })

  it('does not descend into node_modules or the other heavy directories', async () => {
    const root = await makeTmp()
    await write(root, 'src/app.ts', 'export const app = 1\n')
    // An indexer that walks these is broken, not slow.
    await write(root, 'node_modules/react/index.js', 'module.exports = {}\n')
    await write(root, 'node_modules/.bin/nested/deep.ts', 'export const x = 1\n')
    await write(root, 'dist/app.js', 'export const app = 1\n')
    await write(root, 'build/out.js', 'x\n')
    await write(root, 'coverage/report.json', '{}\n')
    await write(root, 'target/debug/thing.rs', 'fn main() {}\n')
    await write(root, '__pycache__/mod.py', 'x = 1\n')
    await write(root, '.git/objects/ab/cdef.json', '{}\n')

    expect(await paths(root)).toEqual(['src/app.ts'])
  })

  it('respects .gitignore: directories, globs, root anchoring and negation', async () => {
    const root = await makeTmp()
    await write(
      root,
      '.gitignore',
      [
        '# a comment, and a blank line follow',
        '',
        'vendor/',
        '/generated',
        '*.generated.ts',
        '!keep.generated.ts',
        'secrets.json',
      ].join('\n')
    )

    await write(root, 'src/app.ts', 'export const app = 1\n')
    await write(root, 'config.json', '{}\n')
    // Ignored by `vendor/`
    await write(root, 'vendor/lib.ts', 'export const lib = 1\n')
    // Ignored by the root-anchored `/generated` …
    await write(root, 'generated/out.ts', 'export const out = 1\n')
    // … which must NOT reach a nested directory of the same name.
    await write(root, 'src/generated/keep.ts', 'export const keep = 1\n')
    // Ignored by the glob …
    await write(root, 'src/api.generated.ts', 'export const api = 1\n')
    // … and re-included by the negation, because the last matching rule wins.
    await write(root, 'src/keep.generated.ts', 'export const kept = 1\n')
    await write(root, 'secrets.json', '{"token":"x"}\n')

    expect(await paths(root)).toEqual([
      'config.json',
      'src/app.ts',
      'src/generated/keep.ts',
      'src/keep.generated.ts',
    ])
  })

  it('skips dotfiles, dot directories and the engine state directory', async () => {
    const root = await makeTmp()
    await write(root, 'src/app.ts', 'export const app = 1\n')
    await write(root, '.env', 'SECRET=1\n')
    await write(root, '.sketch/index/graph.json', '{}\n')
    await write(root, '.vscode/settings.json', '{}\n')

    // The index must not index itself, or every rebuild grows the graph.
    expect(await paths(root)).toEqual(['src/app.ts'])
  })

  it('skips unknown extensions and files over the size cap', async () => {
    const root = await makeTmp()
    await write(root, 'src/app.ts', 'export const app = 1\n')
    await write(root, 'logo.png', 'not really a png')
    await write(root, 'notes.log', 'noise\n')
    await write(root, 'huge.ts', 'x'.repeat(1024 * 1024 + 1))

    expect(await paths(root)).toEqual(['src/app.ts'])
  })

  it('is deterministic: the same tree yields the same order every time', async () => {
    const root = await makeTmp()
    for (const name of ['zeta', 'alpha', 'middle', 'beta']) {
      await write(root, `src/${name}/mod.ts`, `export const ${name} = 1\n`)
      await write(root, `${name}.md`, `# ${name}\n`)
    }

    const first = await paths(root)
    const second = await paths(root)
    const third = await paths(root)
    expect(second).toEqual(first)
    expect(third).toEqual(first)
    expect(first).toEqual([...first].sort())
  })

  it('caps the walk at maxFiles and reports the truncation', async () => {
    const root = await makeTmp()
    for (let i = 0; i < 12; i++) {
      await write(root, `src/f${String(i).padStart(2, '0')}.ts`, `export const f${i} = 1\n`)
    }

    const capped = await walkProjectDetailed(root, { maxFiles: 5 })
    expect(capped.files).toHaveLength(5)
    expect(capped.truncated).toBe(true)
    expect(capped.maxFiles).toBe(5)

    // A stated limit, cut in the same place every time.
    const again = await walkProjectDetailed(root, { maxFiles: 5 })
    expect(again.files.map(f => f.relativePath)).toEqual(capped.files.map(f => f.relativePath))

    const full = await walkProjectDetailed(root, { maxFiles: 100 })
    expect(full.truncated).toBe(false)
    expect(full.files).toHaveLength(12)
  })

  it('does not follow a symlink whose target is outside the project', async () => {
    const root = await makeTmp()
    const outside = await makeTmp()

    if (!(await canSymlink(root))) {
      console.log('SKIPPED: this platform will not create symlinks without elevation')
      return
    }
    // The probe's own artifacts are dot-prefixed, so the walk already ignores them.

    await write(outside, 'secret/leak.ts', 'export const leak = 1\n')
    await write(outside, 'loose.ts', 'export const loose = 1\n')
    await write(root, 'src/app.ts', 'export const app = 1\n')
    await symlink(join(outside, 'secret'), join(root, 'linked-dir'), 'junction')

    // A file symlink needs more privilege than a directory junction on Windows,
    // so its assertion is conditional rather than vacuous.
    let linkedFile = true
    try {
      await symlink(join(outside, 'loose.ts'), join(root, 'linked-file.ts'), 'file')
    } catch {
      linkedFile = false
      console.log('SKIPPED (file symlink only): this platform refused to create it')
    }

    const found = await paths(root)
    expect(found).toContain('src/app.ts')
    expect(found.some(p => p.startsWith('linked-dir'))).toBe(false)
    if (linkedFile) expect(found).not.toContain('linked-file.ts')
  })

  it('terminates on a symlink pointing at an ancestor', async () => {
    const root = await makeTmp()

    if (!(await canSymlink(root))) {
      console.log('SKIPPED: this platform will not create symlinks without elevation')
      return
    }
    await write(root, 'src/app.ts', 'export const app = 1\n')
    // `src/loop` → the project root. Following it is not slow, it never returns.
    await symlink(root, join(root, 'src', 'loop'), 'junction')

    const found = await paths(root)
    expect(found).toEqual(['src/app.ts'])
  })
})
