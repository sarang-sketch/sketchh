// The derived tree, tested without a DOM and without a disk.
//
// These are the rules the panel cannot restate: what an unread, loading, empty and
// failed directory each look like, and which directories a given expansion actually
// requires a `read_dir` for. Getting those wrong is how a failure comes out looking
// like an empty folder, and how a lazy tree turns into an eager walk.
//
// Validates: Requirements 14.4, 27.3, 27.5

import { describe, expect, it } from 'vitest'

import {
  directoriesToRead,
  EMPTY_FOLDER,
  flattenTree,
  READING,
  UNREAD_FOLDER,
  type DirLoad,
  type TreeEntry,
} from './fileTree'

const ROOT = 'C:/app'

function dir(name: string, parent = ROOT): TreeEntry {
  return { name, path: `${parent}/${name}`, isDir: true }
}

function file(name: string, parent = ROOT): TreeEntry {
  return { name, path: `${parent}/${name}`, isDir: false }
}

function ready(...entries: TreeEntry[]): DirLoad {
  return { status: 'ready', entries }
}

function input(dirs: Record<string, DirLoad>, expanded: string[] = []) {
  return { root: ROOT, dirs: new Map(Object.entries(dirs)), expanded: new Set(expanded) }
}

describe('flattenTree', () => {
  it('lists the root in the order the backend gave, and nothing deeper', () => {
    const rows = flattenTree(
      input({ [ROOT]: ready(dir('src'), file('README.md'), file('package.json')) }),
    )

    expect(rows.map((r) => [r.kind, 'name' in r ? r.name : r.text])).toEqual([
      ['dir', 'src'],
      ['file', 'README.md'],
      ['file', 'package.json'],
    ])
    expect(rows.every((r) => r.depth === 0)).toBe(true)
  })

  it('shows children only for an expanded folder, one level per read', () => {
    const rows = flattenTree(
      input(
        {
          [ROOT]: ready(dir('src'), dir('public')),
          'C:/app/src': ready(dir('nested', 'C:/app/src'), file('main.ts', 'C:/app/src')),
        },
        ['C:/app/src'],
      ),
    )

    expect(rows.map((r) => ['name' in r ? r.name : r.text, r.depth])).toEqual([
      ['src', 0],
      ['nested', 1],
      ['main.ts', 1],
      // `public` is collapsed, so it contributes one row and no note.
      ['public', 0],
    ])
    const src = rows.find((r) => r.kind === 'dir' && r.name === 'src')
    expect(src?.kind === 'dir' && src.expanded).toBe(true)
  })

  it('tells apart unread, still reading, empty, and failed', () => {
    const cases: Array<[DirLoad | undefined, string]> = [
      [undefined, UNREAD_FOLDER],
      [{ status: 'loading' }, READING],
      [ready(), EMPTY_FOLDER],
      [{ status: 'error', message: 'Cannot list secrets: permission denied.' }, 'permission denied'],
    ]

    for (const [load, expected] of cases) {
      const dirs: Record<string, DirLoad> = { [ROOT]: ready(dir('sub')) }
      if (load !== undefined) dirs['C:/app/sub'] = load
      const rows = flattenTree(input(dirs, ['C:/app/sub']))

      const note = rows.find((r) => r.kind === 'note')
      expect(note?.kind === 'note' && note.text).toContain(expected)
      expect(note?.depth).toBe(1)
    }
  })

  it('marks a failed read as an error and everything else as information', () => {
    const failed = flattenTree(input({ [ROOT]: { status: 'error', message: 'boom' } }))
    expect(failed).toEqual([
      { kind: 'note', key: `${ROOT}:error`, depth: 0, tone: 'error', text: 'boom' },
    ])
    // An empty folder is not an error, and an error is not an empty folder.
    const empty = flattenTree(input({ [ROOT]: ready() }))
    expect(empty[0]?.kind === 'note' && empty[0].tone).toBe('info')
  })

  it('refuses to recurse into a folder that links back into its own ancestors', () => {
    const rows = flattenTree(
      input(
        {
          [ROOT]: ready(dir('src')),
          'C:/app/src': ready({ name: 'loop', path: ROOT, isDir: true }),
        },
        ['C:/app/src', ROOT],
      ),
    )

    const note = rows.find((r) => r.kind === 'note')
    expect(note?.kind === 'note' && note.tone).toBe('error')
    expect(note?.kind === 'note' && note.text).toContain('links back')
    // One row for the loop entry and one note. It did not descend again.
    expect(rows.filter((r) => r.kind === 'dir').length).toBe(2)
  })

  it('gives every row a distinct key', () => {
    const rows = flattenTree(
      input(
        {
          [ROOT]: ready(dir('a'), dir('b')),
          'C:/app/a': ready(file('same.ts', 'C:/app/a')),
          'C:/app/b': ready(file('same.ts', 'C:/app/b')),
        },
        ['C:/app/a', 'C:/app/b'],
      ),
    )

    expect(new Set(rows.map((r) => r.key)).size).toBe(rows.length)
  })
})

describe('directoriesToRead', () => {
  it('asks for the root and nothing else when nothing is expanded', () => {
    expect(directoriesToRead(input({}))).toEqual([ROOT])
    expect(directoriesToRead(input({ [ROOT]: ready(dir('src'), dir('public')) }))).toEqual([ROOT])
  })

  it('asks for each expanded folder, deepest last, as its parent becomes known', () => {
    const dirs = {
      [ROOT]: ready(dir('src')),
      'C:/app/src': ready(dir('deep', 'C:/app/src')),
    }
    expect(directoriesToRead(input(dirs, ['C:/app/src', 'C:/app/src/deep']))).toEqual([
      ROOT,
      'C:/app/src',
      'C:/app/src/deep',
    ])
  })

  it('does not ask for a folder whose parent is collapsed', () => {
    // `src/deep` is remembered as expanded, but `src` is not, so nobody can see it.
    const dirs = {
      [ROOT]: ready(dir('src')),
      'C:/app/src': ready(dir('deep', 'C:/app/src')),
    }
    expect(directoriesToRead(input(dirs, ['C:/app/src/deep']))).toEqual([ROOT])
  })

  it('does not ask for children of a folder that has not been read yet', () => {
    expect(directoriesToRead(input({}, ['C:/app/src']))).toEqual([ROOT])
  })
})
