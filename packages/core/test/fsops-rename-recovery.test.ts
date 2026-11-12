//
// A rename whose last step fails. On Windows another program (an indexer, a sync
// client, antivirus) can hold an entry for a moment, so a rename can fail half way.
// What the user must never see is their file gone from the Explorer: a case-only
// rename passes through a hidden temporary name, and a failure there has to put the
// entry back under its own name and say what went wrong.
//
// A real file system will not fail on demand, so `rename` is wrapped to refuse one
// destination. Kept in its own file so the wrapper touches no other test.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdtemp, readFile, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

const control = vi.hoisted(() => ({ refuseInto: null as string | null }))

vi.mock('node:fs/promises', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:fs/promises')>()
  return {
    ...actual,
    rename: async (from: string, to: string): Promise<void> => {
      if (control.refuseInto !== null && to === control.refuseInto) {
        throw Object.assign(new Error(`EBUSY: resource busy or locked, rename '${from}' -> '${to}'`), {
          code: 'EBUSY',
        })
      }
      return actual.rename(from, to)
    },
  }
})

const { renameEntry } = await import('../src/tools/fsops.js')

const roots: string[] = []
afterEach(async () => {
  control.refuseInto = null
  while (roots.length > 0) await rm(roots.pop()!, { recursive: true, force: true }).catch(() => {})
})

describe('a rename that fails half way', () => {
  it('leaves the file under its own name and reports the failure', async () => {
    const root = await realpath(await mkdtemp(join(tmpdir(), 'sketch-rename-')))
    roots.push(root)
    await writeFile(join(root, 'readme.md'), '# hi')

    control.refuseInto = join(root, 'README.md')
    await expect(renameEntry(root, 'readme.md', 'README.md')).rejects.toThrow(/EBUSY/)

    // Not stranded under the hidden temporary name.
    expect(await readdir(root)).toEqual(['readme.md'])
    expect(await readFile(join(root, 'readme.md'), 'utf8')).toBe('# hi')
  })
})
