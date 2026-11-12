// One HTTP call to a model provider, with the two guarantees every real provider
// needs and the raw `fetch` in the adapters did not have:
//
//   1. A CEILING. A provider that accepts the connection and then never answers used
//      to hold a run open forever — and until the stdio control plane was fixed, Stop
//      could not reach it either. Every attempt now has a timeout, and a timeout is
//      reported as itself ("no answer within 180 s"), not as a generic failure.
//
//   2. BOUNDED RETRIES for the failures that are transient by definition: rate limits
//      (429), overload (503, Anthropic's 529), gateway errors (502/504), and a socket
//      that was reset mid-flight. `Retry-After` is honoured when the provider sends
//      one. Everything else — a rejected key, an unknown model, a malformed request —
//      fails on the first answer, because retrying a 401 only bills the user three
//      times for the same refusal.
//
// WHAT IS DELIBERATELY NOT RETRIED: a refused connection (nothing is listening — a
// local model server that is not running will not start because we asked twice) and
// a timeout (the next attempt would wait just as long). Cancellation is never
// retried and never delayed: an abort during a backoff wait ends the wait at once.
//
// Dependency-free, like the rest of the engine: `fetch`, `AbortController`, timers.

/** Statuses worth another attempt. */
export const RETRYABLE_STATUSES: ReadonlySet<number> = new Set([408, 425, 429, 500, 502, 503, 504, 529])

/** Socket-level failures worth another attempt. ECONNREFUSED is deliberately absent. */
const RETRYABLE_NETWORK_CODES: ReadonlySet<string> = new Set([
  'ECONNRESET',
  'ETIMEDOUT',
  'EPIPE',
  'EAI_AGAIN',
  'ENETRESET',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
  'UND_ERR_HEADERS_TIMEOUT',
  'UND_ERR_BODY_TIMEOUT',
])

/** Default per-attempt ceiling for a hosted provider. */
export const DEFAULT_REMOTE_TIMEOUT_MS = 180_000
/** Default per-attempt ceiling for a model on this machine, which may be CPU-bound. */
export const DEFAULT_LOCAL_TIMEOUT_MS = 600_000
/** Retries after the first attempt. Three requests at most. */
export const DEFAULT_RETRIES = 2
/** Never wait longer than this between attempts, whatever `Retry-After` asks for. */
export const MAX_BACKOFF_MS = 20_000

export interface ProviderFetchOptions {
  /** The caller's cancellation. Aborting it ends the call and any backoff at once. */
  signal?: AbortSignal
  /** Per-attempt ceiling. Defaults by endpoint: local vs hosted. */
  timeoutMs?: number
  /** Retries after the first attempt. */
  retries?: number
  /** Injected in tests. Defaults to the global `fetch`. */
  fetchImpl?: typeof fetch
  /** Injected in tests so backoff does not slow the suite. */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Told about each retry, for a diagnostic line. Never told about a credential. */
  onRetry?: (info: { attempt: number; delayMs: number; reason: string }) => void
}

/** A per-attempt timeout, distinguishable from a user cancellation. */
export class ProviderTimeoutError extends Error {
  readonly timeoutMs: number
  constructor(timeoutMs: number) {
    super(`no answer within ${Math.round(timeoutMs / 1000)} s`)
    this.name = 'ProviderTimeoutError'
    this.timeoutMs = timeoutMs
  }
}

/** True for an endpoint on this machine, judged from the URL that will be called. */
export function isLoopbackUrl(raw: string): boolean {
  let host: string
  try {
    host = new URL(raw).hostname.toLowerCase().replace(/^\[|\]$/g, '')
  } catch {
    return false
  }
  return host === 'localhost' || host === '::1' || /^127(\.\d{1,3}){3}$/.test(host) || host.endsWith('.localhost')
}

function abortError(): Error {
  const err = new Error('The operation was aborted.')
  err.name = 'AbortError'
  return err
}

/** Resolves after `ms`, or rejects with an AbortError the moment `signal` aborts. */
export function sleepFor(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(abortError())
      return
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort)
      resolve()
    }, ms)
    const onAbort = () => {
      clearTimeout(timer)
      reject(abortError())
    }
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

/** `Retry-After` as milliseconds: delta-seconds or an HTTP date. Null when absent/unusable. */
export function retryAfterMs(header: string | null, now: number = Date.now()): number | null {
  if (header === null) return null
  const text = header.trim()
  if (text === '') return null
  if (/^\d+(\.\d+)?$/.test(text)) return Math.max(0, Math.round(Number(text) * 1000))
  const when = Date.parse(text)
  if (Number.isNaN(when)) return null
  return Math.max(0, when - now)
}

/** The Node/undici error code behind a failed `fetch`, when there is one. */
function networkCode(err: unknown): string | null {
  if (err === null || typeof err !== 'object') return null
  const direct = (err as { code?: unknown }).code
  if (typeof direct === 'string') return direct
  const cause = (err as { cause?: unknown }).cause
  if (cause !== null && typeof cause === 'object') {
    const code = (cause as { code?: unknown }).code
    if (typeof code === 'string') return code
  }
  return null
}

/** Exponential backoff with a little jitter: ~1 s, ~2 s, ~4 s … capped. */
export function backoffMs(attempt: number): number {
  const base = 1000 * 2 ** Math.max(0, attempt - 1)
  const jitter = Math.floor(Math.random() * 250)
  return Math.min(MAX_BACKOFF_MS, base + jitter)
}

/**
 * Let go of a response body without reading it. Never throws and never waits, so a
 * body that stalls cannot hold the caller; cancelling also releases the connection.
 */
function discardBody(response: Response): void {
  try {
    void response.body?.cancel().catch(() => {})
  } catch {
    // Not a standard stream, or already released: nothing to free.
  }
}

/**
 * One sentence on what an HTTP failure status means for the person reading it, or
 * an empty string when the status says nothing more than its number. Prefixed to
 * the provider's own (redacted) body, never instead of it.
 */
export function statusHint(status: number): string {
  if (status === 401 || status === 403) {
    return 'The provider rejected the credential. Check the API key in Settings → Models.'
  }
  if (status === 402) return 'The provider account has no credit left for this request.'
  if (status === 404) return 'The endpoint or the model was not found. Check the model name.'
  if (status === 408 || status === 504) return 'The provider timed out.'
  if (status === 413) return 'The request is too large for this model.'
  if (status === 429) return 'Rate limited or out of quota. Wait a moment, or check your plan.'
  if (status >= 500) return 'The provider is having trouble. Try again shortly.'
  return ''
}

/**
 * `fetch` with a per-attempt ceiling and bounded retries.
 *
 * Resolves with the LAST response — including a non-retryable or final error
 * status, which the adapter turns into its own redacted message. Rejects with an
 * AbortError on cancellation, a {@link ProviderTimeoutError} on a timeout, or the
 * last network error once retries are spent.
 */
export async function providerFetch(
  url: string,
  init: RequestInit,
  options: ProviderFetchOptions = {},
): Promise<Response> {
  const doFetch = options.fetchImpl ?? fetch
  const sleep = options.sleep ?? sleepFor
  const retries = Math.max(0, Math.floor(options.retries ?? DEFAULT_RETRIES))
  const timeoutMs =
    options.timeoutMs ?? (isLoopbackUrl(url) ? DEFAULT_LOCAL_TIMEOUT_MS : DEFAULT_REMOTE_TIMEOUT_MS)
  const outer = options.signal

  for (let attempt = 0; ; attempt++) {
    if (outer?.aborted) throw abortError()

    const controller = new AbortController()
    let timedOut = false
    const timer = setTimeout(() => {
      timedOut = true
      controller.abort()
    }, timeoutMs)
    const onOuterAbort = () => controller.abort()
    outer?.addEventListener('abort', onOuterAbort, { once: true })

    let response: Response | null = null
    let failure: unknown = null
    try {
      response = await doFetch(url, { ...init, signal: controller.signal })
    } catch (err) {
      failure = err
    } finally {
      clearTimeout(timer)
      outer?.removeEventListener('abort', onOuterAbort)
    }

    if (outer?.aborted) throw abortError()
    if (timedOut) throw new ProviderTimeoutError(timeoutMs)

    const canRetry = attempt < retries
    if (response !== null) {
      if (!RETRYABLE_STATUSES.has(response.status) || !canRetry) return response
      const delay = Math.min(
        MAX_BACKOFF_MS,
        retryAfterMs(response.headers?.get?.('retry-after') ?? null) ?? backoffMs(attempt + 1),
      )
      // The body is not needed. Let go of it rather than read it to the end: this
      // attempt's timer and abort hook are already gone, so a body that stalls would
      // hold the run here with no timeout and no way to Stop it.
      discardBody(response)
      options.onRetry?.({ attempt: attempt + 1, delayMs: delay, reason: `HTTP ${response.status}` })
      await sleep(delay, outer)
      continue
    }

    const code = networkCode(failure)
    if (!canRetry || code === null || !RETRYABLE_NETWORK_CODES.has(code)) throw failure
    const delay = backoffMs(attempt + 1)
    options.onRetry?.({ attempt: attempt + 1, delayMs: delay, reason: code })
    await sleep(delay, outer)
  }
}

/**
 * The part of a provider's error body a person can read.
 *
 * Most providers answer a failure with JSON — OpenAI-shaped `{ error: { message } }`,
 * Anthropic's `{ type: "error", error: { message } }`, or a flat `{ message }` /
 * `{ error: "…" }` — and pasting that JSON into a chat reply is noise. The message is
 * pulled out (with the error code when there is one); anything that is not JSON, or
 * JSON without a message, is returned as it came, trimmed. Redaction still happens
 * afterwards, in `providerError`, on whatever this returns.
 */
export function readableErrorDetail(body: string): string {
  const text = body.trim()
  if (text === '' || (text[0] !== '{' && text[0] !== '[')) return text
  let parsed: unknown
  try {
    parsed = JSON.parse(text)
  } catch {
    return text
  }
  const first = Array.isArray(parsed) ? parsed[0] : parsed
  if (first === null || typeof first !== 'object') return text
  const record = first as Record<string, unknown>
  const error = record['error']
  const nested = error !== null && typeof error === 'object' && !Array.isArray(error) ? (error as Record<string, unknown>) : undefined
  const message =
    (typeof nested?.['message'] === 'string' && nested['message'].trim()) ||
    (typeof error === 'string' && error.trim()) ||
    (typeof record['message'] === 'string' && record['message'].trim()) ||
    (typeof record['detail'] === 'string' && record['detail'].trim()) ||
    ''
  if (message === '') return Object.keys(record).length === 0 ? '' : text
  const code = typeof nested?.['code'] === 'string' ? nested['code'] : typeof nested?.['type'] === 'string' ? nested['type'] : undefined
  return code !== undefined && code !== '' && !message.includes(code) ? `${message} (${code})` : message
}