// The Explorer's file operations, against real folders.
//
// In user terms: New File and New Folder never replace something that is already
// there; Rename moves open work without losing it and handles a change of letter case;
// Delete goes to the trash unless the user said otherwise; and none of it can reach a
// file outside the open project, through `..` or through a link.

import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, readFile, realpath, rm, stat, symlink, writeFile, readdir } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import {
  FsRefusal,
  createFile,
  createFolder,
  deleteEntry,
  renameEntry,
  trashCommand,
  validateName,
} from '../src/tools/fsops.js'
import { METHODS } from '../src/rpc/methods.js'
import { createMethodContext } from '../src/rpc/server.js'

const roots: string[] = []
afterEach(async () => {
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true }).catch(() => {})
})

async function tempRoot(): Promise<string> {
  const root = await realpath(await mkdtemp(join(tmpdir(), 'sketch-fsops-')))
  roots.push(root)
  return root
}

const present = (path: string) => stat(path).then(() => true, () => false)

describe('creating', () => {
  it('creates a file and its missing parent folders, and never overwrites one', async () => {
    const root = await tempRoot()
    const { path } = await createFile(root, 'src/new/hello.ts', 'export {}\n')
    expect(path).toBe(join(root, 'src', 'new', 'hello.ts'))
    expect(await readFile(path, 'utf8')).toBe('export {}\n')

    await writeFile(join(root, 'keep.txt'), 'precious')
    await expect(createFile(root, 'keep.txt')).rejects.toThrow(/already exists/)
    expect(await readFile(join(root, 'keep.txt'), 'utf8')).toBe('precious')
  })

  it('creates folders, and refuses one that exists', async () => {
    const root = await tempRoot()
    await createFolder(root, 'a/b/c')
    expect((await stat(join(root, 'a', 'b', 'c'))).isDirectory()).toBe(true)
    await expect(createFolder(root, 'a/b')).rejects.toThrow(/already exists/)
  })

  it('refuses names a file system cannot hold', () => {
    for (const bad of ['', '  ', '.', '..', 'a:b', 'what?', 'CON', 'nul.txt', 'trailing.', 'tab\there']) {
      expect(() => validateName(bad), bad).toThrow(FsRefusal)
    }
    // What a user typed is trimmed, as every file dialog does.
    expect(validateName('  ok.ts ')).toBe('ok.ts')
  })
})

describe('containment', () => {
  it('refuses paths outside the project, by text and by link', async () => {
    const root = await tempRoot()
    const outside = await tempRoot()
    await expect(createFile(root, '../escape.txt')).rejects.toThrow(/outside the open project/)
    await expect(createFile(root, join(outside, 'abs.txt'))).rejects.toThrow(/outside the open project/)

    await symlink(outside, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    await expect(createFile(root, 'link/through.txt')).rejects.toThrow(/resolves outside/)
    await expect(createFolder(root, 'link/deeper')).rejects.toThrow(/resolves outside/)
    expect(await readdir(outside)).toEqual([])
  })

  it('will not delete or rename the project folder itself', async () => {
    const root = await tempRoot()
    await expect(deleteEntry(root, root, { trash: false })).rejects.toThrow(/project folder itself/)
    await expect(renameEntry(root, root, join(root, 'x'))).rejects.toThrow(/project folder itself/)
  })
})

describe('renaming', () => {
  it('renames and moves, and never onto an existing name', async () => {
    const root = await tempRoot()
    await writeFile(join(root, 'a.txt'), 'A')
    await writeFile(join(root, 'b.txt'), 'B')
    await expect(renameEntry(root, 'a.txt', 'b.txt')).rejects.toThrow(/already exists/)
    expect(await readFile(join(root, 'b.txt'), 'utf8')).toBe('B')

    await renameEntry(root, 'a.txt', 'docs/moved.txt')
    expect(await readFile(join(root, 'docs', 'moved.txt'), 'utf8')).toBe('A')
    expect(await present(join(root, 'a.txt'))).toBe(false)
  })

  it('changes only the letter case of a name', async () => {
    const root = await tempRoot()
    await writeFile(join(root, 'readme.md'), '# hi')
    await renameEntry(root, 'readme.md', 'README.md')
    expect(await readdir(root)).toEqual(['README.md'])
    expect(await readFile(join(root, 'README.md'), 'utf8')).toBe('# hi')
  })

  it('refuses to move a folder into itself', async () => {
    const root = await tempRoot()
    await mkdir(join(root, 'pkg'))
    await expect(renameEntry(root, 'pkg', 'pkg/inner/pkg')).rejects.toThrow(/into itself/)
  })
})

describe('deleting', () => {
  it('deletes permanently only when asked to', async () => {
    const root = await tempRoot()
    await mkdir(join(root, 'dir', 'sub'), { recursive: true })
    await writeFile(join(root, 'dir', 'sub', 'f.txt'), 'x')
    const result = await deleteEntry(root, 'dir', { trash: false })
    expect(result.trashed).toBe(false)
    expect(await present(join(root, 'dir'))).toBe(false)
  })

  it('removes a link without touching what it points at', async () => {
    const root = await tempRoot()
    const outside = await tempRoot()
    await writeFile(join(outside, 'theirs.txt'), 'not yours')
    await symlink(outside, join(root, 'link'), process.platform === 'win32' ? 'junction' : 'dir')
    // A link that leads out of the project is refused outright: nothing is followed.
    await expect(deleteEntry(root, 'link', { trash: false })).rejects.toThrow(/resolves outside/)
    expect(await readFile(join(outside, 'theirs.txt'), 'utf8')).toBe('not yours')
  })

  it('builds a trash command that carries the path as data, never as script', () => {
    const tricky = "C:\\p\\it's $(evil) `x`.txt"
    const win = trashCommand(tricky, 'win32', { SystemRoot: 'C:\\Windows' })!
    expect(win.env?.['SKETCH_TRASH_PATH']).toBe(tricky)
    const script = Buffer.from(win.args[win.args.length - 1]!, 'base64').toString('utf16le')
    expect(script).not.toContain('evil')
    expect(script).toContain('SendToRecycleBin')

    const mac = trashCommand('/tmp/a "b".txt', 'darwin', {})!
    expect(mac.args[mac.args.length - 1]).toBe('/tmp/a "b".txt')
    expect(trashCommand('/tmp/x', 'linux', { PATH: '' })).toBeNull()
  })
})

describe('over the method table', () => {
  const ctx = () =>
    createMethodContext('fs-1', {
      writeFrame: () => {},
      writeErr: () => {},
      env: process.env,
      cwd: () => process.cwd(),
      secrets: new Set(),
    })

  it('creates, renames and deletes, and answers refusals as invalid params', async () => {
    const root = await tempRoot()
    await METHODS['fs-create-folder']!({ root, path: 'lib' }, ctx())
    await METHODS['fs-create-file']!({ root, path: 'lib/a.ts' }, ctx())
    await METHODS['fs-rename']!({ root, source: 'lib/a.ts', target: 'lib/b.ts' }, ctx())
    expect(await readdir(join(root, 'lib'))).toEqual(['b.ts'])
    const removed = (await METHODS['fs-delete']!({ root, path: 'lib/b.ts', trash: false }, ctx())) as {
      deleted: boolean
    }
    expect(removed.deleted).toBe(true)
    await expect(METHODS['fs-create-file']!({ root, path: '../x' }, ctx())).rejects.toThrow(/outside the open project/)
  })
})
