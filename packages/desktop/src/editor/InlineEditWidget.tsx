// Inline edit (Ctrl+K): say what should change, see the diff, accept or reject it.
//
// The widget floats over the top of the editor. It owns the conversation (instruction,
// progress, the proposed text, an error) and nothing else: WHERE the change applies and
// HOW it is applied belong to the editor host, which checks the code is still what the
// model was shown before it writes a single character, and applies the change as one
// undoable edit. Accepting is Ctrl+Enter, rejecting is Esc, and editing the instruction
// and pressing Enter again asks for a new version of the same selection.

import { useEffect, useMemo, useRef, useState, type KeyboardEvent as ReactKeyboardEvent } from 'react'

import { Check, Sparkles, Stop, X } from '../components/Icons'
import { diffLines, splitLines, type DiffOp } from './lineDiff'
import styles from './InlineEditWidget.module.css'

/** What the widget edits. Fixed when it opens; a new selection is a new session. */
export interface InlineEditSession {
  /** Canonical path of the file. */
  path: string
  /** "Lines 12–30", "Line 7", "New line below 7". */
  target: string
  /** The code being replaced, exactly as the model is shown it. Empty for an insertion. */
  original: string
  /** An instruction to start with (e.g. from "Fix with AI"). */
  instruction?: string
  /** Generate straight away instead of waiting for Enter. */
  autoRun?: boolean
}

export interface InlineEditWidgetProps {
  session: InlineEditSession
  /** Ask the model; resolves with the proposed replacement. Rejects with a readable error. */
  generate: (instruction: string, signal: AbortSignal) => Promise<string>
  /** Apply the proposal. Resolves with null when applied, or the reason it could not be. */
  accept: (proposed: string) => string | null
  onClose: () => void
  /** Hand the request to the chat agent instead (bigger, multi-file changes). */
  openInChat?: (instruction: string) => void
}

type Phase =
  | { kind: 'prompt' }
  | { kind: 'running' }
  | { kind: 'review'; proposed: string }
  | { kind: 'error'; message: string }

/** Unchanged lines shown around each change; longer runs fold. */
const CONTEXT_LINES = 2

type Row = { kind: 'equal' | 'insert' | 'delete'; text: string } | { kind: 'fold'; count: number }

/** The diff as rows, with long unchanged runs folded to their edges. */
export function diffRows(original: string, proposed: string): Row[] {
  const ops: DiffOp[] = diffLines(original === '' ? [] : splitLines(original), splitLines(proposed))
  const rows: Row[] = []
  ops.forEach((op, index) => {
    if (op.kind !== 'equal') {
      for (const text of op.lines) rows.push({ kind: op.kind, text })
      return
    }
    const first = index === 0
    const last = index === ops.length - 1
    const keepHead = first ? 0 : CONTEXT_LINES
    const keepTail = last ? 0 : CONTEXT_LINES
    if (op.lines.length <= keepHead + keepTail + 1) {
      for (const text of op.lines) rows.push({ kind: 'equal', text })
      return
    }
    for (const text of op.lines.slice(0, keepHead)) rows.push({ kind: 'equal', text })
    rows.push({ kind: 'fold', count: op.lines.length - keepHead - keepTail })
    for (const text of op.lines.slice(op.lines.length - keepTail)) rows.push({ kind: 'equal', text })
  })
  return rows
}

export function InlineEditWidget({ session, generate, accept, onClose, openInChat }: InlineEditWidgetProps) {
  const [instruction, setInstruction] = useState(session.instruction ?? '')
  const [phase, setPhase] = useState<Phase>({ kind: 'prompt' })
  const inputRef = useRef<HTMLInputElement | null>(null)
  const acceptRef = useRef<HTMLButtonElement | null>(null)
  const controller = useRef<AbortController | null>(null)

  const stop = () => {
    controller.current?.abort()
    controller.current = null
  }

  const run = async (text: string) => {
    const asked = text.trim()
    if (asked === '') {
      inputRef.current?.focus()
      return
    }
    stop()
    const mine = new AbortController()
    controller.current = mine
    setPhase({ kind: 'running' })
    try {
      const proposed = await generate(asked, mine.signal)
      if (mine.signal.aborted) return
      setPhase({ kind: 'review', proposed })
      requestAnimationFrame(() => acceptRef.current?.focus())
    } catch (err) {
      if (mine.signal.aborted) return
      setPhase({ kind: 'error', message: err instanceof Error ? err.message : String(err) })
    } finally {
      if (controller.current === mine) controller.current = null
    }
  }

  // Open: focus the instruction, or generate at once when asked to.
  useEffect(() => {
    if (session.autoRun === true && (session.instruction ?? '').trim() !== '') void run(session.instruction!)
    else inputRef.current?.focus()
    return stop
    // A session is fixed for the widget's lifetime; the host remounts it for a new one.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  const rows = useMemo(
    () => (phase.kind === 'review' ? diffRows(session.original, phase.proposed) : []),
    [phase, session.original],
  )
  const unchanged = phase.kind === 'review' && rows.every((row) => row.kind === 'equal' || row.kind === 'fold')

  const doAccept = () => {
    if (phase.kind !== 'review') return
    const problem = accept(phase.proposed)
    if (problem !== null) setPhase({ kind: 'error', message: problem })
  }

  const close = () => {
    stop()
    onClose()
  }

  const onKeyDown = (event: ReactKeyboardEvent) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (phase.kind === 'running') {
        stop()
        setPhase({ kind: 'prompt' })
        inputRef.current?.focus()
        return
      }
      close()
      return
    }
    if (event.key === 'Enter' && (event.ctrlKey || event.metaKey) && phase.kind === 'review') {
      event.preventDefault()
      event.stopPropagation()
      doAccept()
    }
  }

  return (
    <div className={styles.widget} role="dialog" aria-label="Edit with AI" onKeyDown={onKeyDown}>
      <div className={styles.header}>
        <Sparkles size={13} />
        <span className={styles.target}>{session.target}</span>
        <button type="button" className={styles.iconBtn} onClick={close} aria-label="Close inline edit" title="Close (Esc)">
          <X size={13} />
        </button>
      </div>

      <form
        className={styles.promptRow}
        onSubmit={(event) => {
          event.preventDefault()
          void run(instruction)
        }}
      >
        <input
          ref={inputRef}
          className={styles.input}
          value={instruction}
          onChange={(event) => setInstruction(event.target.value)}
          placeholder={session.original === '' ? 'Describe the code to write…' : 'Describe the change, e.g. "add error handling"'}
          aria-label="What should change"
          maxLength={2000}
          disabled={phase.kind === 'running'}
          spellCheck={false}
        />
        {phase.kind === 'running' ? (
          <button
            type="button"
            className={styles.secondary}
            onClick={() => {
              stop()
              setPhase({ kind: 'prompt' })
            }}
          >
            <Stop size={11} /> Stop
          </button>
        ) : (
          <button type="submit" className={styles.primary} disabled={instruction.trim() === ''}>
            {phase.kind === 'review' || phase.kind === 'error' ? 'Regenerate' : 'Generate'}
          </button>
        )}
      </form>

      {phase.kind === 'running' && (
        <div className={styles.status} role="status">
          <span className={styles.spinner} aria-hidden="true" /> Writing the change…
        </div>
      )}

      {phase.kind === 'error' && (
        <div className={styles.error} role="alert">
          {phase.message}
        </div>
      )}

      {phase.kind === 'review' && (
        <>
          <div className={styles.diff} role="region" aria-label="Proposed change">
            {unchanged ? (
              <div className={styles.note}>The model returned the code unchanged.</div>
            ) : (
              rows.map((row, index) =>
                row.kind === 'fold' ? (
                  <div key={index} className={styles.fold}>
                    ⋯ {row.count} unchanged {row.count === 1 ? 'line' : 'lines'}
                  </div>
                ) : (
                  <div
                    key={index}
                    className={`${styles.line} ${row.kind === 'insert' ? styles.insert : row.kind === 'delete' ? styles.delete : ''}`}
                  >
                    <span className={styles.sign} aria-hidden="true">
                      {row.kind === 'insert' ? '+' : row.kind === 'delete' ? '−' : ' '}
                    </span>
                    <span className={styles.code}>
                      {row.kind === 'insert' ? <span className="sr-only">added: </span> : null}
                      {row.kind === 'delete' ? <span className="sr-only">removed: </span> : null}
                      {row.text === '' ? ' ' : row.text}
                    </span>
                  </div>
                ),
              )
            )}
          </div>
          <div className={styles.actions}>
            <button ref={acceptRef} type="button" className={styles.primary} onClick={doAccept} disabled={unchanged}>
              <Check size={12} /> Accept <kbd className={styles.kbd}>Ctrl+Enter</kbd>
            </button>
            <button type="button" className={styles.secondary} onClick={close}>
              Reject <kbd className={styles.kbd}>Esc</kbd>
            </button>
            {openInChat !== undefined && (
              <button type="button" className={styles.link} onClick={() => openInChat(instruction)}>
                Ask the agent instead
              </button>
            )}
          </div>
        </>
      )}

      {phase.kind !== 'review' && phase.kind !== 'running' && (
        <div className={styles.hint}>
          Enter to generate · Esc to close
          {openInChat !== undefined && (
            <>
              {' · '}
              <button type="button" className={styles.link} onClick={() => openInChat(instruction)}>
                Ask the agent instead
              </button>
            </>
          )}
        </div>
      )}
    </div>
  )
}

export default InlineEditWidget
