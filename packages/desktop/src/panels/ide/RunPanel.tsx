// Run — the project's own scripts, one click each.
//
// This used to be a "Debugger is not implemented yet" notice. It now lists what the
// project declares it can run — package.json scripts (with the right package manager),
// Makefile targets, and the conventional entry points of Python, Rust and Go projects —
// and runs each in its own terminal tab, where its output streams and Stop ends it.
//
// Debugging with breakpoints is not part of this build, and the panel says so instead of
// drawing a call stack with nothing behind it.

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { AlertCircle, Info, Play, Refresh, Stop } from '../../components/Icons'
import { useFileIo } from '../../editor/FileIoProvider'
import { listForExplorer, readForEditor } from '../../editor/fileIo'
import { detectScripts, type RunScript } from '../../run/scripts'
import { useAppDispatch, useAppState } from '../../state/AppState'
import { useTerminalRunner } from '../../terminal/TerminalRunner'
import styles from './RunPanel.module.css'

/** A Stop this soon after the same script's Run is the second click of a double-click. */
export const RUN_DOUBLE_CLICK_MS = 500

type Load =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'error'; message: string }
  | { status: 'ready'; scripts: RunScript[] }

const GROUP_LABEL: Record<RunScript['group'], string> = {
  setup: 'Setup',
  package: 'Scripts (package.json)',
  make: 'Make targets',
  python: 'Python',
  rust: 'Rust',
  go: 'Go',
}

export default function RunPanel() {
  const state = useAppState()
  const dispatch = useAppDispatch()
  const io = useFileIo()
  const runner = useTerminalRunner()
  const root = state.projectRoot
  const [load, setLoad] = useState<Load>({ status: 'idle' })
  const [nonce, setNonce] = useState(0)

  useEffect(() => {
    if (root === null) {
      setLoad({ status: 'idle' })
      return
    }
    let cancelled = false
    setLoad({ status: 'loading' })
    void (async () => {
      const listing = await listForExplorer(io, root, root)
      if (cancelled) return
      if (!listing.ok) {
        setLoad({ status: 'error', message: listing.message })
        return
      }
      const names = listing.entries.map((e) => e.name)
      const read = async (name: string) => {
        if (!names.some((n) => n.toLowerCase() === name.toLowerCase())) return null
        const outcome = await readForEditor(io, root, `${root}/${name}`)
        return outcome.ok ? outcome.content : null
      }
      const [packageJson, makefile] = await Promise.all([read('package.json'), read('Makefile')])
      if (cancelled) return
      setLoad({ status: 'ready', scripts: detectScripts({ names, packageJson, makefile }) })
    })()
    return () => {
      cancelled = true
    }
  }, [io, nonce, root])

  /** A script's terminal tab, and its running command if it has one. */
  const running = useMemo(() => {
    const map = new Map<string, string>()
    for (const run of state.terminalHistory) {
      if (run.status === 'running' && run.terminalId?.startsWith('run:')) map.set(run.terminalId, run.id)
    }
    return map
  }, [state.terminalHistory])

  // When each script was last started here. Stop replaces Run in the same place, so the
  // second click of a double-click on Run lands on Stop; this tells the two apart.
  const startedAt = useRef(new Map<string, number>())

  const start = useCallback(
    (script: RunScript) => {
      const terminalId = `run:${script.id}`
      if (!state.terminals.some((t) => t.id === terminalId)) {
        // The classic runner: a script's tab shows its exit status and has a Stop button,
        // which a free-form shell cannot report per command.
        dispatch({ type: 'TERMINAL_NEW', payload: { id: terminalId, title: script.label, kind: 'commands' } })
      } else {
        dispatch({ type: 'TERMINAL_SELECT', payload: terminalId })
      }
      startedAt.current.set(script.id, Date.now())
      // An explicit click on a named script is the user asking for exactly that command.
      void runner.run(script.command, { terminalId })
    },
    [dispatch, runner, state.terminals],
  )

  const stop = (script: RunScript, runId: string) => {
    if (Date.now() - (startedAt.current.get(script.id) ?? 0) < RUN_DOUBLE_CLICK_MS) return
    void runner.stop(runId)
  }

  if (root === null) {
    return <div className={styles.empty}>Open a folder to see what it can run.</div>
  }

  const groups = load.status === 'ready'
    ? (Object.keys(GROUP_LABEL) as Array<RunScript['group']>)
        .map((group) => ({ group, scripts: load.scripts.filter((s) => s.group === group) }))
        .filter((g) => g.scripts.length > 0)
    : []

  return (
    <div className={styles.panel}>
      <div className={styles.toolbar}>
        <span className={styles.hint}>Runs in the terminal, one tab per script.</span>
        <button className={styles.iconBtn} onClick={() => setNonce((n) => n + 1)} title="Look for scripts again" aria-label="Refresh scripts">
          <Refresh size={13} />
        </button>
      </div>

      {load.status === 'loading' && <div className={styles.empty}>Reading the project…</div>}
      {load.status === 'error' && (
        <div className={`${styles.empty} ${styles.error}`} role="alert">
          <AlertCircle size={13} /> {load.message}
        </div>
      )}
      {load.status === 'ready' && groups.length === 0 && (
        <div className={styles.empty}>
          No scripts found. Add a <code>scripts</code> section to package.json or a Makefile, or run a command in the terminal.
        </div>
      )}

      {groups.map(({ group, scripts }) => (
        <div key={group} className={styles.group}>
          <div className={styles.groupTitle}>{GROUP_LABEL[group]}</div>
          {scripts.map((script) => {
            const runId = running.get(`run:${script.id}`)
            return (
              <div key={script.id} className={`${styles.script} ${script.primary ? styles.primary : ''}`}>
                <div className={styles.scriptText}>
                  <span className={styles.label}>{script.label}</span>
                  <span className={styles.command} title={script.source}>{script.command}</span>
                </div>
                {runId !== undefined ? (
                  <button className={styles.stopBtn} onClick={() => stop(script, runId)} title={`Stop ${script.label}`} aria-label={`Stop ${script.label}`}>
                    <Stop size={11} /> Stop
                  </button>
                ) : (
                  <button className={styles.runBtn} onClick={() => start(script)} title={`Run: ${script.command}`} aria-label={`Run ${script.label}`}>
                    <Play size={11} /> Run
                  </button>
                )}
              </div>
            )
          })}
        </div>
      ))}

      <div className={styles.note}>
        <Info size={12} /> Breakpoint debugging is not available in this build. To debug, start your program with its
        debugger from the terminal (for example <code>node --inspect app.js</code> or <code>python -m pdb app.py</code>).
      </div>
    </div>
  )
}
