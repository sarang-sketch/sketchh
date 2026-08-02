// JSON-RPC 2.0 over stdio, hand-rolled. No SDK.
//
// ── WHY HAND-ROLLED ────────────────────────────────────────────────────────
//
// `packages/core` has zero runtime dependencies, and that is what makes the engine
// embeddable, auditable, and bundleable into one sidecar file. MCP's stdio transport
// is newline-delimited JSON-RPC 2.0 — a few hundred lines — so taking a dependency
// to speak it would trade the whole constraint for a convenience.
//
// The framing discipline is the one this package already proved in `src/rpc/`:
// one JSON object per line, PROTOCOL ON STDOUT, DIAGNOSTICS ON STDERR, correlate by
// id. That split is not stylistic: a server that logs to stdout corrupts the stream,
// and the only way to survive a server that does it anyway is to treat an
// unparseable line as a diagnostic rather than a fatal error.
//
// ── WHAT IS DELIBERATELY NOT HERE ──────────────────────────────────────────
//
// No batching (MCP does not use it), no request cancellation over the wire (there is
// no such notification in the version this targets — a timeout kills the process
// instead), and no schema validation of a tool's result beyond "it is JSON". The
// last one matters: a tool's result is UNTRUSTED DATA from a third-party process, and
// validating it into a shape we then trust would be the wrong kind of confidence.
//
// Validates: Requirements 22.1, 22.3

/** The protocol version string this client sends in `initialize`. */
export const MCP_PROTOCOL_VERSION = '2024-11-05'

/** Client identity sent in the handshake. */
export const MCP_CLIENT_INFO = Object.freeze({ name: 'sketch', version: '0.1.0' })

export interface JsonRpcRequest {
  jsonrpc: '2.0'
  id: number
  method: string
  params?: unknown
}

export interface JsonRpcNotification {
  jsonrpc: '2.0'
  method: string
  params?: unknown
}

export interface JsonRpcError {
  code: number
  message: string
  data?: unknown
}

export interface JsonRpcResponse {
  jsonrpc: '2.0'
  id: number
  result?: unknown
  error?: JsonRpcError
}

/** One decoded line from a server's stdout. */
export type IncomingFrame =
  | { kind: 'response'; response: JsonRpcResponse }
  | { kind: 'notification'; notification: JsonRpcNotification }
  /** A line that is not protocol. Kept as a diagnostic, never fatal. */
  | { kind: 'noise'; line: string; reason: string }

/** Encode one outgoing frame. Exactly one line, always terminated. */
export function encode(frame: JsonRpcRequest | JsonRpcNotification): string {
  return `${JSON.stringify(frame)}\n`
}

/**
 * Decode one line.
 *
 * A server that prints a banner, a deprecation warning, or a progress bar to stdout
 * is common and is not a protocol violation worth dying over — it is `noise`, and the
 * caller logs it and carries on. Anything that parses as JSON but is not a valid
 * response or notification is noise too, with the reason attached: silently
 * discarding it would hide a real interoperability problem.
 */
export function decode(line: string): IncomingFrame | null {
  const trimmed = line.trim()
  if (trimmed === '') return null

  let parsed: unknown
  try {
    parsed = JSON.parse(trimmed)
  } catch {
    return { kind: 'noise', line: trimmed, reason: 'not JSON' }
  }
  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return { kind: 'noise', line: trimmed, reason: 'not a JSON object' }
  }

  const frame = parsed as Record<string, unknown>
  if (frame['jsonrpc'] !== '2.0') {
    return { kind: 'noise', line: trimmed, reason: 'missing jsonrpc "2.0"' }
  }

  const id = frame['id']
  if (typeof id === 'number') {
    const error = frame['error']
    if (error !== undefined) {
      if (error === null || typeof error !== 'object' || Array.isArray(error)) {
        return { kind: 'noise', line: trimmed, reason: 'error is not an object' }
      }
      const record = error as Record<string, unknown>
      return {
        kind: 'response',
        response: {
          jsonrpc: '2.0',
          id,
          error: {
            code: typeof record['code'] === 'number' ? record['code'] : -32_000,
            message: typeof record['message'] === 'string' ? record['message'] : 'unknown error',
            ...(record['data'] !== undefined ? { data: record['data'] } : {}),
          },
        },
      }
    }
    return { kind: 'response', response: { jsonrpc: '2.0', id, result: frame['result'] } }
  }

  const method = frame['method']
  if (typeof method === 'string') {
    return {
      kind: 'notification',
      notification: { jsonrpc: '2.0', method, ...(frame['params'] !== undefined ? { params: frame['params'] } : {}) },
    }
  }

  return { kind: 'noise', line: trimmed, reason: 'neither a response (numeric id) nor a notification (method)' }
}

/**
 * Split a growing buffer into complete lines, returning the remainder.
 *
 * Stdout arrives in arbitrary chunks: one read can hold half a frame, or three
 * frames and half of a fourth. Treating a chunk as a line is the classic stdio bug,
 * and it fails only under load — which is when it matters.
 */
export function takeLines(buffer: string): { lines: string[]; rest: string } {
  const lines: string[] = []
  let rest = buffer
  for (;;) {
    const at = rest.indexOf('\n')
    if (at === -1) break
    lines.push(rest.slice(0, at))
    rest = rest.slice(at + 1)
  }
  return { lines, rest }
}

// ── the shapes this client reads out of MCP results ─────────────────────────
//
// Read defensively and narrowly. Every field below is optional in practice because
// the server is a third-party process that may be a different version, a different
// implementation, or broken — and a missing field must degrade the result rather
// than throw inside a verification run.

/** One tool a server advertises. */
export interface McpToolInfo {
  name: string
  description: string
  /** The raw JSON Schema for the tool's arguments, unvalidated and unused. */
  inputSchema?: unknown
}

/** `tools/list` → the advertised tools. Anything malformed is dropped, not fatal. */
export function readToolList(result: unknown): McpToolInfo[] {
  if (result === null || typeof result !== 'object') return []
  const tools = (result as Record<string, unknown>)['tools']
  if (!Array.isArray(tools)) return []

  const out: McpToolInfo[] = []
  for (const entry of tools) {
    if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) continue
    const record = entry as Record<string, unknown>
    const name = record['name']
    if (typeof name !== 'string' || name.trim() === '') continue
    out.push({
      name,
      description: typeof record['description'] === 'string' ? record['description'] : '',
      ...(record['inputSchema'] !== undefined ? { inputSchema: record['inputSchema'] } : {}),
    })
  }
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/** What a `tools/call` produced, flattened to text plus the server's own error flag. */
export interface McpCallOutcome {
  /** The server's `isError`. A tool that failed is not a protocol error. */
  isError: boolean
  /** Concatenated text content. Empty when the tool returned only non-text parts. */
  text: string
  /** Content parts this client did not render, by type, so nothing is silently lost. */
  unrendered: string[]
}

/**
 * `tools/call` → text.
 *
 * MCP content is a list of typed parts (`text`, `image`, `resource`, …). Only `text`
 * is rendered, and the types that were NOT rendered are listed rather than dropped:
 * "the tool returned an image" is information a model and a user both need, and
 * silently returning an empty string for it reads as "the tool did nothing".
 */
export function readCallResult(result: unknown): McpCallOutcome {
  if (result === null || typeof result !== 'object') {
    return { isError: false, text: '', unrendered: [] }
  }
  const record = result as Record<string, unknown>
  const isError = record['isError'] === true
  const content = record['content']
  if (!Array.isArray(content)) {
    return { isError, text: '', unrendered: [] }
  }

  const chunks: string[] = []
  const unrendered = new Set<string>()
  for (const part of content) {
    if (part === null || typeof part !== 'object' || Array.isArray(part)) continue
    const entry = part as Record<string, unknown>
    const type = typeof entry['type'] === 'string' ? (entry['type'] as string) : 'unknown'
    if (type === 'text' && typeof entry['text'] === 'string') {
      chunks.push(entry['text'])
      continue
    }
    unrendered.add(type)
  }

  return { isError, text: chunks.join('\n'), unrendered: [...unrendered].sort() }
}
