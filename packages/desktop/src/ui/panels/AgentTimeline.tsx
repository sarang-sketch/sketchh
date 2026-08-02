// Timeline — a run, reconstructed from its event log and nothing else.
//
// Req 27.2: the Timeline must be able to rebuild a run from events alone. So this
// component takes `SketchEvent[]` and reads no other state: no side-channel run
// table, no status flags, no fixtures. Everything on screen — grouping, ordering,
// elapsed time, outcome — is derived from the log.
//
// Req 27.3: with no events it says so, and offers no sample data.
//
// Validates: Requirements 27.2, 27.3

import { useState } from 'react'
import type { SketchEvent } from '../../lib/contracts'
import { useEngineStatus, useSketchEvents, useOptionalSketchClient } from '../../lib/ClientProvider'
import styles from './AgentTimeline.module.css'

export interface AgentTimelineProps {
  events: SketchEvent[]
  /** Shown in the header so the surface names its transport honestly. */
  transportLabel?: string
}

interface RunGroup {
  runId: string
  events: SketchEvent[]
  startedTs: number
}

/** Group by runId, preserving first-seen order. Derived purely from the log. */
export function groupByRun(events: SketchEvent[]): RunGroup[] {
  const groups = new Map<string, RunGroup>()
  for (const event of events) {
    const existing = groups.get(event.runId)
    if (existing) existing.events.push(event)
    else groups.set(event.runId, { runId: event.runId, events: [event], startedTs: event.ts })
  }
  return [...groups.values()]
}

export function formatOffset(ms: number): string {
  if (ms < 1000) return `+${ms}ms`
  return `+${(ms / 1000).toFixed(1)}s`
}

/** Terminal events tell us the outcome; dispatcher outcomes are terminal for their own slice. */
function runOutcome(events: SketchEvent[]): 'running' | 'completed' | 'failed' {
  let dispatcherOutcome: 'completed' | 'failed' | null = null
  for (const event of events) {
    if (event.kind === 'run_failed') return 'failed'
    if (event.kind === 'run_completed') return 'completed'
    if (event.kind === 'strategy_selected' && event.payload['phase'] === 'outcome') {
      dispatcherOutcome = event.payload['ok'] === true ? 'completed' : 'failed'
    }
  }
  return dispatcherOutcome ?? 'running'
}

/** One-line gist of an event, pulled from its payload with no assumptions. */
function summarize(event: SketchEvent): string {
  const p = event.payload
  switch (event.kind) {
    case 'run_started':
      return typeof p.prompt === 'string' ? p.prompt : ''
    case 'llm_request':
      return [p.model, Array.isArray(p.messages) ? `${p.messages.length} messages` : null]
        .filter(Boolean)
        .join(' · ')
    case 'llm_response': {
      const usage = p.usage as { in?: number; out?: number } | undefined
      const tokens = usage ? `${usage.in ?? 0} in / ${usage.out ?? 0} out` : null
      return [p.model, tokens].filter(Boolean).join(' · ')
    }
    case 'plan_written':
      return typeof p.dir === 'string' ? p.dir : ''
    case 'verify_started':
      return Array.isArray(p.commands) ? p.commands.join(', ') : ''
    case 'verify_result':
      return `${p.name ?? 'verify'} — ${p.ok ? 'pass' : `fail (exit ${p.exitCode ?? '?'})`}`
    case 'strategy_selected': {
      const phase = typeof p.phase === 'string' ? p.phase : 'selection'
      if (phase === 'roles') {
        const verifiable = Array.isArray(p.verifiable) ? p.verifiable.length : 0
        const skipped = Array.isArray(p.skipped) ? p.skipped.length : 0
        return `${p.strategy ?? 'strategy'} · ${verifiable} verifiable · ${skipped} skipped`
      }
      if (phase === 'outcome') {
        return `${p.succeeded ?? 'no strategy'} · ${p.ok ? 'completed' : 'failed'}`
      }
      return `${p.strategy ?? 'strategy'} · ${phase}`
    }
    case 'budget_exceeded':
      return `${p.limit ?? 'budget'} · ${p.outcome ?? 'stopped'}`
    case 'run_completed':
      return `${p.ok ? 'ok' : 'not ok'} · ${p.iterations ?? '?'} iterations`
    case 'run_failed':
      return typeof p.error === 'string'
        ? p.error
        : typeof p.detail === 'string'
          ? p.detail
          : typeof p.reason === 'string'
            ? p.reason
            : 'run failed'
    default:
      return ''
  }
}

export function AgentTimeline({ events, transportLabel }: AgentTimelineProps) {
  const [expanded, setExpanded] = useState<Set<string>>(new Set())
  const client = useOptionalSketchClient()

  const toggle = (id: string) =>
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(id)) next.delete(id)
      else next.add(id)
      return next
    })

  const handleCaptureRun = async (run: RunGroup) => {
    if (!client || typeof client.captureEval !== 'function') return
    try {
      const promptEvent = run.events.find(e => e.kind === 'run_started')
      const prompt = typeof promptEvent?.payload?.prompt === 'string' ? promptEvent.payload.prompt : 'Captured run'
      await client.captureEval({
        run: {
          runId: run.runId,
          ok: runOutcome(run.events) === 'completed',
          finalText: prompt,
          iterations: run.events.length,
          verify: [],
          events: run.events,
        },
        want: { checks: [{ kind: 'verify-pass' }] },
      })
    } catch {
      // capture error handler
    }
  }

  const runs = groupByRun(events)

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <span className={styles.title}>Timeline</span>
        <span className={styles.headerMeta}>
          {transportLabel ? <span className={styles.transport}>{transportLabel}</span> : null}
          <span>
            {events.length} {events.length === 1 ? 'event' : 'events'}
          </span>
        </span>
      </div>

      {runs.length === 0 ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>No events yet</p>
          <p className={styles.emptyBody}>
            The timeline is built from the engine's event log. Start a run and every
            event appears here as it is emitted.
          </p>
        </div>
      ) : (
        <div className={styles.runs}>
          {runs.map((run) => {
            const outcome = runOutcome(run.events)
            return (
              <section key={run.runId} className={styles.run} aria-label={`Run ${run.runId}`}>
                <header className={styles.runHeader}>
                  <span className={styles.runId}>{run.runId}</span>
                  <span className={`${styles.outcome} ${styles[outcome]}`}>{outcome}</span>
                  {outcome !== 'running' && (
                    <button 
                      type="button" 
                      className={styles.captureBtn}
                      title="Save run as evaluation case"
                      onClick={() => handleCaptureRun(run)}
                    >
                      Save as Eval
                    </button>
                  )}
                </header>

                <ol className={styles.events}>
                  {run.events.map((event) => {
                    const isOpen = expanded.has(event.id)
                    const summary = summarize(event)
                    return (
                      <li key={event.id} className={styles.event}>
                        <button
                          type="button"
                          className={styles.eventRow}
                          aria-expanded={isOpen}
                          onClick={() => toggle(event.id)}
                        >
                          <span className={styles.offset}>
                            {formatOffset(event.ts - run.startedTs)}
                          </span>
                          <span className={styles.kind}>{event.kind}</span>
                          <span className={styles.summary}>{summary}</span>
                        </button>
                        {isOpen && (
                          <pre className={styles.payload}>
                            {JSON.stringify(event.payload, null, 2)}
                          </pre>
                        )}
                      </li>
                    )
                  })}
                </ol>
              </section>
            )
          })}
        </div>
      )}
    </div>
  )
}

/**
 * Connected form. The seam is read here so `AgentTimeline` itself stays a pure
 * function of the event log.
 */
export function AgentTimelinePanel() {
  const events = useSketchEvents()
  const status = useEngineStatus()
  const label =
    status.state === 'error'
      ? `engine unavailable: ${status.error ?? 'unknown error'}`
      : status.ping
        ? `${status.ping.transport} · v${status.ping.version}`
        : 'connecting'

  return <AgentTimeline events={events} transportLabel={label} />
}

export default AgentTimelinePanel
