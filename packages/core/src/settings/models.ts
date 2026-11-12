// "Which models can I use?" — answered by the provider itself.
//
// The setup flow used to ask a person to TYPE a model id from memory, which is how a
// first run fails: `gpt4o` instead of `gpt-4o`, a model the account cannot reach, a
// Gemini id with a `models/` prefix the chat endpoint does not want. This asks the
// endpoint for its list and hands it to the picker, with the facts that decide a
// choice when the provider publishes them: context window, price, and whether the
// model is free.
//
// SAME RULES AS THE CONNECTION TEST (settings/connectionTest.ts): it is a real
// network call, so it only runs because someone asked; it takes a signal and has a
// ceiling of its own; the key is an argument for this one call and every message is
// redacted before it leaves.

import type { ProviderKind } from '../types.js'
import { redact } from '../providers/redact.js'
import { trimBaseUrl } from '../providers/wire.js'
import { checkEndpoint } from './providerSettings.js'

const ANTHROPIC_VERSION = '2023-06-01'
const DEFAULT_TIMEOUT_MS = 10_000
/** A catalog bigger than this is not a list anyone scrolls; OpenRouter is ~350. */
const MAX_MODELS = 1_000

/** One model, as much as the provider told us about it. */
export interface ProviderModel {
  /** The id to put in `providers.json` and send on the wire. */
  id: string
  /** A display name when the provider has one. */
  name?: string
  /** Context window in tokens, when published. */
  contextLength?: number
  /** True when the provider prices both directions at zero. */
  free?: boolean
  /** USD per million input tokens, when published. */
  inputPerMillion?: number
  /** USD per million output tokens, when published. */
  outputPerMillion?: number
}

export interface ProviderModelsTarget {
  id: string
  kind: ProviderKind
  baseUrl: string
  apiKey?: string
  headers?: Record<string, string>
}

export interface ProviderModelsResult {
  ok: boolean
  /** Same vocabulary as the connection test, so the surface explains failures alike. */
  code: 'ok' | 'invalid-endpoint' | 'unreachable' | 'unauthorized' | 'forbidden' | 'rate-limited' | 'endpoint-error' | 'timeout' | 'cancelled' | 'unlisted'
  message: string
  url: string
  models: ProviderModel[]
  status?: number
  /** Seconds to wait before retrying, parsed from `Retry-After` on a 429. */
  retryAfterSeconds?: number
}

export interface ProviderModelsOptions {
  signal?: AbortSignal
  timeoutMs?: number
  fetchImpl?: typeof fetch
}

function headersFor(target: ProviderModelsTarget): Record<string, string> {
  const headers: Record<string, string> = { Accept: 'application/json' }
  if (target.kind === 'anthropic-messages') {
    headers['anthropic-version'] = ANTHROPIC_VERSION
    if (target.apiKey) headers['x-api-key'] = target.apiKey
  } else if (target.apiKey) {
    headers['Authorization'] = `Bearer ${target.apiKey}`
  }
  return { ...headers, ...(target.headers ?? {}) }
}

function secretsOf(target: ProviderModelsTarget): string[] {
  const out: string[] = []
  if (target.apiKey) out.push(target.apiKey)
  for (const value of Object.values(target.headers ?? {})) if (value) out.push(value)
  return out
}

function numberOf(value: unknown): number | undefined {
  const n = typeof value === 'string' ? Number(value) : value
  return typeof n === 'number' && Number.isFinite(n) ? n : undefined
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

/**
 * Parse whichever list shape came back: OpenAI/OpenRouter `{ data: [...] }`,
 * Ollama's native `{ models: [...] }`, or a bare array. Unknown fields are ignored;
 * a model with no usable id is dropped rather than shown as a blank row.
 */
export function parseModelList(body: unknown): ProviderModel[] | null {
  const list = Array.isArray(body)
    ? body
    : body !== null && typeof body === 'object'
      ? Array.isArray((body as Record<string, unknown>)['data'])
        ? ((body as Record<string, unknown>)['data'] as unknown[])
        : Array.isArray((body as Record<string, unknown>)['models'])
          ? ((body as Record<string, unknown>)['models'] as unknown[])
          : null
      : null
  if (list === null) return null

  const out: ProviderModel[] = []
  const seen = new Set<string>()
  for (const item of list) {
    let id: string | undefined
    let record: Record<string, unknown> = {}
    if (typeof item === 'string') id = item
    else if (item !== null && typeof item === 'object') {
      record = item as Record<string, unknown>
      const raw = record['id'] ?? record['name'] ?? record['model']
      if (typeof raw === 'string') id = raw
    }
    if (id === undefined || id.trim() === '') continue
    // Gemini's OpenAI-compatible list says `models/gemini-2.5-flash`; its chat
    // endpoint wants `gemini-2.5-flash`. Store what the chat call accepts.
    id = id.trim().replace(/^models\//, '')
    if (seen.has(id)) continue
    seen.add(id)

    const model: ProviderModel = { id }
    const name = record['display_name'] ?? record['name']
    if (typeof name === 'string' && name.trim() !== '' && name !== id) model.name = name.trim()
    const context =
      numberOf(record['context_length']) ??
      numberOf(record['context_window']) ??
      numberOf((record['top_provider'] as Record<string, unknown> | undefined)?.['context_length'])
    if (context !== undefined && context > 0) model.contextLength = context
    const pricing = record['pricing']
    if (pricing !== null && typeof pricing === 'object') {
      // OpenRouter prices per TOKEN as decimal strings.
      const prompt = numberOf((pricing as Record<string, unknown>)['prompt'])
      const completion = numberOf((pricing as Record<string, unknown>)['completion'])
      if (prompt !== undefined) model.inputPerMillion = Math.round(prompt * 1_000_000 * 1000) / 1000
      if (completion !== undefined) model.outputPerMillion = Math.round(completion * 1_000_000 * 1000) / 1000
      if (prompt === 0 && completion === 0) model.free = true
    }
    if (id.endsWith(':free')) model.free = true
    out.push(model)
    if (out.length >= MAX_MODELS) break
  }
  return out
}

/** Chat-capable first: embedding, audio, image and moderation models cannot drive a run. */
function looksChatCapable(id: string): boolean {
  return !/(embed|whisper|tts|dall-e|moderation|image|audio|transcribe|rerank|guard)/i.test(id)
}

/**
 * Ask a provider which models it serves. Never throws for a failed call: "the key
 * was rejected" is an answer the picker has to render.
 */
export async function listProviderModels(
  target: ProviderModelsTarget,
  options: ProviderModelsOptions = {},
): Promise<ProviderModelsResult> {
  const secrets = secretsOf(target)
  const finish = (result: ProviderModelsResult): ProviderModelsResult => ({
    ...result,
    message: redact(result.message, secrets),
  })

  const endpoint = checkEndpoint(target.baseUrl)
  if (!endpoint.ok) {
    return finish({
      ok: false,
      code: 'invalid-endpoint',
      message: endpoint.reason ?? 'the endpoint is not usable',
      url: target.baseUrl,
      models: [],
    })
  }
  const base = trimBaseUrl(endpoint.resolvedUrl)
  const url = target.kind === 'anthropic-messages' ? `${base}/v1/models?limit=1000` : `${base}/models`

  const controller = new AbortController()
  const onAbort = () => controller.abort()
  if (options.signal?.aborted) {
    return finish({ ok: false, code: 'cancelled', message: 'cancelled', url, models: [] })
  }
  options.signal?.addEventListener('abort', onAbort, { once: true })
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort()
  }, options.timeoutMs ?? DEFAULT_TIMEOUT_MS)

  try {
    const res = await (options.fetchImpl ?? fetch)(url, {
      method: 'GET',
      headers: headersFor(target),
      signal: controller.signal,
    })
    const text = await res.text().catch(() => '')
    if (res.status === 401) {
      return finish({
        ok: false,
        code: 'unauthorized',
        status: res.status,
        url,
        models: [],
        message:
          target.apiKey === undefined || target.apiKey === ''
            ? 'This provider needs an API key before it will list its models.'
            : 'The provider rejected this API key (HTTP 401).',
      })
    }
    if (res.status === 403) {
      return finish({
        ok: false,
        code: 'forbidden',
        status: res.status,
        url,
        models: [],
        message: 'The key was accepted but is not permitted to list models here (HTTP 403). Check its permissions or your plan.',
      })
    }
    if (res.status === 429) {
      const header = res.headers?.get?.('retry-after') ?? null
      const seconds = retryAfterSeconds(header, Date.now())
      return finish({
        ok: false,
        code: 'rate-limited',
        status: res.status,
        url,
        models: [],
        ...(seconds !== null ? { retryAfterSeconds: seconds } : {}),
        message:
          'The provider is rate-limiting requests (HTTP 429)' +
          (seconds !== null ? `. Wait about ${seconds} second${seconds === 1 ? '' : 's'} and try again.` : '. Wait a moment and try again.'),
      })
    }
    if (res.status < 200 || res.status >= 300) {
      return finish({
        ok: false,
        code: 'endpoint-error',
        status: res.status,
        url,
        models: [],
        message: `The provider answered HTTP ${res.status}${text.trim() === '' ? '' : ` — ${text.slice(0, 200)}`}`,
      })
    }
    let json: unknown = null
    try {
      json = text === '' ? null : JSON.parse(text)
    } catch {
      json = null
    }
    const parsed = parseModelList(json)
    if (parsed === null) {
      // Deployment-scoped endpoints (Azure, Cloudflare) answer without a list. The
      // connection works; the model has to be named by hand, and the UI says so.
      return finish({
        ok: true,
        code: 'unlisted',
        status: res.status,
        url,
        models: [],
        message: 'Connected, but this endpoint does not publish a model list. Enter the model or deployment name.',
      })
    }
    const models = [...parsed.filter((m) => looksChatCapable(m.id)), ...parsed.filter((m) => !looksChatCapable(m.id))]
    return finish({
      ok: true,
      code: 'ok',
      status: res.status,
      url,
      models,
      message: `${models.length} model${models.length === 1 ? '' : 's'} available.`,
    })
  } catch (err) {
    if (timedOut) {
      return finish({ ok: false, code: 'timeout', url, models: [], message: 'The provider did not answer in time.' })
    }
    if (options.signal?.aborted) {
      return finish({ ok: false, code: 'cancelled', url, models: [], message: 'cancelled' })
    }
    const cause = (err as { cause?: { message?: unknown } }).cause
    const detail = typeof cause?.message === 'string' ? cause.message : err instanceof Error ? err.message : String(err)
    return finish({
      ok: false,
      code: 'unreachable',
      url,
      models: [],
      message: `Nothing answered at ${base} — ${detail}`,
    })
  } finally {
    clearTimeout(timer)
    options.signal?.removeEventListener('abort', onAbort)
  }
}
