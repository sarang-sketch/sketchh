// Keeping what the window shows in step with what is on disk.
//
// The editor's buffers, the Explorer's listings and the Source Control status are each
// read once and then trusted. That was safe while every change went through this
// window — a save, an Explorer operation, an agent edit each re-sync what they touched —
// and it stopped being safe once the window had a terminal and git sync. A `git switch`,
// a pull, a formatter or a code generator run in the terminal changes files behind the
// editor. An open tab kept the old text, and the next save wrote it back: a pull undone
// without a word.
//
// So whatever may have changed the disk ANNOUNCES it, and the readers look again:
//
//   * a terminal command finishing, a branch switch, a pull or a discard, an agent run
//     ending, a Replace in Files — `announceDiskChanged(reason)`;
//   * the window coming back to the front, because the user may have used another
//     program in the meantime.
//
// WHAT HAPPENS TO AN OPEN BUFFER IS THE REDUCER'S DECISION (`DISK_CHANGED`,
// `DISK_DELETED` in state/AppState.tsx), never this file's: a tab with no unsaved edits
// takes the new text; a tab WITH unsaved edits keeps them and is flagged, exactly like an
// engine write (Requirement 15.3). A file that disappeared keeps its tab and its text,
// marked deleted, until the user saves (recreating it) or closes it.
//
// Validates: Requirements 15.2, 15.3

import { useCallback, useEffect, useRef } from 'react'

import { useAppDispatch, useAppState } from '../state/AppState'
import { useFileIo } from './FileIoProvider'
import { MAX_OPEN_BYTES, byteLength, isEditorSaveInFlight, isMissingFileError, looksBinary, type FileIo } from './fileIo'
import { canonicalPath } from './paths'

export type DiskChangeReason = 'terminal' | 'git' | 'agent' | 'replace' | 'manual' | 'focus' | 'watcher'

export const DISK_CHANGED_EVENT = 'sketch:disk-changed'

/** Announcements this close together are one look at the disk, not several. */
export const DISK_SIGNAL_COALESCE_MS = 120

/** Switching windows back and forth quickly does not re-read everything each time. */
export const FOCUS_MIN_INTERVAL_MS = 1500

/** What a reader is told about one (coalesced) look at the disk. */
export interface DiskChange {
  /**
   * The files and folders that changed, by `diskPathKey`. Null: unknown — a terminal
   * command, a pull, the window regaining focus — so look at everything.
   */
  paths: ReadonlySet<string> | null
  /** Git's own state (HEAD, the index, a branch) may have changed. */
  git: boolean
  /** Why: every announcement that was coalesced into this look. */
  reasons: ReadonlySet<DiskChangeReason>
}

/**
 * The comparison key for a path on disk: canonical spelling, and case-folded where the
 * file system is case-insensitive in practice (a drive-letter path), so a watcher's
 * `C:\Work\App\a.ts` and an editor tab's `C:/work/app/a.ts` are the same file.
 */
export function diskPathKey(path: string): string {
  const canonical = canonicalPath(path)
  return /^[A-Za-z]:\//.test(canonical) || canonical.startsWith('//') ? canonical.toLowerCase() : canonical
}

/** The folder a path is in, as a `diskPathKey`. */
export function parentKey(path: string): string {
  const key = diskPathKey(path)
  const at = key.lastIndexOf('/')
  if (at < 0) return key
  if (at === 0) return '/'
  // `C:/a.ts` → `C:/`, the drive root keeps its slash.
  return /^[a-z]:\/[^/]*$/.test(key) ? key.slice(0, 3) : key.slice(0, at)
}

export interface DiskAnnouncement {
  /** Exactly what changed, when the announcer knows (the watcher does). */
  paths?: readonly string[]
  git?: boolean
}

/** Tell every reader in the window that files may have changed on disk. */
export function announceDiskChanged(reason: Exclude<DiskChangeReason, 'focus'>, details: DiskAnnouncement = {}): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent(DISK_CHANGED_EVENT, { detail: { reason, ...details } }))
}

export interface DiskSignalOptions {
  /** Announcements to ignore — a reader's own, which it has already accounted for. */
  ignore?: readonly DiskChangeReason[]
  /** Also look again when the window comes back to the front. Default true. */
  focus?: boolean
}

/**
 * Call `onChange` when the disk may have changed. Bursts are coalesced into one call,
 * and the window regaining focus counts unless `focus: false`. Paths from every
 * coalesced announcement are merged; one announcement without paths makes it "all".
 */
export function useDiskChangeSignal(onChange: (change: DiskChange) => void, options: DiskSignalOptions = {}): void {
  const callback = useRef(onChange)
  callback.current = onChange
  const ignore = (options.ignore ?? []).join(',')
  const focus = options.focus !== false

  useEffect(() => {
    if (typeof window === 'undefined') return
    const skip = new Set(ignore === '' ? [] : ignore.split(','))
    let timer: ReturnType<typeof setTimeout> | null = null
    let lastFocus = 0
    let paths: Set<string> | null = new Set()
    let git = false
    let reasons = new Set<DiskChangeReason>()

    const schedule = (reason: DiskChangeReason, changed: readonly string[] | undefined, gitChanged: boolean) => {
      reasons.add(reason)
      if (gitChanged) git = true
      if (changed === undefined) paths = null
      else if (paths !== null) for (const path of changed) paths.add(diskPathKey(path))
      if (timer !== null) return
      timer = setTimeout(() => {
        timer = null
        const change: DiskChange = { paths, git, reasons }
        paths = new Set()
        git = false
        reasons = new Set()
        callback.current(change)
      }, DISK_SIGNAL_COALESCE_MS)
    }
    const onAnnounce = (event: Event) => {
      const detail = (event as CustomEvent<{ reason?: string; paths?: unknown; git?: unknown }>).detail
      const reason = detail?.reason
      if (typeof reason === 'string' && skip.has(reason)) return
      const changed = Array.isArray(detail?.paths) ? detail.paths.filter((p): p is string => typeof p === 'string') : undefined
      // Anything but the watcher is a "look at everything" (it does not know what changed).
      schedule((reason ?? 'manual') as DiskChangeReason, changed, detail?.git === true || changed === undefined)
    }
    const onFocus = () => {
      const now = Date.now()
      if (now - lastFocus < FOCUS_MIN_INTERVAL_MS) return
      lastFocus = now
      schedule('focus', undefined, true)
    }
    const onVisibility = () => {
      if (document.visibilityState === 'visible') onFocus()
    }

    window.addEventListener(DISK_CHANGED_EVENT, onAnnounce)
    if (focus) {
      window.addEventListener('focus', onFocus)
      document.addEventListener('visibilitychange', onVisibility)
    }
    return () => {
      window.removeEventListener(DISK_CHANGED_EVENT, onAnnounce)
      window.removeEventListener('focus', onFocus)
      document.removeEventListener('visibilitychange', onVisibility)
      if (timer !== null) clearTimeout(timer)
    }
  }, [focus, ignore])
}

/** What one look at an open file found. */
export type DiskProbe =
  | { kind: 'text'; content: string }
  | { kind: 'missing' }
  /** Unreadable for some other reason (too big now, binary, permissions). Left alone. */
  | { kind: 'unreadable' }

/** Read an open file the way the editor would, without ever throwing. */
export async function probeOpenFile(io: FileIo, root: string, path: string): Promise<DiskProbe> {
  try {
    const content = await io.readFile(root, path)
    if (looksBinary(content) || byteLength(content) > MAX_OPEN_BYTES) return { kind: 'unreadable' }
    return { kind: 'text', content }
  } catch (err) {
    return isMissingFileError(err) ? { kind: 'missing' } : { kind: 'unreadable' }
  }
}

/**
 * Re-read every open tab when the disk may have changed. Rendered once, by the editor.
 *
 * One look at a time: an announcement during a look schedules exactly one more, so a
 * burst of terminal commands cannot stack up reads.
 */
export function useOpenFilesDiskSync(): void {
  const state = useAppState()
  const dispatch = useAppDispatch()
  const io = useFileIo()
  const latest = useRef(state)
  latest.current = state
  const looking = useRef(false)
  const again = useRef(false)
  /** What the next look covers: everything, or only these files (by `diskPathKey`). */
  const everything = useRef(false)
  const only = useRef(new Set<string>())
  const mounted = useRef(true)
  useEffect(() => {
    mounted.current = true
    return () => {
      mounted.current = false
    }
  }, [])

  const look = useCallback((change?: DiskChange) => {
    if (change !== undefined && change.paths !== null) {
      // The watcher said exactly what changed: only those tabs need a look.
      for (const key of change.paths) only.current.add(key)
    } else {
      everything.current = true
    }
    if (looking.current) {
      again.current = true
      return
    }
    looking.current = true
    void (async () => {
      try {
        do {
          again.current = false
          const all = everything.current
          const wanted = only.current
          everything.current = false
          only.current = new Set()
          const snapshot = latest.current
          const root = snapshot.projectRoot
          if (root === null || snapshot.openFiles.length === 0) break
          const targets = all ? snapshot.openFiles : snapshot.openFiles.filter((path) => wanted.has(diskPathKey(path)))
          await Promise.all(
            targets.map(async (path) => {
              const entry = snapshot.files[path]
              // A save in progress establishes the new baseline itself.
              if (entry === undefined || isEditorSaveInFlight(path)) return
              const version = entry.diskVersion
              const probe = await probeOpenFile(io, root, path)
              if (!mounted.current || latest.current.projectRoot !== root || isEditorSaveInFlight(path)) return
              if (probe.kind === 'text') {
                dispatch({ type: 'DISK_CHANGED', payload: { path, content: probe.content, version } })
              } else if (probe.kind === 'missing') {
                dispatch({ type: 'DISK_DELETED', payload: { path, version } })
              }
            }),
          )
        } while (again.current && mounted.current)
      } finally {
        looking.current = false
      }
    })()
  }, [dispatch, io])

  useDiskChangeSignal(look)
}
