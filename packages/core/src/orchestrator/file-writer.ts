// FileWriter — applies file edits to disk, scoped to the project directory.
// Rule 8: agents may only write inside the open project directory.
//
// ── CONTAINMENT IS CHECKED ON THE REAL PATH ─────────────────────────────────
//
// A lexical `resolve`/`relative` check alone is symlink-escapable: a link inside
// the project (`src/out -> C:\Users\me\.ssh`) passes the lexical test and the
// write lands outside. The Rust host canonicalizes; this writer now meets the same
// bar. The deepest EXISTING ancestor of the target is resolved to its real path
// and the remainder re-attached, so a write through a link that points elsewhere —
// or onto an existing file that is itself such a link — is refused before a byte
// is written.

import { createHash } from 'node:crypto'
import { mkdir, readFile, realpath, rm, writeFile } from 'node:fs/promises'
import { dirname, isAbsolute, join, relative, resolve } from 'node:path'

import type { FileEdit } from './types.js'

export interface FileWriter {
  apply(root: string, edits: FileEdit[]): Promise<string[]>  // returns paths written
}

function isMissing(err: unknown): boolean {
  const code = (err as { code?: unknown } | null)?.code
  return code === 'ENOENT' || code === 'ENOTDIR'
}

/**
 * Where `target` really lands: the real path of its deepest existing ancestor with
 * the not-yet-existing remainder re-attached. A link anywhere on the way is
 * resolved, which is the whole point.
 */
export async function realTargetPath(target: string): Promise<string> {
  let probe = target
  for (;;) {
    try {
      const real = await realpath(probe)
      return resolve(real, relative(probe, target))
    } catch (err) {
      if (!isMissing(err)) throw err
      const parent = dirname(probe)
      if (parent === probe) return target
      probe = parent
    }
  }
}

/** Refuse a write whose real destination is outside the project's real root. */
export async function assertRealContainment(rootAbs: string, target: string, shown: string): Promise<void> {
  let realRoot = rootAbs
  try {
    realRoot = await realpath(rootAbs)
  } catch {
    // A root that does not exist yet has nothing to link through.
  }
  const realTarget = await realTargetPath(target)
  if (!isWithin(realRoot, realTarget)) {
    throw new Error(`Refusing to write outside project directory (through a link): ${shown}`)
  }
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
      await assertRealContainment(rootAbs, target, edit.path)
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

// ── snapshots: undo without Git ─────────────────────────────────────────────
//
// `/undo` in other agents needs a Git repository. This is the file-level journal
// instead: before a run's FIRST write to a path, the original bytes (or the fact
// that the file did not exist) are copied under `.sketch/snapshots/<runId>/`, and
// after every write the hash of what was written is recorded. `restoreSnapshot`
// puts the originals back — and refuses, per file, to touch anything that has
// changed since the run wrote it, because the person may have edited it since and
// their work exists nowhere else.

/** One file a run touched. */
export interface SnapshotEntry {
  /** Project-relative path, as the edit named it. */
  path: string
  /** False when the run created the file; undo then deletes it. */
  existed: boolean
  /** Blob file under the snapshot directory holding the original bytes. */
  blob: string | null
  /** sha256 of the bytes the run last wrote, so undo can tell if anyone changed it since. */
  afterHash: string
}

export interface SnapshotManifest {
  version: 1
  runId: string
  createdAt: number
  entries: SnapshotEntry[]
}

const SNAPSHOT_RUN_ID = /^[A-Za-z0-9._-]{1,128}$/

export function snapshotDir(root: string, runId: string): string {
  if (!SNAPSHOT_RUN_ID.test(runId)) throw new Error(`invalid run id for a snapshot: ${runId}`)
  return join(resolve(root), '.sketch', 'snapshots', runId)
}

function sha256(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex')
}

async function readManifest(dir: string): Promise<SnapshotManifest | null> {
  try {
    const parsed = JSON.parse(await readFile(join(dir, 'manifest.json'), 'utf8')) as SnapshotManifest
    return parsed !== null && parsed.version === 1 && Array.isArray(parsed.entries) ? parsed : null
  } catch {
    return null
  }
}

/**
 * A `FileWriter` that journals each path's original bytes before the run's first
 * write to it, then delegates the write. The inner writer still owns containment.
 */
export class SnapshottingFileWriter implements FileWriter {
  readonly #inner: FileWriter
  readonly #runId: string
  readonly #now: () => number

  constructor(inner: FileWriter, options: { runId: string; now?: () => number }) {
    this.#inner = inner
    this.#runId = options.runId
    this.#now = options.now ?? (() => Date.now())
  }

  async apply(root: string, edits: FileEdit[]): Promise<string[]> {
    const rootAbs = resolve(root)
    const dir = snapshotDir(rootAbs, this.#runId)
    const manifest: SnapshotManifest = (await readManifest(dir)) ?? {
      version: 1,
      runId: this.#runId,
      createdAt: this.#now(),
      entries: [],
    }

    for (const edit of edits) {
      if (manifest.entries.some((entry) => entry.path === edit.path)) continue
      const target = resolve(rootAbs, edit.path)
      // Containment first: never journal (read) a path the write would refuse.
      if (!isWithin(rootAbs, target)) continue
      let original: string | null = null
      try {
        original = await readFile(target, 'utf8')
      } catch (err) {
        if (!isMissing(err)) throw err
      }
      let blob: string | null = null
      if (original !== null) {
        blob = `files/${manifest.entries.length}.txt`
        await mkdir(join(dir, 'files'), { recursive: true })
        await writeFile(join(dir, blob), original, 'utf8')
      }
      manifest.entries.push({ path: edit.path, existed: original !== null, blob, afterHash: '' })
    }

    const written = await this.#inner.apply(root, edits)

    for (const edit of edits) {
      const entry = manifest.entries.find((candidate) => candidate.path === edit.path)
      if (entry !== undefined) entry.afterHash = sha256(edit.content)
    }
    await mkdir(dir, { recursive: true })
    await writeFile(join(dir, 'manifest.json'), `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
    return written
  }
}

export interface RestoreOutcome {
  runId: string
  /** Paths put back to their original bytes. */
  restored: string[]
  /** Paths the run created, now removed. */
  removed: string[]
  /** Paths left alone because they changed after the run wrote them. */
  skipped: Array<{ path: string; reason: string }>
  /** False when no snapshot exists for this run. */
  found: boolean
}

/**
 * Undo a run's file changes from its snapshot. A file edited by someone after the
 * run wrote it is SKIPPED and reported, never overwritten.
 */
export async function restoreSnapshot(root: string, runId: string): Promise<RestoreOutcome> {
  const rootAbs = resolve(root)
  const dir = snapshotDir(rootAbs, runId)
  const manifest = await readManifest(dir)
  const outcome: RestoreOutcome = { runId, restored: [], removed: [], skipped: [], found: manifest !== null }
  if (manifest === null) return outcome

  for (const entry of manifest.entries) {
    const target = resolve(rootAbs, entry.path)
    if (!isWithin(rootAbs, target)) {
      outcome.skipped.push({ path: entry.path, reason: 'outside the project' })
      continue
    }
    let current: string | null = null
    try {
      current = await readFile(target, 'utf8')
    } catch (err) {
      if (!isMissing(err)) throw err
    }
    if (current !== null && entry.afterHash !== '' && sha256(current) !== entry.afterHash) {
      outcome.skipped.push({ path: entry.path, reason: 'changed after the run wrote it' })
      continue
    }
    await assertRealContainment(rootAbs, target, entry.path)
    if (!entry.existed) {
      if (current !== null) {
        await rm(target, { force: true })
        outcome.removed.push(entry.path)
      }
      continue
    }
    if (entry.blob === null) continue
    const original = await readFile(join(dir, entry.blob), 'utf8')
    await mkdir(dirname(target), { recursive: true })
    await writeFile(target, original, 'utf8')
    outcome.restored.push(entry.path)
  }

  // A snapshot is single-use: once restored, the journal is spent.
  await rm(dir, { recursive: true, force: true })
  return outcome
}
