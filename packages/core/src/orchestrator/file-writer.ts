// FileWriter — applies file edits to disk, scoped to the project directory.
// Rule 8: agents may only write inside the open project directory.

import { writeFile, mkdir } from 'node:fs/promises'
import { dirname, resolve, relative, isAbsolute } from 'node:path'
import type { FileEdit } from './types.js'

export interface FileWriter {
  apply(root: string, edits: FileEdit[]): Promise<string[]>  // returns paths written
}

export class DiskFileWriter implements FileWriter {
  async apply(root: string, edits: FileEdit[]): Promise<string[]> {
    const written: string[] = []
    const rootAbs = resolve(root)

    for (const edit of edits) {
      const target = resolve(rootAbs, edit.path)
      if (!isWithin(rootAbs, target)) {
        throw new Error(`Refusing to write outside project directory: ${edit.path}`)
      }
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, edit.content, 'utf8')
      written.push(edit.path)
    }

    return written
  }
}

// True if `target` is inside `root` (or is root itself).
export function isWithin(root: string, target: string): boolean {
  const rel = relative(root, target)
  return rel === '' || (!rel.startsWith('..') && !isAbsolute(rel))
}
