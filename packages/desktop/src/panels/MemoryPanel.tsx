// Memory — what this project remembers, when it was true, and what replaced what.
//
// ── MEMORY THE USER CANNOT INSPECT OR CORRECT IS MEMORY THEY CANNOT TRUST ──
//
// That is the whole reason this panel exists. Everything in the store is fed to a model as
// project fact, so a user who cannot see it has no way to notice when it is wrong, and no
// way to fix it when they do. So: every row, its validity window, and one control to
// retract it.
//
// ── SUPERSEDED ROWS ARE SHOWN, NOT HIDDEN ──────────────────────────────────
//
// Retrieval excludes retracted entries — a withdrawn fact must not reach a prompt. This
// panel is the opposite case and shows them, greyed and labelled, because a history you
// cannot see is a history you cannot audit. "Why does the agent think we use REST?" is
// answered by seeing that the decision existed, when it was closed, and why.
//
// ── RETRACTING IS NOT DELETING, AND THE UI SAYS SO ─────────────────────────
//
// The control reads "Retract", not "Delete", and it REQUIRES a reason before it is
// enabled. Requirement 21.3 asks that superseding record why; a panel with an optional
// reason box would produce a store full of rows closed for no stated reason, which is
// indistinguishable from a bug months later. The row survives with its window closed, so
// the correction itself is auditable.
//
// ── THE LINT FINDINGS ARE QUESTIONS, NOT VERDICTS ──────────────────────────
//
// `findings` are rendered with their confidence and a suggestion, and NOTHING is applied
// automatically. The engine's lint pass deliberately supersedes nothing: deciding from
// prose which of two decisions is wrong would eventually discard the correct one. So the
// panel asks, and the user decides.
//
// Validates: Requirements 21.1, 21.2, 21.3, 21.4, 21.5, 21.6, 27.1

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Check, Refresh, Search, X } from '../components/Icons'
import { useSketchClient } from '../lib/ClientProvider'
import { useAppState } from '../state/AppState'
import type {
  MemoryEntryRow,
  MemoryFinding,
  MemoryListResult,
  MemorySearchResult,
} from '../lib/client'
import styles from './MemoryPanel.module.css'

type Tab = 'all' | 'search' | 'findings'

export function MemoryPanel() {
  const { projectRoot } = useAppState()
  const client = useSketchClient()

  const [list, setList] = useState<MemoryListResult | null>(null)
  const [search, setSearch] = useState<MemorySearchResult | null>(null)
  const [query, setQuery] = useState('')
  const [tab, setTab] = useState<Tab>('all')
  const [kind, setKind] = useState<string>('')
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  /** The row awaiting a retraction reason. Nothing closes without passing through this. */
  const [retracting, setRetracting] = useState<MemoryEntryRow | null>(null)
  const [reason, setReason] = useState('')
  const [notice, setNotice] = useState<string | null>(null)

  const generation = useRef(0)
  const canRead = client.memoryList !== undefined
  const canWrite = client.memorySupersede !== undefined

  const refresh = useCallback(
    async (root: string, forKind: string) => {
      const call = client.memoryList
      if (call === undefined) return
      generation.current += 1
      const ticket = generation.current
      setLoading(true)
      setError(null)
      try {
        const answer = await call.call(client, {
          root,
          ...(forKind === '' ? {} : { kind: forKind }),
        })
        if (generation.current !== ticket) return
        setList(answer)
      } catch (err) {
        if (generation.current !== ticket) return
        setList(null)
        setError(`Memory could not be read: ${message(err)}`)
      } finally {
        if (generation.current === ticket) setLoading(false)
      }
    },
    [client],
  )

  // Reading the store is a local file read with no side effect, so it may happen on
  // mount. Nothing here writes or retracts without an explicit action.
  useEffect(() => {
    if (projectRoot === null) {
      setList(null)
      setError(null)
      return
    }
    void refresh(projectRoot, kind)
  }, [projectRoot, kind, refresh])

  const runSearch = useCallback(async () => {
    const call = client.memorySearch
    if (call === undefined || projectRoot === null || query.trim() === '') return
    setError(null)
    try {
      // `includeSuperseded` on, because this panel's job is showing history. Retrieval for
      // a PROMPT uses the default, which excludes it.
      setSearch(await call.call(client, { root: projectRoot, query, includeSuperseded: true }))
      setTab('search')
    } catch (err) {
      setError(`Search failed: ${message(err)}`)
    }
  }, [client, projectRoot, query])

  const confirmRetract = useCallback(async () => {
    const call = client.memorySupersede
    const entry = retracting
    if (call === undefined || entry === null || projectRoot === null) return
    if (reason.trim() === '') return
    setError(null)
    try {
      const result = await call.call(client, { root: projectRoot, id: entry.id, reason })
      if (!result.ok) {
        setError(result.reason ?? 'The entry could not be retracted.')
      } else {
        setNotice(`Retracted. The row is kept with its window closed, so the change is auditable.`)
      }
      await refresh(projectRoot, kind)
    } catch (err) {
      setError(`Retracting failed: ${message(err)}`)
    } finally {
      setRetracting(null)
      setReason('')
    }
  }, [client, retracting, projectRoot, reason, refresh, kind])

  if (projectRoot === null) {
    return (
      <Frame>
        <Empty
          title="No folder opened"
          detail="Memory belongs to a project and lives under .sketch/memory/. Open a folder first."
        />
      </Frame>
    )
  }

  if (!canRead) {
    return (
      <Frame>
        <Empty
          title="No engine behind this transport"
          detail={`The ${client.transport} transport does not implement memory-list, so there is nothing to show. Invented entries would be invented decisions about your codebase, with invented dates — the one fixture that would actively mislead the agent.`}
        />
      </Frame>
    )
  }

  const rows = tab === 'search' ? (search?.hits.map((hit) => hit.entry) ?? []) : (list?.entries ?? [])

  return (
    <Frame
      action={
        <button
          type="button"
          className={styles.iconButton}
          onClick={() => void refresh(projectRoot, kind)}
          disabled={loading}
          title="Re-read memory from disk"
        >
          <Refresh size={12} />
        </button>
      }
    >
      {error !== null && (
        <div className={styles.error} role="alert">
          <AlertCircle size={13} />
          <span>{error}</span>
        </div>
      )}
      {notice !== null && (
        <div className={styles.notice} role="status">
          <Check size={13} />
          <span>{notice}</span>
        </div>
      )}

      <div className={styles.searchRow}>
        <Search size={13} className={styles.searchIcon} />
        <input
          type="text"
          className={styles.searchInput}
          placeholder="Search memory…"
          aria-label="Search memory"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Enter') void runSearch()
          }}
        />
      </div>

      <div className={styles.tabs} role="tablist">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'all'}
          className={tab === 'all' ? styles.tabActive : styles.tab}
          onClick={() => setTab('all')}
        >
          All ({list?.total ?? 0})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'search'}
          className={tab === 'search' ? styles.tabActive : styles.tab}
          onClick={() => setTab('search')}
          disabled={search === null}
        >
          Results ({search?.hits.length ?? 0})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'findings'}
          className={tab === 'findings' ? styles.tabActive : styles.tab}
          onClick={() => setTab('findings')}
        >
          Hygiene ({list?.findings.length ?? 0})
        </button>
      </div>

      {tab === 'all' && list !== null && (
        <>
          <select
            className={styles.kindFilter}
            aria-label="Filter by kind"
            value={kind}
            onChange={(event) => setKind(event.target.value)}
          >
            <option value="">All kinds</option>
            {list.kinds.map((summary) => (
              <option key={summary.kind} value={summary.kind}>
                {summary.kind} ({summary.current} current of {summary.total})
              </option>
            ))}
          </select>
          <p className={styles.summary} role="status">
            {list.current} of {list.total} entries are currently valid. Closed rows are kept and
            shown below, because a history you cannot see is a history you cannot correct.
          </p>
          {list.skipped > 0 && (
            <p className={styles.warning}>
              <AlertCircle size={12} />
              <span>
                {list.skipped} line(s) in the memory log could not be read and are not shown.
              </span>
            </p>
          )}
        </>
      )}

      {tab === 'search' && search !== null && (
        <p className={styles.summary} role="status">
          {search.hits.length} of {search.candidates} matched “{search.terms.join(' ')}”.
          {search.supersededExcluded > 0
            ? ` ${search.supersededExcluded} retracted entries would be hidden from a prompt.`
            : ''}
        </p>
      )}

      {tab === 'findings' ? (
        <Findings findings={list?.findings ?? []} />
      ) : rows.length === 0 ? (
        <Empty
          title={tab === 'search' ? 'Nothing matched' : 'Nothing remembered yet'}
          detail={
            tab === 'search'
              ? 'No entry matched those terms. This is an honest nothing, not an error.'
              : 'This project has recorded no decisions, standards or bugs yet. Memory fills up as runs record what they learned.'
          }
        />
      ) : (
        <ul className={styles.entries} aria-label="Memory entries">
          {rows.map((entry) => (
            <Row
              key={entry.id}
              entry={entry}
              canRetract={canWrite}
              onRetract={() => {
                setRetracting(entry)
                setReason('')
                setNotice(null)
              }}
            />
          ))}
        </ul>
      )}

      {retracting !== null && (
        <div className={styles.dialogBackdrop}>
          <div
            className={styles.dialog}
            role="dialog"
            aria-modal="true"
            aria-label={`Retract this ${retracting.kind}`}
          >
            <h3 className={styles.dialogTitle}>Retract this {retracting.kind}?</h3>
            <p className={styles.dialogText}>{retracting.text}</p>
            <p className={styles.dialogNote}>
              This is not a delete. The row is kept and its validity window closes, so the history
              stays readable and the correction itself is auditable.
            </p>
            <label className={styles.label} htmlFor="retract-reason">
              Why is this no longer true?
            </label>
            <textarea
              id="retract-reason"
              className={styles.reasonInput}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
              rows={3}
            />
            {/* Required, not optional. A store full of rows closed for no stated reason is
                indistinguishable from a bug months later (Requirement 21.3). */}
            {reason.trim() === '' && (
              <p className={styles.dialogNote}>A reason is required before this can be retracted.</p>
            )}
            <div className={styles.dialogButtons}>
              <button
                type="button"
                className={styles.secondaryButton}
                onClick={() => {
                  setRetracting(null)
                  setReason('')
                }}
              >
                Cancel
              </button>
              <button
                type="button"
                className={styles.primaryButton}
                onClick={() => void confirmRetract()}
                disabled={reason.trim() === ''}
              >
                Retract
              </button>
            </div>
          </div>
        </div>
      )}
    </Frame>
  )
}

/** One entry, with its window and — when it is closed — why. */
function Row({
  entry,
  canRetract,
  onRetract,
}: {
  entry: MemoryEntryRow
  canRetract: boolean
  onRetract: () => void
}) {
  return (
    <li className={entry.current ? styles.entry : styles.entryClosed} data-memory-id={entry.id}>
      <div className={styles.entryHead}>
        <span className={styles.kindBadge}>{entry.kind}</span>
        {entry.subject !== undefined && <code className={styles.subject}>{entry.subject}</code>}
        {/* A word, not just a colour: "retracted" has to survive being read aloud. */}
        <span className={entry.current ? styles.currentMark : styles.retractedMark}>
          {entry.current ? 'current' : 'retracted'}
        </span>
        {canRetract && entry.current && (
          <button
            type="button"
            className={styles.retractButton}
            onClick={onRetract}
            aria-label={`Retract ${entry.kind}: ${entry.text.slice(0, 40)}`}
          >
            <X size={11} />
            <span>Retract</span>
          </button>
        )}
      </div>

      <p className={styles.entryText}>{entry.text}</p>

      <div className={styles.entryMeta}>
        <span>{entry.window}</span>
        {entry.key !== undefined && <code className={styles.key}>{entry.key}</code>}
        <span className={styles.source}>{entry.source}</span>
      </div>
    </li>
  )
}

/** The lint pass's findings. Questions for the user; nothing is applied. */
function Findings({ findings }: { findings: MemoryFinding[] }) {
  if (findings.length === 0) {
    return (
      <Empty
        title="No hygiene problems found"
        detail="No contradictions, duplicates or unreasoned retractions. This is checked over the current entries every time this panel loads."
      />
    )
  }
  return (
    <>
      <p className={styles.summary} role="status">
        These are reported, not applied. Nothing here has been changed — deciding from the text
        which of two entries is wrong would eventually discard the right one, so the choice is
        yours.
      </p>
      <ul className={styles.findings} aria-label="Hygiene findings">
        {findings.map((finding, index) => (
          <li key={`${finding.kind}-${index}`} className={styles.finding}>
            <div className={styles.findingHead}>
              <span className={confidenceClass(finding.confidence)}>{finding.confidence}</span>
              <span className={styles.findingKind}>{finding.kind}</span>
            </div>
            <p className={styles.entryText}>{finding.detail}</p>
            <p className={styles.entryMeta}>{finding.suggestion}</p>
          </li>
        ))}
      </ul>
    </>
  )
}

function confidenceClass(confidence: MemoryFinding['confidence']): string {
  if (confidence === 'certain') return styles.certain!
  if (confidence === 'likely') return styles.likely!
  return styles.possible!
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function Frame({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.titleRow}>
          <Check size={16} />
          <span>Memory</span>
        </div>
        {action}
      </div>
      <div className={styles.body}>{children}</div>
    </div>
  )
}

function Empty({ title, detail }: { title: string; detail?: string }) {
  return (
    <div className={styles.emptyState}>
      <div className={styles.emptyText}>{title}</div>
      {detail !== undefined && <p className={styles.emptySubtext}>{detail}</p>}
    </div>
  )
}
