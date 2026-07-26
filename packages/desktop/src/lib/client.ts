// The client seam.
//
// Every call the UI makes into the engine goes through `SketchClient`. Three
// implementations live behind it — mock (this phase), stdio sidecar (task 2.1),
// http dev bridge (task 2.2) — and exactly one factory chooses between them
// (./factory.ts). No React component may import a concrete implementation.
//
// Validates: Requirements 13.1, 13.3

import type { EvalCase, EvalResult, RunResult, SketchEvent, Task } from './contracts'

/** Which transport is live. Reported by `ping` so the UI can name it honestly. */
export type TransportKind = 'mock' | 'stdio' | 'http'

export interface PingResult {
  ok: boolean
  /** Engine version string as reported by the engine itself. */
  version: string
  transport: TransportKind
}

export type EventHandler = (event: SketchEvent) => void

/** Calling the returned function detaches the handler. Idempotent. */
export type Unsubscribe = () => void

export interface SketchClient {
  /** Which implementation this is. Surfaced in the UI; never branched on by panels. */
  readonly transport: TransportKind

  /** Liveness check against the engine. Must succeed offline with no API key. */
  ping(): Promise<PingResult>

  /**
   * Run a task to completion.
   *
   * `run` is long-lived: it resolves only when the run finishes. Progress is not
   * carried by the promise — it arrives on `subscribe` as the run proceeds, which
   * is what lets the Timeline fill in live instead of blinking into existence at
   * completion. The resolved `RunResult.events` is the same sequence, replayed,
   * so a caller that never subscribed still gets the whole log.
   */
  run(task: Task): Promise<RunResult>

  /** Score eval cases through the harness. */
  eval(cases: EvalCase[]): Promise<EvalResult[]>

  /**
   * Attach a handler to the engine's event stream. Called for every event from
   * every run, in emission order. Subscribing mid-run yields only subsequent
   * events; the accumulated log is held by the client provider, not here.
   */
  subscribe(handler: EventHandler): Unsubscribe
}

/**
 * Minimal fan-out used by the client implementations. Handlers are snapshotted
 * before dispatch so a handler that unsubscribes (or subscribes) during dispatch
 * cannot corrupt the iteration, and a throwing handler cannot starve the rest.
 */
export function createEventBus() {
  const handlers = new Set<EventHandler>()

  return {
    subscribe(handler: EventHandler): Unsubscribe {
      handlers.add(handler)
      return () => {
        handlers.delete(handler)
      }
    },
    emit(event: SketchEvent): void {
      for (const handler of [...handlers]) {
        try {
          handler(event)
        } catch (err) {
          // A broken panel must not break the engine's event stream.
          console.error('[sketch] event handler threw', err)
        }
      }
    },
    get size() {
      return handlers.size
    },
  }
}

export type EventBus = ReturnType<typeof createEventBus>
