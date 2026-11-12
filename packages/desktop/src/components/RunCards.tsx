// What a run is doing, and what it did — rendered from engine events.
//
// `LiveRun` shows an in-flight run: a present-tense status line ("Reading the
// project…"), each step as it lands, and Stop. `RunSteps` and `ChangedFilesCard`
// show a finished run from what its message recorded: the steps, and the files it
// changed with Undo (auto-apply) or Accept / Reject (review mode). Nothing here is a
// placeholder: an empty step list renders nothing at all.

import { useMemo, useState } from 'react'
import type { SketchEvent } from '../lib/contracts'
import { changedFiles, currentActivity, stepsFor, type ChangedFile } from '../lib/runSummary'
import type { ChatMessage, RunReceipt, RunStepSummary } from '../state/AppState'
import {
  AlertTriangle,
  Brain,
  Check,
  ChevronDown,
  ChevronRight,
  FileCode,
  FileText,
  Folder,
  Search,
  Sparkles,
  Stop,
  Terminal,
  Undo,
  X,
  Zap,
} from './Icons'
import styles from './RunCards.module.css'

function StepIcon({ step }: { step: RunStepSummary }) {
  if (step.ok === false) return <AlertTriangle size={12} />
  switch (step.kind) {
    case 'read':
      return <FileText size={12} />
    case 'list':
      return <Folder size={12} />
    case 'search':
      return <Search size={12} />
    case 'edit':
      return <FileCode size={12} />
    case 'verify':
      return <Check size={12} />
    case 'think':
    case 'plan':
      return <Brain size={12} />
    case 'index':
      return <Zap size={12} />
    case 'command':
      return <Terminal size={12} />
    case 'skill':
      return <Sparkles size={12} />
    default:
      return <ChevronRight size={12} />
  }
}

function formatDuration(ms: number): string {
  if (ms < 1000) return `${ms} ms`
  const seconds = Math.round(ms / 1000)
  return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${seconds % 60}s`
}

function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(n >= 10_000 ? 0 : 1)}k` : String(n)
}

/**
 * The proof line under a reply: which checks really ran and how they ended, which
 * commands ran and what they exited with, and what the run cost in calls, tokens and
 * time — all read from the run's own events, never from what the model said.
 */
export function RunReceiptLine({ receipt }: { receipt: RunReceipt }) {
  const failed = receipt.checks.filter((check) => !check.ok)
  const failedCommands = receipt.commands.filter((command) => command.exitCode !== 0)
  const parts: string[] = []
  // Which model actually answered this message. The receipt carries the model the
  // PROVIDER named (a router alias when one resolved); when the provider named none we
  // only know the requested model, and it is labelled "(requested)" so the two are not
  // confused. This is the "history shows which model answered each message" guarantee.
  if (receipt.models.length > 0) {
    const names = receipt.models.join(', ')
    parts.push(receipt.modelsAnswered ? names : `${names} (requested)`)
  }
  if (receipt.durationMs !== null) parts.push(formatDuration(receipt.durationMs))
  if (receipt.modelCalls > 0) {
    // Logical calls, plus the automatic-retry count when any call was retried, so the
    // receipt shows the retries without inflating the call count.
    const retrySuffix = receipt.retries > 0 ? ` (${receipt.retries} retr${receipt.retries === 1 ? 'y' : 'ies'})` : ''
    parts.push(`${receipt.modelCalls} model call${receipt.modelCalls === 1 ? '' : 's'}${retrySuffix}`)
  }
  const tokens = receipt.tokens.in + receipt.tokens.out
  // Tokens are shown with their honesty: an estimate is marked, a call the provider gave
  // no usage for is "unknown" and NEVER shown as 0.
  if (tokens > 0) parts.push(`${formatTokens(tokens)}${receipt.tokensEstimated ? ' ~' : ' '}tokens${receipt.tokensEstimated ? ' (estimated)' : ''}`.replace('  ', ' '))
  if (receipt.tokensUnknownCalls > 0) {
    parts.push(`tokens unknown for ${receipt.tokensUnknownCalls} of ${receipt.modelCalls} call${receipt.modelCalls === 1 ? '' : 's'}`)
  }
  if (receipt.commands.length > 0) {
    parts.push(`${receipt.commands.length} command${receipt.commands.length === 1 ? '' : 's'} run${failedCommands.length > 0 ? ` (${failedCommands.length} non-zero)` : ''}`)
  }
  if (parts.length === 0 && receipt.checks.length === 0) return null
  return (
    <div className={styles.receipt} aria-label="What this run verifiably did">
      {receipt.checks.length > 0 &&
        (failed.length === 0 ? (
          <span className={styles.receiptOk} title={receipt.checks.map((c) => c.name).join(', ')}>
            <Check size={11} /> Verified: {receipt.checks.map((c) => c.name).join(', ')}
          </span>
        ) : (
          <span className={styles.receiptBad} title={failed.map((c) => c.name).join(', ')}>
            <AlertTriangle size={11} /> {failed.length} of {receipt.checks.length} check{receipt.checks.length === 1 ? '' : 's'} failed: {failed.map((c) => c.name).join(', ')}
          </span>
        ))}
      {parts.length > 0 && <span className={styles.receiptMeta}>{parts.join(' · ')}</span>}
    </div>
  )
}

export function StepList({ steps }: { steps: readonly RunStepSummary[] }) {
  if (steps.length === 0) return null
  return (
    <ul className={styles.steps}>
      {steps.map((step, index) => (
        <li
          key={index}
          className={`${styles.step} ${step.ok === false ? styles.stepBad : ''} ${step.kind === 'think' ? styles.stepThink : ''}`}
        >
          <span className={styles.stepIcon}>
            <StepIcon step={step} />
          </span>
          <span className={styles.stepText}>{step.text}</span>
        </li>
      ))}
    </ul>
  )
}

/** A finished run's steps, folded by default so the answer stays the focus. */
export function RunSteps({ steps }: { steps: readonly RunStepSummary[] }) {
  const [open, setOpen] = useState(false)
  if (steps.length === 0) return null
  return (
    <div className={styles.stepsFold}>
      <button type="button" className={styles.foldBtn} onClick={() => setOpen(!open)} aria-expanded={open}>
        {open ? <ChevronDown size={12} /> : <ChevronRight size={12} />}
        {steps.length} step{steps.length === 1 ? '' : 's'}
      </button>
      {open && <StepList steps={steps} />}
    </div>
  )
}

/** An in-flight run, live from its events. */
export function LiveRun({
  events,
  onStop,
  stopping,
}: {
  events: readonly SketchEvent[]
  onStop: () => void
  stopping: boolean
}) {
  const steps = useMemo(() => stepsFor(events), [events])
  const files = useMemo(() => changedFiles(events), [events])
  const status = stopping ? 'Stopping…' : currentActivity(events)
  return (
    <div className={styles.live} aria-live="polite">
      <div className={styles.liveHead}>
        <span className={styles.spinner} aria-hidden />
        <span className={styles.liveStatus}>{status}</span>
        <button type="button" className={styles.stopBtn} onClick={onStop} disabled={stopping}>
          <Stop size={10} /> Stop
        </button>
      </div>
      <StepList steps={steps.slice(-12)} />
      {files.length > 0 && <FileRows files={files} />}
    </div>
  )
}

function FileRows({ files, expandable = false }: { files: readonly ChangedFile[] | NonNullable<ChatMessage['files']>; expandable?: boolean }) {
  const [openPath, setOpenPath] = useState<string | null>(null)
  return (
    <ul className={styles.files}>
      {files.map((file) => {
        const preview = 'preview' in file ? file.preview : []
        const canOpen = expandable && preview.length > 0
        const isOpen = openPath === file.path
        return (
          <li key={file.path} className={styles.fileItem}>
            <button
              type="button"
              className={styles.fileRow}
              onClick={() => canOpen && setOpenPath(isOpen ? null : file.path)}
              disabled={!canOpen}
            >
              <FileCode size={12} />
              <span className={styles.filePath}>{file.path}</span>
              {file.created ? (
                <span className={styles.fileNew}>new</span>
              ) : (
                <>
                  <span className={styles.fileAdd}>+{file.added}</span>
                  <span className={styles.fileDel}>−{file.removed}</span>
                </>
              )}
            </button>
            {isOpen && (
              <pre className={styles.preview}>
                {preview.map((line, index) =>
                  line === null ? (
                    <div key={index} className={styles.previewGap}>
                      ⋯
                    </div>
                  ) : (
                    <div
                      key={index}
                      className={line.kind === 'add' ? styles.previewAdd : line.kind === 'del' ? styles.previewDel : styles.previewSame}
                    >
                      {line.kind === 'add' ? '+ ' : line.kind === 'del' ? '- ' : '  '}
                      {line.text}
                    </div>
                  ),
                )}
              </pre>
            )}
          </li>
        )
      })}
    </ul>
  )
}

/**
 * The files a finished run changed or proposed, and what can still be done about
 * them. `events` (when this window still has them) adds an inline diff per file.
 */
export function ChangedFilesCard({
  message,
  events,
  onUndo,
  onAccept,
  onReject,
  onReview,
}: {
  message: ChatMessage
  events: readonly SketchEvent[]
  onUndo: () => void
  onAccept: () => void
  onReject: () => void
  onReview: () => void
}) {
  const [busy, setBusy] = useState(false)
  const live = useMemo(
    () => (message.runId === undefined ? [] : changedFiles(events.filter((e) => e.runId === message.runId))),
    [events, message.runId],
  )
  const files = live.length > 0 ? live : message.files ?? []
  if (files.length === 0) return null
  const state = message.filesState ?? 'applied'
  const run = async (fn: () => void | Promise<void>) => {
    setBusy(true)
    try {
      await fn()
    } finally {
      setBusy(false)
    }
  }
  const label =
    state === 'proposed'
      ? `Proposed changes to ${files.length} file${files.length === 1 ? '' : 's'} — not written yet`
      : state === 'undone'
        ? `Changes to ${files.length} file${files.length === 1 ? '' : 's'} were undone`
        : state === 'rejected'
          ? 'Proposed changes were rejected'
          : `Changed ${files.length} file${files.length === 1 ? '' : 's'}`
  return (
    <div className={styles.filesCard}>
      <div className={styles.filesHead}>
        <span>{label}</span>
      </div>
      <FileRows files={files} expandable={live.length > 0} />
      <div className={styles.fileActions}>
        {state === 'applied' && (
          <button type="button" className={styles.actionBtn} disabled={busy} onClick={() => void run(onUndo)}>
            <Undo size={12} /> Undo changes
          </button>
        )}
        {state === 'proposed' && (
          <>
            <button type="button" className={`${styles.actionBtn} ${styles.primary}`} disabled={busy} onClick={() => void run(onAccept)}>
              <Check size={12} /> Accept all
            </button>
            <button type="button" className={styles.actionBtn} disabled={busy} onClick={() => void run(onReject)}>
              <X size={12} /> Reject
            </button>
            <button type="button" className={styles.actionBtn} disabled={busy} onClick={onReview}>
              Review hunk by hunk
            </button>
          </>
        )}
        {state === 'accepted' && <span className={styles.settled}><Check size={12} /> Applied</span>}
      </div>
    </div>
  )
}
