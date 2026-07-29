// The terminal — a real input, real processes, real output.
//
// WHAT THIS REPLACED: forty lines of static markup pretending to be an `npm install`
// that had already succeeded, complete with `[1/4] Resolving packages...`, a
// `success Saved lockfile.` line, a hardcoded `saran@sketch` prompt, a second tab
// labelled `Terminal 2` that did nothing, and a blinking div where a caret would be.
// There was no input element at all: the panel could not accept a keystroke, let
// alone run anything.
//
// ── HOW A COMMAND ACTUALLY RUNS ─────────────────────────────────────────────
//
//   1. `parseCommandLine` splits the line into a program and an argument VECTOR.
//      There is no shell, so nothing is re-parsed downstream; a line containing
//      shell syntax is refused with a sentence saying so.
//   2. `programGate` mirrors the backend allowlist — fetched from `allowed_programs`,
//      never hardcoded here — so a refusal is explained before anything is spawned.
//   3. The panel ASKS. `run_command` requires `confirmed: true` and refuses without
//      it, and this is the prompt that earns it (Requirement 22.6).
//   4. `run_command` starts the program with a cwd the backend contains inside the
//      open project. Nothing about that containment is re-implemented here.
//
// ── THIS IS NOT A SANDBOX, AND THE UI SAYS SO ───────────────────────────────
//
// `node`, `python`, `npm` and `cargo` all run arbitrary code by design: `node -e` is
// a complete escape hatch, and always was. The real boundaries are the confirmation
// prompt, the contained working directory and the absence of a shell. The allowlist
// stops a typo, not an attacker. The header says that rather than implying a
// guarantee this layer cannot provide (NEED-TO-DO §4.3).
//
// ── OUTPUT IS TEXT NODES, ALWAYS ────────────────────────────────────────────
//
// This is the highest-risk render in the application: the CSP still carries
// `script-src 'unsafe-inline'`, and command output is attacker-influenced by nature
// — a dependency's warning, a test name, a compiler diagnostic quoting source. So
// there is NO `dangerouslySetInnerHTML` here, not even for colour. `parseAnsi`
// returns DATA (`{ text, color, bold }`) and each span is rendered as a React child,
// which escapes it. `ansi.test.ts` asserts the parser cannot emit a tag, and
// `Terminal.test.tsx` asserts markup in real stdout reaches the DOM as text.
//
// ── HONEST STATES ───────────────────────────────────────────────────────────
//
//   no project open      nothing to run a command in; the input is disabled
//   nothing run yet      said plainly, instead of somebody else's npm transcript
//   exited non-zero      the code, with stderr
//   denied by policy     the refusal, in the backend's own words
//   failed to start      named as a failure, which is a different thing
//
// Validates: Requirements 14.6, 22.6, 27.1, 27.3, 27.4, 27.5

import { useCallback, useEffect, useRef, useState } from 'react'

import { AlertCircle, Play, Plus, X } from '../../components/Icons'
import { basename } from '../../editor/paths'
import {
  useAppDispatch,
  useAppState,
  type TerminalRun,
} from '../../state/AppState'
import { toAnsiLines, type AnsiSpan } from '../../terminal/ansi'
import {
  classifyRunFailure,
  formatCommand,
  parseCommandLine,
  programGate,
  type ParsedCommand,
} from '../../terminal/commandLine'
import { useCommandIo } from '../../terminal/CommandIoProvider'
import styles from './Terminal.module.css'

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

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

/** One stream, rendered line by line, span by span, as text. */
function StreamOutput({ text, tone }: { text: string; tone?: 'error' }) {
  const lines = toAnsiLines(text)
  if (lines.length === 0) return null
  return (
    <>
      {lines.map((spans, index) => (
        <div
          key={index}
          className={`${styles.outputLine} ${tone === 'error' ? styles.stderrLine : ''}`}
        >
          {/* Each span is a React child: React escapes it. This is the whole
              defence, and it is why no branch of this component sets HTML. */}
          {spans.map((span, spanIndex) => (
            <span key={spanIndex} className={spanClass(span)}>
              {span.text}
            </span>
          ))}
        </div>
      ))}
    </>
  )
}

export default function Terminal() {
  const state = useAppState()
  const dispatch = useAppDispatch()
  const io = useCommandIo()

  const root = state.projectRoot
  const history = state.terminalHistory

  const [line, setLine] = useState('')
  /** The command awaiting confirmation. Nothing is spawned while this is null. */
  const [pending, setPending] = useState<{ line: string; command: ParsedCommand } | null>(null)
  const [busy, setBusy] = useState(false)
  const [allowed, setAllowed] = useState<string[]>([])
  const [allowlistError, setAllowlistError] = useState<string | null>(null)

  const mounted = useRef(true)
  useEffect(() => () => { mounted.current = false }, [])

  // Monotonic, so two commands typed in the same millisecond still get distinct ids.
  const runCounter = useRef(0)
  const nextId = () => {
    runCounter.current += 1
    return `run-${runCounter.current}-${Date.now()}`
  }

  // The allowlist comes from the backend so this panel cannot drift from what Rust
  // permits. A failure here is reported, not defaulted: guessing a list would make
  // the mirror lie in the one direction that matters.
  useEffect(() => {
    void io
      .allowedPrograms()
      .then((programs) => {
        if (!mounted.current) return
        setAllowed(programs)
        setAllowlistError(null)
      })
      .catch((err: unknown) => {
        if (!mounted.current) return
        setAllowed([])
        setAllowlistError(messageOf(err))
      })
  }, [io])

  const bodyRef = useRef<HTMLDivElement | null>(null)
  useEffect(() => {
    const body = bodyRef.current
    if (body !== null) body.scrollTop = body.scrollHeight
  }, [history, pending])

  /** Record a command that never ran, so the transcript still shows the attempt. */
  const recordRefusal = useCallback(
    (typed: string, command: ParsedCommand | null, message: string) => {
      const run: TerminalRun = {
        id: nextId(),
        line: typed,
        program: command?.program ?? '',
        args: command?.args ?? [],
        status: 'denied',
        exitCode: null,
        stdout: '',
        stderr: '',
        message,
      }
      dispatch({ type: 'TERMINAL_RUN_STARTED', payload: run })
    },
    [dispatch],
  )

  const submit = useCallback(
    (event: React.FormEvent) => {
      event.preventDefault()
      if (root === null || busy || pending !== null) return

      const parsed = parseCommandLine(line)
      if (!parsed.ok) {
        // A blank line is not an error; anything else refused at this stage is.
        if (parsed.empty === true) return
        recordRefusal(line, null, parsed.message)
        setLine('')
        return
      }

      const gate = programGate(parsed.command.program, allowed)
      if (!gate.ok) {
        recordRefusal(line, parsed.command, gate.reason)
        setLine('')
        return
      }

      // Confirmation is a step the user takes, not a flag this panel sets on its
      // own behalf. Nothing is spawned until `confirm` below.
      setPending({ line, command: parsed.command })
    },
    [allowed, busy, line, pending, recordRefusal, root],
  )

  const confirm = useCallback(async () => {
    if (root === null || pending === null) return
    const { command, line: typed } = pending
    const id = nextId()

    dispatch({
      type: 'TERMINAL_RUN_STARTED',
      payload: {
        id,
        line: typed,
        program: command.program,
        args: command.args,
        status: 'running',
        exitCode: null,
        stdout: '',
        stderr: '',
        message: null,
      },
    })
    setPending(null)
    setLine('')
    setBusy(true)

    try {
      const output = await io.run({
        projectRoot: root,
        // The project root itself. There is no `cd`, and `programGate` says so.
        cwd: '',
        program: command.program,
        args: command.args,
        confirmed: true,
      })
      // Dispatched whether or not this panel is still mounted: the run happened, and
      // the transcript belongs to the window, not to this component's lifetime.
      dispatch({
        type: 'TERMINAL_RUN_SETTLED',
        payload: {
          id,
          status: 'exited',
          exitCode: output.exitCode,
          stdout: output.stdout,
          stderr: output.stderr,
        },
      })
    } catch (err) {
      const message = messageOf(err)
      dispatch({
        type: 'TERMINAL_RUN_SETTLED',
        payload: { id, status: classifyRunFailure(message), message },
      })
    } finally {
      if (mounted.current) setBusy(false)
    }
  }, [dispatch, io, pending, root])

  const promptName = root === null ? '' : basename(root) || root

  const renderRun = (run: TerminalRun) => (
    <div key={run.id} className={styles.run}>
      <div className={styles.outputLine}>
        <span className={styles.prompt}>{promptName}</span>{' '}
        <span className={styles.dollar}>$</span> {run.line}
      </div>

      <StreamOutput text={run.stdout} />
      <StreamOutput text={run.stderr} tone="error" />

      {run.status === 'running' && (
        <div className={`${styles.outputLine} ${styles.muted}`}>Running…</div>
      )}

      {run.status === 'exited' && run.exitCode !== 0 && (
        <div className={`${styles.outputLine} ${styles.error}`} role="alert">
          <AlertCircle size={12} /> Exited with code {run.exitCode}.
        </div>
      )}

      {run.status === 'exited' &&
        run.exitCode === 0 &&
        run.stdout.trim() === '' &&
        run.stderr.trim() === '' && (
          <div className={`${styles.outputLine} ${styles.muted}`}>
            Exited with code 0 and printed nothing.
          </div>
        )}

      {run.status === 'denied' && (
        <div className={`${styles.outputLine} ${styles.error}`} role="alert">
          <AlertCircle size={12} /> Not run: {run.message}
        </div>
      )}

      {run.status === 'failed' && (
        <div className={`${styles.outputLine} ${styles.error}`} role="alert">
          <AlertCircle size={12} /> Could not start: {run.message}
        </div>
      )}
    </div>
  )

  return (
    <div className={styles.terminal}>
      <div className={styles.header}>
        <div className={styles.tabs}>
          <div className={`${styles.tab} ${styles.active}`}>Terminal</div>
          {/* Kept, and disabled: a second session is not implemented, and a tab
              that silently shows the same output is what this panel used to do. */}
          <button
            className={styles.addBtn}
            disabled
            title="A second terminal session is not implemented yet"
            aria-label="A second terminal session is not implemented yet"
          >
            <Plus size={14} />
          </button>
        </div>
        <div className={styles.headerRight}>
          <span
            className={styles.notSandbox}
            title="Programs come from an allowlist and run with a working directory inside the open project, with no shell. That stops a mistyped program name — it does not sandbox anything: node, python, npm and cargo all run arbitrary code by design."
          >
            allowlisted, no shell — not a sandbox
          </span>
          <button
            className={styles.addBtn}
            onClick={() => dispatch({ type: 'TERMINAL_CLEARED' })}
            disabled={history.length === 0}
            title="Clear the scrollback"
            aria-label="Clear the scrollback"
          >
            <X size={14} />
          </button>
        </div>
      </div>

      <div className={styles.body} ref={bodyRef}>
        {root === null ? (
          <div className={styles.muted}>
            No folder is open, so there is no project to run a command in. Open one from the
            Explorer first.
          </div>
        ) : (
          <>
            {history.length === 0 && (
              <div className={styles.muted}>
                No commands run yet.
                {allowed.length > 0 && ` Runnable here: ${allowed.join(', ')}.`}
              </div>
            )}

            {allowlistError !== null && (
              <div className={`${styles.outputLine} ${styles.error}`} role="alert">
                <AlertCircle size={12} /> Cannot read the list of runnable programs:{' '}
                {allowlistError}
              </div>
            )}

            {history.map(renderRun)}

            {pending !== null && (
              <div className={styles.confirm} role="alertdialog" aria-label="Confirm this command">
                <div className={styles.confirmText}>
                  Run <span className={styles.confirmCommand}>{formatCommand(pending.command)}</span>{' '}
                  in {promptName}?
                </div>
                <div className={styles.confirmNote}>
                  This starts a real process with your user permissions. Nothing has run yet.
                </div>
                <div className={styles.confirmActions}>
                  <button className={styles.runBtn} onClick={() => void confirm()} autoFocus>
                    <Play size={12} /> Run
                  </button>
                  <button className={styles.cancelBtn} onClick={() => setPending(null)}>
                    Cancel
                  </button>
                </div>
              </div>
            )}
          </>
        )}
      </div>

      <form className={styles.inputLine} onSubmit={submit}>
        {root !== null && <span className={styles.prompt}>{promptName}</span>}
        <span className={styles.dollar}>$</span>
        <input
          className={styles.input}
          value={line}
          onChange={(event) => setLine(event.target.value)}
          disabled={root === null || busy || pending !== null}
          placeholder={
            root === null
              ? 'Open a folder to run a command'
              : pending !== null
                ? 'Confirm or cancel the command above'
                : busy
                  ? 'Waiting for the running command…'
                  : 'A program and its arguments, e.g. npm test'
          }
          aria-label="Command to run"
          spellCheck={false}
          autoComplete="off"
        />
      </form>
    </div>
  )
}
