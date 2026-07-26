// The tee: an `EventStore` decorator that streams what the real store persisted.
//
// Requirement 12.6 wants run progress to reach the caller AS IT HAPPENS, not
// bundled into the response at the end. The engine already funnels every step of
// a run through one `EventStore`, so the streaming seam is a decorator around it
// rather than a second notification path that could drift from the log.
//
// WHY IT READS THE EVENT BACK INSTEAD OF RE-STAMPING IT
// The obvious implementation stamps an id and a timestamp, sanitizes the payload
// itself, and writes that to stdout while handing the raw input to the inner
// store. That bypasses the store's write path twice over: the streamed event
// would carry a DIFFERENT id from the persisted one (so a UI could not correlate
// a streamed event with the line on disk it came from), and its payload would be
// sanitized by a second call site — which is exactly the arrangement
// `sanitizePayload`-on-the-write-path exists to prevent (Requirement 3.7). One
// forgotten `secrets` argument here and a key reaches stdout while the log stays
// clean.
//
// So: emit to the inner store first, then ask it what it stored and stream that.
// The frame carries the persisted event byte-for-byte, already sanitized by the
// store, with the same id the log has.
//
// COST. `forRun` on the JSONL store re-reads the day's file per emit, so this is
// quadratic in events-per-day for a long-lived log. Accepted for now: a run emits
// tens of events, and the alternative is a second sanitation path. The clean fix
// is for `EventStore.emit` to return the event it stored — a change inside
// `src/events/`, which this task is not permitted to make.
//
// Validates: Requirements 12.6, 3.7

import type { EventStore, EventInput } from '../events/store.js'
import type { SketchEvent } from '../types.js'

/** Called once per persisted event, in emission order. */
export type EventSink = (event: SketchEvent) => void

export class StreamingEventStore implements EventStore {
  readonly #inner: EventStore
  readonly #sink: EventSink
  /** Ids already streamed, so a re-read never double-delivers. */
  readonly #streamed = new Set<string>()

  constructor(inner: EventStore, sink: EventSink) {
    this.#inner = inner
    this.#sink = sink
  }

  async emit(input: EventInput): Promise<void> {
    await this.#inner.emit(input)

    let persisted: SketchEvent[]
    try {
      persisted = await this.#inner.forRun(input.runId)
    } catch {
      // A failed read-back must not fail the run: the event IS stored, only the
      // stream missed it. The response still carries the full event list.
      return
    }

    for (const event of persisted) {
      if (this.#streamed.has(event.id)) continue
      this.#streamed.add(event.id)
      try {
        this.#sink(event)
      } catch {
        // A broken pipe on stdout must not abort the run.
      }
    }
  }

  readAll(): Promise<SketchEvent[]> {
    return Promise.resolve(this.#inner.readAll())
  }

  forRun(runId: string): Promise<SketchEvent[]> {
    return Promise.resolve(this.#inner.forRun(runId))
  }
}
