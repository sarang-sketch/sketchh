// Agent Console — what was actually sent to the model, and what came back.
//
// This is the panel that makes model behavior legible: the exact messages of each
// turn, the returned text, and the token usage. Like the Timeline it is a pure
// function of the event log — it pairs `llm_request` with the `llm_response` that
// answered it and shows nothing that is not in a payload.
//
// Validates: Requirements 27.1, 27.3

import type { SketchEvent } from '../../lib/contracts'
import { useSketchEvents } from '../../lib/ClientProvider'
import styles from './AgentConsole.module.css'

interface ConsoleMessage {
  role: string
  content: string
}

export interface ConsoleTurn {
  id: string
  runId: string
  iteration: number | null
  model: string | null
  messages: ConsoleMessage[]
  /** Null while the request is still in flight — an honest pending state. */
  response: { text: string; usage: { in: number; out: number } | null } | null
}

function asMessages(value: unknown): ConsoleMessage[] {
  if (!Array.isArray(value)) return []
  return value
    .filter((m): m is Record<string, unknown> => typeof m === 'object' && m !== null)
    .map((m) => ({
      role: typeof m.role === 'string' ? m.role : 'unknown',
      content: typeof m.content === 'string' ? m.content : '',
    }))
}

function asUsage(value: unknown): { in: number; out: number } | null {
  if (typeof value !== 'object' || value === null) return null
  const usage = value as Record<string, unknown>
  if (typeof usage.in !== 'number' || typeof usage.out !== 'number') return null
  return { in: usage.in, out: usage.out }
}

function asIteration(value: unknown): number | null {
  return typeof value === 'number' ? value : null
}

/**
 * Pair each `llm_request` with its `llm_response`.
 *
 * Matching is per run and FIFO, tightened by `iteration` when both sides carry
 * one. A request with no response yet stays unpaired rather than borrowing some
 * other turn's answer.
 */
export function pairTurns(events: SketchEvent[]): ConsoleTurn[] {
  const turns: ConsoleTurn[] = []
  const pending = new Map<string, ConsoleTurn[]>()

  for (const event of events) {
    if (event.kind === 'llm_request') {
      const turn: ConsoleTurn = {
        id: event.id,
        runId: event.runId,
        iteration: asIteration(event.payload.iteration),
        model: typeof event.payload.model === 'string' ? event.payload.model : null,
        messages: asMessages(event.payload.messages),
        response: null,
      }
      turns.push(turn)
      const queue = pending.get(event.runId) ?? []
      queue.push(turn)
      pending.set(event.runId, queue)
      continue
    }

    if (event.kind !== 'llm_response') continue

    const queue = pending.get(event.runId) ?? []
    const iteration = asIteration(event.payload.iteration)
    const index =
      iteration === null ? 0 : Math.max(0, queue.findIndex((t) => t.iteration === iteration))
    const turn = queue[index]
    if (!turn) continue

    queue.splice(index, 1)
    turn.response = {
      text: typeof event.payload.text === 'string' ? event.payload.text : '',
      usage: asUsage(event.payload.usage),
    }
    if (turn.model === null && typeof event.payload.model === 'string') {
      turn.model = event.payload.model
    }
  }

  return turns
}

export interface AgentConsoleProps {
  events: SketchEvent[]
}

export function AgentConsole({ events }: AgentConsoleProps) {
  const turns = pairTurns(events)
  const totalIn = turns.reduce((sum, t) => sum + (t.response?.usage?.in ?? 0), 0)
  const totalOut = turns.reduce((sum, t) => sum + (t.response?.usage?.out ?? 0), 0)

  return (
    <div className={styles.container}>
      <div className={styles.header}>
        <span className={styles.title}>Agent Console</span>
        <span className={styles.headerMeta}>
          {turns.length} {turns.length === 1 ? 'turn' : 'turns'}
          {turns.length > 0 ? ` · ${totalIn} in / ${totalOut} out` : ''}
        </span>
      </div>

      {turns.length === 0 ? (
        <div className={styles.empty}>
          <p className={styles.emptyTitle}>No model traffic yet</p>
          <p className={styles.emptyBody}>
            Every request sent to a model and every response received will be shown
            here in full, with token usage.
          </p>
        </div>
      ) : (
        <div className={styles.turns}>
          {turns.map((turn) => (
            <section
              key={turn.id}
              className={styles.turn}
              aria-label={`Turn ${turn.iteration ?? ''} of run ${turn.runId}`}
            >
              <header className={styles.turnHeader}>
                <span className={styles.model}>{turn.model ?? 'unknown model'}</span>
                <span className={styles.turnMeta}>
                  {turn.iteration !== null ? `iteration ${turn.iteration} · ` : ''}
                  {turn.runId}
                </span>
              </header>

              <div className={styles.section}>
                <div className={styles.sectionLabel}>Request</div>
                {turn.messages.length === 0 ? (
                  <div className={styles.muted}>No messages recorded on this request.</div>
                ) : (
                  turn.messages.map((message, index) => (
                    <div key={index} className={styles.message}>
                      <span className={styles.role}>{message.role}</span>
                      <pre className={styles.content}>{message.content}</pre>
                    </div>
                  ))
                )}
              </div>

              <div className={styles.section}>
                <div className={styles.sectionLabel}>Response</div>
                {turn.response === null ? (
                  <div className={styles.pending}>Awaiting response…</div>
                ) : (
                  <>
                    <pre className={styles.content}>{turn.response.text}</pre>
                    <div className={styles.usage}>
                      {turn.response.usage
                        ? `${turn.response.usage.in} tokens in · ${turn.response.usage.out} tokens out`
                        : 'usage not reported'}
                    </div>
                  </>
                )}
              </div>
            </section>
          ))}
        </div>
      )}
    </div>
  )
}

/** Connected form — reads the seam so `AgentConsole` stays pure. */
export function AgentConsolePanel() {
  return <AgentConsole events={useSketchEvents()} />
}

export default AgentConsolePanel
