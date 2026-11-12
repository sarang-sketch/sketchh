// The offline provider: a scripted `ChatAdapter` that never touches the network.
//
// This is the reason every phase gate in this project can pass at $0 with no API
// key (constraint C2). The eval harness, the SkillOpt trainer, and the agent loop
// all resolve a `ChatAdapter`; point that seam here and the whole system runs
// deterministically offline.
//
// The default script walks the model action protocol from design.md:
//   call 1 → { "action": "plan", "artifacts": { prd, arch, schema, tests } }
//   call 2 → { "action": "verify" }
//   call 3 → { "action": "done", "text": … }
//
// Past the end of the script the LAST response repeats rather than throwing or
// cycling, so a loop configured with a higher iteration cap terminates on `done`
// instead of dying on an exhausted fake.
//
// There is deliberately no `fetch` in this file — not imported, not referenced.
//
// Validates: Requirements 2.7, 1.6

import type { ChatAdapter, Message, Usage } from '../types.js'

/** Call 1: the plan action, in the exact shape the design's protocol specifies. */
export const FAKE_PLAN_RESPONSE = JSON.stringify({
  action: 'plan',
  artifacts: {
    prd: '# PRD\n\nOffline fixture: the user wants the scripted happy path.',
    arch: '# Architecture\n\nOne module, one seam, no network.',
    schema: '# Schema\n\nNo persistent state for this fixture.',
    tests: '# Tests\n\nRun the configured verify commands and expect PASS.',
  },
})

/** Call 2: hand control to the verify stage. Byte-for-byte what Req 2.7 names. */
export const FAKE_VERIFY_RESPONSE = '{"action":"verify"}'

/** Call 3 and every call after it: terminate the loop. */
export const FAKE_DONE_RESPONSE = JSON.stringify({
  action: 'done',
  text: 'Offline fixture run complete.',
})

/** The three-call sequence `SKETCH_FAKE_PROVIDER=1` gives you. */
export const FAKE_DEFAULT_SCRIPT: readonly string[] = [
  FAKE_PLAN_RESPONSE,
  FAKE_VERIFY_RESPONSE,
  FAKE_DONE_RESPONSE,
]

export interface FakeChatAdapterOptions {
  /** Adapter id. Defaults to `'fake'` — obviously not a real provider. */
  id?: string
  /** Reported model. Defaults to `'fake'`, which prices at a real zero. */
  model?: string
  /**
   * Responses to return, in order. Injecting a script is how the eval harness and
   * the trainer drive an arbitrary action sequence. Defaults to
   * {@link FAKE_DEFAULT_SCRIPT}. An empty array is treated as "no script" and
   * falls back to the default.
   */
  script?: readonly string[]
}

/** Rough token count: ~4 characters per token, never less than one. */
function estimateTokens(text: string): number {
  return text.length === 0 ? 0 : Math.max(1, Math.ceil(text.length / 4))
}

/**
 * Deterministic offline `ChatAdapter`. No sockets, no keys, no clock — the same
 * inputs always produce the same outputs, which is what makes the eval harness
 * and the trainer's strict validation gate meaningful.
 */
export class FakeChatAdapter implements ChatAdapter {
  readonly id: string
  /**
   * The model this adapter reports.
   *
   * Defaults to `fake`, which the pricing table lists at zero and marks `local`. So an
   * offline run's ledger reads `$0.00 (local models only)` — a PRICED zero — rather
   * than "cost unknown", which is what an unnamed model would honestly have to say.
   */
  readonly model: string

  /**
   * This adapter ESTIMATES its token numbers (~len/4); it does not receive them from a
   * provider, because no provider is contacted. A surface reads this to label the
   * numbers "estimated" rather than presenting them as a provider's own count. It is a
   * fixed property of the adapter TYPE (the fake always estimates), not per-call state,
   * so reading it structurally carries none of the shared-state hazard of a per-call
   * field.
   */
  readonly estimatesUsage = true

  /** The scripted responses, in order. */
  readonly script: readonly string[]

  private readonly received: Message[][] = []

  constructor(options: FakeChatAdapterOptions = {}) {
    this.id = options.id ?? 'fake'
    this.model = options.model ?? 'fake'
    this.script =
      options.script && options.script.length > 0 ? [...options.script] : [...FAKE_DEFAULT_SCRIPT]
  }

  /** How many times `chat()` has been called. */
  get callCount(): number {
    return this.received.length
  }

  /** Every message array this adapter was handed, in call order. */
  get calls(): readonly Message[][] {
    return this.received.map((messages) => messages.map((m) => ({ ...m })))
  }

  /** The messages from the most recent call, or `undefined` before the first. */
  get lastMessages(): Message[] | undefined {
    const last = this.received[this.received.length - 1]
    return last ? last.map((m) => ({ ...m })) : undefined
  }

  /** Forget the call history so one adapter can drive several scenarios. */
  reset(): void {
    this.received.length = 0
  }

  async chat(
    messages: Message[],
    options?: { signal?: AbortSignal },
  ): Promise<{ text: string; usage?: Usage }> {
    if (options?.signal?.aborted) throw abortError()

    this.received.push(messages.map((m) => ({ ...m })))

    // Clamp rather than wrap: the tail of the script repeats forever, so a loop
    // with a generous iteration cap keeps seeing `done` and exits cleanly.
    const index = Math.min(this.received.length - 1, this.script.length - 1)
    const text = this.script[index] ?? FAKE_DONE_RESPONSE

    const inTokens = messages.reduce((sum, m) => sum + estimateTokens(m.content), 0)
    return { text, usage: { in: inTokens, out: estimateTokens(text) } }
  }
}

/** An `AbortError`-shaped failure, matching what `fetch` throws on cancellation. */
function abortError(): Error {
  const err = new Error('The operation was aborted')
  err.name = 'AbortError'
  return err
}
