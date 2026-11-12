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
// (the agent just wrote a file, so the working tree changed), the panel's explicit
// refresh, and — quietly, without a busy state — anything announced through
// editor/diskSync.ts: a terminal command finishing (`git commit` typed by hand), an
// agent run ending, the window coming back to the front. There is still NO TIMER: a
// poll loop would run `git status` forever in the background of a window nobody is
// looking at.
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

import { announceDiskChanged, useDiskChangeSignal } from '../editor/diskSync'
import { useSketchClient, useOptionalSketchEvents } from '../lib/ClientProvider'
import type { GitStatusResult } from '../lib/contracts'
import type { GitBranchesResult, GitCommitSummary } from '../lib/client'
import { resolveApiKeyForRun } from '../lib/secrets'
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
  /** Throw away working-tree edits to tracked files. */
  discard(paths: string[]): Promise<boolean>
  /** Local branches, or null when the transport cannot list them or it failed. */
  branches(): Promise<GitBranchesResult | null>
  switchBranch(name: string, create?: boolean): Promise<boolean>
  /** Push / pull / fetch. Resolves with git's output, or null on failure (see `error`). */
  sync(op: 'push' | 'pull' | 'fetch'): Promise<string | null>
  /** The last commits, newest first. */
  log(limit?: number): Promise<GitCommitSummary[] | null>
  /** A commit message drafted by the connected model, or null (see `error`). */
  suggestMessage(): Promise<string | null>
  /** What the last push/pull/fetch said, for a quiet confirmation line. */
  lastSync: { op: 'push' | 'pull' | 'fetch'; output: string; at: number } | null
}

const GitContext = createContext<GitState | null>(null)

/** Watcher-driven status refreshes, at most this often while files keep changing. */
export const WATCH_REFRESH_MS = 1_500

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

export function GitProvider({ children }: { children: ReactNode }) {
  const client = useSketchClient()
  const events = useOptionalSketchEvents()
  const appState = useAppState()
  const { projectRoot } = appState
  const latestState = useRef(appState)
  latestState.current = appState

  const [status, setStatus] = useState<GitStatusResult | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const [lastSync, setLastSync] = useState<GitState['lastSync']>(null)

  // Which root the held status belongs to. A response that arrives after the user
  // switched projects describes the wrong repository and is dropped.
  const currentRoot = useRef<string | null>(projectRoot)
  currentRoot.current = projectRoot
  /** Bumped by every read or change this provider starts; a background read that is older is dropped. */
  const generation = useRef(0)

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
    generation.current += 1
    setBusy(true)
    try {
      settle(root, await client.gitStatus({ root }))
    } catch (err) {
      fail(root, err)
    } finally {
      setBusy(false)
    }
  }, [client, projectRoot, settle, fail])

  // A look in the background — the window came back, a terminal command finished. No
  // busy state (nothing flickers) and no error banner for a transient failure; the
  // explicit refresh still reports one. Dropped if any other read or change started
  // meanwhile, because that one is newer.
  const quietRefresh = useCallback(async () => {
    const root = currentRoot.current
    if (root === null) return
    const started = generation.current
    try {
      const next = await client.gitStatus({ root })
      if (started !== generation.current) return
      settle(root, next)
    } catch {
      /* the next explicit refresh says what is wrong */
    }
  }, [client, settle])

  // The watcher can report changes several times a second while a build or a formatter
  // writes; `git status` on a large repository is not free. So watcher-only changes
  // refresh at most once per WATCH_REFRESH_MS (the last one always lands); anything
  // else — a terminal command, focus — refreshes at once, as before.
  const throttle = useRef<{ timer: ReturnType<typeof setTimeout> | null; last: number }>({ timer: null, last: 0 })
  useEffect(
    () => () => {
      if (throttle.current.timer !== null) clearTimeout(throttle.current.timer)
    },
    [],
  )
  useDiskChangeSignal(
    (change) => {
      const watcherOnly = change.reasons.size === 1 && change.reasons.has('watcher')
      const t = throttle.current
      if (!watcherOnly) {
        t.last = Date.now()
        void quietRefresh()
        return
      }
      if (t.timer !== null) return
      const wait = Math.max(0, t.last + WATCH_REFRESH_MS - Date.now())
      t.timer = setTimeout(() => {
        t.timer = null
        t.last = Date.now()
        void quietRefresh()
      }, wait)
    },
    { ignore: ['git'] },
  )

  const mutate = useCallback(
    async (action: (root: string) => Promise<GitStatusResult>): Promise<boolean> => {
      const root = projectRoot
      if (root === null) {
        setError('no project folder is open, so there is no repository to act on')
        return false
      }
      generation.current += 1
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
      discard: async (paths) => {
        if (paths.length === 0) return true
        const call = client.gitDiscard
        if (call === undefined) {
          setError('this transport cannot discard changes')
          return false
        }
        const ok = await mutate((root) => call.call(client, { root, paths }))
        // Discarding rewrote those files: open tabs and the Explorer look again.
        if (ok) announceDiskChanged('git')
        return ok
      },
      branches: async () => {
        const root = projectRoot
        const call = client.gitBranches
        if (root === null || call === undefined) return null
        try {
          return await call.call(client, { root })
        } catch (err) {
          fail(root, err)
          return null
        }
      },
      switchBranch: async (name, create) => {
        const call = client.gitSwitch
        if (call === undefined) {
          setError('this transport cannot switch branches')
          return false
        }
        const ok = await mutate((root) => call.call(client, { root, branch: name, ...(create === true ? { create: true } : {}) }))
        // A different branch is different files: every open tab is re-read.
        if (ok) announceDiskChanged('git')
        return ok
      },
      sync: async (op) => {
        const root = projectRoot
        if (root === null) return null
        generation.current += 1
        setBusy(true)
        try {
          let output = ''
          if (op === 'fetch') {
            if (client.gitFetch === undefined) throw new Error('this transport cannot fetch')
            settle(root, await client.gitFetch({ root }))
          } else {
            const call = op === 'push' ? client.gitPush : client.gitPull
            if (call === undefined) throw new Error(`this transport cannot ${op}`)
            const result = await call.call(client, { root })
            settle(root, result.status)
            output = result.output
            // A pull rewrites working-tree files.
            if (op === 'pull') announceDiskChanged('git')
          }
          setLastSync({ op, output, at: Date.now() })
          return output
        } catch (err) {
          fail(root, err)
          return null
        } finally {
          setBusy(false)
        }
      },
      log: async (limit) => {
        const root = projectRoot
        const call = client.gitLog
        if (root === null || call === undefined) return null
        try {
          return (await call.call(client, { root, ...(limit !== undefined ? { limit } : {}) })).commits
        } catch {
          // History is a convenience: a repository with no commits, or a transient
          // failure, simply shows none rather than an alarming error.
          return null
        }
      },
      suggestMessage: async () => {
        const root = projectRoot
        const call = client.gitCommitMessage
        if (root === null) return null
        if (call === undefined) {
          setError('this transport cannot draft a commit message')
          return null
        }
        const snapshot = latestState.current
        const selected = snapshot.providers.find((p) => p.id === snapshot.selectedProvider)
        if (selected === undefined) {
          setError('connect a model first (Settings → Models) to draft commit messages')
          return null
        }
        const provider =
          snapshot.selectedModel !== null && snapshot.selectedModel !== selected.model
            ? { ...selected, model: snapshot.selectedModel }
            : selected
        setBusy(true)
        try {
          // Resolved for this one call and dropped, like a run's key (lib/secrets.ts).
          const apiKey = await resolveApiKeyForRun(provider.id)
          const result = await call.call(client, { root, provider, ...(apiKey !== null ? { apiKey } : {}) })
          if (currentRoot.current !== root) return null
          setError(null)
          return result.message
        } catch (err) {
          fail(root, err)
          return null
        } finally {
          setBusy(false)
        }
      },
      lastSync,
    }),
    [client, projectRoot, status, busy, error, refresh, mutate, fail, settle, lastSync],
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
