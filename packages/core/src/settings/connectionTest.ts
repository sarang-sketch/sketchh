// The per-provider connection test (Requirements 17.1, 17.7).
//
// THIS MAKES A REAL NETWORK CALL. It is therefore never automatic: it runs when a
// user asks for it, it takes an `AbortSignal`, and it has a timeout of its own so
// a black-holed TCP connection cannot hang the surface forever.
//
// IT REPORTS WHICH FAILURE HAPPENED. A single "connection failed" is useless: the
// three things that actually go wrong need three different fixes, so they get three
// different codes and three different sentences.
//
//   unreachable      nothing is listening — start Ollama, check the port
//   unauthorized     something answered and rejected the credential — fix the key
//   model-not-found  the endpoint is fine and the key is fine; the model name is not
//
// A deployment-scoped endpoint that serves no model list (Azure OpenAI, Cloudflare
// Workers AI) passes, with a message that says the model itself was NOT verified.
// Claiming a verified model there would be the lie; refusing a working endpoint
// would be the other one.
//
// THE KEY IS AN ARGUMENT, FOR THIS CALL ONLY (Requirement 17.4). It is never stored,
// never returned, and every message this module produces is passed through the
// provider redactor before it leaves.
//
// Validates: Requirements 17.1, 17.4, 17.7

import type { ProviderKind } from '../types.js'
import { redact } from '../providers/redact.js'
import { trimBaseUrl } from '../providers/wire.js'
import { checkEndpoint } from './providerSettings.js'

/** What went wrong, in the terms that decide what the user does next. */
export type ProviderTestCode =
  | 'ok'
  | 'invalid-endpoint'
  | 'unreachable'
  | 'unauthorized'
  | 'forbidden'
  | 'rate-limited'
  | 'model-not-found'
  | 'malformed-response'
  | 'endpoint-error'
  | 'timeout'
  | 'cancelled'

export interface ProviderTestResult {
  ok: boolean
  code: ProviderTestCode
  /** One sentence, redacted, naming what happened and what to do about it. */
  message: string
  /** The URL that was actually called. Shown so a typo is visible. */
  url: string
  /** HTTP status, when one came back. */
  status?: number
  /** Model ids the endpoint advertised, capped. Present on a model mismatch. */
  models?: string[]
  /** Seconds to wait before retrying, parsed from `Retry-After` on a 429. */
  retryAfterSeconds?: number
  durationMs: number
}

/** What to test. `apiKey` is supplied per call and is not persisted anywhere. */
export interface ProviderTestTarget {
  id: string
  kind: ProviderKind
  baseUrl: string
  model: string
  apiKey?: string
  headers?: Record<string, string>
}

export interface ProviderTestOptions {
  /** User cancellation. An aborted test resolves as `cancelled`, it does not throw. */
  signal?: AbortSignal
  /** Per-request ceiling. Default 5 s: long enough for a cold local model list. */
  timeoutMs?: number
  /** Injected in tests that must not open a socket at all. Defaults to `fetch`. */
  fetchImpl?: typeof fetch
  clock?: () => number
}

const DEFAULT_TIMEOUT_MS = 5_000
const MAX_REPORTED_MODELS = 12
/** Anthropic's messages API requires this header on every request. */
const ANTHROPIC_VERSION = '2023-06-01'

function headersFor(target: ProviderTestTarget): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (target.apiKey) {
    if (target.kind === 'anthropic-messages') {
      headers['x-api-key'] = target.apiKey
      headers['anthropic-version'] = ANTHROPIC_VERSION
    } else {
      headers['Authorization'] = `Bearer ${target.apiKey}`
    }
  } else if (target.kind === 'anthropic-messages') {
    headers['anthropic-version'] = ANTHROPIC_VERSION
  }
  return { ...headers, ...(target.headers ?? {}) }
}

function secretsOf(target: ProviderTestTarget): string[] {
  const secrets: string[] = []
  if (target.apiKey) secrets.push(target.apiKey)
  for (const value of Object.values(target.headers ?? {})) if (value) secrets.push(value)
  return secrets
}

/** `{baseUrl}/models`, or Anthropic's `{baseUrl}/v1/models`. */
function modelsUrl(target: ProviderTestTarget): string {
  const base = trimBaseUrl(target.baseUrl)
  return target.kind === 'anthropic-messages' ? `${base}/v1/models` : `${base}/models`
}

/** Model ids out of either shape: OpenAI's `{data:[{id}]}` or Ollama's `{models:[…]}`. */
function modelIdsFrom(body: unknown): string[] | null {
  if (body === null || typeof body !== 'object') return null
  const record = body as Record<string, unknown>
  const list = Array.isArray(record['data'])
    ? (record['data'] as unknown[])
    : Array.isArray(record['models'])
      ? (record['models'] as unknown[])
      : null
  if (list === null) return null

  const ids: string[] = []
  for (const item of list) {
    if (typeof item === 'string') ids.push(item)
    else if (item !== null && typeof item === 'object') {
      const id = (item as Record<string, unknown>)['id'] ?? (item as Record<string, unknown>)['name']
      if (typeof id === 'string') ids.push(id)
    }
  }
  return ids
}

/**
 * Ollama serves both `llama3` and `llama3:latest` under one name, and OpenAI-style
 * deployments append suffixes. A configured name matches when the advertised id is
 * the same, or the same up to a `:tag`.
 */
function advertises(ids: string[], model: string): boolean {
  const wanted = model.toLowerCase()
  return ids.some((id) => {
    const found = id.toLowerCase()
    return found === wanted || found.split(':')[0] === wanted || wanted.split(':')[0] === found
  })
}

interface Attempt {
  kind: 'response'
  status: number
  body: string
  json: unknown
  /** `Retry-After` header value, when the response carried one. */
  retryAfter: string | null
}

/** `Retry-After` in seconds: an integer delta, or an HTTP date, or null. */
function retryAfterSeconds(header: string | null, now: number): number | null {
  if (header === null) return null
  const text = header.trim()
  if (text === '') return null
  if (/^\d+$/.test(text)) return Math.max(0, Number(text))
  const when = Date.parse(text)
  if (Number.isNaN(when)) return null
  return Math.max(0, Math.round((when - now) / 1000))
}

type AttemptOutcome = Attempt | { kind: 'aborted' } | { kind: 'timeout' } | { kind: 'network'; detail: string }

async function attempt(
  url: string,
  init: RequestInit,
  options: ProviderTestOptions,
): Promise<AttemptOutcome> {
  const doFetch = options.fetchImpl ?? fetch
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS
  const controller = new AbortController()

  const onAbort = () => controller.abort()
  if (options.signal) {
    if (options.signal.aborted) return { kind: 'aborted' }
    options.signal.addEventListener('abort', onAbort, { once: true })
  }
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, timeoutMs)

  try {
    const res = await doFetch(url, { ...init, signal: controller.signal })
    const body = await res.text().catch(() => '')
    let json: unknown = null
    try {
      json = body === '' ? null : JSON.parse(body)
    } catch {
      json = null
    }
    return { kind: 'response', status: res.status, body, json, retryAfter: res.headers?.get?.('retry-after') ?? null }
  } catch (err) {
    if (timedOut) return { kind: 'timeout' }
    if (options.signal?.aborted) return { kind: 'aborted' }
    if (err instanceof Error && err.name === 'AbortError') return { kind: 'aborted' }
    // Node wraps the real reason (ECONNREFUSED, ENOTFOUND, EHOSTUNREACH) in `cause`.
    const cause = (err as { cause?: unknown }).cause
    const causeText =
      cause instanceof Error
        ? cause.message
        : cause !== undefined && cause !== null
          ? String(cause)
          : ''
    const detail = err instanceof Error ? err.message : String(err)
    return { kind: 'network', detail: causeText === '' ? detail : `${detail} (${causeText})` }
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}

/** `http://localhost:11434/v1` → `localhost:11434`, for a message a human reads. */
function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

function looksLikeModelComplaint(body: string): boolean {
  return /model|deployment/i.test(body) && !/api[_ -]?key|token|unauthor/i.test(body)
}

/**
 * Test one provider. Resolves with a verdict; it does not throw for a failed
 * connection, because "no server there" is an answer the surface has to render.
 */
export async function testProviderConnection(
  target: ProviderTestTarget,
  options: ProviderTestOptions = {},
): Promise<ProviderTestResult> {
  const clock = options.clock ?? (() => Date.now())
  const startedAt = clock()
  const secrets = secretsOf(target)
  const finish = (
    partial: Omit<ProviderTestResult, 'durationMs' | 'message'> & { message: string },
  ): ProviderTestResult => ({
    ...partial,
    message: redact(partial.message, secrets),
    durationMs: Math.max(0, clock() - startedAt),
  })

  const endpoint = checkEndpoint(target.baseUrl)
  if (!endpoint.ok) {
    return finish({
      ok: false,
      code: 'invalid-endpoint',
      url: target.baseUrl,
      message: `${target.id}: ${endpoint.reason ?? 'the endpoint is not usable'}`,
    })
  }
  if (target.model.trim() === '') {
    return finish({
      ok: false,
      code: 'model-not-found',
      url: endpoint.resolvedUrl,
      message: `${target.id}: no model is configured, so the endpoint was not contacted`,
    })
  }

  const url = modelsUrl({ ...target, baseUrl: endpoint.resolvedUrl })
  const outcome = await attempt(url, { method: 'GET', headers: headersFor(target) }, options)

  if (outcome.kind === 'aborted') {
    return finish({ ok: false, code: 'cancelled', url, message: `${target.id}: test cancelled` })
  }
  if (outcome.kind === 'timeout') {
    return finish({
      ok: false,
      code: 'timeout',
      url,
      message: `${target.id}: ${hostOf(url)} accepted the connection but did not answer within ${
        options.timeoutMs ?? DEFAULT_TIMEOUT_MS
      } ms`,
    })
  }
  if (outcome.kind === 'network') {
    return finish({
      ok: false,
      code: 'unreachable',
      url,
      message:
        `${target.id}: nothing answered at ${hostOf(url)} — ${outcome.detail}. ` +
        'Check that the server is running and that the host and port are right.',
    })
  }

  if (outcome.status === 401) {
    return finish({
      ok: false,
      code: 'unauthorized',
      url,
      status: outcome.status,
      message:
        target.apiKey === undefined || target.apiKey === ''
          ? `${target.id}: ${hostOf(url)} answered HTTP 401 and requires a key, but none was supplied`
          : `${target.id}: ${hostOf(url)} rejected the supplied key with HTTP 401. Check the API key in Settings → Models.`,
    })
  }

  // 403 is a DIFFERENT fix from 401: the key is recognised but this account or key
  // is not permitted to do this — a missing scope, a region the plan does not cover,
  // an org that has to grant access. Saying "rejected the key" would send the user
  // to replace a key that is fine.
  if (outcome.status === 403) {
    return finish({
      ok: false,
      code: 'forbidden',
      url,
      status: outcome.status,
      message:
        `${target.id}: ${hostOf(url)} answered HTTP 403 — the key was accepted but is not permitted to use this ` +
        `endpoint or model. Check the key's permissions, your plan, or your organisation access.`,
    })
  }

  // 429 is transient and ACTIONABLE: it tells the user to wait, and for how long when
  // the provider sent Retry-After. It is not a broken key and not a broken endpoint.
  if (outcome.status === 429) {
    const seconds = retryAfterSeconds(outcome.retryAfter, clock())
    return finish({
      ok: false,
      code: 'rate-limited',
      url,
      status: outcome.status,
      ...(seconds !== null ? { retryAfterSeconds: seconds } : {}),
      message:
        `${target.id}: ${hostOf(url)} is rate-limiting requests (HTTP 429)` +
        (seconds !== null
          ? `. Wait about ${seconds} second${seconds === 1 ? '' : 's'} and try again.`
          : '. Wait a moment, or check your plan and quota, and try again.'),
    })
  }

  if (outcome.status >= 200 && outcome.status < 300) {
    // Nothing parseable came back at all. That is a broken endpoint, not a verdict
    // about the model, and it is reported as its own failure.
    if (outcome.json === null && outcome.body.trim() !== '') {
      return finish({
        ok: false,
        code: 'malformed-response',
        url,
        status: outcome.status,
        message:
          `${target.id}: ${hostOf(url)} answered HTTP ${outcome.status}, but the body was not JSON. ` +
          'No model was verified.',
      })
    }

    const ids = modelIdsFrom(outcome.json)
    if (ids === null) {
      // JSON, but no model list in it. Deployment-scoped endpoints (Azure OpenAI,
      // Cloudflare Workers AI) answer exactly like this. The connection and the
      // credential ARE verified by this response; the model name is not, and the
      // message says so rather than inventing either verdict.
      return finish({
        ok: true,
        code: 'ok',
        url,
        status: outcome.status,
        message:
          `${target.id}: ${hostOf(url)} answered HTTP ${outcome.status} and accepted the request, ` +
          `but it does not list its models, so '${target.model}' was not verified.`,
      })
    }
    if (ids.length === 0) {
      return finish({
        ok: false,
        code: 'model-not-found',
        url,
        status: outcome.status,
        models: [],
        message: `${target.id}: ${hostOf(url)} is reachable, but it advertised no models`,
      })
    }
    if (advertises(ids, target.model)) {
      return finish({
        ok: true,
        code: 'ok',
        url,
        status: outcome.status,
        message: `${target.id}: ${hostOf(url)} answered and serves '${target.model}'`,
      })
    }
    return finish({
      ok: false,
      code: 'model-not-found',
      url,
      status: outcome.status,
      models: ids.slice(0, MAX_REPORTED_MODELS),
      message:
        `${target.id}: ${hostOf(url)} is reachable and the key is accepted, but it does not serve ` +
        `'${target.model}'. It offers: ${ids.slice(0, MAX_REPORTED_MODELS).join(', ')}`,
    })
  }

  if (outcome.status === 404 && looksLikeModelComplaint(outcome.body)) {
    return finish({
      ok: false,
      code: 'model-not-found',
      url,
      status: outcome.status,
      message: `${target.id}: ${hostOf(url)} does not know '${target.model}' — ${outcome.body.slice(0, 200)}`,
    })
  }

  return finish({
    ok: false,
    code: 'endpoint-error',
    url,
    status: outcome.status,
    message:
      `${target.id}: ${hostOf(url)} answered HTTP ${outcome.status}` +
      (outcome.body.trim() === '' ? '' : ` — ${outcome.body.slice(0, 200)}`),
  })
}
