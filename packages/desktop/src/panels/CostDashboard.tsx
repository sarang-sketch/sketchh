// Cost — what this project's runs actually cost, summed from the event log.
//
// ── WHAT REPLACED WHAT ──────────────────────────────────────────────────────
//
// `$1.4025` was rendered in two places (`StatusBar` and `TaskLog`) and stored a third
// time as `AppState.totalCost: 12.45`. Three numbers, none of them related to each other
// or to anything that happened. All three are gone.
//
// ── THERE IS NO RUNNING TOTAL, ANYWHERE ────────────────────────────────────
//
// Requirement 20.2: the session total is the sum over events with no independent source.
// So this panel holds no counter, does not accumulate as events stream in, and does not
// keep a subtotal between fetches. It asks the engine, which reads the JSONL log and
// calls `ledgerFor`. Refreshing recomputes from the bytes.
//
// That is not fussiness. A counter and a log are two sources that agree right up until
// they do not, and when a MONEY number disagrees with itself the user cannot tell which
// half to believe. It is also what makes the reconciliation testable as an equality
// rather than a tolerance: the panel's total and the log's sum are the same computation.
//
// ── EVERY ROW LINKS BACK TO A LOG LINE ─────────────────────────────────────
//
// Each call shows its event id. A total a user cannot audit is a total they cannot
// challenge, and "trust me, it was $4.12" is not a feature.
//
// ── UNKNOWN IS SHOWN AS UNKNOWN ────────────────────────────────────────────
//
// A model that is not in the price table reports `null`, and this panel says "cost
// unknown" and counts those calls. It does NOT render them as $0.00. Showing unknown as
// free is how a user leaves something running and finds out from an invoice, and it is
// the one failure mode this whole phase exists to prevent.
//
// Validates: Requirements 20.1, 20.2, 20.7, 20.8, 27.1, 14.6

import { useCallback, useEffect, useRef, useState } from 'react'
import { AlertCircle, Refresh, Zap } from '../components/Icons'
import { useSketchClient } from '../lib/ClientProvider'
import { useAppState } from '../state/AppState'
import type { CostEntry, CostReport, UsageSummary } from '../lib/client'
import styles from './CostDashboard.module.css'

/** Human label per non-run cause. */
const CAUSE_LABELS: Record<string, string> = {
  completion: 'Inline completions',
  'inline-edit': 'Inline edits',
  'commit-message': 'Commit messages',
  'connection-test': 'Connection tests',
  'model-list': 'Model listing',
}

export function CostDashboard() {
  const { projectRoot } = useAppState()
  const client = useSketchClient()

  const [report, setReport] = useState<CostReport | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [loading, setLoading] = useState(false)
  const [usage, setUsage] = useState<UsageSummary | null>(null)
  const generation = useRef(0)

  const canRead = client.cost !== undefined

  const refresh = useCallback(
    async (root: string) => {
      const call = client.cost
      if (call === undefined) return
      generation.current += 1
      const ticket = generation.current
      setLoading(true)
      setError(null)
      try {
        // Recomputed from the log every time. Nothing is carried over.
        const answer = await call.call(client, { root })
        if (generation.current !== ticket) return
        setReport(answer)
      } catch (err) {
        if (generation.current !== ticket) return
        setReport(null)
        setError(`The cost log could not be read: ${message(err)}`)
      } finally {
        if (generation.current === ticket) setLoading(false)
      }
      // Non-run calls (completions, inline edits, …) live in ~/.sketch/usage, not the
      // project log, so they are fetched separately. A failure here is not fatal to the
      // main cost view.
      const usageCall = client.costUsage
      if (usageCall !== undefined) {
        try {
          const answer = await usageCall.call(client, {})
          if (generation.current === ticket) setUsage(answer)
        } catch {
          if (generation.current === ticket) setUsage(null)
        }
      }
    },
    [client],
  )

  useEffect(() => {
    if (projectRoot === null) {
      setReport(null)
      setError(null)
      return
    }
    void refresh(projectRoot)
  }, [projectRoot, refresh])

  if (projectRoot === null) {
    return (
      <Frame>
        <Empty
          title="No folder opened"
          detail="Cost is summed from the event log in the open project, under .sketch/events/. Open a folder first."
        />
      </Frame>
    )
  }

  if (!canRead) {
    return (
      <Frame>
        <Empty
          title="No engine behind this transport"
          detail={`The ${client.transport} transport does not implement cost, so there is nothing to sum. An invented total would be an invented invoice, which is exactly what the hardcoded $1.4025 this panel replaced was.`}
        />
      </Frame>
    )
  }

  return (
    <Frame
      action={
        <button
          type="button"
          className={styles.refreshButton}
          onClick={() => void refresh(projectRoot)}
          disabled={loading}
        >
          <Refresh size={12} />
          <span>{loading ? 'Reading…' : 'Refresh'}</span>
        </button>
      }
    >
      {error !== null && (
        <div className={styles.error} role="alert">
          <AlertCircle size={13} />
          <span>{error}</span>
        </div>
      )}

      {report !== null && (
        <>
          <Total report={report} />

          {/* A price table with no date implies live pricing. It is not live, and it
              cannot be without a network call this product refuses to make. */}
          <p className={styles.pricedAt}>
            Prices as published on {report.pricedAt}
            {report.stale && (
              <strong className={styles.staleMark}>
                {' '}
                — this table is old enough that the figures above may be wrong. Update
                cost/pricing.ts.
              </strong>
            )}
          </p>

          {report.skipped > 0 && (
            <p className={styles.warning}>
              <AlertCircle size={12} />
              <span>
                {report.skipped} log line(s) could not be read and are NOT counted, so the total
                is a lower bound.
              </span>
            </p>
          )}

          {report.runs.length > 0 && (
            <>
              <h3 className={styles.sectionTitle}>By run</h3>
              <ul className={styles.runs} aria-label="Cost by run">
                {report.runs.map((run) => (
                  <li key={run.runId} className={styles.run}>
                    <code className={styles.runId}>{run.runId}</code>
                    <span className={styles.runMoney}>
                      {run.unpriced === run.calls && run.calls > 0
                        ? 'unknown'
                        : run.allLocal
                          ? '$0.00'
                          : `$${run.usd.toFixed(4)}`}
                    </span>
                    <span className={styles.runMeta}>
                      {run.calls} call(s) · {run.tokensIn} in / {run.tokensOut} out
                      {run.cacheHits > 0 ? ` · ${run.cacheHits} cached` : ''}
                      {run.unpriced > 0 ? ` · ${run.unpriced} unpriced` : ''}
                    </span>
                  </li>
                ))}
              </ul>
            </>
          )}

          <h3 className={styles.sectionTitle}>Every call</h3>
          {report.entries.length === 0 ? (
            <p className={styles.footNote}>
              No model call has been recorded in this project yet. This is the honest zero: it
              means nothing ran, not that everything was free.
            </p>
          ) : (
            <ul className={styles.entries} aria-label="Every priced model call">
              {report.entries.map((entry) => (
                <Row key={entry.eventId} entry={entry} />
              ))}
            </ul>
          )}

          <p className={styles.footNote}>
            Every figure here is summed from {report.root}/.sketch/events/. There is no separate
            counter to disagree with it, and each row above names the log line it came from.
          </p>

          <NotTiedToAMessage usage={usage} />
        </>
      )}
    </Frame>
  )
}

/**
 * Model calls NOT tied to a message — completions, inline edits, commit messages,
 * connection tests, model listing — grouped by cause, read from ~/.sketch/usage. These
 * never enter a project's event log. Unknown tokens are shown as unknown, never as 0.
 */
function NotTiedToAMessage({ usage }: { usage: UsageSummary | null }) {
  if (usage === null || usage.total.calls === 0) return null
  return (
    <>
      <h3 className={styles.sectionTitle}>Model calls not tied to a message</h3>
      <ul className={styles.runs} aria-label="Model calls not tied to a message">
        {usage.byCause.map((c) => {
          const tokens = c.tokensIn + c.tokensOut
          return (
            <li key={c.cause} className={styles.run}>
              <code className={styles.runId}>{CAUSE_LABELS[c.cause] ?? c.cause}</code>
              <span className={styles.runMoney}>
                {c.calls} call{c.calls === 1 ? '' : 's'}
              </span>
              <span className={styles.runMeta}>
                {tokens > 0 ? `${c.tokensIn} in / ${c.tokensOut} out` : 'no tokens'}
                {c.usageUnknown > 0 ? ` · tokens unknown for ${c.usageUnknown}` : ''}
                {c.usageEstimated > 0 ? ` · ${c.usageEstimated} estimated` : ''}
                {c.failed > 0 ? ` · ${c.failed} failed` : ''}
              </span>
            </li>
          )
        })}
      </ul>
      <p className={styles.footNote}>
        These are summed from the engine's ~/.sketch/usage log, which records a cause, provider
        and token count per call and never a key, a prompt, or a reply. They are kept out of the
        project event log so a completion on every typing pause does not bury your runs.
      </p>
    </>
  )
}

/** The headline. Says "unknown" when it is unknown. */
function Total({ report }: { report: CostReport }) {
  const { total } = report
  const nothingRan = total.calls === 0 && total.cacheHits === 0
  const allUnknown = total.calls > 0 && total.unpriced === total.calls
  // Present on the ledger total; the client type does not yet declare them, so read
  // narrowly. These are the invariant-3 honesty counts.
  const usageUnknown = (total as { usageUnknown?: number }).usageUnknown ?? 0
  const usageEstimatedCalls = (total as { usageEstimatedCalls?: number }).usageEstimatedCalls ?? 0

  return (
    <div className={styles.total} role="status">
      <div className={styles.totalMoney}>
        <Zap size={16} className={styles.zap} />
        <span className={styles.amount}>
          {nothingRan ? '—' : allUnknown ? 'unknown' : total.allLocal ? '$0.00' : `$${total.usd.toFixed(4)}`}
        </span>
      </div>
      {/* The engine's own wording, so the UI does not invent a second way to say
          unknown and then disagree with the sentence in the log. */}
      <p className={styles.summary}>{report.summary}</p>

      {total.allLocal && total.calls > 0 && (
        <p className={styles.note}>
          Every call ran on a model on this machine, so this zero is a real price rather than a
          missing one.
        </p>
      )}
      {total.unpriced > 0 && (
        <p className={styles.warning}>
          <AlertCircle size={12} />
          <span>
            {total.unpriced} of {total.calls} call(s) used a model that is not in the price
            table, so their cost is unknown and is not in the figure above. The total is a lower
            bound.
          </span>
        </p>
      )}
      {usageUnknown > 0 && (
        <p className={styles.warning}>
          <AlertCircle size={12} />
          <span>
            Tokens are unknown for {usageUnknown} of {total.calls} call(s) — the provider reported
            none — so they are shown as unknown here, never as 0, and their cost is unknown.
          </span>
        </p>
      )}
      {usageEstimatedCalls > 0 && (
        <p className={styles.note}>
          {usageEstimatedCalls} call(s) used the offline test provider, whose token numbers are
          estimates (~characters/4), not a provider's own count.
        </p>
      )}
      {total.cacheHits > 0 && (
        <p className={styles.note}>
          {total.cacheHits} request(s) were answered from the cache and made no network call
          {total.savedUsd > 0 ? `, avoiding about $${total.savedUsd.toFixed(4)}` : ''}.
        </p>
      )}
    </div>
  )
}

/** One call, with the log line it came from. */
function Row({ entry }: { entry: CostEntry }) {
  // The model the provider NAMED when a router answered with a different one than
  // requested. Present on the ledger entry; the client type does not yet declare it,
  // so it is read narrowly and shown only when it differs.
  const requestedModel = (entry as { requestedModel?: string | null }).requestedModel ?? null
  return (
    <li className={styles.entry}>
      <span className={entry.usd === null ? styles.unknownMoney : styles.entryMoney}>
        {entry.usd === null ? 'unknown' : `$${entry.usd.toFixed(6)}`}
      </span>
      <span className={styles.entryModel}>
        {entry.model ?? <span className={styles.unnamed}>model not recorded</span>}
        {requestedModel !== null && requestedModel !== entry.model && (
          <span className={styles.localMark} title={`Requested ${requestedModel}; a router answered with ${entry.model}`}>
            {' '}← {requestedModel}
          </span>
        )}
        {entry.local && <span className={styles.localMark}> local</span>}
      </span>
      <span className={styles.entryMeta}>
        {entry.usage.in} in / {entry.usage.out} out
        {entry.iteration !== null ? ` · turn ${entry.iteration}` : ''}
      </span>
      {/* The audit trail. A total a user cannot trace is one they cannot challenge. */}
      <code className={styles.eventId} title={`Event ${entry.eventId} in run ${entry.runId}`}>
        {entry.eventId}
      </code>
    </li>
  )
}

function message(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function Frame({ children, action }: { children: React.ReactNode; action?: React.ReactNode }) {
  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.titleRow}>
          <Zap size={16} />
          <span>Cost</span>
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
