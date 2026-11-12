// The terminal's process owner for the window.
//
// Commands run in the ENGINE (packages/core/src/tools/terminal.ts). This provider starts
// them, polls their output into `AppState.terminalHistory`, stops them and types into
// them. It sits at the top of the app rather than inside the terminal panel, so a dev
// server keeps streaming while the bottom panel is closed, and the Run panel and the
// agent's "run it" buttons start commands the same way the prompt does.
//
// Polling, not push: one `term-read` per running command every POLL_MS. Over the local
// stdio pipe that costs microseconds, it needs nothing new on either transport, and a
// read that arrives late loses nothing — the engine keeps the output by sequence number.

import { createContext, useCallback, useContext, useEffect, useMemo, useRef, type ReactNode } from 'react'

import { announceDiskChanged } from '../editor/diskSync'
import { useSketchClient } from '../lib/ClientProvider'
import { useAppDispatch, useAppState, type AppState, type TerminalRun } from '../state/AppState'

export const POLL_MS = 100

/**
 * While a command runs and prints, the window looks at the disk again at most this often
 * (open tabs, the Explorer, Source Control). Printing is the signal: a watcher that
 * rebuilt or a generator that wrote files says so on its output.
 */
export const LIVE_DISK_CHECK_MS = 2_500

export interface RunOptions {
  /** The tab to run in. Defaults to the active one. */
  terminalId?: string
  /** Show the bottom panel on the terminal (default true). */
  reveal?: boolean
}

export interface TerminalRunner {
  /** False when this transport has no engine terminal (the mock client). */
  readonly available: boolean
  /** Run one line. `clear`/`cls` clears the tab instead. Never throws. */
  run(line: string, options?: RunOptions): Promise<void>
  stop(runId: string): Promise<void>
  /** Type into a running command. A newline is NOT added. */
  input(runId: string, text: string): Promise<void>
  /** Close a running command's input (Ctrl+D). */
  endInput(runId: string): Promise<void>
}

const RunnerContext = createContext<TerminalRunner | null>(null)

export function useTerminalRunner(): TerminalRunner {
  const runner = useContext(RunnerContext)
  if (runner === null) throw new Error('useTerminalRunner must be used within a TerminalRunnerProvider')
  return runner
}

export function useOptionalTerminalRunner(): TerminalRunner | null {
  return useContext(RunnerContext)
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

let counter = 0
function nextRunId(): string {
  counter += 1
  return `run-${counter}-${Date.now()}`
}

interface Watched {
  sessionId: string
  since: number
  stopping: boolean
}

export function TerminalRunnerProvider({ children }: { children: ReactNode }) {
  const client = useSketchClient()
  const state = useAppState()
  const dispatch = useAppDispatch()
  const latest = useRef<AppState>(state)
  latest.current = state

  /** Running commands being polled, by run id. */
  const watched = useRef(new Map<string, Watched>())
  const polling = useRef(false)
  /** When output from a running command last made the window look at the disk again. */
  const lastLiveCheck = useRef(0)
  const available = typeof client.termStart === 'function' && typeof client.termRead === 'function'

  const settle = useCallback(
    (id: string, outcome: { status: 'exited' | 'denied' | 'failed' | 'stopped'; exitCode?: number | null; message?: string | null; durationMs?: number | null }) => {
      // Only a command that actually ran can have changed files: a refusal or a `cd` did not.
      const ran = watched.current.delete(id)
      dispatch({ type: 'TERMINAL_RUN_SETTLED', payload: { id, ...outcome } })
      // A formatter, `git checkout`, a code generator: open tabs, the Explorer and
      // Source Control look at the disk again (editor/diskSync.ts).
      if (ran) announceDiskChanged('terminal')
    },
    [dispatch],
  )

  const pollOnce = useCallback(async () => {
    if (polling.current || watched.current.size === 0 || client.termRead === undefined) return
    polling.current = true
    try {
      await Promise.all(
        [...watched.current.entries()].map(async ([id, watch]) => {
          try {
            const read = await client.termRead!({ id: watch.sessionId, since: watch.since })
            const current = watched.current.get(id)
            if (current === undefined) return
            current.since = read.next
            let stdout = ''
            let stderr = ''
            for (const chunk of read.chunks) {
              if (chunk.stream === 'stderr') stderr += chunk.text
              else stdout += chunk.text
            }
            if (stdout !== '' || stderr !== '') {
              dispatch({
                type: 'TERMINAL_RUN_OUTPUT',
                payload: { id, ...(stdout !== '' ? { stdout } : {}), ...(stderr !== '' ? { stderr } : {}) },
              })
              // A command that keeps running and keeps printing — a dev server rebuilding,
              // `tsc --watch`, a code generator — may be writing files as it goes. Look
              // again while it runs, not only when it ends; at most every LIVE_DISK_CHECK_MS.
              const now = Date.now()
              if (read.running && now - lastLiveCheck.current >= LIVE_DISK_CHECK_MS) {
                lastLiveCheck.current = now
                announceDiskChanged('terminal')
              }
            }
            if (!read.running) {
              if (read.error !== null) {
                settle(id, { status: 'failed', message: read.error, durationMs: read.durationMs })
              } else if (current.stopping) {
                settle(id, { status: 'stopped', exitCode: read.exitCode, durationMs: read.durationMs })
              } else {
                settle(id, { status: 'exited', exitCode: read.exitCode ?? (read.signal !== null ? 1 : 0), durationMs: read.durationMs })
              }
            }
          } catch (err) {
            // The engine restarted or forgot the session: the command is gone with it.
            settle(id, { status: 'failed', message: `lost track of this command: ${messageOf(err)}` })
          }
        }),
      )
    } finally {
      polling.current = false
    }
  }, [client, dispatch, settle])

  useEffect(() => {
    const timer = setInterval(() => void pollOnce(), POLL_MS)
    return () => clearInterval(timer)
  }, [pollOnce])

  const run = useCallback(
    async (line: string, options: RunOptions = {}) => {
      const snapshot = latest.current
      const terminalId = options.terminalId ?? snapshot.activeTerminalId
      // A tab dispatched in the same tick is not in the snapshot yet: it is new, so it
      // starts at the project root.
      const tab = snapshot.terminals.find((t) => t.id === terminalId) ?? (options.terminalId === undefined ? snapshot.terminals[0] : undefined)
      const tabId = tab?.id ?? terminalId
      if (options.reveal !== false) dispatch({ type: 'SHOW_BOTTOM_PANEL', payload: 'terminal' })

      const trimmed = line.trim()
      if (trimmed === '') return
      if (/^(clear|cls|clear-host)$/i.test(trimmed)) {
        dispatch({ type: 'TERMINAL_CLEARED', payload: tabId })
        return
      }

      const id = nextRunId()
      const root = snapshot.projectRoot
      const base: TerminalRun = {
        id,
        line,
        program: trimmed.split(/\s+/)[0] ?? '',
        args: [],
        status: 'running',
        exitCode: null,
        stdout: '',
        stderr: '',
        message: null,
        terminalId: tabId,
        cwd: tab?.cwd ?? root,
        sessionId: null,
        durationMs: null,
      }
      dispatch({ type: 'TERMINAL_RUN_STARTED', payload: base })

      if (root === null) {
        settle(id, { status: 'denied', message: 'No folder is open. Open a project folder first.' })
        return
      }
      if (!available || client.termStart === undefined) {
        settle(id, { status: 'failed', message: `the ${client.transport} transport has no terminal behind it` })
        return
      }

      try {
        const started = await client.termStart({
          root,
          line,
          confirmed: true,
          ...(tab?.cwd ? { cwd: tab.cwd } : {}),
        })
        if (started.kind === 'cd') {
          const atRoot = started.cwd.replace(/\\/g, '/').toLowerCase() === root.replace(/\\/g, '/').toLowerCase()
          dispatch({ type: 'TERMINAL_CD', payload: { terminalId: tabId, cwd: atRoot ? null : started.cwd } })
          settle(id, { status: 'exited', exitCode: 0, durationMs: 0 })
          return
        }
        watched.current.set(id, { sessionId: started.id, since: 0, stopping: false })
        dispatch({ type: 'TERMINAL_RUN_SESSION', payload: { id, sessionId: started.id, cwd: started.cwd } })
      } catch (err) {
        settle(id, { status: 'denied', message: messageOf(err) })
      }
    },
    [available, client, dispatch, settle],
  )

  const stop = useCallback(
    async (runId: string) => {
      const watch = watched.current.get(runId)
      if (watch === undefined || client.termKill === undefined) return
      watch.stopping = true
      try {
        await client.termKill({ id: watch.sessionId })
      } catch (err) {
        dispatch({ type: 'TERMINAL_RUN_OUTPUT', payload: { id: runId, stderr: `\nCould not stop it: ${messageOf(err)}\n` } })
      }
    },
    [client, dispatch],
  )

  const input = useCallback(
    async (runId: string, text: string) => {
      const watch = watched.current.get(runId)
      if (watch === undefined || client.termWrite === undefined) return
      try {
        await client.termWrite({ id: watch.sessionId, data: text })
      } catch (err) {
        dispatch({ type: 'TERMINAL_RUN_OUTPUT', payload: { id: runId, stderr: `\n${messageOf(err)}\n` } })
      }
    },
    [client, dispatch],
  )

  const endInput = useCallback(
    async (runId: string) => {
      const watch = watched.current.get(runId)
      if (watch === undefined || client.termWrite === undefined) return
      try {
        await client.termWrite({ id: watch.sessionId, end: true })
      } catch {
        /* already closed */
      }
    },
    [client],
  )

  const value = useMemo<TerminalRunner>(() => ({ available, run, stop, input, endInput }), [available, run, stop, input, endInput])
  return <RunnerContext.Provider value={value}>{children}</RunnerContext.Provider>
}
