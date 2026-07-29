// Every file operation the editor performs, in one place, all of them dispatching
// into the single state owner.
//
// Nothing here holds file state of its own. Each action reads the current
// `AppState`, talks to the file layer, and dispatches the result — so `AppState`
// stays the only thing that knows what is open, what it says, and whether it is
// dirty (Requirement 15.2). The FileExplorer (task 3.4) will call `openPath` too;
// that is why this is a hook and not private to `EditorArea`.
//
// Validates: Requirements 15.2, 15.4, 15.6, 27.3

import { useCallback, useRef } from 'react'
import { makeFileEntry, useAppDispatch, useAppState, type AppState } from '../state/AppState'
import { useFileIo } from './FileIoProvider'
import { readForEditor, writeFromEditor } from './fileIo'
import { canonicalPath, isWithinRoot, toAbsolutePath } from './paths'

export interface FileActions {
  /** Read `path` from disk and open it as a tab. Absolute or project-relative. */
  openPath(path: string): Promise<void>
  closePath(path: string): void
  activate(path: string): void
  /** Write a buffer to disk and clear its dirty flag. Defaults to the active file. */
  save(path?: string): Promise<void>
  /** Take what is on disk, discarding this buffer's unsaved edits. */
  reloadFromDisk(path: string): Promise<void>
  /** Keep the buffer and stop flagging the conflict. */
  keepMine(path: string): void
  /** The real OS folder picker. */
  openFolder(): Promise<void>
  dismissNotice(): void
}

export function useFileActions(): FileActions {
  const state = useAppState()
  const dispatch = useAppDispatch()
  const io = useFileIo()

  // An async action must act on the state as it is when it resolves, not on the
  // render that started it. The reducer is still the arbiter of every decision that
  // depends on state (dirty vs clean, open vs closed); this ref only supplies the
  // inputs an action needs to make its call.
  const latest = useRef<AppState>(state)
  latest.current = state

  const fail = useCallback(
    (message: string) => {
      dispatch({ type: 'SET_EDITOR_NOTICE', payload: { level: 'error', message } })
    },
    [dispatch],
  )

  const openPath = useCallback(
    async (path: string) => {
      const root = latest.current.projectRoot
      if (!root) {
        fail('Open a project folder before opening a file.')
        return
      }
      const absolute = toAbsolutePath(root, path)

      // Already open: focus it. Re-reading would silently drop unsaved edits.
      if (latest.current.openFiles.includes(absolute)) {
        dispatch({ type: 'SET_ACTIVE_FILE', payload: absolute })
        return
      }

      // Said plainly here rather than waiting for the backend, which would answer
      // the same way. Containment itself stays in Rust (Requirement 15.6).
      if (!isWithinRoot(root, absolute)) {
        fail(`Cannot open ${path}: it is outside the open project ${root}.`)
        return
      }

      const outcome = await readForEditor(io, root, absolute)
      if (!outcome.ok) {
        fail(outcome.message)
        return
      }
      dispatch({ type: 'OPEN_FILE', payload: makeFileEntry(absolute, outcome.content) })
      dispatch({ type: 'SET_EDITOR_NOTICE', payload: null })
    },
    [dispatch, fail, io],
  )

  const closePath = useCallback(
    (path: string) => {
      dispatch({ type: 'CLOSE_FILE', payload: canonicalPath(path) })
    },
    [dispatch],
  )

  const activate = useCallback(
    (path: string) => {
      dispatch({ type: 'SET_ACTIVE_FILE', payload: canonicalPath(path) })
    },
    [dispatch],
  )

  const save = useCallback(
    async (path?: string) => {
      const snapshot = latest.current
      const target = canonicalPath(path ?? snapshot.activeFile ?? '')
      const entry = target === '' ? undefined : snapshot.files[target]
      if (!entry) return
      const root = snapshot.projectRoot
      if (!root) {
        fail('Cannot save: no project folder is open.')
        return
      }

      const outcome = await writeFromEditor(io, root, entry.path, entry.content)
      if (!outcome.ok) {
        // A write the backend refuses is an error on screen, never a quiet no-op
        // that leaves the tab looking saved (Requirement 15.6).
        fail(outcome.message)
        return
      }
      dispatch({ type: 'FILE_SAVED', payload: entry.path })
    },
    [dispatch, fail, io],
  )

  const reloadFromDisk = useCallback(
    async (path: string) => {
      const snapshot = latest.current
      const target = canonicalPath(path)
      const root = snapshot.projectRoot
      if (!root || !snapshot.files[target]) return

      const outcome = await readForEditor(io, root, target)
      if (!outcome.ok) {
        fail(outcome.message)
        return
      }
      dispatch({ type: 'RELOAD_FILE', payload: { path: target, content: outcome.content } })
    },
    [dispatch, fail, io],
  )

  const keepMine = useCallback(
    (path: string) => {
      dispatch({ type: 'DISMISS_CONFLICT', payload: canonicalPath(path) })
    },
    [dispatch],
  )

  const openFolder = useCallback(async () => {
    let picked: string | null
    try {
      picked = await io.pickFolder()
    } catch (err) {
      fail(
        `Could not open the folder picker: ${err instanceof Error ? err.message : String(err)}`,
      )
      return
    }
    // Null is a cancelled dialog. Nothing to report.
    if (picked === null) return
    dispatch({ type: 'SET_PROJECT_ROOT', payload: picked })
  }, [dispatch, fail, io])

  const dismissNotice = useCallback(() => {
    dispatch({ type: 'SET_EDITOR_NOTICE', payload: null })
  }, [dispatch])

  return { openPath, closePath, activate, save, reloadFromDisk, keepMine, openFolder, dismissNotice }
}
