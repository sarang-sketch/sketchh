// The terminal — the user's shell, streamed, stoppable, in tabs.
//
// ── WHAT CHANGED, AND WHY ───────────────────────────────────────────────────
//
// This panel used to send each line to the Tauri command `run_command`, which ran the
// program to completion ON THE WINDOW'S MAIN THREAD and returned its output in one
// piece. So the app froze for as long as a command ran (`npm install`: a minute;
// `npm run dev`: forever), nothing appeared until the end, nothing could be stopped,
// and only an allowlist of program names could run, with no shell, no pipes and no `cd`.
//
// Commands now run in the engine (packages/core/src/tools/terminal.ts) through
// `TerminalRunner`: the platform shell, one process per line, output streamed while it
// runs, a Stop button and Ctrl+C, typed input forwarded to a program that is waiting
// for it, `cd` that sticks, several terminals side by side, and ↑/↓ history.
//
// ── CONSENT ─────────────────────────────────────────────────────────────────
//
// The engine still refuses a command without `confirmed: true`. The panel asks before
// the FIRST command in a folder — allow for this session, or always for this folder
// (remembered in terminal/trust.ts) — instead of before every line, which made the old
// terminal unusable. It is not a sandbox and says so: a shell runs whatever it is given.
//
// ── OUTPUT IS TEXT NODES, ALWAYS ────────────────────────────────────────────
//
// Command output is attacker-influenced by nature and the CSP still allows inline
// script, so nothing here sets HTML. `parseAnsi` returns data and every span is a React
// child, which React escapes.

import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'

import { AlertCircle, Check, ChevronDown, Play, Plus, Sparkles, Stop, Trash, X } from '../../components/Icons'
import { ContextMenu, type ContextMenuItem } from '../../components/ContextMenu'
import { openExternal } from '../../components/Markdown'
import { basename, isWithinRoot, relativeToRoot, toAbsolutePath } from '../../editor/paths'
import { useFileActions } from '../../editor/useFileActions'
import { useOptionalAgentSession } from '../../lib/AgentSession'
import { useAppDispatch, useAppState, type TerminalRun } from '../../state/AppState'
import { collapseCarriageReturns, toAnsiLines, type AnsiSpan } from '../../terminal/ansi'
import { terminalLinksOf, type TerminalLinkTarget } from '../../terminal/links'
import { useShellTerminals } from '../../terminal/ShellSessions'
import { useTerminalRunner } from '../../terminal/TerminalRunner'
import { allowFolderForSession, isFolderAllowed, trustFolder } from '../../terminal/trust'
import { ShellTerminalView } from './ShellTerminal'
import styles from './Terminal.module.css'

/** ANSI colour token → a class from this panel's stylesheet. Never inline CSS. */
const ANSI_CLASS: Record<string, string | undefined> = {
  black: styles.ansiBlack,
  red: styles.ansiRed,
  green: styles.ansiGreen,
  yellow: styles.ansiYellow,
  blue: styles.ansiBlue,
  magenta: styles.ansiMagenta,
  cyan: styles.ansiCyan,
  white: styles.ansiWhite,
}

function spanClass(span: AnsiSpan): string {
  const colour = span.color === null ? undefined : ANSI_CLASS[span.color]
  return [colour, span.bold ? styles.ansiBold : undefined].filter(Boolean).join(' ')
}

/** What a click on a link in the output does; the panel supplies it. */
type LinkHandler = (target: TerminalLinkTarget, cwd: string | null) => void

/** One line's spans, with any links in it made clickable. A link may cross two spans. */
function LineSpans({ spans, cwd, onLink }: { spans: AnsiSpan[]; cwd: string | null; onLink?: LinkHandler }) {
  const text = spans.map((span) => span.text).join('')
  const links = onLink === undefined ? [] : terminalLinksOf(text)
  if (links.length === 0) {
    // Each span is a React child: React escapes it. This is the whole defence.
    return (
      <>
        {spans.map((span, spanIndex) => (
          <span key={spanIndex} className={spanClass(span)}>
            {span.text}
          </span>
        ))}
      </>
    )
  }
  const out: ReactNode[] = []
  let offset = 0
  spans.forEach((span, spanIndex) => {
    const spanEnd = offset + span.text.length
    let at = offset
    for (const link of links) {
      if (link.end <= at || link.start >= spanEnd) continue
      if (link.start > at) out.push(<span key={`${spanIndex}:${at}`} className={spanClass(span)}>{text.slice(at, link.start)}</span>)
      const to = Math.min(link.end, spanEnd)
      const target = link.target
      const label = target.kind === 'url' ? `Open ${target.url} in your browser` : `Open ${target.path}${target.line !== undefined ? ` at line ${target.line}` : ''}`
      out.push(
        <span
          key={`${spanIndex}:${Math.max(link.start, at)}:link`}
          className={`${spanClass(span)} ${styles.link}`}
          role="link"
          tabIndex={0}
          title={`${label} (click)`}
          onClick={() => {
            // A drag that selected text is a selection, not a click on the link.
            if ((window.getSelection?.()?.toString() ?? '') !== '') return
            onLink!(target, cwd)
          }}
          onKeyDown={(event) => {
            if (event.key !== 'Enter') return
            event.preventDefault()
            onLink!(target, cwd)
          }}
        >
          {text.slice(Math.max(link.start, at), to)}
        </span>,
      )
      at = to
    }
    if (at < spanEnd) out.push(<span key={`${spanIndex}:${at}`} className={spanClass(span)}>{text.slice(at, spanEnd)}</span>)
    offset = spanEnd
  })
  return <>{out}</>
}

/** One stream, rendered line by line, span by span, as text. Memoised: output only grows. */
const StreamOutput = memo(function StreamOutput({
  text,
  tone,
  cwd = null,
  onLink,
}: {
  text: string
  tone?: 'error'
  cwd?: string | null
  onLink?: LinkHandler
}) {
  const lines = useMemo(() => toAnsiLines(collapseCarriageReturns(text)), [text])
  if (lines.length === 0) return null
  return (
    <>
      {lines.map((spans, index) => (
        <div key={index} className={`${styles.outputLine} ${tone === 'error' ? styles.stderrLine : ''}`}>
          <LineSpans spans={spans} cwd={cwd} onLink={onLink} />
        </div>
      ))}
    </>
  )
})

function formatDuration(ms: number | null | undefined): string {
  if (ms === null || ms === undefined) return ''
  if (ms < 1000) return `${ms} ms`
  const seconds = ms / 1000
  if (seconds < 60) return `${seconds.toFixed(seconds < 10 ? 1 : 0)} s`
  return `${Math.floor(seconds / 60)} min ${Math.round(seconds % 60)} s`
}

export default function Terminal() {
  const state = useAppState()
  const dispatch = useAppDispatch()
  const runner = useTerminalRunner()
  const session = useOptionalAgentSession()
  const shells = useShellTerminals()

  const root = state.projectRoot
  const firstId = state.terminals[0]?.id ?? 'term-1'
  const activeId = state.activeTerminalId
  const tab = state.terminals.find((t) => t.id === activeId) ?? state.terminals[0]
  /** A real shell in a pseudo-terminal (desktop), not the classic one-process-per-line runner. */
  const shellTab = tab?.kind === 'shell' && shells !== null
  const [newMenu, setNewMenu] = useState<{ x: number; y: number } | null>(null)

  const newTerminal = (options: { kind?: 'shell' | 'commands'; profileId?: string | null } = {}) => {
    const profile = options.profileId !== undefined && options.profileId !== null ? shells?.profiles.find((p) => p.id === options.profileId) : undefined
    dispatch({
      type: 'TERMINAL_NEW',
      payload: {
        cwd: tab?.cwd ?? null,
        ...(options.kind !== undefined ? { kind: options.kind } : {}),
        ...(options.profileId !== undefined ? { profileId: options.profileId } : {}),
        ...(profile !== undefined ? { title: profile.name } : {}),
      },
    })
  }

  const newMenuItems: ContextMenuItem[] =
    shells === null
      ? []
      : [
          ...shells.profiles.map((profile, index): ContextMenuItem => ({
            id: `profile:${profile.id}`,
            label: profile.name,
            ...(index === 0 ? { hint: 'default' } : {}),
            run: () => newTerminal({ kind: 'shell', profileId: profile.id }),
          })),
          'separator',
          {
            id: 'classic',
            label: 'Command runner (one process per line)',
            run: () => newTerminal({ kind: 'commands' }),
          },
          { id: 'rescan', label: 'Look for newly installed shells', run: () => void shells.refreshProfiles() },
        ]
  const runs = useMemo(
    () => state.terminalHistory.filter((run) => (run.terminalId ?? firstId) === activeId),
    [activeId, firstId, state.terminalHistory],
  )
  /** The command in the foreground of this tab: input goes to it. */
  const foreground = [...runs].reverse().find((run) => run.status === 'running') ?? null

  const [line, setLine] = useState('')
  const [pending, setPending] = useState<string | null>(null)
  const fileActions = useFileActions()
  const fileActionsRef = useRef(fileActions)
  fileActionsRef.current = fileActions

  // A link in the output: a URL opens in the browser; a file location opens in the
  // editor at its line. Stable per folder, so streaming output stays memoised.
  const openLink = useCallback(
    (target: TerminalLinkTarget, cwd: string | null) => {
      if (target.kind === 'url') {
        void openExternal(target.url)
        return
      }
      if (root === null) return
      const absolute = toAbsolutePath(cwd ?? root, target.path)
      if (!isWithinRoot(root, absolute)) {
        dispatch({
          type: 'SET_EDITOR_NOTICE',
          payload: { level: 'info', message: `${target.path} is outside the open folder, so it cannot be opened here.` },
        })
        return
      }
      dispatch({ type: 'SET_MODE', payload: 'ide' })
      void fileActionsRef.current.openPath(absolute).then(() => {
        if (target.line !== undefined) {
          dispatch({ type: 'REVEAL_IN_EDITOR', payload: { path: absolute, line: target.line, column: target.column ?? 1 } })
        }
      })
    },
    [dispatch, root],
  )
  /** Typed commands per tab, oldest first, for ↑/↓. */
  const historyRef = useRef(new Map<string, string[]>())
  const [historyAt, setHistoryAt] = useState<number | null>(null)
  const inputRef = useRef<HTMLInputElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const stickToBottom = useRef(true)

  // Follow the output, unless the user scrolled up to read something.
  useEffect(() => {
    const body = bodyRef.current
    if (body !== null && stickToBottom.current) body.scrollTop = body.scrollHeight
  }, [runs, pending])

  useEffect(() => {
    setHistoryAt(null)
    setPending(null)
  }, [activeId])

  // Other parts of the window (the Run panel, a "run it" button) can focus the prompt.
  useEffect(() => {
    const focus = () => inputRef.current?.focus()
    window.addEventListener('sketch:focus-terminal', focus)
    return () => window.removeEventListener('sketch:focus-terminal', focus)
  }, [])

  const allowed = isFolderAllowed(root)

  const execute = useCallback(
    (typed: string) => {
      const list = historyRef.current.get(activeId) ?? []
      if (typed.trim() !== '' && list[list.length - 1] !== typed) list.push(typed)
      historyRef.current.set(activeId, list.slice(-200))
      setHistoryAt(null)
      stickToBottom.current = true
      void runner.run(typed, { terminalId: activeId })
    },
    [activeId, runner],
  )

  const submit = (event: React.FormEvent) => {
    event.preventDefault()
    if (root === null) return
    const typed = line
    if (foreground !== null) {
      // A program is waiting: this line is its input, echoed as a terminal would.
      dispatch({ type: 'TERMINAL_RUN_OUTPUT', payload: { id: foreground.id, stdout: `${typed}\n` } })
      void runner.input(foreground.id, `${typed}\n`)
      setLine('')
      return
    }
    if (typed.trim() === '') return
    setLine('')
    if (!allowed && !/^(clear|cls)$/i.test(typed.trim())) {
      setPending(typed)
      return
    }
    execute(typed)
  }

  const onKeyDown = (event: React.KeyboardEvent<HTMLInputElement>) => {
    const ctrl = event.ctrlKey || event.metaKey
    if (ctrl && event.key.toLowerCase() === 'c' && foreground !== null && (event.currentTarget.selectionStart === event.currentTarget.selectionEnd)) {
      event.preventDefault()
      void runner.stop(foreground.id)
      return
    }
    if (ctrl && event.key.toLowerCase() === 'd' && foreground !== null) {
      event.preventDefault()
      void runner.endInput(foreground.id)
      return
    }
    if (ctrl && event.key.toLowerCase() === 'l') {
      event.preventDefault()
      dispatch({ type: 'TERMINAL_CLEARED', payload: activeId })
      return
    }
    if (foreground !== null) return
    const list = historyRef.current.get(activeId) ?? []
    if (event.key === 'ArrowUp' && list.length > 0) {
      event.preventDefault()
      const at = historyAt === null ? list.length - 1 : Math.max(0, historyAt - 1)
      setHistoryAt(at)
      setLine(list[at] ?? '')
    } else if (event.key === 'ArrowDown' && historyAt !== null) {
      event.preventDefault()
      const at = historyAt + 1
      if (at >= list.length) {
        setHistoryAt(null)
        setLine('')
      } else {
        setHistoryAt(at)
        setLine(list[at] ?? '')
      }
    }
  }

  const where = (cwd: string | null | undefined): string => {
    if (root === null) return ''
    const project = basename(root) || root
    if (cwd === null || cwd === undefined || cwd === '') return project
    const rel = relativeToRoot(root, cwd)
    return rel === '' || rel === cwd ? project : `${project}/${rel}`
  }

  /** Hand a failed command to the agent: the line it ran, and the tail of what it printed. */
  const fixWithAgent = (run: TerminalRun) => {
    if (session === null) return
    const tail = (text: string) => {
      const clean = collapseCarriageReturns(text).replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').trimEnd()
      return clean.length > 6000 ? `…${clean.slice(-6000)}` : clean
    }
    const output = [tail(run.stdout), tail(run.stderr)].filter((part) => part !== '').join('\n')
    if (state.rightPanelCollapsed) dispatch({ type: 'TOGGLE_RIGHT_PANEL' })
    session.send(
      `This command failed with exit code ${run.exitCode}:\n\n\`${run.line}\`\n\nOutput:\n\`\`\`\n${output || '(no output)'}\n\`\`\`\n\n` +
        'Find the root cause in the project and fix it, then run the same command again to confirm it passes.',
      { display: `Fix: \`${run.line}\` failed (exit ${run.exitCode})` },
    )
  }

  const renderRun = (run: TerminalRun) => {
    const isCd = run.program.toLowerCase() === 'cd' || run.program.toLowerCase() === 'set-location'
    return (
      <div key={run.id} className={styles.run}>
        <div className={styles.outputLine}>
          <span className={styles.prompt}>{where(run.cwd)}</span> <span className={styles.dollar}>❯</span> {run.line}
        </div>

        <StreamOutput text={run.stdout} cwd={run.cwd ?? null} onLink={openLink} />
        <StreamOutput text={run.stderr} tone="error" cwd={run.cwd ?? null} onLink={openLink} />

        {run.status === 'running' && run.stdout === '' && run.stderr === '' && (
          <div className={`${styles.outputLine} ${styles.muted}`}>Running… (Ctrl+C stops it)</div>
        )}

        {run.status === 'exited' && run.exitCode !== 0 && (
          <div className={`${styles.outputLine} ${styles.error}`} role="alert">
            <AlertCircle size={12} /> Exited with code {run.exitCode}
            {run.durationMs ? ` after ${formatDuration(run.durationMs)}` : ''}.
            {session !== null && (
              <button
                type="button"
                className={styles.fixBtn}
                onClick={() => fixWithAgent(run)}
                disabled={session.activeRunId !== null}
                title="Send this command and its output to the agent and let it fix the cause"
              >
                <Sparkles size={11} /> Fix with Sketch
              </button>
            )}
          </div>
        )}

        {run.status === 'exited' && run.exitCode === 0 && !isCd && (
          <div className={`${styles.outputLine} ${styles.done}`}>
            <Check size={11} /> Done{run.durationMs ? ` in ${formatDuration(run.durationMs)}` : ''}
            {run.stdout.trim() === '' && run.stderr.trim() === '' ? ' — no output.' : '.'}
          </div>
        )}

        {run.status === 'stopped' && (
          <div className={`${styles.outputLine} ${styles.muted}`}>
            <Stop size={10} /> Stopped{run.durationMs ? ` after ${formatDuration(run.durationMs)}` : ''}.
          </div>
        )}

        {run.status === 'denied' && (
          <div className={`${styles.outputLine} ${styles.error}`} role="alert">
            <AlertCircle size={12} /> Not run: {run.message}
          </div>
        )}

        {run.status === 'failed' && (
          <div className={`${styles.outputLine} ${styles.error}`} role="alert">
            <AlertCircle size={12} /> Could not run: {run.message}
          </div>
        )}
      </div>
    )
  }

  return (
    <div className={styles.terminal} onClick={(event) => {
      // A click on the scrollback focuses the prompt, unless the user is selecting text.
      if ((event.target as HTMLElement).closest('button') !== null) return
      if (window.getSelection?.()?.toString()) return
      inputRef.current?.focus()
    }}>
      <div className={styles.header}>
        <div className={styles.tabs} role="tablist" aria-label="Terminals">
          {state.terminals.map((t) => {
            const busy = state.terminalHistory.some((run) => (run.terminalId ?? firstId) === t.id && run.status === 'running')
            return (
              <div key={t.id} className={`${styles.tab} ${t.id === activeId ? styles.active : ''}`} role="tab" aria-selected={t.id === activeId}>
                <button type="button" className={styles.tabLabel} onClick={() => dispatch({ type: 'TERMINAL_SELECT', payload: t.id })}>
                  {busy && <span className={styles.busyDot} aria-label="running" />}
                  {t.title}
                </button>
                {state.terminals.length > 1 && (
                  <button
                    type="button"
                    className={styles.tabClose}
                    aria-label={`Close ${t.title}`}
                    title={busy ? 'Close (stops what is running in it)' : 'Close'}
                    onClick={() => {
                      for (const run of state.terminalHistory) {
                        if ((run.terminalId ?? firstId) === t.id && run.status === 'running') void runner.stop(run.id)
                      }
                      dispatch({ type: 'TERMINAL_CLOSE', payload: t.id })
                    }}
                  >
                    <X size={11} />
                  </button>
                )}
              </div>
            )
          })}
          <button
            type="button"
            className={styles.addBtn}
            onClick={() => newTerminal()}
            title={shells !== null ? `New terminal (${shells.profiles[0]?.name ?? 'default shell'})` : 'New terminal'}
            aria-label="New terminal"
          >
            <Plus size={14} />
          </button>
          {shells !== null && (
            <button
              type="button"
              className={styles.addBtn}
              onClick={(event) => {
                const rect = event.currentTarget.getBoundingClientRect()
                setNewMenu({ x: rect.left, y: rect.bottom + 2 })
              }}
              title="Choose a shell: PowerShell, Command Prompt, Git Bash, WSL…"
              aria-label="Choose a shell for a new terminal"
              aria-haspopup="menu"
            >
              <ChevronDown size={12} />
            </button>
          )}
          {newMenu !== null && (
            <ContextMenu x={newMenu.x} y={newMenu.y} items={newMenuItems} onClose={() => setNewMenu(null)} label="New terminal" />
          )}
        </div>
        <div className={styles.headerRight}>
          {root !== null && <span className={styles.where} title={tab?.cwd ?? root}>{where(tab?.cwd)}</span>}
          {!shellTab && foreground !== null && (
            <button type="button" className={styles.stopBtn} onClick={() => void runner.stop(foreground.id)} title="Stop the running command (Ctrl+C)">
              <Stop size={10} /> Stop
            </button>
          )}
          <button
            type="button"
            className={styles.addBtn}
            onClick={() => {
              if (shellTab) shells.manager.get(activeId)?.clear()
              else dispatch({ type: 'TERMINAL_CLEARED', payload: activeId })
            }}
            disabled={!shellTab && runs.length === 0}
            title="Clear (Ctrl+L)"
            aria-label="Clear the scrollback"
          >
            <Trash size={13} />
          </button>
        </div>
      </div>

      {shellTab && tab !== undefined ? (
        <ShellTerminalView key={tab.id} tab={tab} active />
      ) : (
      <>
      <div
        className={styles.body}
        ref={bodyRef}
        onScroll={(event) => {
          const el = event.currentTarget
          stickToBottom.current = el.scrollHeight - el.scrollTop - el.clientHeight < 24
        }}
      >
        {root === null ? (
          <div className={styles.muted}>No folder is open, so there is nowhere to run a command. Open a folder first.</div>
        ) : !runner.available ? (
          <div className={`${styles.outputLine} ${styles.error}`} role="alert">
            <AlertCircle size={12} /> This window is not connected to the Sketch engine, so commands cannot run.
          </div>
        ) : (
          <>
            {runs.length === 0 && pending === null && (
              <div className={styles.welcome}>
                <div>Your shell, inside <strong>{basename(root) || root}</strong>. Try <code>npm install</code>, <code>git status</code> or <code>python app.py</code>.</div>
                <div className={styles.muted}>Ctrl+C stops · ↑/↓ history · Ctrl+L clears · Ctrl+` shows or hides this panel</div>
              </div>
            )}

            {runs.map(renderRun)}

            {pending !== null && (
              <div className={styles.confirm} role="alertdialog" aria-label="Allow commands in this folder">
                <div className={styles.confirmText}>
                  Run <span className={styles.confirmCommand}>{pending}</span> in {basename(root) || root}?
                </div>
                <div className={styles.confirmNote}>
                  Commands run in your shell with your permissions, like any terminal. Sketch asks once per folder.
                </div>
                <div className={styles.confirmActions}>
                  <button
                    type="button"
                    className={styles.runBtn}
                    autoFocus
                    onClick={() => {
                      trustFolder(root)
                      const typed = pending
                      setPending(null)
                      execute(typed)
                    }}
                  >
                    <Play size={12} /> Always allow in this folder
                  </button>
                  <button
                    type="button"
                    className={styles.cancelBtn}
                    onClick={() => {
                      allowFolderForSession(root)
                      const typed = pending
                      setPending(null)
                      execute(typed)
                    }}
                  >
                    Allow until I restart
                  </button>
                  <button type="button" className={styles.cancelBtn} onClick={() => setPending(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <form className={styles.inputLine} onSubmit={submit}>
        {root !== null && <span className={styles.prompt}>{foreground !== null ? 'input' : where(tab?.cwd)}</span>}
        <span className={styles.dollar}>{foreground !== null ? '›' : '❯'}</span>
        <input
          ref={inputRef}
          className={styles.input}
          data-terminal-input
          value={line}
          onChange={(event) => setLine(event.target.value)}
          onKeyDown={onKeyDown}
          disabled={root === null || !runner.available || pending !== null}
          placeholder={
            root === null
              ? 'Open a folder to run a command'
              : pending !== null
                ? 'Answer the question above'
                : foreground !== null
                  ? 'The command is running — type input for it and press Enter, or Ctrl+C to stop'
                  : 'Type a command, e.g. npm test'
          }
          aria-label={foreground !== null ? 'Input for the running command' : 'Command to run'}
          spellCheck={false}
          autoComplete="off"
        />
      </form>
      </>
      )}
    </div>
  )
}
