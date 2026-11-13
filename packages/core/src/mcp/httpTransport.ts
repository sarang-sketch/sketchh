// Remote MCP: Streamable HTTP transport.
//
// The stdio client (`client.ts`) speaks JSON-RPC over pipes to a child process.
// This is the same protocol over HTTP, for servers that live at a URL instead:
// one POST per request, `Accept: application/json, text/event-stream`, and a
// session id the server hands back in the `Mcp-Session-Id` response header and
// expects on later requests.
//
// ── THE SAME THREE OBLIGATIONS AS STDIO (Requirement 22.3) ────────────────
//
// Every request has a deadline; a server that hangs is latched unavailable for
// the remainder of the run, so the next call fails immediately instead of
// paying the timeout again; and a hang is a result (`ok: false`), never a
// throw. The latch reasons reuse the stdio vocabulary (`timeout`,
// `handshake-failed`, `closed`, `exited`) so a surface reads both transports
// the same way.
//
// ── WHAT IS NOT HERE ──────────────────────────────────────────────────────
//
// No OAuth. A server that requires an OAuth flow returns 401, the client
// re-initializes once, and if the server still refuses the call fails with
// `ok: false` and the reason. Header credentials come from the caller in the
// spec — this code never reads them from a config file — and header VALUES are
// never logged; only header NAMES may appear in diagnostics.
//
// ── RESPONSE SHAPES ───────────────────────────────────────────────────────
//
// A server may answer plain JSON or Server-Sent Events. SSE is parsed
// minimally: lines starting `data: ` carry JSON-RPC messages, lines starting
// `:` are comments and ignored, `event: ` lines are ignored. A response that
// is neither parseable JSON nor SSE with a matching message is an error, not
// a silent empty result.

import {
  DEFAULT_HANDSHAKE_TIMEOUT_MS,
  DEFAULT_REQUEST_TIMEOUT_MS,
  type McpCallResult,
  type UnavailableReason,
} from './client.js'
import type { EventInput } from '../events/store.js'
import {
  MCP_CLIENT_INFO,
  MCP_PROTOCOL_VERSION,
  readCallResult,
  readToolList,
  type McpToolInfo,
} from './protocol.js'

export interface RemoteMcpServerSpec {
  /** Registry id, e.g. `remote-docs`. Used in logs and denials. */
  id: string
  /** Streamable HTTP endpoint, e.g. `https://mcp.example.com/mcp`. */
  url: string
  /**
   * Extra headers, supplied by the caller. Values are credential material as
   * often as not: they are sent, and never logged.
   */
  headers?: Record<string, string>
  requestTimeoutMs?: number
  handshakeTimeoutMs?: number
}

export interface RemoteResourceInfo {
  name: string
  description?: string
  uri?: string
}

export interface RemotePromptInfo {
  name: string
  description?: string
}

/** A best-effort list: empty plus a note when the server cannot answer. */
export interface RemoteListResult<T> {
  ok: boolean
  items: T[]
  /** Why the list is empty, when the server said so. */
  note?: string
}

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

function clip(text: string, limit = 500): string {
  const trimmed = text.trim()
  return trimmed.length <= limit ? trimmed : `${trimmed.slice(0, limit)}…`
}

function describeRpcError(error: { code?: unknown; message?: unknown }): string {
  const code = typeof error.code === 'number' ? error.code : -32_000
  const message = typeof error.message === 'string' ? error.message : 'unknown error'
  return `${message} (code ${code})`
}

/**
 * Parse an SSE body into JSON-RPC messages.
 *
 * `data: ` lines carry the messages; `:` comment lines and `event: ` lines are
 * ignored. Multi-line `data:` blocks are joined with `\n` (the SSE rule). A
 * line that is not JSON is skipped, not fatal — the same noise discipline as
 * the stdio decoder. Returns the parsed messages in order.
 */
export function parseSseMessages(text: string): unknown[] {
  const messages: unknown[] = []
  let dataLines: string[] = []
  const flush = (): void => {
    if (dataLines.length === 0) return
    const joined = dataLines.join('\n')
    dataLines = []
    try {
      messages.push(JSON.parse(joined) as unknown)
    } catch {
      // Not JSON: noise, skipped like a non-protocol stdio line.
    }
  }
  for (const rawLine of text.split('\n')) {
    const line = rawLine.endsWith('\r') ? rawLine.slice(0, -1) : rawLine
    if (line === '') {
      flush()
      continue
    }
    if (line.startsWith(':')) continue
    if (line.startsWith('event:')) continue
    if (line.startsWith('data:')) {
      dataLines.push(line.slice('data:'.length).replace(/^ /, ''))
      continue
    }
    // Unknown SSE field: ignored.
  }
  flush()
  return messages
}

function readStringList(result: unknown, key: string): Array<Record<string, unknown>> {
  if (result === null || typeof result !== 'object') return []
  const list = (result as Record<string, unknown>)[key]
  if (!Array.isArray(list)) return []
  return list.filter(
    (entry): entry is Record<string, unknown> =>
      entry !== null && typeof entry === 'object' && !Array.isArray(entry),
  )
}

/**
 * A live connection to one remote MCP server.
 *
 * Constructed but not started: `start()` handshakes and lists tools, and every
 * method is safe to call before it — they fail with the reason rather than
 * throwing.
 */
export class RemoteMcpServer {
  readonly id: string

  #sessionId: string | null = null
  #nextId = 1
  #unavailable: { reason: UnavailableReason; detail: string } | null = null
  #tools: McpToolInfo[] = []
  #started = false
  #lastError = ''

  constructor(
    private readonly spec: RemoteMcpServerSpec,
    private readonly options: {
      events?: { emit(event: EventInput): Promise<void> | void }
      runId?: string
      /** Diagnostics sink. Header names only, never values. */
      log?: (message: string) => void
    } = {},
  ) {
    this.id = spec.id
  }

  /** Null while healthy. Set, and never cleared, once the server is written off. */
  get unavailable(): { reason: UnavailableReason; detail: string } | null {
    return this.#unavailable
  }

  /** Tools the server advertised at handshake. Empty until `start()` succeeds. */
  get tools(): readonly McpToolInfo[] {
    return this.#tools
  }

  /** The last transport error, for the surface. Header values never appear here. */
  get diagnostics(): string {
    return this.#lastError
  }

  /** POST one JSON-RPC request and return its `result`, or throw. */
  async #request(method: string, params: unknown, timeoutMs?: number, runId?: string): Promise<unknown> {
    return this.#requestOnce(method, params, timeoutMs, false, runId)
  }

  async #requestOnce(
    method: string,
    params: unknown,
    timeoutMs: number | undefined,
    retried: boolean,
    runId?: string,
  ): Promise<unknown> {
    const deadline = timeoutMs ?? this.spec.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS
    const id = this.#nextId++
    const headers = new Headers()
    headers.set('Content-Type', 'application/json')
    headers.set('Accept', 'application/json, text/event-stream')
    if (this.#sessionId !== null) headers.set('Mcp-Session-Id', this.#sessionId)
    for (const [name, value] of Object.entries(this.spec.headers ?? {})) {
      headers.set(name, value)
    }

    let response: Response
    try {
      response = await fetch(this.spec.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({ jsonrpc: '2.0', id, method, params }),
        signal: AbortSignal.timeout(deadline),
      })
    } catch (err) {
      // `AbortSignal.timeout` aborts with `TimeoutError`; a manually aborted
      // signal reports `AbortError`. Either way the deadline passed, not the
      // server answering.
      if (err instanceof Error && (err.name === 'AbortError' || err.name === 'TimeoutError')) {
        // THE HANG, same as stdio: latch, so the next call costs nothing.
        await this.#writeOff(
          'timeout',
          `${this.id} did not answer ${method} within ${deadline}ms and is marked unavailable for the rest of this run`,
          runId,
        )
        throw new Error(`timed out after ${deadline}ms`)
      }
      this.#lastError = `${method} failed: ${messageOf(err)}`
      throw new Error(`could not reach ${this.id}: ${messageOf(err)}`)
    }

    const sessionId = response.headers.get('mcp-session-id')
    if (sessionId !== null && sessionId !== '') this.#sessionId = sessionId

    // A session the server no longer knows (401/404) gets one re-initialize and
    // one retry, then the failure stands. No OAuth is attempted: a server that
    // still refuses after a fresh handshake is reported, not chased.
    if ((response.status === 401 || response.status === 404) && !retried && method !== 'initialize') {
      this.options.log?.(`mcp ${this.id}: ${method} returned ${response.status}, re-initializing once`)
      this.#sessionId = null
      try {
        await this.#initialize()
      } catch (err) {
        throw new Error(`re-initialize after ${response.status} failed: ${messageOf(err)}`)
      }
      return this.#requestOnce(method, params, timeoutMs, true, runId)
    }

    if (!response.ok) {
      const body = await response.text().catch(() => '')
      this.#lastError = `${method} returned HTTP ${response.status}${body !== '' ? `: ${clip(body, 200)}` : ''}`
      throw new Error(`${this.id} ${method} returned HTTP ${response.status}`)
    }

    const contentType = response.headers.get('content-type') ?? ''
    const text = await response.text()
    if (text.trim() === '') throw new Error(`${this.id} ${method} returned an empty response`)

    let parsed: unknown
    if (contentType.includes('text/event-stream')) {
      const messages = parseSseMessages(text)
      const match = [...messages].reverse().find(
        (entry): entry is Record<string, unknown> =>
          entry !== null &&
          typeof entry === 'object' &&
          !Array.isArray(entry) &&
          (entry as Record<string, unknown>)['id'] === id,
      )
      parsed = match ?? messages[messages.length - 1]
      if (parsed === undefined) throw new Error(`${this.id} ${method} returned SSE with no JSON-RPC message`)
    } else {
      try {
        parsed = JSON.parse(text) as unknown
      } catch {
        throw new Error(`${this.id} ${method} returned a response that is not JSON`)
      }
    }

    if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
      throw new Error(`${this.id} ${method} returned a response that is not a JSON-RPC object`)
    }
    const record = parsed as Record<string, unknown>
    if (record['error'] !== undefined && record['error'] !== null && typeof record['error'] === 'object') {
      throw new Error(describeRpcError(record['error'] as { code?: unknown; message?: unknown }))
    }
    return record['result']
  }

  /** Send a notification (no id, no response expected). Best-effort. */
  async #notify(method: string, params?: unknown): Promise<void> {
    const headers = new Headers()
    headers.set('Content-Type', 'application/json')
    headers.set('Accept', 'application/json, text/event-stream')
    if (this.#sessionId !== null) headers.set('Mcp-Session-Id', this.#sessionId)
    for (const [name, value] of Object.entries(this.spec.headers ?? {})) {
      headers.set(name, value)
    }
    try {
      await fetch(this.spec.url, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          jsonrpc: '2.0',
          method,
          ...(params !== undefined ? { params } : {}),
        }),
        signal: AbortSignal.timeout(this.spec.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS),
      })
    } catch {
      // A notification that never lands is not a failure of the session.
    }
  }

  async #initialize(): Promise<void> {
    await this.#request(
      'initialize',
      {
        protocolVersion: MCP_PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: MCP_CLIENT_INFO,
      },
      this.spec.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS,
    )
    await this.#notify('notifications/initialized')
  }

  /**
   * Handshake and list tools. Returns a verdict instead of throwing: a server
   * failing to start is an ordinary outcome and must not end a run.
   */
  async start(): Promise<{ ok: boolean; detail: string }> {
    if (this.#unavailable !== null) {
      return { ok: false, detail: this.#unavailable.detail }
    }
    if (this.#started) return { ok: true, detail: 'already started' }

    let url: URL
    try {
      url = new URL(this.spec.url)
    } catch {
      return this.#writeOff('handshake-failed', `${this.id} has an invalid URL`)
    }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      return this.#writeOff('handshake-failed', `${this.id} URL must be http(s)`)
    }

    const handshakeTimeout = this.spec.handshakeTimeoutMs ?? DEFAULT_HANDSHAKE_TIMEOUT_MS
    try {
      await this.#initialize()
    } catch (err) {
      return this.#writeOff('handshake-failed', `${this.id} handshake failed: ${messageOf(err)}`)
    }

    try {
      const listed = await this.#request('tools/list', {}, handshakeTimeout)
      this.#tools = readToolList(listed)
    } catch (err) {
      return this.#writeOff('handshake-failed', `${this.id} could not list tools: ${messageOf(err)}`)
    }

    this.#started = true
    return { ok: true, detail: `${this.id} ready with ${this.#tools.length} tool(s)` }
  }

  /**
   * Call one tool. Every failure mode is a result: unavailable, timed out,
   * transport-broken, or the tool's own error. Nothing throws.
   */
  async callTool(name: string, args: Record<string, unknown>, runId?: string): Promise<McpCallResult> {
    const started = Date.now()

    if (this.#unavailable !== null) {
      return {
        ok: false,
        text: `${this.id} is unavailable for the rest of this run: ${this.#unavailable.detail}`,
        toolError: false,
        transportError: this.#unavailable.reason,
        unrendered: [],
        durationMs: 0,
      }
    }
    if (!this.#started) {
      return {
        ok: false,
        text: `${this.id} has not been started`,
        toolError: false,
        transportError: 'exited',
        unrendered: [],
        durationMs: 0,
      }
    }

    let raw: unknown
    try {
      raw = await this.#request('tools/call', { name, arguments: args }, undefined, runId)
    } catch (err) {
      const latched: { reason: UnavailableReason; detail: string } | null = this.unavailable
      return {
        ok: false,
        text: `${this.id}/${name} failed: ${messageOf(err)}`,
        toolError: false,
        transportError: latched?.reason ?? 'exited',
        unrendered: [],
        durationMs: Date.now() - started,
      }
    }
    // The run id goes with the call so a latched server's `tool_denied` lands
    // in this run's slice of the log, as in the stdio client.
    const outcome = readCallResult(raw)
    return {
      ok: !outcome.isError,
      text: outcome.text,
      toolError: outcome.isError,
      unrendered: outcome.unrendered,
      durationMs: Date.now() - started,
    }
  }

  /** Liveness probe. Never throws; method-not-found is a clean failure. */
  async ping(): Promise<{ ok: boolean; detail: string }> {
    if (this.#unavailable !== null) return { ok: false, detail: this.#unavailable.detail }
    if (!this.#started) return { ok: false, detail: `${this.id} has not been started` }
    try {
      await this.#request('ping', {})
      return { ok: true, detail: 'pong' }
    } catch (err) {
      const text = messageOf(err)
      if (text.includes('code -32601') || text.includes('Method not found')) {
        return { ok: false, detail: `${this.id} does not support ping` }
      }
      return { ok: false, detail: text }
    }
  }

  /**
   * `resources/list`, best-effort. A server that does not implement it returns
   * an empty list with a note; any other failure does the same. Never throws.
   */
  async listResources(): Promise<RemoteListResult<RemoteResourceInfo>> {
    if (this.#unavailable !== null) {
      return { ok: false, items: [], note: this.#unavailable.detail }
    }
    if (!this.#started) return { ok: false, items: [], note: `${this.id} has not been started` }
    let result: unknown
    try {
      result = await this.#request('resources/list', {})
    } catch (err) {
      const text = messageOf(err)
      if (text.includes('code -32601') || text.includes('Method not found')) {
        return { ok: true, items: [], note: `${this.id} does not support resources/list` }
      }
      return { ok: false, items: [], note: text }
    }
    return {
      ok: true,
      items: readStringList(result, 'resources')
        .filter((entry) => typeof entry['name'] === 'string' && (entry['name'] as string).trim() !== '')
        .map((entry) => ({
          name: entry['name'] as string,
          ...(typeof entry['description'] === 'string' ? { description: entry['description'] } : {}),
          ...(typeof entry['uri'] === 'string' ? { uri: entry['uri'] } : {}),
        })),
    }
  }

  /**
   * `prompts/list`, best-effort. Same contract as `listResources`.
   */
  async listPrompts(): Promise<RemoteListResult<RemotePromptInfo>> {
    if (this.#unavailable !== null) {
      return { ok: false, items: [], note: this.#unavailable.detail }
    }
    if (!this.#started) return { ok: false, items: [], note: `${this.id} has not been started` }
    let result: unknown
    try {
      result = await this.#request('prompts/list', {})
    } catch (err) {
      const text = messageOf(err)
      if (text.includes('code -32601') || text.includes('Method not found')) {
        return { ok: true, items: [], note: `${this.id} does not support prompts/list` }
      }
      return { ok: false, items: [], note: text }
    }
    return {
      ok: true,
      items: readStringList(result, 'prompts')
        .filter((entry) => typeof entry['name'] === 'string' && (entry['name'] as string).trim() !== '')
        .map((entry) => ({
          name: entry['name'] as string,
          ...(typeof entry['description'] === 'string' ? { description: entry['description'] } : {}),
        })),
    }
  }

  /** Shut the server down. Idempotent. */
  async close(): Promise<void> {
    if (this.#unavailable === null) await this.#writeOff('closed', `${this.id} was closed`)
    this.#sessionId = null
  }

  /** Latch the server off and record it. */
  async #writeOff(
    reason: UnavailableReason,
    detail: string,
    runId?: string,
  ): Promise<{ ok: false; detail: string }> {
    if (this.#unavailable === null) {
      this.#unavailable = { reason, detail }
      this.#lastError = detail
      await this.options.events?.emit({
        runId: runId ?? this.options.runId ?? 'mcp',
        kind: 'tool_denied',
        payload: {
          component: 'mcp',
          server: this.id,
          transport: 'http',
          reason,
          detail,
        },
      })
    }
    return { ok: false, detail }
  }
}
