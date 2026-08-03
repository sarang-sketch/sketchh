// Tasks — one row per run, derived from the event log.
//
// ── WHAT REPLACED WHAT ──────────────────────────────────────────────────────
//
// `MOCK_TASKS` held five invented rows with invented durations ("2.4s", "45.0s"), invented
// per-row costs ("$0.15"), an invented npm error, an invented 65% progress bar, and four
// agent names ("Coder", "QA", "System", "Architect") that are not roles this product has.
// The filter dropdown above them was declared, bound to state, and NEVER APPLIED — the
// string `.filter(` did not appear in this file, so choosing "Failed" changed nothing.
// `AppState.tasks: TaskEntry[]` was a third home for the same idea and was never populated
// or read.
//
// All of it is gone. A task IS a run, and a run's story is already on the append-only log:
// `run_started` carries the prompt and the adapter, the terminal event carries `ok` and a
// `reason`, and the two timestamps are the duration. So this panel is a projection of the
// event stream, the same way the cost ledger is (Requirement 20.2's one-source rule applied
// to task state), and the filter now really filters.
//
// ── WHAT IS STILL NOT HERE, ON PURPOSE ──────────────────────────────────────
//
// A per-row cost. Attributing money to a row means pricing that row's `llm_response` events,
// and the Cost panel already does that from the one price table. A second money number here
// would be a second source, and two money numbers agree right up until they do not. The bar
// links there instead.
//
// A progress percentage. Nothing in the engine reports one — a run has an iteration count and
// a cap, not a fraction complete — so the bar shows iterations, or nothing.
//
// Validates: Requirements 27.1, 27.3, 27.4, 14.6

import { useMemo, useState } from 'react'
import {
  Activity,
  Zap,
  CheckCircle,
  AlertCircle,
  Clock,
  ChevronDown,
  ChevronRight,
} from '../components/Icons'
import { useOptionalSketchEvents } from '../lib/ClientProvider'
import { useAppDispatch } from '../state/AppState'
import type { SketchEvent } from '../lib/contracts'
import styles from './TaskLog.module.css'

type TaskStatus = 'running' | 'done' | 'failed'

const FILTERS = ['All', 'Running', 'Done', 'Failed'] as const
type Filter = (typeof FILTERS)[number]

/** One run, as this panel shows it. Every field comes off an event. */
export interface RunRow {
  runId: string
  taskId: string | null
  /** The task prompt, first line. Null when `run_started` carried none. */
  name: string | null
  status: TaskStatus
  /** The adapter id the run started with. Not a job title. */
  adapter: string | null
  /** Milliseconds between `run_started` and the terminal event. Null while running. */
  durationMs: number | null
  iterations: number | null
  maxIterations: number | null
  /** The terminal event's `reason`. Null while running. */
  reason: string | null
  /** Which strategy the dispatcher chose for this run, when a dispatch drove it. */
  strategy: string | null
  /** Verify rows on the terminal event, so a failure names the stage. */
  verify: { name: string; ok: boolean }[]
}

function firstLine(value: unknown): string | null {
  if (typeof value !== 'string') return null
  const line = value.trim().split('\n')[0] ?? ''
  return line === '' ? null : line
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value !== '' ? value : null
}

function optionalNumber(value: unknown): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? value : null
}

/**
 * The dispatch a sub-run belongs to, or null when this id was not minted by a dispatcher.
 *
 * The engine derives sub-run ids as `<dispatchId>-r<n>` (see `strategy/dispatcher.ts`), which
 * is deliberate: it is distinct even under a frozen clock and it is READABLE, so a person —
 * and this function — can see the parent without a second lookup.
 */
export function dispatchIdOf(runId: string): string | null {
  const match = /^(.+)-r\d+$/.exec(runId)
  return match === null ? null : match[1]!
}

/**
 * Group the log into one row per run, in the order the runs started.
 *
 * Exported so the test drives the real projection rather than a copy of it. A run with no
 * `run_started` (a slice the user scrolled into halfway) still produces a row, because
 * dropping it would silently hide a run that really happened.
 */
export function projectRuns(events: readonly SketchEvent[]): RunRow[] {
  const rows = new Map<string, RunRow>()
  const startedAt = new Map<string, number>()
  /**
   * dispatch id → the strategy of the attempt currently in flight.
   *
   * Filled as the log is read, and consulted when a sub-run's row is CREATED. An earlier
   * version walked the existing rows when the dispatcher event arrived, which found nothing:
   * the dispatcher emits its attempt event BEFORE the sub-run it is about to start, so the
   * row did not exist yet. A test caught it.
   */
  const currentStrategy = new Map<string, string>()

  const rowFor = (runId: string): RunRow => {
    const existing = rows.get(runId)
    if (existing !== undefined) return existing
    const created: RunRow = {
      runId,
      taskId: null,
      name: null,
      status: 'running',
      adapter: null,
      durationMs: null,
      iterations: null,
      maxIterations: null,
      reason: null,
      // Sub-run ids are derived as `<dispatchId>-r<n>`, so a row can name the strategy that
      // started it without the dispatcher having to repeat itself per run.
      strategy: currentStrategy.get(dispatchIdOf(runId) ?? '') ?? null,
      verify: [],
    }
    rows.set(runId, created)
    return created
  }

  for (const event of events) {
    const payload = event.payload as Record<string, unknown>

    if (event.kind === 'run_started') {
      const row = rowFor(event.runId)
      row.taskId = optionalString(payload['taskId'])
      row.name = firstLine(payload['prompt'])
      row.adapter = optionalString(payload['adapter'])
      row.maxIterations = optionalNumber(payload['maxIterations'])
      startedAt.set(event.runId, event.ts)
      continue
    }

    if (event.kind === 'run_completed' || event.kind === 'run_failed') {
      const row = rowFor(event.runId)
      row.status = event.kind === 'run_completed' ? 'done' : 'failed'
      row.reason = optionalString(payload['reason'])
      row.iterations = optionalNumber(payload['iterations'])
      const started = startedAt.get(event.runId)
      row.durationMs = started === undefined ? null : Math.max(0, event.ts - started)
      const verify = payload['verify']
      if (Array.isArray(verify)) {
        row.verify = verify.flatMap((entry) => {
          if (entry === null || typeof entry !== 'object') return []
          const record = entry as Record<string, unknown>
          const name = optionalString(record['name'])
          return name === null ? [] : [{ name, ok: record['ok'] === true }]
        })
      }
      continue
    }

    if (event.kind === 'llm_request' || event.kind === 'llm_response') {
      const row = rowFor(event.runId)
      const iteration = optionalNumber(payload['iteration'])
      // While a run is in flight the highest iteration seen IS its progress, and it is the
      // only progress figure the engine actually reports.
      if (iteration !== null && (row.iterations === null || iteration > row.iterations)) {
        row.iterations = iteration
      }
      continue
    }

    // The dispatcher's own slice is not a run — nothing emits `run_started` under a dispatch
    // id, so it never becomes a row, which is right: a ladder is not a task. What it does
    // carry is which strategy is about to run, and the sub-runs that follow belong to it.
    //
    // The `component` check is still load-bearing, for a narrower reason than before. The
    // Phase 8 cost router used to emit this same KIND with `component: 'router'` and a
    // `policy` key; the `EventKind` amendment moved it to `model_selected`, so live runs no
    // longer collide. But JSONL logs written before the amendment still carry router events
    // under `strategy_selected`, and reading one as a strategy would label a run with a
    // strategy nobody chose. So the check stays and old logs keep rendering correctly.
    if (
      event.kind === 'strategy_selected' &&
      payload['component'] === 'dispatcher' &&
      payload['phase'] === 'attempt'
    ) {
      const strategy = optionalString(payload['strategy'])
      if (strategy !== null) currentStrategy.set(event.runId, strategy)
    }
  }

  // The dispatch slice itself never became a row because nothing emitted `run_started` under
  // it, which is correct: it is a ladder, not a task.
  return [...rows.values()]
}

function formatDuration(ms: number | null): string {
  if (ms === null) return 'running'
  if (ms < 1000) return `${ms}ms`
  const seconds = ms / 1000
  return seconds < 60 ? `${seconds.toFixed(1)}s` : `${Math.floor(seconds / 60)}m ${Math.round(seconds % 60)}s`
}

function matchesFilter(row: RunRow, filter: Filter): boolean {
  switch (filter) {
    case 'All':
      return true
    case 'Running':
      return row.status === 'running'
    case 'Done':
      return row.status === 'done'
    case 'Failed':
      return row.status === 'failed'
  }
}

export function TaskLog() {
  const dispatch = useAppDispatch()
  const events = useOptionalSketchEvents()
  const [filter, setFilter] = useState<Filter>('All')
  const [expanded, setExpanded] = useState<string | null>(null)

  const rows = useMemo(() => projectRuns(events), [events])
  // THE FILTER IS APPLIED. It was declared and ignored before this task.
  const shown = useMemo(() => rows.filter((row) => matchesFilter(row, filter)), [rows, filter])

  const statusIcon = (status: TaskStatus) => {
    switch (status) {
      case 'running':
        return <div className={styles.spinner} />
      case 'done':
        return <CheckCircle size={14} className={styles.iconDone} />
      case 'failed':
        return <AlertCircle size={14} className={styles.iconFailed} />
    }
  }

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <div className={styles.titleRow}>
          <Activity size={16} />
          <span>Tasks</span>
        </div>
        <select
          className={styles.filterDropdown}
          value={filter}
          onChange={(e) => setFilter(e.target.value as Filter)}
          aria-label="Filter tasks by status"
        >
          {FILTERS.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
      </div>

      {/* The `$1.4025` cost bar is GONE (task 8.4). It was the same invented string the
          status bar carried, and a third copy lived in `AppState.totalCost`. The real
          total is summed from the event log by the Cost panel, which is the one source
          Requirement 20.2 requires. A link, not a number: a second figure here would be
          a second source, and two money numbers disagree eventually. */}
      <button
        type="button"
        className={styles.costBar}
        onClick={() => dispatch({ type: 'SET_ACTIVE_PANEL', payload: 'cost' })}
      >
        <Zap size={14} className={styles.zapIcon} />
        <span>Session cost is summed from the event log — open the Cost panel</span>
      </button>

      <div className={styles.timeline}>
        {rows.length === 0 && (
          <div className={styles.taskDetails}>
            <div className={styles.logText}>
              No task has run in this session. Rows appear here as runs emit events; there is
              nothing to show before one does.
            </div>
          </div>
        )}

        {rows.length > 0 && shown.length === 0 && (
          <div className={styles.taskDetails}>
            <div className={styles.logText}>
              {rows.length} run{rows.length === 1 ? '' : 's'} in this session, none of them{' '}
              {filter.toLowerCase()}.
            </div>
          </div>
        )}

        {shown.map((row, idx) => (
          <div key={row.runId} className={styles.taskItem}>
            <div className={styles.timelineLine}>
              <div className={styles.timelineDot}>{statusIcon(row.status)}</div>
              {idx < shown.length - 1 && <div className={styles.timelineConnector} />}
            </div>

            <div className={styles.taskContent}>
              <div
                className={styles.taskHeader}
                onClick={() => setExpanded(expanded === row.runId ? null : row.runId)}
              >
                <div className={styles.taskMain}>
                  <span className={styles.taskName}>
                    {row.name ?? `run ${row.runId}`}
                  </span>
                  {row.adapter !== null && <span className={styles.agentBadge}>{row.adapter}</span>}
                  {row.strategy !== null && (
                    <span className={styles.agentBadge}>{row.strategy}</span>
                  )}
                </div>

                <div className={styles.taskMeta}>
                  <div className={styles.duration}>
                    <Clock size={12} />
                    <span>{formatDuration(row.durationMs)}</span>
                  </div>
                  {expanded === row.runId ? <ChevronDown size={14} /> : <ChevronRight size={14} />}
                </div>
              </div>

              {row.status === 'running' && row.iterations !== null && row.maxIterations !== null && (
                <div className={styles.progressContainer}>
                  {/* Iterations against the cap. Not an invented percentage: this is the only
                      progress figure the engine reports. */}
                  <div
                    className={styles.progressBar}
                    style={{
                      width: `${Math.min(100, (row.iterations / Math.max(1, row.maxIterations)) * 100)}%`,
                    }}
                  />
                </div>
              )}

              {expanded === row.runId && (
                <div className={styles.taskDetails}>
                  {row.status === 'failed' ? (
                    <div className={styles.errorLog}>
                      {row.reason ?? 'the terminal event carried no reason'}
                      {row.verify.filter((entry) => !entry.ok).length > 0 && (
                        <>
                          <br />
                          failed stages:{' '}
                          {row.verify
                            .filter((entry) => !entry.ok)
                            .map((entry) => entry.name)
                            .join(', ')}
                        </>
                      )}
                    </div>
                  ) : (
                    <div className={styles.logText}>
                      run {row.runId}
                      <br />
                      {row.taskId === null ? 'no task id on the log' : `task ${row.taskId}`}
                      <br />
                      {row.iterations === null
                        ? 'no iteration recorded yet'
                        : `${row.iterations} iteration${row.iterations === 1 ? '' : 's'}${
                            row.maxIterations === null ? '' : ` of at most ${row.maxIterations}`
                          }`}
                      <br />
                      {row.verify.length === 0
                        ? 'no verify stage ran'
                        : `verify: ${row.verify
                            .map((entry) => `${entry.name} ${entry.ok ? 'PASS' : 'FAIL'}`)
                            .join(', ')}`}
                      {row.reason !== null && (
                        <>
                          <br />
                          reason: {row.reason}
                        </>
                      )}
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        ))}
      </div>
    </div>
  )
}
