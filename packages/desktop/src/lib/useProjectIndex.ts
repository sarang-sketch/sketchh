// The project's file list and the composer's command menu, fetched from the engine.
//
// Both are read-only engine calls (`project-files`, `commands-list`, `skills-catalog`)
// made when a folder is opened and refreshed when they are likely stale — never on
// every keystroke. The file list is cached per root for a short time so Quick Open,
// `@` mentions and the palette share one walk instead of three.

import { useCallback, useEffect, useRef, useState } from 'react'

import { diskPathKey, useDiskChangeSignal, type DiskChange } from '../editor/diskSync'
import { toAbsolutePath } from '../editor/paths'
import { useAppState } from '../state/AppState'
import { useSketchClient } from './ClientProvider'
import type { SketchClient } from './client'
import { commandMenu, customCommand, skillCommand, type MenuCommand } from './slashCommands'

const FILE_CACHE_MS = 20_000

interface CachedList {
  files: string[]
  at: number
  truncated: boolean
}

/** Per engine client, then per root: a list fetched through one client is never served for another. */
const caches = new WeakMap<object, { lists: Map<string, CachedList>; inflight: Map<string, Promise<{ files: string[]; truncated: boolean }>> }>()

function cacheFor(client: SketchClient) {
  let entry = caches.get(client)
  if (entry === undefined) {
    entry = { lists: new Map(), inflight: new Map() }
    caches.set(client, entry)
  }
  return entry
}

/**
 * Forget cached file lists. Called whenever files may have been created, renamed or
 * deleted — an Explorer operation, a terminal command, a branch switch, an agent run —
 * so Quick Open and `@` mentions never offer a file that is gone or miss a new one.
 */
export function invalidateProjectFiles(client: SketchClient, root?: string): void {
  const { lists } = cacheFor(client)
  if (root === undefined) lists.clear()
  else lists.delete(root)
}

export interface ProjectFilesState {
  files: string[]
  truncated: boolean
  loading: boolean
  error: string | null
  refresh(): void
}

/** The open project's files, project-relative. Empty with no folder open. */
export function useProjectFiles(enabled = true): ProjectFilesState {
  const state = useAppState()
  const client = useSketchClient()
  const root = state.projectRoot
  const cached = root !== null ? cacheFor(client).lists.get(root) : undefined
  const [files, setFiles] = useState<string[]>(cached?.files ?? [])
  const [truncated, setTruncated] = useState(cached?.truncated ?? false)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [nonce, setNonce] = useState(0)

  // The file set may have changed: drop the cached list and, if this view is showing
  // files, read it again. Not on window focus: walking a large project every time the
  // window comes back would cost more than the 20-second cache saves. And not for the
  // watcher reporting edits to files already listed — a save does not change the set.
  const filesRef = useRef(files)
  filesRef.current = files
  const stale = useCallback(
    (change?: DiskChange) => {
      if (root === null) return
      if (change !== undefined && change.paths !== null && change.reasons.size === 1 && change.reasons.has('watcher')) {
        const known = new Set(filesRef.current.map((file) => diskPathKey(toAbsolutePath(root, file))))
        const rootKey = diskPathKey(root)
        const unknown = [...change.paths].some((path) => path !== rootKey && !known.has(path))
        if (!unknown) return
      }
      invalidateProjectFiles(client, root)
      if (enabled) setNonce((n) => n + 1)
    },
    [client, enabled, root],
  )
  useDiskChangeSignal(stale, { focus: false })
  useEffect(() => {
    const onFsChanged = () => stale()
    window.addEventListener('sketch:fs-changed', onFsChanged)
    return () => window.removeEventListener('sketch:fs-changed', onFsChanged)
  }, [stale])

  useEffect(() => {
    if (!enabled || root === null || client.projectFiles === undefined) {
      if (root === null) setFiles([])
      return
    }
    const { lists, inflight } = cacheFor(client)
    const hit = lists.get(root)
    if (hit !== undefined && Date.now() - hit.at < FILE_CACHE_MS) {
      setFiles(hit.files)
      setTruncated(hit.truncated)
      return
    }
    let cancelled = false
    setLoading(true)
    const pending =
      inflight.get(root) ??
      client
        .projectFiles({ root })
        .then((result) => ({ files: result.files, truncated: result.truncated }))
        .finally(() => inflight.delete(root))
    inflight.set(root, pending)
    pending
      .then((result) => {
        lists.set(root, { ...result, at: Date.now() })
        if (cancelled) return
        setFiles(result.files)
        setTruncated(result.truncated)
        setError(null)
      })
      .catch((err: unknown) => {
        if (!cancelled) setError(err instanceof Error ? err.message : String(err))
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [client, enabled, nonce, root])

  const refresh = useCallback(() => {
    if (root !== null) invalidateProjectFiles(client, root)
    setNonce((n) => n + 1)
  }, [client, root])

  return { files, truncated, loading, error, refresh }
}

/** Built-ins, the project's and the user's Markdown commands, and installed skills. */
export function useCommandMenu(): MenuCommand[] {
  const state = useAppState()
  const client = useSketchClient()
  const root = state.projectRoot
  const [custom, setCustom] = useState<MenuCommand[]>([])
  const [skills, setSkills] = useState<MenuCommand[]>([])

  useEffect(() => {
    let cancelled = false
    if (client.commandsList !== undefined) {
      client
        .commandsList(root !== null ? { root } : {})
        .then((result) => {
          if (!cancelled) setCustom(result.commands.map(customCommand))
        })
        .catch(() => {
          if (!cancelled) setCustom([])
        })
    }
    if (root !== null && client.skillsCatalog !== undefined) {
      client
        .skillsCatalog({ root })
        .then((result) => {
          if (!cancelled) setSkills(result.installed.map((skill) => skillCommand(skill)))
        })
        .catch(() => {
          if (!cancelled) setSkills([])
        })
    } else {
      setSkills([])
    }
    return () => {
      cancelled = true
    }
  }, [client, root])

  return commandMenu(custom, skills)
}
