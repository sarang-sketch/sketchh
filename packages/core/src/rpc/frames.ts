// The wire format: one JSON object per line, in both directions.
//
// THREE frame shapes travel over stdout and they must be distinguishable by a
// consumer that does nothing but `JSON.parse` a line (Requirement 12.1, 12.6):
//
//   response, ok      { "id": <id>, "ok": true,  "result": <any> }
//   response, error   { "id": <id>, "ok": false, "error": "<message>", "code": "<code>" }
//   event             { "kind": "event", "runId": "<runId>", "requestId": <id|null>,
//                       "event": { id, ts, runId, kind, payload } }
//
// The discriminator is `ok`: a response ALWAYS carries `ok` (a boolean) and an
// `id`; an event frame NEVER carries either, and always carries
// `kind === "event"`. Either test is sufficient on its own, which is deliberate —
// `StdioSketchClient` (task 2.1) demultiplexes on one, the SSE bridge (task 2.2)
// forwards on the other, and neither has to agree with the other about which.
//
// `code` is an ADDITION to the shape Requirement 12.1 mandates, never a
// substitute: the error frame always carries a human-readable `error` string, and
// `code` is the machine-readable reason next to it. A client that ignores `code`
// still sees a conforming frame.
//
// `id` is echoed back exactly as received when it is a string or a number, and is
// `null` when the request had no usable id — including the malformed-JSON case,
// where there is no id to read. It is never invented, so a caller can always
// match a response to its request (Requirement 12.1).
//
// Validates: Requirements 12.1, 12.6

import type { SketchEvent } from '../types.js'

/**
 * A request correlation id. Strings and numbers are echoed verbatim; `null` is
 * what an unidentifiable request gets in its error response.
 */
export type FrameId = string | number | null

/** A decoded, validated request. `params` is always an object, never absent. */
export interface RequestFrame {
  id: FrameId
  method: string
  params: Record<string, unknown>
}

export interface ResponseOkFrame {
  id: FrameId
  ok: true
  result: unknown
}

export interface ResponseErrorFrame {
  id: FrameId
  ok: false
  error: string
  code: ErrorCode
}

export type ResponseFrame = ResponseOkFrame | ResponseErrorFrame

/**
 * A streamed run event. Correlated by `runId` (Requirement 12.6) and, as a
 * convenience for a client multiplexing several calls over one pipe, by the
 * `requestId` of the request that produced it.
 */
export interface EventFrame {
  kind: 'event'
  runId: string
  requestId: FrameId
  event: SketchEvent
}

export type Frame = ResponseFrame | EventFrame

/** Machine-readable error reasons. Additive: new codes may appear. */
export const ERROR_CODES = [
  /** The line was not JSON at all (Requirement 12.4). */
  'malformed_json',
  /** Valid JSON, but not a `{ id, method, params }` request. */
  'invalid_request',
  /** No such method (Requirement 12.3). */
  'unknown_method',
  /** The method exists but `params` did not satisfy it. */
  'invalid_params',
  /** The handler threw. The process stays available. */
  'handler_error',
  /** A declared method whose implementation lands in a later task. */
  'not_implemented',
] as const

export type ErrorCode = (typeof ERROR_CODES)[number]

/** Outcome of decoding one input line. */
export type ParseResult =
  | { ok: true; request: RequestFrame }
  | { ok: false; id: FrameId; code: ErrorCode; error: string }

function messageOf(err: unknown): string {
  return err instanceof Error ? err.message : String(err)
}

/** An id we are willing to echo. Anything else becomes `null`. */
function readId(value: unknown): FrameId {
  if (typeof value === 'string') return value
  if (typeof value === 'number' && Number.isFinite(value)) return value
  return null
}

/**
 * Decode one line into a request, or into the error frame it earns.
 *
 * Never throws: a caller feeding this arbitrary bytes off a pipe must get a
 * response, not an exception (Requirement 12.4).
 */
export function parseRequest(line: string): ParseResult {
  let parsed: unknown
  try {
    parsed = JSON.parse(line)
  } catch (err) {
    return {
      ok: false,
      id: null,
      code: 'malformed_json',
      error: `malformed JSON request: ${messageOf(err)}`,
    }
  }

  if (parsed === null || typeof parsed !== 'object' || Array.isArray(parsed)) {
    return {
      ok: false,
      id: null,
      code: 'invalid_request',
      error: 'request must be a JSON object of the form { id, method, params }',
    }
  }

  const record = parsed as Record<string, unknown>
  const id = readId(record['id'])

  const method = record['method']
  if (typeof method !== 'string' || method.trim() === '') {
    return {
      ok: false,
      id,
      code: 'invalid_request',
      error: 'request.method must be a non-empty string',
    }
  }

  const rawParams = record['params']
  if (rawParams !== undefined && rawParams !== null) {
    if (typeof rawParams !== 'object' || Array.isArray(rawParams)) {
      return {
        ok: false,
        id,
        code: 'invalid_request',
        error: 'request.params must be an object when present',
      }
    }
  }

  return {
    ok: true,
    request: {
      id,
      method,
      params:
        rawParams === undefined || rawParams === null
          ? {}
          : (rawParams as Record<string, unknown>),
    },
  }
}

/**
 * Serialize a frame to its single output line, WITHOUT the trailing newline —
 * adding that is the writer's job, so there is exactly one place that decides
 * what a line terminator is.
 *
 * `JSON.stringify` escapes every newline inside string values, so a frame can
 * never span two lines whatever a payload contains. That is the whole reason the
 * protocol can be line-delimited at all.
 */
export function encodeFrame(frame: Frame): string {
  return JSON.stringify(frame)
}

/** True for a streamed event frame. The complement of {@link isResponseFrame}. */
export function isEventFrame(value: unknown): value is EventFrame {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return record['kind'] === 'event' && record['ok'] === undefined
}

/** True for a response frame, ok or error. */
export function isResponseFrame(value: unknown): value is ResponseFrame {
  if (value === null || typeof value !== 'object') return false
  const record = value as Record<string, unknown>
  return typeof record['ok'] === 'boolean' && 'id' in record
}
