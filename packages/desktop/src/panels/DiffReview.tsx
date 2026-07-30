// Diff review — accept or reject a proposed change one hunk at a time.
//
// WHAT IS REAL HERE. Every hunk on screen comes from an `edit_proposed` event that
// the engine actually emitted, parsed by the engine's own parser (part 1 of this
// task: packages/core/src/diff/hunks.ts, reached through ../review/diffEngine). There
// is no fixture in this file, no sample patch, and no placeholder proposal — a panel
// with nothing to review says so (Requirement 14.6).
//
// ── THE FIVE THINGS THIS PANEL REFUSES TO DO ────────────────────────────────
//
//  1. IT DOES NOT CACHE FILE TEXT. The baseline a hunk is applied to is
//     `AppState.files[path].content` when the file is open — the one authoritative
//     record (Requirement 15.2) — and a fresh read through the file layer when it is
//     not. Nothing is stored locally but VERDICTS, and Monaco is never touched
//     directly: the accepted content is written to disk through `writeFromEditor`
//     (the same function `useFileActions.save` uses) and then handed to the reducer,
//     which is what the editor projects from.
//  2. IT DOES NOT APPLY HUNKS ONE AT A TIME. Accepting hunk 1 changes the line
//     numbers hunk 2 was computed against, so a per-click apply would fail — or
//     worse, land in the wrong place. Verdicts are collected, then the accepted
//     SUBSET is applied against the original in a single `applyHunks` call, which is
//     exactly the case that function was written and tested for.
//  3. IT DOES NOT WRITE WHEN EVERYTHING IS REJECTED. See THE REJECT-ALL GUARD
//     below: with no accepted hunk the file layer is never called at all — not with
//     identical bytes, not at all (Requirement 16.5).
//  4. IT DOES NOT SWALLOW A MISMATCH. A proposal computed against a version of the
//     file that is no longer on disk comes back from `applyHunks` as a typed
//     diagnostic naming the hunk, and that sentence goes on screen. Nothing is
//     written in that case (Requirement 16.5's spirit, applied to failure).
//  5. IT DOES NOT SET HTML. Diff text is attacker-influenced — it is model output
//     about file content — and the app's CSP still carries `script-src
//     'unsafe-inline'`. Every character of every hunk is rendered as a TEXT NODE.
//     There is no `dangerouslySetInnerHTML` in this file and a test asserts it.
//
// ── FOUR HONEST NOTHINGS ────────────────────────────────────────────────────
//
//   no folder open        — paths cannot be resolved, so nothing can be applied
//   no proposal           — the engine has not proposed an edit in this window
//   already resolved      — the newest proposal has a verdict; it names which
//   no diff text          — the event named a file but carried no patch, so there
//                           are no hunks. Reported as that, never as an empty diff
//
// Validates: Requirements 16.1, 16.2, 16.3, 16.5, 14.6, 15.2

import { useCallback, useMemo, useRef, useState } from 'react'
import { AlertTriangle, Check, FileCode, X } from '../components/Icons'
import { byteLength, readForEditor, writeFromEditor } from '../editor/fileIo'
import { useFileIo } from '../editor/FileIoProvider'
import { useOptionalEventPublisher, useOptionalSketchEvents } from '../lib/ClientProvider'
import type { SketchEvent } from '../lib/contracts'
import { allHunkIndexes, applyHunks } from '../review/diffEngine'
import {
  acceptedPayload,
  describeDiagnostic,
  describeParseError,
  hunkLabel,
  isReviewable,
  linePrefix,
  newReviewEventId,
  newestOpen,
  proposalsFrom,
  rejectedPayload,
  type Proposal,
  type ProposedFile,
} from '../review/proposals'
import { useAppDispatch, useAppState } from '../state/AppState'
import styles from './DiffReview.module.css'

type Verdict = 'accept' | 'reject'

/** One hunk's verdict key. Carries the proposal id so a stale one cannot leak. */
function verdictKey(proposal: Proposal, file: ProposedFile, index: number): string {
  return `${proposal.id}\u0000${file.path}\u0000${index}`
}

function summaryLine(file: ProposedFile): string | null {
  const summary = file.summary
  if (summary === null) return null
  const parts: string[] = []
  if (summary.wholeFile === true) parts.push('whole file')
  if (summary.searchBytes !== null) parts.push(`${summary.searchBytes} B searched`)
  if (summary.replaceBytes !== null) parts.push(`${summary.replaceBytes} B replacing it`)
  return parts.length === 0 ? null : parts.join(' · ')
}

export function DiffReview() {
  const state = useAppState()
  const dispatch = useAppDispatch()
  const io = useFileIo()
  const events = useOptionalSketchEvents()
  const publish = useOptionalEventPublisher()

  const [selectedId, setSelectedId] = useState<string | null>(null)
  const [verdicts, setVerdicts] = useState<Record<string, Verdict>>({})
  const [reason, setReason] = useState('')
  const [problem, setProblem] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)

  const root = state.projectRoot

  // An async handler must act on the state as it is when it runs, not on the render
  // that started it — the same reason `useFileActions` keeps this ref.
  const latest = useRef(state)
  latest.current = state

  const proposals = useMemo(() => proposalsFrom(events, root ?? ''), [events, root])

  const selected =
    (selectedId === null ? undefined : proposals.find((proposal) => proposal.id === selectedId)) ??
    newestOpen(proposals) ??
    proposals[proposals.length - 1]

  /**
   * The verdicts, read against a proposal explicitly rather than off the render's
   * selection, so the apply handler cannot act on a selection that has since moved.
   */
  const verdictIn = useCallback(
    (table: Record<string, Verdict>, proposal: Proposal, file: ProposedFile, index: number) =>
      table[verdictKey(proposal, file, index)],
    [],
  )

  const verdictOf = (file: ProposedFile, index: number): Verdict | undefined =>
    selected === undefined ? undefined : verdicts[verdictKey(selected, file, index)]

  const setVerdict = (file: ProposedFile, index: number, verdict: Verdict) => {
    if (selected === undefined) return
    const key = verdictKey(selected, file, index)
    setProblem(null)
    setVerdicts((prev) => {
      // Clicking the same verdict again clears it, so a mis-click is undoable
      // without a third button.
      if (prev[key] === verdict) {
        const { [key]: _cleared, ...rest } = prev
        return rest
      }
      return { ...prev, [key]: verdict }
    })
  }

  /**
   * Proposals whose hunks no longer fit the file, checked before a click.
   *
   * Only for files that are OPEN, because their buffer is the authoritative text.
   * For a file that is not open this says nothing rather than guessing — the same
   * check runs against a fresh read at apply time, where the answer is certain.
   */
  const staleness = useMemo(() => {
    const out: Record<string, string> = {}
    if (selected === undefined) return out
    for (const file of selected.files) {
      if (file.hunks.length === 0) continue
      const open = state.files[file.path]
      if (!open) continue
      const applied = applyHunks(open.content, file.hunks, allHunkIndexes(file.hunks))
      if (!applied.ok) out[file.path] = describeDiagnostic(file.statedPath, applied.error)
    }
    return out
  }, [selected, state.files])

  const emit = useCallback(
    (proposal: Proposal, kind: SketchEvent['kind'], payload: Record<string, unknown>) => {
      publish({
        id: newReviewEventId(),
        ts: Date.now(),
        runId: proposal.runId,
        kind,
        payload,
      })
    },
    [publish],
  )

  /** The text a hunk is applied to: the open buffer, else what is on disk now. */
  const baselineFor = useCallback(
    async (file: ProposedFile): Promise<{ ok: true; content: string } | { ok: false; message: string }> => {
      const snapshot = latest.current
      const open = snapshot.files[file.path]
      if (open) return { ok: true, content: open.content }
      if (!snapshot.projectRoot) {
        return { ok: false, message: 'Cannot apply this hunk: no project folder is open.' }
      }
      return readForEditor(io, snapshot.projectRoot, file.path)
    },
    [io],
  )

  const applyReview = useCallback(
    async (proposal: Proposal) => {
      const projectRoot = latest.current.projectRoot
      if (!projectRoot) {
        setProblem('Cannot apply this proposal: no project folder is open.')
        return
      }
      setBusy(true)
      setProblem(null)
      try {
        for (const file of proposal.files) {
          const indexes = allHunkIndexes(file.hunks)
          const accepted = indexes.filter(
            (index) => verdictIn(verdicts, proposal, file, index) === 'accept',
          )
          const rejected = indexes.filter(
            (index) => verdictIn(verdicts, proposal, file, index) === 'reject',
          )

          // ── THE REJECT-ALL GUARD ────────────────────────────────────────────
          // No accepted hunk means the file layer is not reached: no read, no
          // write, no touch of the bytes on disk. Rewriting identical content
          // would still change the modification time, restart a watcher, and show
          // up in a build — "unchanged" has to mean the writer was never called
          // (Requirement 16.5).
          if (accepted.length > 0) {
            const baseline = await baselineFor(file)
            if (!baseline.ok) {
              setProblem(baseline.message)
              return
            }

            const applied = applyHunks(baseline.content, file.hunks, accepted)
            if (!applied.ok) {
              // A stale proposal, named and shown. Still no write.
              setProblem(describeDiagnostic(file.statedPath, applied.error))
              return
            }

            const written = await writeFromEditor(io, projectRoot, file.path, applied.content)
            if (!written.ok) {
              setProblem(written.message)
              return
            }

            // Disk and the one state owner now agree. The reducer is told, rather
            // than Monaco: the editor projects from `AppState`, so this is what puts
            // the accepted hunks on screen (Requirement 15.2).
            if (latest.current.files[file.path]) {
              dispatch({ type: 'RELOAD_FILE', payload: { path: file.path, content: applied.content } })
            }

            // Emitted AFTER the write resolves. Earlier and the editor's reconciler
            // would re-read a file that had not been written yet and flag a
            // conflict against a change the reviewer just accepted.
            emit(
              proposal,
              'edit_accepted',
              acceptedPayload(
                { proposalId: proposal.id, path: file.statedPath, hunks: accepted },
                byteLength(applied.content),
              ),
            )
          }

          if (rejected.length > 0) {
            emit(
              proposal,
              'edit_rejected',
              rejectedPayload({ proposalId: proposal.id, path: file.statedPath, hunks: rejected }, reason),
            )
          }
        }
      } finally {
        setBusy(false)
      }
    },
    [baselineFor, dispatch, emit, io, reason, verdictIn, verdicts],
  )

  const rejectEverything = useCallback(
    (proposal: Proposal) => {
      setProblem(null)
      // Nothing is read and nothing is written. The only effect is the verdict.
      //
      // "Put the file back the way it was" is the tempting bug here, and it is a
      // bug: rewriting identical bytes still bumps the modification time and wakes
      // every watcher. DiffReview.test.tsx counts writer CALLS, so that version of
      // this function fails while the file contents still look untouched.
      for (const file of proposal.files) {
        emit(
          proposal,
          'edit_rejected',
          rejectedPayload(
            { proposalId: proposal.id, path: file.statedPath, hunks: allHunkIndexes(file.hunks) },
            reason,
          ),
        )
      }
    },
    [emit, reason],
  )

  // ── honest nothings ───────────────────────────────────────────────────────

  if (!root) {
    return (
      <div className={styles.container}>
        <div className={styles.empty}>
          <div className={styles.emptyTitle}>No folder open</div>
          <div className={styles.emptyDetail}>
            Open a project folder to review the edits an agent proposes. Without one, the paths in a
            proposal cannot be resolved and nothing can be applied.
          </div>
        </div>
      </div>
    )
  }

  if (selected === undefined) {
    return (
      <div className={styles.container}>
        <div className={styles.empty}>
          <div className={styles.emptyTitle}>No proposal to review</div>
          <div className={styles.emptyDetail}>
            The engine emits an <code>edit_proposed</code> event before it changes a file. Nothing has
            proposed an edit in this window yet.
          </div>
        </div>
      </div>
    )
  }

  const reviewable = selected.files.filter(isReviewable)
  const totalHunks = reviewable.reduce((count, file) => count + file.hunks.length, 0)
  const acceptedCount = reviewable.reduce(
    (count, file) =>
      count + allHunkIndexes(file.hunks).filter((index) => verdictOf(file, index) === 'accept').length,
    0,
  )
  const decidedCount = reviewable.reduce(
    (count, file) =>
      count + allHunkIndexes(file.hunks).filter((index) => verdictOf(file, index) !== undefined).length,
    0,
  )
  const undecided = totalHunks - decidedCount
  const open = selected.outcome.state === 'open'
  const hasPath = selected.files.length > 0

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <FileCode size={14} />
        <span className={styles.headerTitle}>
          {hasPath
            ? selected.files.map((file) => file.statedPath).join(', ')
            : 'proposal with no file path'}
        </span>
        {totalHunks > 0 && <span className={styles.badge}>{totalHunks}</span>}
      </div>

      {proposals.length > 1 && (
        <div className={styles.proposalList} role="list" aria-label="Proposed edits">
          {[...proposals].reverse().map((proposal) => (
            <button
              key={proposal.id}
              role="listitem"
              className={`${styles.proposalRow} ${proposal.id === selected.id ? styles.proposalRowSelected : ''}`}
              onClick={() => setSelectedId(proposal.id)}
            >
              <span className={styles.proposalPath}>
                {proposal.files.map((file) => file.statedPath).join(', ') || 'no file named'}
              </span>
              <span className={styles.proposalState}>
                {proposal.outcome.state === 'open' ? 'awaiting review' : proposal.outcome.state}
              </span>
            </button>
          ))}
        </div>
      )}

      {selected.outcome.state === 'accepted' && (
        <div className={styles.resolved} role="status">
          <Check size={14} />
          <span>
            Already resolved: this proposal was accepted
            {selected.outcome.hunks === null
              ? ''
              : ` (${selected.outcome.hunks.length} hunk${selected.outcome.hunks.length === 1 ? '' : 's'})`}
            . There is nothing left to apply.
          </span>
        </div>
      )}

      {selected.outcome.state === 'rejected' && (
        <div className={styles.resolved} role="status">
          <X size={14} />
          <span>Already resolved: this proposal was rejected — {selected.outcome.reason}</span>
        </div>
      )}

      {problem !== null && (
        <div className={styles.error} role="alert">
          <AlertTriangle size={14} />
          <span>{problem}</span>
        </div>
      )}

      <div className={styles.files}>
        {!hasPath && (
          <div className={styles.empty}>
            <div className={styles.emptyTitle}>This proposal named no file</div>
            <div className={styles.emptyDetail}>
              The <code>edit_proposed</code> event carried no path, so there is no file to review and
              nothing to accept or reject.
            </div>
          </div>
        )}

        {selected.files.map((file) => {
          const summary = summaryLine(file)
          const stale = staleness[file.path]
          return (
            <div key={file.path} className={styles.file}>
              <div className={styles.filePath} title={file.path}>
                {file.statedPath}
                {summary !== null && <span className={styles.fileSummary}>{summary}</span>}
              </div>

              {file.parseError !== null && (
                <div className={styles.error} role="alert">
                  <AlertTriangle size={14} />
                  <span>{describeParseError(file.statedPath, file.parseError)}</span>
                </div>
              )}

              {file.parseError === null && file.hunks.length === 0 && (
                <div className={styles.note} role="note">
                  This proposal named {file.statedPath} but carried no diff text, so there are no hunks
                  to review. Nothing is shown rather than an empty diff, which would read as "no
                  change".
                </div>
              )}

              {stale !== undefined && (
                <div className={styles.error} role="alert">
                  <AlertTriangle size={14} />
                  <span>{stale}</span>
                </div>
              )}

              {file.hunks.map((hunk, index) => {
                const verdict = verdictOf(file, index)
                return (
                  <div
                    key={`${file.path}:${index}`}
                    className={`${styles.hunk} ${
                      verdict === 'accept'
                        ? styles.hunkAccepted
                        : verdict === 'reject'
                          ? styles.hunkRejected
                          : ''
                    }`}
                  >
                    <div className={styles.hunkHeader}>
                      <span className={styles.hunkLabel}>{hunkLabel(hunk)}</span>
                      {open && (
                        <>
                          <button
                            className={`${styles.hunkBtn} ${verdict === 'accept' ? styles.hunkBtnOn : ''}`}
                            aria-pressed={verdict === 'accept'}
                            aria-label={`Accept hunk ${index + 1} of ${file.statedPath}`}
                            disabled={busy}
                            onClick={() => setVerdict(file, index, 'accept')}
                          >
                            <Check size={12} /> Accept
                          </button>
                          <button
                            className={`${styles.hunkBtn} ${verdict === 'reject' ? styles.hunkBtnOn : ''}`}
                            aria-pressed={verdict === 'reject'}
                            aria-label={`Reject hunk ${index + 1} of ${file.statedPath}`}
                            disabled={busy}
                            onClick={() => setVerdict(file, index, 'reject')}
                          >
                            <X size={12} /> Reject
                          </button>
                        </>
                      )}
                      {verdict !== undefined && (
                        <span className={styles.verdictTag}>
                          {verdict === 'accept' ? 'will apply' : 'will not apply'}
                        </span>
                      )}
                    </div>
                    {/* Text nodes only. Never innerHTML — this is model output about
                        file content and the CSP allows inline script. */}
                    <pre className={styles.hunkBody}>
                      {hunk.lines.map((line, lineIndex) => (
                        <span
                          key={lineIndex}
                          className={
                            line.kind === 'add'
                              ? styles.lineAdd
                              : line.kind === 'remove'
                                ? styles.lineRemove
                                : styles.lineContext
                          }
                        >
                          {`${linePrefix(line.kind)}${line.text}\n`}
                        </span>
                      ))}
                    </pre>
                  </div>
                )
              })}
            </div>
          )
        })}
      </div>

      {open && hasPath && (
        <div className={styles.footer}>
          <textarea
            className={styles.reasonInput}
            aria-label="Why these hunks are rejected"
            placeholder="Why are you rejecting these hunks?"
            value={reason}
            onChange={(event) => setReason(event.target.value)}
          />
          <div className={styles.footerRow}>
            <button
              className={styles.applyBtn}
              disabled={busy || totalHunks === 0 || undecided > 0 || acceptedCount === 0}
              title={
                totalHunks === 0
                  ? 'There are no hunks to apply.'
                  : undecided > 0
                    ? `${undecided} hunk${undecided === 1 ? '' : 's'} still need a verdict.`
                    : acceptedCount === 0
                      ? 'Every hunk is rejected, so there is nothing to write. Use Reject all.'
                      : `Apply ${acceptedCount} accepted hunk${acceptedCount === 1 ? '' : 's'}`
              }
              onClick={() => void applyReview(selected)}
            >
              <Check size={14} /> Apply {acceptedCount} accepted
            </button>
            <button
              className={styles.rejectBtn}
              disabled={busy}
              title="Reject every hunk. Nothing is written."
              onClick={() => rejectEverything(selected)}
            >
              <X size={14} /> Reject all
            </button>
          </div>
          {undecided > 0 && (
            <div className={styles.hint}>
              {undecided} hunk{undecided === 1 ? '' : 's'} still need a verdict before anything can be
              applied.
            </div>
          )}
        </div>
      )}
    </div>
  )
}

export default DiffReview
