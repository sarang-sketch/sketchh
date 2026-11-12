// Every file operation the editor performs, in one place, all of them dispatching
// into the single state owner.
//
// Nothing here holds file state of its own. Each action reads the current
// `AppState`, talks to the file layer, and dispatches the result — so `AppState`
// stays the only thing that knows what is open, what it says, and whether it is
// dirty (Requirement 15.2).
//
// CLOSING NEVER LOSES WORK. A tab with unsaved edits used to close silently and take
// the edits with it. Closing one now asks Save / Don't Save / Cancel, and closing
// several asks once for all of them.
//
// Explorer operations (new file, new folder, rename, delete) go through the engine
// (`fs-*` on the client seam), which contains them by real path and never overwrites;
// delete moves to the operating system's trash unless the user chooses otherwise.
//
// Validates: Requirements 15.2, 15.4, 15.6, 27.3

import { useCallback, useRef } from 'react'
import { useConfirm } from '../components/ConfirmDialog'
import { useOptionalSketchClient } from '../lib/ClientProvider'
import type { SketchClient } from '../lib/client'
import { makeFileEntry, useAppDispatch, useAppState, type AppState } from '../state/AppState'
import { editorBridge } from './editorBridge'
import { useFileIo } from './FileIoProvider'
import { beginEditorSave, readForEditor, writeFromEditor } from './fileIo'
import { basename, canonicalPath, isWithinRoot, relativeToRoot, toAbsolutePath } from './paths'

/** How one save runs. */
export interface SaveOptions {
  /** Apply format-on-save when that setting is on. Default true. */
  format?: boolean
}

export interface FileActions {
  /** Read `path` from disk and open it as a tab. Absolute or project-relative. */
  openPath(path: string): Promise<void>
  /** Close one tab; asks first when it has unsaved edits. Resolves true when it closed. */
  closePath(path: string): Promise<boolean>
  /** Close several tabs; asks once about any unsaved ones. Resolves true when they closed. */
  closeMany(paths: string[]): Promise<boolean>
  activate(path: string): void
  /**
   * Write a buffer to disk and clear its dirty flag. Defaults to the active file.
   * `format: false` skips format-on-save: an auto-save after a delay fires while the
   * user is only pausing, and must not reflow the text under the caret.
   */
  save(path?: string, options?: SaveOptions): Promise<boolean>
  /** Save every open buffer with unsaved edits. Resolves true when all saved. */
  saveAll(): Promise<boolean>
  /** Take what is on disk, discarding this buffer's unsaved edits. */
  reloadFromDisk(path: string): Promise<void>
  /** Keep the buffer and stop flagging the conflict. */
  keepMine(path: string): void
  /** The real OS folder picker. */
  openFolder(): Promise<void>
  /** Switch to a folder by path (Open Recent). Asks about unsaved tabs first; true when it switched. */
  openFolderPath(path: string): Promise<boolean>
  dismissNotice(): void
  /** New empty file `name` inside folder `dir` (absolute). Opens it. */
  createFile(dir: string, name: string): Promise<string | null>
  /** New folder `name` inside folder `dir` (absolute). */
  createFolder(dir: string, name: string): Promise<string | null>
  /** Rename `path` (absolute) to `newName` in the same folder. Open tabs follow. */
  renamePath(path: string, newName: string): Promise<string | null>
  /** Move `path` into folder `targetDir` (absolute). Open tabs follow. */
  movePath(path: string, targetDir: string): Promise<string | null>
  /** Delete `path` (absolute) after asking; to the trash when the system has one. */
  deletePath(path: string, isDir: boolean): Promise<boolean>
}

/** Tell the Explorer which folders changed on disk, so it re-reads only those. */
export function announceFsChange(dirs: string[]): void {
  if (typeof window === 'undefined') return
  window.dispatchEvent(new CustomEvent('sketch:fs-changed', { detail: { dirs: dirs.map((d) => canonicalPath(d)) } }))
}

function parentOf(path: string): string {
  const canonical = canonicalPath(path)
  const at = canonical.lastIndexOf('/')
  return at <= 0 ? canonical : canonical.slice(0, at)
}

/**
 * Every folder from `path`'s parent up to the root. Creating `src/new/util.ts` adds the
 * folder `src/new` to `src` and maybe `src` to the root, so each listing on the way up
 * may have changed.
 */
function ancestorsWithin(root: string, path: string): string[] {
  const top = canonicalPath(root)
  const out: string[] = []
  let at = parentOf(path)
  while (at.length >= top.length && at !== '') {
    out.push(at)
    if (at === top) break
    const next = parentOf(at)
    if (next === at) break
    at = next
  }
  return out
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function useFileActions(): FileActions {
  const state = useAppState()
  const dispatch = useAppDispatch()
  const io = useFileIo()
  // Optional: the editor still opens and saves files in a tree with no engine attached.
  const client: Partial<SketchClient> = useOptionalSketchClient() ?? {}
  const confirm = useConfirm()

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

  const activate = useCallback(
    (path: string) => {
      dispatch({ type: 'SET_ACTIVE_FILE', payload: canonicalPath(path) })
    },
    [dispatch],
  )

  const save = useCallback(
    async (path?: string, options?: SaveOptions) => {
      const snapshot = latest.current
      const target = canonicalPath(path ?? snapshot.activeFile ?? '')
      const entry = target === '' ? undefined : snapshot.files[target]
      if (!entry) return false
      const root = snapshot.projectRoot
      if (!root) {
        fail('Cannot save: no project folder is open.')
        return false
      }

      // Registered for the whole save, so a disk check (editor/diskSync.ts) never
      // mistakes a half-written file for something another program changed.
      const endSave = beginEditorSave(entry.path)
      try {
        let content = entry.content
        if (snapshot.editorSettings.formatOnSave && options?.format !== false) {
          // A formatter that fails never blocks the save: the user's text is written as is.
          const formatted = await editorBridge()?.format(entry.path).catch(() => null)
          if (typeof formatted === 'string' && formatted !== content) {
            content = formatted
            dispatch({ type: 'UPDATE_FILE_CONTENT', payload: { path: entry.path, content } })
          }
        }

        const outcome = await writeFromEditor(io, root, entry.path, content)
        if (!outcome.ok) {
          // A write the backend refuses is an error on screen, never a quiet no-op
          // that leaves the tab looking saved (Requirement 15.6).
          fail(outcome.message)
          return false
        }
        // Saved what was written. If the user typed during the write, the buffer is
        // newer than the disk and stays dirty — the reducer compares, on the latest state.
        dispatch({ type: 'FILE_SAVED', payload: { path: entry.path, content } })
        // Saving a file that had been deleted on disk recreates it: its folder listing changed.
        if (entry.deletedOnDisk === true) announceFsChange([parentOf(entry.path)])
        return true
      } finally {
        endSave()
      }
    },
    [dispatch, fail, io],
  )

  const saveAll = useCallback(async () => {
    const dirty = latest.current.openFiles.filter((p) => latest.current.files[p]?.isDirty)
    let ok = true
    for (const path of dirty) ok = (await save(path)) && ok
    return ok
  }, [save])

  const closeMany = useCallback(
    async (paths: string[]) => {
      const snapshot = latest.current
      const targets = paths.map((p) => canonicalPath(p)).filter((p) => snapshot.openFiles.includes(p))
      if (targets.length === 0) return true
      const dirty = targets.filter((p) => snapshot.files[p]?.isDirty)
      if (dirty.length > 0) {
        const one = dirty.length === 1
        const name = one ? basename(dirty[0]!) : `${dirty.length} files`
        const choice = await confirm({
          title: one ? `Save changes to ${name}?` : `Save changes to ${name}?`,
          message: one
            ? 'Your changes will be lost if you don’t save them.'
            : dirty.map((p) => basename(p)).slice(0, 8).join(', ') + (dirty.length > 8 ? ', …' : ''),
          buttons: [
            { id: 'save', label: one ? 'Save' : 'Save All', kind: 'primary' },
            { id: 'discard', label: 'Don’t Save', kind: 'danger' },
            { id: 'cancel', label: 'Cancel' },
          ],
          cancelId: 'cancel',
        })
        if (choice === 'cancel') return false
        if (choice === 'save') {
          for (const path of dirty) {
            if (!(await save(path))) return false
          }
        }
      }
      dispatch({ type: 'CLOSE_FILES', payload: targets })
      return true
    },
    [confirm, dispatch, save],
  )

  const closePath = useCallback((path: string) => closeMany([path]), [closeMany])

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

  // Leaving a project with unsaved edits asks first, like closing its tabs would.
  const openFolderPath = useCallback(
    async (path: string) => {
      const snapshot = latest.current
      if (snapshot.projectRoot !== null && canonicalPath(path) !== snapshot.projectRoot) {
        const closed = await closeMany(snapshot.openFiles)
        if (!closed) return false
      }
      dispatch({ type: 'SET_PROJECT_ROOT', payload: path })
      return true
    },
    [closeMany, dispatch],
  )

  const openFolder = useCallback(async () => {
    let picked: string | null
    try {
      picked = await io.pickFolder()
    } catch (err) {
      const message = messageOf(err)
      // Outside the desktop shell (the browser dev bridge) there is no native picker.
      // The engine can still open a folder by path, so ask for one instead of failing.
      if (message.toLowerCase().includes('not running under tauri') && typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('sketch:open-folder-path'))
        return
      }
      fail(`Could not open the folder picker: ${message}`)
      return
    }
    // Null is a cancelled dialog. Nothing to report.
    if (picked === null) return
    await openFolderPath(picked)
  }, [fail, io, openFolderPath])

  const dismissNotice = useCallback(() => {
    dispatch({ type: 'SET_EDITOR_NOTICE', payload: null })
  }, [dispatch])

  // ── explorer operations ──────────────────────────────────────────────────

  const requireRoot = useCallback((): string | null => {
    const root = latest.current.projectRoot
    if (root === null) fail('Open a project folder first.')
    return root
  }, [fail])

  const createFile = useCallback(
    async (dir: string, name: string) => {
      const root = requireRoot()
      if (root === null) return null
      if (client.fsCreateFile === undefined) {
        fail('Creating files needs the Sketch engine, and this window is not connected to it.')
        return null
      }
      const rel = relativeToRoot(root, `${canonicalPath(dir)}/${name.trim()}`)
      try {
        const { path } = await client.fsCreateFile({ root, path: rel })
        announceFsChange(ancestorsWithin(root, path))
        await openPath(path)
        return canonicalPath(path)
      } catch (err) {
        fail(`Could not create ${name.trim()}: ${messageOf(err)}`)
        return null
      }
    },
    [client, fail, openPath, requireRoot],
  )

  const createFolder = useCallback(
    async (dir: string, name: string) => {
      const root = requireRoot()
      if (root === null) return null
      if (client.fsCreateFolder === undefined) {
        fail('Creating folders needs the Sketch engine, and this window is not connected to it.')
        return null
      }
      const rel = relativeToRoot(root, `${canonicalPath(dir)}/${name.trim()}`)
      try {
        const { path } = await client.fsCreateFolder({ root, path: rel })
        announceFsChange(ancestorsWithin(root, path))
        return canonicalPath(path)
      } catch (err) {
        fail(`Could not create the folder ${name.trim()}: ${messageOf(err)}`)
        return null
      }
    },
    [client, fail, requireRoot],
  )

  const moveTo = useCallback(
    async (path: string, destination: string, label: string) => {
      const root = requireRoot()
      if (root === null) return null
      if (client.fsRename === undefined) {
        fail('Renaming needs the Sketch engine, and this window is not connected to it.')
        return null
      }
      try {
        const result = await client.fsRename({
          root,
          from: relativeToRoot(root, canonicalPath(path)),
          to: relativeToRoot(root, canonicalPath(destination)),
        })
        dispatch({ type: 'PATHS_RENAMED', payload: { from: result.from, to: result.to } })
        announceFsChange([parentOf(result.from), parentOf(result.to)])
        return canonicalPath(result.to)
      } catch (err) {
        fail(`Could not ${label} ${basename(path)}: ${messageOf(err)}`)
        return null
      }
    },
    [client, dispatch, fail, requireRoot],
  )

  const renamePath = useCallback(
    (path: string, newName: string) => moveTo(path, `${parentOf(path)}/${newName.trim()}`, 'rename'),
    [moveTo],
  )

  const movePath = useCallback(
    (path: string, targetDir: string) => moveTo(path, `${canonicalPath(targetDir)}/${basename(path)}`, 'move'),
    [moveTo],
  )

  const deletePath = useCallback(
    async (path: string, isDir: boolean) => {
      const root = requireRoot()
      if (root === null) return false
      if (client.fsDelete === undefined) {
        fail('Deleting needs the Sketch engine, and this window is not connected to it.')
        return false
      }
      const name = basename(path)
      const target = canonicalPath(path)
      const openUnder = latest.current.openFiles.filter((p) => p === target || p.startsWith(`${target}/`))
      const unsaved = openUnder.filter((p) => latest.current.files[p]?.isDirty).length
      const choice = await confirm({
        title: `Delete ${isDir ? 'the folder ' : ''}${name}?`,
        message: isDir ? 'The folder and everything in it will be moved to the trash.' : 'It will be moved to the trash.',
        ...(unsaved > 0 ? { detail: `${unsaved} open file${unsaved === 1 ? ' has' : 's have'} unsaved changes that will be lost.` } : {}),
        buttons: [
          { id: 'trash', label: 'Move to Trash', kind: 'danger' },
          { id: 'cancel', label: 'Cancel' },
        ],
        cancelId: 'cancel',
      })
      if (choice !== 'trash') return false
      const rel = relativeToRoot(root, target)
      try {
        let result = await client.fsDelete({ root, path: rel, trash: true })
        if (!result.deleted && result.trashUnavailable) {
          const permanent = await confirm({
            title: `Delete ${name} permanently?`,
            message: `${result.message ?? 'It could not be moved to the trash.'} Deleting it permanently cannot be undone.`,
            buttons: [
              { id: 'delete', label: 'Delete Permanently', kind: 'danger' },
              { id: 'cancel', label: 'Cancel' },
            ],
            cancelId: 'cancel',
          })
          if (permanent !== 'delete') return false
          result = await client.fsDelete({ root, path: rel, trash: false })
        }
        if (!result.deleted) {
          fail(`Could not delete ${name}.`)
          return false
        }
        dispatch({ type: 'PATHS_DELETED', payload: target })
        announceFsChange([parentOf(target)])
        return true
      } catch (err) {
        fail(`Could not delete ${name}: ${messageOf(err)}`)
        return false
      }
    },
    [client, confirm, dispatch, fail, requireRoot],
  )

  return {
    openPath,
    closePath,
    closeMany,
    activate,
    save,
    saveAll,
    reloadFromDisk,
    keepMine,
    openFolder,
    openFolderPath,
    dismissNotice,
    createFile,
    createFolder,
    renamePath,
    movePath,
    deletePath,
  }
}
