// The single owner of git working-tree state for the whole window.
//
// ── WHY THIS IS A PROVIDER AND NOT A HOOK PER PANEL ─────────────────────────
//
// Two surfaces read the same thing: the Git panel lists the changes, and the status
// bar shows the branch. A hook called in both places would poll twice and could show
// two different branches in one window — the same "two independent caches" mistake
// the editor's single file-state owner exists to avoid (Requirement 15.2, applied
// here by analogy). So there is one fetch, one result, and one error.
//
// ── WHAT REFRESHES IT ───────────────────────────────────────────────────────
//
// Opening a project, a mutation this provider performed (each returns a fresh
// status, so no re-read is needed), an `edit_accepted` on the engine's event stream
// (the agent just wrote a file, so the working tree changed), and the panel's
// explicit refresh. There is NO TIMER: a poll loop would append nothing to what the
// event stream already says and would run `git status` forever in the background of
// a window nobody is looking at.
//
// A FAILURE IS STATE, NOT AN EXCEPTION. `git` missing from PATH, a root the backend
// refuses, a dead sidecar: each arrives here as `error` carrying the engine's own
// sentence, and the panel names it (Requirement 27.5).
//
// Validates: Requirements 14.6, 27.1, 27.3, 27.5

import {
  createContext,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'

import { useSketchClient, useOptionalSketchEvents } from '../lib/ClientProvider'
import type { GitStatusResult } from '../lib/contracts'
import { useAppState } from '../state/AppState'

export interface GitState {
  /** The repository this state describes, or null when no project is open. */
  root: string | null
  /** The last successful status, or null before the first one arrives. */
  status: GitStatusResult | null
  /** True while a read or a mutation is in flight. */
  busy: boolean
  /** The last failure, in the engine's words. Cleared by the next success. */
  error: string | null
  refresh(): Promise<void>
  stage(paths: string[]): Promise<void>
  unstage(paths: string[]): Promise<void>
  /** Resolves true when the commit was made. */
  commit(message: string): Promise<boolean>
  /** A unified diff for one path. Rejects nothing: a failure lands in `error`. */
  diff(params: { path?: string; staged?: boolean }): Promise<string | null>
}

const GitContext = createContext<GitState | null>(null)

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function GitProvider({ children }: { children: ReactNode }) {
  const client = useSketchClient()
  const events = useOptionalSketchEvents()
  const { projectRoot } = useAppState()

  const [status, setStatus] = useState<GitStatusResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  // Which root the held status belongs to. A response that arrives after the user
  // switched projects describes the wrong repository and is dropped.
  const currentRoot = useRef<string | null>(projectRoot)
  currentRoot.current = projectRoot

  const settle = useCallback((root: string, next: GitStatusResult) => {
    if (currentRoot.current !== root) return
    setStatus(next)
    setError(null)
  }, [])

  const fail = useCallback((root: string, err: unknown) => {
    if (currentRoot.current !== root) return
    setError(messageOf(err))
  }, [])

  const refresh = useCallback(async () => {
    const root = projectRoot
    if (root === null) {
      setStatus(null)
      setError(null)
      return
    }
    setBusy(true)
    try {
      settle(root, await client.gitStatus({ root }))
    } catch (err) {
      fail(root, err)
    } finally {
      setBusy(false)
    }
  }, [client, projectRoot, settle, fail])

  const mutate = useCallback(
    async (action: (root: string) => Promise<GitStatusResult>): Promise<boolean> => {
      const root = projectRoot
      if (root === null) {
        setError('no project folder is open, so there is no repository to act on')
        return false
      }
      setBusy(true)
      try {
        settle(root, await action(root))
        return true
      } catch (err) {
        fail(root, err)
        return false
      } finally {
        setBusy(false)
      }
    },
    [projectRoot, settle, fail],
  )

  // Opening or switching a project reads the new repository, and clears the old
  // one's rows first so nothing from the previous project lingers on screen.
  useEffect(() => {
    setStatus(null)
    setError(null)
    void refresh()
  }, [refresh])

  // The engine wrote a file: the working tree changed under us. Keyed on the count
  // so only a NEW acceptance triggers a read.
  const accepted = events.filter((event) => event.kind === 'edit_accepted').length
  const seenAccepted = useRef(accepted)
  useEffect(() => {
    if (accepted === seenAccepted.current) return
    seenAccepted.current = accepted
    void refresh()
  }, [accepted, refresh])

  const value = useMemo<GitState>(
    () => ({
      root: projectRoot,
      status,
      busy,
      error,
      refresh,
      stage: async (paths) => {
        if (paths.length === 0) return
        await mutate((root) => client.gitStage({ root, paths }))
      },
      unstage: async (paths) => {
        if (paths.length === 0) return
        await mutate((root) => client.gitUnstage({ root, paths }))
      },
      commit: async (message) =>
        mutate(async (root) => (await client.gitCommit({ root, message })).status),
      diff: async ({ path, staged }) => {
        const root = projectRoot
        if (root === null) return null
        try {
          const text = await client.gitDiff({
            root,
            ...(path !== undefined ? { path } : {}),
            ...(staged === true ? { staged: true } : {}),
          })
          if (currentRoot.current !== root) return null
          setError(null)
          return text
        } catch (err) {
          fail(root, err)
          return null
        }
      },
    }),
    [client, projectRoot, status, busy, error, refresh, mutate, fail],
  )

  return <GitContext.Provider value={value}>{children}</GitContext.Provider>
}

/** The git state. Throws outside the provider, because a panel without it is a bug. */
export function useGit(): GitState {
  const ctx = useContext(GitContext)
  if (!ctx) throw new Error('useGit must be used inside <GitProvider>')
  return ctx
}

/**
 * The git state when there is a provider, null when there is not.
 *
 * For a component that MENTIONS the branch rather than existing to show it — the
 * status bar. It stays usable in a tree with no git owner attached and simply says
 * nothing, while `useGit` keeps throwing for the panel whose whole job this is.
 */
export function useOptionalGit(): GitState | null {
  return useContext(GitContext)
}
