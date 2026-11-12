// Optional ghost completions: debounce and cancellation without owning file text.
// The controller receives immutable snapshots and emits a decoration string only.
// It never writes AppState or a Monaco model, so an unaccepted suggestion cannot
// dirty a file. Validates: Requirement 15.5.

export const DEFAULT_GHOST_COMPLETIONS_ENABLED = false
export const GHOST_COMPLETION_DEBOUNCE_MS = 180

export interface GhostCompletionInput {
  path: string
  content: string
  cursorOffset: number
  /** Monaco's language id, when the editor knows it. */
  language?: string
}

export interface GhostCompletionRequest extends GhostCompletionInput {
  signal: AbortSignal
}

export type GhostCompletionProvider = (
  request: GhostCompletionRequest,
) => Promise<string | null>

export interface GhostCompletionScheduler {
  set(delayMs: number, callback: () => void): unknown
  clear(handle: unknown): void
}

const browserScheduler: GhostCompletionScheduler = {
  set: (delayMs, callback) => globalThis.setTimeout(callback, delayMs),
  clear: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
}

export interface GhostCompletionControllerOptions {
  provider: GhostCompletionProvider
  enabled?: () => boolean
  debounceMs?: number
  scheduler?: GhostCompletionScheduler
  onSuggestion: (suggestion: string | null) => void
}

export class GhostCompletionController {
  readonly #provider: GhostCompletionProvider
  readonly #enabled: () => boolean
  readonly #debounceMs: number
  readonly #scheduler: GhostCompletionScheduler
  readonly #onSuggestion: (suggestion: string | null) => void
  #timer: unknown = null
  #request: AbortController | null = null
  #requestId = 0
  #suggestion: string | null = null

  constructor(options: GhostCompletionControllerOptions) {
    this.#provider = options.provider
    this.#enabled = options.enabled ?? (() => DEFAULT_GHOST_COMPLETIONS_ENABLED)
    this.#debounceMs = options.debounceMs ?? GHOST_COMPLETION_DEBOUNCE_MS
    this.#scheduler = options.scheduler ?? browserScheduler
    this.#onSuggestion = options.onSuggestion
  }

  get suggestion(): string | null {
    return this.#suggestion
  }

  /**
   * Handle a keystroke synchronously. The local path only cancels/schedules work;
   * the provider is never called in this stack, keeping input latency independent
   * of provider speed.
   */
  update(input: GhostCompletionInput): void {
    this.cancel()
    if (!this.#enabled()) return

    const requestId = ++this.#requestId
    this.#timer = this.#scheduler.set(this.#debounceMs, () => {
      this.#timer = null
      if (!this.#enabled() || requestId !== this.#requestId) return
      const controller = new AbortController()
      this.#request = controller
      void this.#provider({ ...input, signal: controller.signal }).then(
        (suggestion) => {
          if (
            controller.signal.aborted ||
            requestId !== this.#requestId ||
            !this.#enabled()
          ) return
          this.#request = null
          this.#setSuggestion(suggestion)
        },
        () => {
          if (controller.signal.aborted || requestId !== this.#requestId) return
          this.#request = null
          this.#setSuggestion(null)
        },
      )
    })
  }

  /** Cancel both queued and in-flight work and discard any visible decoration. */
  cancel(): void {
    this.#requestId++
    if (this.#timer !== null) {
      this.#scheduler.clear(this.#timer)
      this.#timer = null
    }
    this.#request?.abort()
    this.#request = null
    this.#setSuggestion(null)
  }

  dispose(): void {
    this.cancel()
  }

  #setSuggestion(suggestion: string | null): void {
    if (this.#suggestion === suggestion) return
    this.#suggestion = suggestion
    this.#onSuggestion(suggestion)
  }
}
