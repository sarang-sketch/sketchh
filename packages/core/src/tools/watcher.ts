// Watching the open project for changes, so the window shows the disk as it is NOW.
//
// ── WHY ─────────────────────────────────────────────────────────────────────
//
// Until this existed the window re-read the disk when something it knew about might
// have changed it — a terminal command ending, a git operation, an agent run, the
// window coming back to the front. Every other change was invisible until one of
// those happened: a file saved in another editor, a `git checkout` in an external
// terminal, a code generator or a dev server's build writing in the background. An
// open tab kept stale text, and the Explorer did not show a new file. Every desktop
// IDE watches the folder; this is that watcher.
//
// ── HOW ─────────────────────────────────────────────────────────────────────
//
// Windows and macOS: one recursive `fs.watch` on the root (ReadDirectoryChangesW,
// FSEvents) — one handle for the whole tree. Linux: Node's recursive mode watches
// EVERY folder, `node_modules` included, which exhausts the inotify limit on a real
// project; so there each folder gets its own watcher, ignored trees are never entered,
// and the count is capped (`degraded` says when the cap was hit).
//
// Changes are filtered (dependency folders, build caches, git's object store, Sketch's
// own working folder), coalesced for a moment so a build writing 400 files is one
// batch, and handed out by LONG POLL: `poll(since)` answers at once if anything changed
// after `since`, otherwise when something does or the timeout passes. Long poll works
// over both transports (the sidecar's stdio and the dev bridge's HTTP) with nothing
// new on the wire.
//
// The window gets paths, never contents: what to re-read is still the window's
// decision, made by the same code that handles every other kind of change.

import { watch, type FSWatcher } from 'node:fs'
import { readdir, stat } from 'node:fs/promises'
import { isAbsolute, join, resolve } from 'node:path'

/** One answer to a poll. */
export interface WatchBatch {
  /** Pass as `since` to the next poll. */
  cursor: number
  /** Absolute paths that changed (created, written, deleted, renamed), deduplicated. */
  paths: string[]
  /** More changed than `paths` lists (or a change named no file): re-read everything. */
  overflow: boolean
  /** Git's own state changed: HEAD, the index, a branch. Status and markers are stale. */
  git: boolean
  /** False when the folder cannot be watched; the window falls back to its own triggers. */
  watching: boolean
  /** Linux only: the folder has more subfolders than are watched. */
  degraded: boolean
  error: string | null
}

/** Folder names whose contents are never reported. */
export const IGNORED_DIRECTORIES: ReadonlySet<string> = new Set([
  'node_modules',
  '.sketch',
  '__pycache__',
  '.pytest_cache',
  '.mypy_cache',
  '.ruff_cache',
  '.turbo',
  '.parcel-cache',
  '.next',
  '.nuxt',
  '.svelte-kit',
  '.gradle',
  '.idea',
  '.vs',
])

/** Inside `.git`, only these mean "git state changed"; the rest (objects, logs) is noise. */
const GIT_STATE = /^(HEAD|index|packed-refs|FETCH_HEAD|ORIG_HEAD|MERGE_HEAD|CHERRY_PICK_HEAD|REBASE_HEAD|refs)(\/|$)/

/** Changes collected before a batch is handed out. */
export const COALESCE_MS = 120
/** Changes remembered for late pollers. Older ones are summarised as an overflow. */
export const MAX_RETAINED_CHANGES = 4_000
/** Paths in one answer. Past this the answer is an overflow. */
export const MAX_PATHS_PER_BATCH = 400
/** Linux: folders given their own watcher. */
export const MAX_WATCHED_DIRECTORIES = 6_000
/** Longest a poll may wait. */
export const MAX_POLL_MS = 30_000

export type ChangeKind = { kind: 'ignore' } | { kind: 'path' } | { kind: 'git' }

/** What a change at `relative` (to the project root, either separator) means. */
export function classifyChange(relative: string): ChangeKind {
  const rel = relative.replace(/\\/g, '/').replace(/^\.\//, '')
  if (rel === '' || rel === '.') return { kind: 'path' }
  const segments = rel.split('/')
  if (segments[0] === '.git') {
    return GIT_STATE.test(segments.slice(1).join('/')) ? { kind: 'git' } : { kind: 'ignore' }
  }
  // An editor's swap and backup files, and git's lock files elsewhere.
  const last = segments[segments.length - 1]!
  if (/~$|\.sw[px]$|^\.#|^#.*#$/.test(last)) return { kind: 'ignore' }
  for (const segment of segments.slice(0, -1)) if (IGNORED_DIRECTORIES.has(segment)) return { kind: 'ignore' }
  // A change to an ignored folder itself (created, deleted) still changes its parent.
  return { kind: 'path' }
}

interface Change {
  seq: number
  /** Absolute; null for a git change or a change that named no file. */
  path: string | null
  git: boolean
  /** The platform said "something changed" without saying what (its buffer overflowed). */
  unknown: boolean
}

interface Waiter {
  since: number
  resolve: (batch: WatchBatch) => void
  timer: ReturnType<typeof setTimeout>
}

export interface ProjectWatcherOptions {
  /** Force the per-folder strategy (tests; Linux uses it regardless). */
  perDirectory?: boolean
  now?: () => number
}

/** One project root, watched. */
export class ProjectWatcher {
  readonly root: string
  #watchers = new Map<string, FSWatcher>()
  #changes: Change[] = []
  #seq = 0
  /** The oldest seq still in `#changes` minus one: polls older than this overflowed. */
  #floor = 0
  #waiters = new Set<Waiter>()
  #flushTimer: ReturnType<typeof setTimeout> | null = null
  #watching = false
  #degraded = false
  #error: string | null = null
  #closed = false
  #perDirectory: boolean
  #ready: Promise<void>
  lastPolled: number
  #now: () => number

  constructor(root: string, options: ProjectWatcherOptions = {}) {
    this.root = resolve(root)
    this.#now = options.now ?? Date.now
    this.lastPolled = this.#now()
    this.#perDirectory = options.perDirectory ?? process.platform === 'linux'
    this.#ready = this.#start()
  }

  /** Resolves once the watchers are in place (immediately on Windows and macOS). */
  ready(): Promise<void> {
    return this.#ready
  }

  get watching(): boolean {
    return this.#watching
  }

  async #start(): Promise<void> {
    try {
      const info = await stat(this.root)
      if (!info.isDirectory()) throw new Error(`${this.root} is not a folder`)
    } catch (err) {
      this.#fail(err)
      return
    }
    if (!this.#perDirectory) {
      try {
        const watcher = watch(this.root, { recursive: true, persistent: false }, (_event, name) => {
          this.#record(name === null || name === undefined ? null : String(name))
        })
        watcher.on('error', (err) => this.#fail(err))
        this.#watchers.set(this.root, watcher)
        this.#watching = true
        return
      } catch {
        // A platform or file system without recursive watching: watch folder by folder.
        this.#perDirectory = true
      }
    }
    await this.#watchTree(this.root)
    this.#watching = !this.#closed && this.#watchers.size > 0
  }

  /** Give `dir` and every folder under it (not ignored) its own watcher. */
  async #watchTree(dir: string): Promise<void> {
    const queue = [dir]
    while (queue.length > 0 && !this.#closed) {
      const current = queue.shift()!
      if (this.#watchers.has(current)) continue
      if (this.#watchers.size >= MAX_WATCHED_DIRECTORIES) {
        this.#degraded = true
        return
      }
      try {
        const watcher = watch(current, { persistent: false }, (_event, name) => {
          const rel = this.#relative(current)
          const changed = name === null || name === undefined ? null : rel === '' ? String(name) : `${rel}/${String(name)}`
          this.#record(changed)
          // A folder created here gets its own watcher.
          if (changed !== null && classifyChange(changed).kind === 'path') void this.#maybeWatchNew(join(this.root, changed))
        })
        watcher.on('error', () => {
          watcher.close()
          this.#watchers.delete(current)
        })
        this.#watchers.set(current, watcher)
      } catch {
        continue
      }
      let entries: Array<{ name: string; isDirectory(): boolean }> = []
      try {
        entries = await readdir(current, { withFileTypes: true })
      } catch {
        continue
      }
      for (const entry of entries) {
        if (!entry.isDirectory()) continue
        const child = join(current, entry.name)
        const rel = this.#relative(child)
        if (entry.name === '.git') {
          // git's state lives in these two; its object store is not watched.
          for (const gitDir of [child, join(child, 'refs', 'heads')]) queue.push(gitDir)
          continue
        }
        if (classifyChange(`${rel}/x`).kind === 'ignore') continue
        queue.push(child)
      }
    }
  }

  async #maybeWatchNew(path: string): Promise<void> {
    if (this.#watchers.has(path)) return
    try {
      if ((await stat(path)).isDirectory()) await this.#watchTree(path)
    } catch {
      // Gone already, or a file.
    }
  }

  #relative(path: string): string {
    const rel = path.slice(this.root.length).replace(/^[\\/]+/, '')
    return rel.replace(/\\/g, '/')
  }

  #fail(err: unknown): void {
    this.#error = err instanceof Error ? err.message : String(err)
    this.#watching = false
    for (const watcher of this.#watchers.values()) watcher.close()
    this.#watchers.clear()
    this.#flush()
  }

  /** One raw event: filtered, remembered, and a batch scheduled. */
  #record(relative: string | null): void {
    if (this.#closed) return
    let change: Change
    if (relative === null) {
      change = { seq: 0, path: null, git: true, unknown: true }
    } else {
      const kind = classifyChange(relative)
      if (kind.kind === 'ignore') return
      change =
        kind.kind === 'git'
          ? { seq: 0, path: null, git: true, unknown: false }
          : { seq: 0, path: join(this.root, relative), git: false, unknown: false }
    }
    // The same path twice in a row is one change.
    const last = this.#changes[this.#changes.length - 1]
    if (last !== undefined && last.path === change.path && last.git === change.git && last.seq > this.#lastHandedOut) return
    this.#seq += 1
    change.seq = this.#seq
    this.#changes.push(change)
    if (this.#changes.length > MAX_RETAINED_CHANGES) {
      const dropped = this.#changes.splice(0, this.#changes.length - MAX_RETAINED_CHANGES)
      this.#floor = dropped[dropped.length - 1]!.seq
    }
    if (this.#flushTimer === null) {
      this.#flushTimer = setTimeout(() => {
        this.#flushTimer = null
        this.#flush()
      }, COALESCE_MS)
      this.#flushTimer.unref?.()
    }
  }

  /** The newest seq any poller has been given. */
  #lastHandedOut = 0

  #batch(since: number): WatchBatch {
    const overflowed = since < this.#floor
    const paths = new Set<string>()
    let git = false
    let unnamed = false
    for (const change of this.#changes) {
      if (change.seq <= since) continue
      if (change.git) git = true
      if (change.unknown) unnamed = true
      else if (change.path !== null) paths.add(change.path)
    }
    const overflow = overflowed || unnamed || paths.size > MAX_PATHS_PER_BATCH
    this.#lastHandedOut = Math.max(this.#lastHandedOut, this.#seq)
    return {
      cursor: this.#seq,
      paths: overflow ? [] : [...paths],
      overflow,
      git: git || overflowed,
      watching: this.#watching,
      degraded: this.#degraded,
      error: this.#error,
    }
  }

  #flush(): void {
    for (const waiter of [...this.#waiters]) {
      if (this.#seq > waiter.since || !this.#watching) {
        clearTimeout(waiter.timer)
        this.#waiters.delete(waiter)
        waiter.resolve(this.#batch(waiter.since))
      }
    }
  }

  /**
   * Changes after `since`. Without `since`: the current cursor, at once — how a window
   * starts. With it: at once if anything is pending, else when something changes or
   * `timeoutMs` passes (an empty batch).
   */
  async poll(since: number | undefined, timeoutMs = 25_000): Promise<WatchBatch> {
    this.lastPolled = this.#now()
    await this.#ready
    if (since === undefined || since > this.#seq) return this.#batch(this.#seq)
    const pending = this.#changes.some((change) => change.seq > since) || since < this.#floor
    if (pending || !this.#watching || this.#closed) return this.#batch(since)
    const wait = Math.max(0, Math.min(MAX_POLL_MS, timeoutMs))
    return new Promise<WatchBatch>((resolvePoll) => {
      const waiter: Waiter = {
        since,
        resolve: resolvePoll,
        timer: setTimeout(() => {
          this.#waiters.delete(waiter)
          this.lastPolled = this.#now()
          resolvePoll(this.#batch(since))
        }, wait),
      }
      waiter.timer.unref?.()
      this.#waiters.add(waiter)
    })
  }

  close(): void {
    if (this.#closed) return
    this.#closed = true
    this.#watching = false
    if (this.#flushTimer !== null) clearTimeout(this.#flushTimer)
    for (const watcher of this.#watchers.values()) watcher.close()
    this.#watchers.clear()
    for (const waiter of this.#waiters) {
      clearTimeout(waiter.timer)
      waiter.resolve(this.#batch(waiter.since))
    }
    this.#waiters.clear()
  }

  get closed(): boolean {
    return this.#closed
  }
}

/** Watchers by root, closed when no window has polled them for a while. */
export class WatcherRegistry {
  #watchers = new Map<string, ProjectWatcher>()
  #sweeper: ReturnType<typeof setInterval> | null = null
  readonly idleMs: number
  readonly maxRoots: number
  #options: ProjectWatcherOptions

  constructor(options: ProjectWatcherOptions & { idleMs?: number; maxRoots?: number } = {}) {
    this.idleMs = options.idleMs ?? 120_000
    this.maxRoots = options.maxRoots ?? 8
    this.#options = options
  }

  static key(root: string): string {
    const resolved = resolve(root)
    return process.platform === 'win32' || process.platform === 'darwin' ? resolved.toLowerCase() : resolved
  }

  /** The watcher for `root`, started on first use. */
  for(root: string): ProjectWatcher {
    if (!isAbsolute(root)) throw new Error('The project folder must be an absolute path.')
    const key = WatcherRegistry.key(root)
    const existing = this.#watchers.get(key)
    if (existing !== undefined && !existing.closed) return existing
    if (this.#watchers.size >= this.maxRoots) this.#closeStalest()
    const watcher = new ProjectWatcher(root, this.#options)
    this.#watchers.set(key, watcher)
    this.#ensureSweeper()
    return watcher
  }

  #closeStalest(): void {
    let stalest: [string, ProjectWatcher] | null = null
    for (const entry of this.#watchers) if (stalest === null || entry[1].lastPolled < stalest[1].lastPolled) stalest = entry
    if (stalest !== null) {
      stalest[1].close()
      this.#watchers.delete(stalest[0])
    }
  }

  #ensureSweeper(): void {
    if (this.#sweeper !== null) return
    this.#sweeper = setInterval(() => this.sweep(), Math.max(1_000, Math.floor(this.idleMs / 2)))
    this.#sweeper.unref?.()
  }

  /** Close the watchers no window is polling any more (it closed, or opened another folder). */
  sweep(now = Date.now()): void {
    for (const [key, watcher] of this.#watchers) {
      if (now - watcher.lastPolled > this.idleMs) {
        watcher.close()
        this.#watchers.delete(key)
      }
    }
    if (this.#watchers.size === 0 && this.#sweeper !== null) {
      clearInterval(this.#sweeper)
      this.#sweeper = null
    }
  }

  get size(): number {
    return this.#watchers.size
  }

  closeAll(): void {
    for (const watcher of this.#watchers.values()) watcher.close()
    this.#watchers.clear()
    if (this.#sweeper !== null) {
      clearInterval(this.#sweeper)
      this.#sweeper = null
    }
  }
}
