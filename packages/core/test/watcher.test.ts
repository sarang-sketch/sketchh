// The project watcher, against real folders on the machine running the tests. What
// these pin, in user terms:
//   * A file written by anything — not just Sketch — is reported, by absolute path.
//   * A poll waits for a change instead of spinning, and answers soon after one.
//   * node_modules, git's object store and Sketch's own folder are never reported;
//     HEAD and the index are reported as "git changed".
//   * A folder created after watching started is watched too (the per-folder strategy
//     Linux uses, exercised here on any platform).
//   * A burst too big to list is an overflow: "re-read everything".
//   * One watcher per folder, closed when nobody polls it any more.

import { afterEach, describe, expect, it } from 'vitest'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

import { METHODS } from '../src/rpc/methods.js'
import { createMethodContext } from '../src/rpc/server.js'
import {
  MAX_PATHS_PER_BATCH,
  ProjectWatcher,
  WatcherRegistry,
  classifyChange,
  type WatchBatch,
} from '../src/tools/watcher.js'

const roots: string[] = []
const open: ProjectWatcher[] = []

async function tempRoot(): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), 'sketch-watch-'))
  roots.push(root)
  await mkdir(join(root, 'src'), { recursive: true })
  await mkdir(join(root, 'node_modules', 'left-pad'), { recursive: true })
  await mkdir(join(root, '.git', 'objects', 'ab'), { recursive: true })
  await mkdir(join(root, '.git', 'refs', 'heads'), { recursive: true })
  await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/main\n')
  return root
}

async function watcherFor(root: string, perDirectory: boolean): Promise<ProjectWatcher> {
  const watcher = new ProjectWatcher(root, { perDirectory })
  open.push(watcher)
  await watcher.ready()
  // Some platforms deliver the watcher's own setup as events; start from a quiet point.
  await new Promise((resolve) => setTimeout(resolve, 150))
  return watcher
}

/** Poll until `predicate` holds for the accumulated answers, or the deadline passes. */
async function collect(watcher: ProjectWatcher, since: number, until: (b: WatchBatch[]) => boolean, ms = 8000): Promise<WatchBatch[]> {
  const deadline = Date.now() + ms
  const batches: WatchBatch[] = []
  let cursor = since
  while (Date.now() < deadline && !until(batches)) {
    const batch = await watcher.poll(cursor, Math.max(50, Math.min(2000, deadline - Date.now())))
    batches.push(batch)
    cursor = batch.cursor
  }
  return batches
}

const allPaths = (batches: WatchBatch[]) => batches.flatMap((b) => b.paths)
const lower = (p: string) => (process.platform === 'win32' ? p.toLowerCase() : p)
const has = (batches: WatchBatch[], path: string) => allPaths(batches).some((p) => lower(p) === lower(path))

afterEach(async () => {
  for (const watcher of open.splice(0)) watcher.close()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }).catch(() => {})
})

describe('classifyChange', () => {
  it('reports project files and ignores dependency folders, caches and git internals', () => {
    expect(classifyChange('src/app.ts').kind).toBe('path')
    expect(classifyChange('src\\deep\\x.py').kind).toBe('path')
    expect(classifyChange('node_modules/react/index.js').kind).toBe('ignore')
    expect(classifyChange('packages/a/node_modules/x/y.js').kind).toBe('ignore')
    expect(classifyChange('.sketch/snapshots/run-1/a.ts').kind).toBe('ignore')
    expect(classifyChange('app/__pycache__/m.cpython-312.pyc').kind).toBe('ignore')
    expect(classifyChange('.git/objects/ab/cdef').kind).toBe('ignore')
    expect(classifyChange('.git/logs/HEAD').kind).toBe('ignore')
    expect(classifyChange('.git/HEAD').kind).toBe('git')
    expect(classifyChange('.git/index').kind).toBe('git')
    expect(classifyChange('.git/refs/heads/feature/x').kind).toBe('git')
    // The folder itself appearing or vanishing changes its parent's listing.
    expect(classifyChange('node_modules').kind).toBe('path')
    // Editor swap files are not the user's files.
    expect(classifyChange('src/.app.ts.swp').kind).toBe('ignore')
    expect(classifyChange('src/app.ts~').kind).toBe('ignore')
  })
})

describe.each([
  ['the platform watcher', false],
  ['the per-folder watcher', true],
])('%s', (_name, perDirectory) => {
  it('reports a file written by another program, by absolute path', async () => {
    const root = await tempRoot()
    const watcher = await watcherFor(root, perDirectory)
    const start = await watcher.poll(undefined)
    expect(start).toMatchObject({ paths: [], watching: true, overflow: false })
    const file = join(root, 'src', 'app.ts')
    await writeFile(file, 'export const x = 1\n')
    const batches = await collect(watcher, start.cursor, (b) => has(b, file))
    expect(has(batches, file)).toBe(true)
  })

  it('never reports node_modules or the object store, and flags HEAD as a git change', async () => {
    const root = await tempRoot()
    const watcher = await watcherFor(root, perDirectory)
    const start = await watcher.poll(undefined)
    await writeFile(join(root, 'node_modules', 'left-pad', 'index.js'), 'module.exports = 1\n')
    await writeFile(join(root, '.git', 'objects', 'ab', 'cdef'), 'blob')
    await writeFile(join(root, '.git', 'HEAD'), 'ref: refs/heads/feature\n')
    const batches = await collect(watcher, start.cursor, (b) => b.some((x) => x.git))
    expect(batches.some((b) => b.git)).toBe(true)
    expect(allPaths(batches).some((p) => /node_modules[\\/]left-pad/.test(p))).toBe(false)
    expect(allPaths(batches).some((p) => /objects/.test(p))).toBe(false)
  })

  it('watches a folder created after watching started', async () => {
    const root = await tempRoot()
    const watcher = await watcherFor(root, perDirectory)
    const start = await watcher.poll(undefined)
    await mkdir(join(root, 'src', 'feature'))
    // Give the per-folder watcher a moment to notice the new folder.
    await collect(watcher, start.cursor, (b) => has(b, join(root, 'src', 'feature')))
    const mid = await watcher.poll(undefined)
    const file = join(root, 'src', 'feature', 'new.ts')
    await writeFile(file, 'export {}\n')
    const batches = await collect(watcher, mid.cursor, (b) => has(b, file))
    expect(has(batches, file)).toBe(true)
  })
})

describe('polling', () => {
  it('waits for a change instead of answering at once, then answers soon after it', async () => {
    const root = await tempRoot()
    const watcher = await watcherFor(root, false)
    const start = await watcher.poll(undefined)
    const began = Date.now()
    const waiting = watcher.poll(start.cursor, 10_000)
    setTimeout(() => void writeFile(join(root, 'src', 'late.ts'), 'x\n'), 300)
    const batch = await waiting
    const took = Date.now() - began
    expect(batch.paths.length).toBeGreaterThan(0)
    expect(took).toBeGreaterThanOrEqual(250)
    expect(took).toBeLessThan(5_000)
  })

  it('answers an empty batch at the timeout when nothing changed', async () => {
    const root = await tempRoot()
    const watcher = await watcherFor(root, false)
    const start = await watcher.poll(undefined)
    const batch = await watcher.poll(start.cursor, 200)
    expect(batch).toMatchObject({ paths: [], overflow: false, git: false, cursor: start.cursor })
  })

  it('reports a burst too big to list as an overflow', async () => {
    const root = await tempRoot()
    const watcher = await watcherFor(root, false)
    const start = await watcher.poll(undefined)
    await mkdir(join(root, 'gen'))
    await Promise.all(Array.from({ length: MAX_PATHS_PER_BATCH + 60 }, (_, i) => writeFile(join(root, 'gen', `f${i}.ts`), `${i}\n`)))
    const batches = await collect(watcher, start.cursor, (b) => b.some((x) => x.overflow) || new Set(allPaths(b)).size > MAX_PATHS_PER_BATCH, 15_000)
    const distinct = new Set(allPaths(batches)).size
    // Either one answer said "too many to list", or the writes arrived over several answers.
    expect(batches.some((b) => b.overflow) || distinct > MAX_PATHS_PER_BATCH, `${batches.length} answers, ${distinct} paths`).toBe(true)
    for (const batch of batches) expect(batch.paths.length).toBeLessThanOrEqual(MAX_PATHS_PER_BATCH)
  }, 20_000)

  it('answers a folder that does not exist with watching: false instead of throwing', async () => {
    const watcher = new ProjectWatcher(join(tmpdir(), `sketch-missing-${Date.now()}`))
    open.push(watcher)
    const batch = await watcher.poll(undefined)
    expect(batch.watching).toBe(false)
    expect(batch.error).not.toBeNull()
  })
})

describe('the registry and the method table', () => {
  it('shares one watcher per folder and closes it once nobody polls it', async () => {
    const root = await tempRoot()
    const registry = new WatcherRegistry({ idleMs: 1_000 })
    const a = registry.for(root)
    // Windows and macOS file names are case-insensitive: one folder, one watcher.
    const b = registry.for(process.platform === 'win32' ? root.toUpperCase() : root)
    expect(b).toBe(a)
    await a.poll(undefined)
    registry.sweep(Date.now() + 5_000)
    expect(a.closed).toBe(true)
    expect(registry.size).toBe(0)
    registry.closeAll()
  })

  it('serves fs-watch over the method table and validates its parameters', async () => {
    const root = await tempRoot()
    const ctx = createMethodContext('w-1', {
      writeFrame: () => {},
      writeErr: () => {},
      env: process.env,
      cwd: () => process.cwd(),
      secrets: new Set(),
    })
    const start = (await METHODS['fs-watch']!({ root }, ctx)) as WatchBatch
    expect(start.watching).toBe(true)
    const file = join(root, 'src', 'rpc.ts')
    setTimeout(() => void writeFile(file, 'x\n'), 200)
    let seen = false
    for (let i = 0; i < 10 && !seen; i += 1) {
      const batch = (await METHODS['fs-watch']!({ root, since: start.cursor, timeoutMs: 2_000 }, ctx)) as WatchBatch
      seen = batch.paths.some((p) => lower(p) === lower(file))
    }
    expect(seen).toBe(true)
    await expect(METHODS['fs-watch']!({ root: 'relative/path' }, ctx)).rejects.toThrow(/absolute/)
    await expect(METHODS['fs-watch']!({ root, timeoutMs: -1 }, ctx)).rejects.toThrow(/negative/)
  })
})
