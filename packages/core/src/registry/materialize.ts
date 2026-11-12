// The embedded curated registry, written out where the installer can verify it.
//
// The installer's whole guarantee is that it re-hashes registry FILES against the
// pinned manifest before writing anything into a project. Keeping that guarantee for a
// bundled engine means giving it real files, so the embedded bytes are materialized
// into `~/.sketch/registry/curated-<digest>/` once and reused while intact. A folder
// that was edited by hand is noticed (every file is compared byte for byte, which is
// cheap at this size) and rewritten, and the installer would refuse a tampered skill
// regardless — this only decides whether to refresh the copy.

import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises'
import { dirname, join, normalize, sep } from 'node:path'

import { EMBEDDED_REGISTRY_DIGEST, EMBEDDED_REGISTRY_FILES } from './embedded.js'

function decoded(): Array<[string, Buffer]> {
  return Object.entries(EMBEDDED_REGISTRY_FILES).map(([path, base64]) => {
    const local = normalize(path)
    if (local.startsWith('..') || local.includes(`${sep}..${sep}`) || /^[a-z]:|^[\\/]/i.test(local)) {
      throw new Error(`embedded registry path escapes its folder: ${path}`)
    }
    return [local, Buffer.from(base64, 'base64')]
  })
}

async function intact(dir: string, files: ReadonlyArray<[string, Buffer]>): Promise<boolean> {
  for (const [path, bytes] of files) {
    try {
      const onDisk = await readFile(join(dir, path))
      if (!onDisk.equals(bytes)) return false
    } catch {
      return false
    }
  }
  return true
}

/** The folder name for this build's registry. A new pin gets a new folder. */
export function embeddedRegistryFolderName(): string {
  return `curated-${EMBEDDED_REGISTRY_DIGEST.slice(0, 16)}`
}

/**
 * Write (or reuse) the embedded registry under `baseDir` and return its path.
 * Written to a staging folder first and renamed into place, so a crash cannot leave
 * a half-written registry that looks complete.
 */
export async function materializeEmbeddedRegistry(baseDir: string): Promise<string> {
  const files = decoded()
  const dir = join(baseDir, embeddedRegistryFolderName())
  if (await intact(dir, files)) return dir

  const staging = `${dir}.staging-${process.pid}-${Date.now()}`
  try {
    for (const [path, bytes] of files) {
      const target = join(staging, path)
      await mkdir(dirname(target), { recursive: true })
      await writeFile(target, bytes)
    }
    await rm(dir, { recursive: true, force: true })
    await rename(staging, dir)
  } catch (err) {
    await rm(staging, { recursive: true, force: true }).catch(() => {})
    // Another process may have won the race with an identical copy.
    if (await intact(dir, files)) return dir
    throw err
  }
  return dir
}
