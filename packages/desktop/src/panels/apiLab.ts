// API Lab — pure helpers for the request lab.
//
// The panel sends real requests with `fetch` + AbortController; these helpers
// are the parts that can be tested without a network. History storage never
// carries header values or bodies — only method, URL and status — and the
// scrubber is applied to anything that could hold a secret before it is kept.

export type HttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'

export interface HeaderRow {
  key: string
  value: string
}

/** Header names whose values must never be stored or displayed in history. */
const SENSITIVE_HEADERS = new Set(['authorization', 'cookie', 'x-api-key'])

export const MAX_BODY_CHARS = 50_000
export const MAX_HISTORY_ENTRIES = 20
export const HISTORY_KEY = 'sketch.apiLab.history.v1'

export interface ApiHistoryEntry {
  method: HttpMethod
  url: string
  status: number | null
  at: number
}

/**
 * Parse pasted `Key: value` lines into headers. Returns the headers plus one
 * error per line that could not be parsed (empty lines are skipped, and a
 * missing colon or empty key is an error, not silently dropped).
 */
export function parseHeaders(raw: string): { headers: Record<string, string>; errors: string[] } {
  const headers: Record<string, string> = {}
  const errors: string[] = []
  for (const line of raw.split('\n')) {
    const trimmed = line.trim()
    if (trimmed === '') continue
    const colon = trimmed.indexOf(':')
    if (colon <= 0) {
      errors.push(`Could not parse header line: “${trimmed}” (expected “Name: value”).`)
      continue
    }
    const key = trimmed.slice(0, colon).trim()
    const value = trimmed.slice(colon + 1).trim()
    headers[key] = value
  }
  return { headers, errors }
}

/** Build a headers object from the panel's key/value rows (blank keys skipped). */
export function rowsToHeaders(rows: HeaderRow[]): Record<string, string> {
  const headers: Record<string, string> = {}
  for (const row of rows) {
    const key = row.key.trim()
    if (key === '') continue
    headers[key] = row.value
  }
  return headers
}

/**
 * Replace the values of sensitive headers with `[redacted]`. The header name
 * stays so the caller can see a secret header was present; the value never does.
 */
export function scrubHeaders(headers: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {}
  for (const [key, value] of Object.entries(headers)) {
    out[key] = SENSITIVE_HEADERS.has(key.toLowerCase()) ? '[redacted]' : value
  }
  return out
}

/** Truncate a response body for display, saying so when it was cut. */
export function truncateBody(body: string, maxChars = MAX_BODY_CHARS): { text: string; truncated: boolean } {
  if (body.length <= maxChars) return { text: body, truncated: false }
  return { text: body.slice(0, maxChars), truncated: true }
}

export interface ApiRequestInput {
  method: HttpMethod
  url: string
  headers?: Record<string, string>
  body?: string
  timeoutMs?: number
}

export interface ApiResponse {
  status: number
  statusText: string
  headers: Record<string, string>
  body: string
  elapsedMs: number
}

/**
 * Send one request with a real `fetch`, aborting after `timeoutMs`
 * (default 10 s). `fetchImpl` exists so tests can inject a mock; production
 * passes the global fetch. A timeout rejects with a plain Error naming the
 * timeout — an aborted request is not reported as a server error.
 */
export async function executeRequest(
  input: ApiRequestInput,
  fetchImpl: typeof fetch = globalThis.fetch,
): Promise<ApiResponse> {
  const timeoutMs = input.timeoutMs ?? 10_000
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), timeoutMs)
  const started = Date.now()
  try {
    const response = await fetchImpl(input.url, {
      method: input.method,
      headers: input.headers,
      body: input.method === 'GET' ? undefined : input.body,
      signal: controller.signal,
    })
    const body = await response.text()
    const headers: Record<string, string> = {}
    response.headers.forEach((value, key) => {
      headers[key] = value
    })
    return {
      status: response.status,
      statusText: response.statusText,
      headers,
      body,
      elapsedMs: Date.now() - started,
    }
  } catch (err) {
    if (controller.signal.aborted) {
      throw new Error(`Request timed out after ${timeoutMs} ms.`)
    }
    throw err
  } finally {
    clearTimeout(timer)
  }
}

/** Read the saved history (method + URL + status only). Corrupt data → []. */
export function readHistory(storage: Storage | null = safeStorage()): ApiHistoryEntry[] {
  if (storage === null) return []
  try {
    const raw = storage.getItem(HISTORY_KEY)
    if (raw === null) return []
    const parsed: unknown = JSON.parse(raw)
    if (!Array.isArray(parsed)) return []
    return parsed.filter(
      (e): e is ApiHistoryEntry =>
        typeof e === 'object' && e !== null && typeof (e as ApiHistoryEntry).url === 'string',
    )
  } catch {
    return []
  }
}

/** Prepend one entry, capped at MAX_HISTORY_ENTRIES. Stores no headers/bodies. */
export function pushHistory(
  entry: ApiHistoryEntry,
  storage: Storage | null = safeStorage(),
): ApiHistoryEntry[] {
  const next = [entry, ...readHistory(storage)].slice(0, MAX_HISTORY_ENTRIES)
  if (storage !== null) {
    try {
      storage.setItem(HISTORY_KEY, JSON.stringify(next))
    } catch {
      /* storage full or unavailable — history is a convenience, not the result */
    }
  }
  return next
}

export function clearHistory(storage: Storage | null = safeStorage()): void {
  if (storage === null) return
  try {
    storage.removeItem(HISTORY_KEY)
  } catch {
    /* ignore */
  }
}

function safeStorage(): Storage | null {
  try {
    return typeof window !== 'undefined' && window.localStorage ? window.localStorage : null
  } catch {
    return null
  }
}
