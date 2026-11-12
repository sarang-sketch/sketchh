// The `chatgpt` ChatAdapter: a signed-in ChatGPT account as the model.
//
// It speaks the OpenAI Responses API to the ChatGPT backend that serves Codex
// (`https://chatgpt.com/backend-api/codex/responses`), the way Codex CLI, OpenCode
// and Cline do. What that backend requires was read from their sources, not guessed:
//
//   * `stream: true` and `store: false` — always (it refuses anything else);
//   * the system prompt goes in `instructions`, the conversation in `input`;
//   * NO `max_output_tokens`, `temperature` or `stop` — unsupported there;
//   * `Authorization: Bearer <access token>` plus `ChatGPT-Account-Id`;
//   * `originator` names the calling app (OpenCode sends "opencode", Cline "cline").
//
// The answer arrives as server-sent events. The text is taken from the finished
// assistant message items (`response.output_item.done`), preferring the FINAL one
// over "commentary" updates newer models send first; streamed deltas are the
// fallback for a stream that ends without them.
//
// Tokens never leave this module except as the `Authorization` header: every error
// is redacted with them, and they are never part of a returned value.

import { randomUUID } from 'node:crypto'
import { arch, platform, release } from 'node:os'

import type { ChatAdapter, Message, ProviderConfig, Usage } from '../types.js'
import { ENGINE_VERSION } from '../rpc/version.js'
import {
  CHATGPT_ORIGINATOR,
  CHATGPT_PROVIDER_ID,
  ChatGPTAuthError,
  chatgptEndpoints,
  getChatGPTAccess,
  type ChatGPTAccess,
  type ChatGPTStoreOptions,
} from '../settings/chatgptAuth.js'
import { backoffMs, ProviderTimeoutError, sleepFor } from './http.js'
import { providerError } from './redact.js'
import type { ChatCallOptions } from './wire.js'

/** Ceiling on waiting for the response headers. */
const CONNECT_TIMEOUT_MS = 120_000
/** Ceiling on SILENCE once streaming: reasoning models pause, but not for this long. */
const IDLE_TIMEOUT_MS = 180_000
/** Retries after the first attempt, for 5xx and dropped connections only. */
const RETRIES = 2
const RETRYABLE = new Set([500, 502, 503, 504, 529])

/** The instructions sent when a caller supplied no system message at all. */
const DEFAULT_INSTRUCTIONS = 'You are a helpful coding assistant.'

// ── request ──────────────────────────────────────────────────────────────────

type InputItem = {
  type: 'message'
  role: 'user' | 'assistant' | 'developer'
  content: Array<{ type: 'input_text' | 'output_text'; text: string }>
}

export interface ResponsesRequestBody {
  model: string
  instructions: string
  input: InputItem[]
  tool_choice: 'auto'
  parallel_tool_calls: false
  store: false
  stream: true
  include: string[]
  prompt_cache_key: string
  reasoning?: { effort: string }
}

/**
 * `Message[]` → a Responses request. LEADING system messages become the
 * instructions; a system message later in the conversation keeps its place as a
 * `developer` message, so the order the loop built is the order the model reads.
 */
export function toResponsesRequest(
  messages: readonly Message[],
  model: string,
  sessionId: string,
  options: ChatCallOptions = {},
): ResponsesRequestBody {
  const instructions: string[] = []
  const input: InputItem[] = []
  let leading = true
  for (const message of messages) {
    const text = typeof message.content === 'string' ? message.content : String(message.content ?? '')
    if (text.trim() === '') continue
    if (message.role === 'system' && leading) {
      instructions.push(text)
      continue
    }
    leading = false
    if (message.role === 'assistant') {
      input.push({ type: 'message', role: 'assistant', content: [{ type: 'output_text', text }] })
    } else if (message.role === 'system') {
      input.push({ type: 'message', role: 'developer', content: [{ type: 'input_text', text }] })
    } else if (message.role === 'tool') {
      input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text: `Tool output:\n${text}` }] })
    } else {
      input.push({ type: 'message', role: 'user', content: [{ type: 'input_text', text }] })
    }
  }
  const body: ResponsesRequestBody = {
    model,
    instructions: instructions.length > 0 ? instructions.join('\n\n') : DEFAULT_INSTRUCTIONS,
    input,
    tool_choice: 'auto',
    parallel_tool_calls: false,
    store: false,
    stream: true,
    include: [],
    prompt_cache_key: sessionId,
  }
  // A caller asking for a SHORT answer (inline completion) gets the fastest
  // reasoning every listed model supports. The token cap itself is unsupported
  // here; the caller clips.
  if (typeof options.maxTokens === 'number' && options.maxTokens > 0 && options.maxTokens <= 2_048) {
    body.reasoning = { effort: 'low' }
  }
  return body
}

// ── server-sent events ───────────────────────────────────────────────────────

interface SseEvent {
  event?: string
  data: string
}

function parseBlock(block: string): SseEvent | null {
  const data: string[] = []
  let event: string | undefined
  for (const line of block.split('\n')) {
    if (line === '' || line.startsWith(':')) continue
    const colon = line.indexOf(':')
    const field = colon === -1 ? line : line.slice(0, colon)
    let value = colon === -1 ? '' : line.slice(colon + 1)
    if (value.startsWith(' ')) value = value.slice(1)
    if (field === 'data') data.push(value)
    else if (field === 'event') event = value
  }
  if (data.length === 0) return null
  return event === undefined ? { data: data.join('\n') } : { event, data: data.join('\n') }
}

/** Every event in a byte stream, with a ceiling on silence between chunks. */
export async function* readSse(
  body: ReadableStream<Uint8Array>,
  idleTimeoutMs: number = IDLE_TIMEOUT_MS,
  onIdle?: () => void,
): AsyncGenerator<SseEvent> {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    for (;;) {
      let timer: ReturnType<typeof setTimeout> | undefined
      const idle = new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          onIdle?.()
          reject(new ProviderTimeoutError(idleTimeoutMs))
        }, idleTimeoutMs)
      })
      let chunk: { done: boolean; value?: Uint8Array }
      try {
        chunk = await Promise.race([reader.read(), idle])
      } finally {
        clearTimeout(timer)
      }
      if (chunk.done || chunk.value === undefined) break
      buffer = (buffer + decoder.decode(chunk.value, { stream: true })).replace(/\r\n/g, '\n')
      let boundary = buffer.indexOf('\n\n')
      while (boundary !== -1) {
        const parsed = parseBlock(buffer.slice(0, boundary))
        buffer = buffer.slice(boundary + 2)
        if (parsed !== null) yield parsed
        boundary = buffer.indexOf('\n\n')
      }
    }
    const tail = parseBlock((buffer + decoder.decode()).replace(/\r\n/g, '\n'))
    if (tail !== null) yield tail
  } finally {
    reader.releaseLock?.()
    await body.cancel?.().catch?.(() => {})
  }
}

export interface ResponsesOutcome {
  text: string
  usage?: Usage
  /** The model the backend says answered (`response.model`), when it named one. */
  model?: string
  /** Why a response stopped short (`response.incomplete`), when it did. */
  incomplete?: string
}

function asRecord(value: unknown): Record<string, unknown> | undefined {
  return value !== null && typeof value === 'object' && !Array.isArray(value) ? (value as Record<string, unknown>) : undefined
}

/** A failure the backend reported INSIDE the stream. */
export class ResponsesStreamError extends Error {
  readonly code: string | undefined
  constructor(code: string | undefined, message: string) {
    super(message)
    this.name = 'ResponsesStreamError'
    this.code = code
  }
}

/** Collect a Responses event stream into the reply text and usage. */
export async function collectResponses(events: AsyncIterable<SseEvent>): Promise<ResponsesOutcome> {
  const items: Array<{ phase?: string; text: string }> = []
  let deltas = ''
  let usage: Usage | undefined
  let model: string | undefined
  let incomplete: string | undefined
  let completed = false

  for await (const raw of events) {
    if (raw.data === '[DONE]') break
    let event: Record<string, unknown> | undefined
    try {
      event = asRecord(JSON.parse(raw.data))
    } catch {
      event = undefined
    }
    if (event === undefined) continue
    const type = typeof event['type'] === 'string' ? (event['type'] as string) : raw.event
    switch (type) {
      case 'response.output_text.delta': {
        if (typeof event['delta'] === 'string') deltas += event['delta']
        break
      }
      case 'response.output_item.done': {
        const item = asRecord(event['item'])
        if (item?.['type'] !== 'message' || item['role'] !== 'assistant') break
        const parts = Array.isArray(item['content']) ? (item['content'] as unknown[]) : []
        const text = parts
          .map((part) => {
            const p = asRecord(part)
            return p?.['type'] === 'output_text' && typeof p['text'] === 'string' ? (p['text'] as string) : ''
          })
          .join('')
        const phase = typeof item['phase'] === 'string' ? (item['phase'] as string) : undefined
        items.push(phase === undefined ? { text } : { phase, text })
        break
      }
      case 'response.completed':
      case 'response.incomplete': {
        const response = asRecord(event['response'])
        const named = typeof response?.['model'] === 'string' ? (response['model'] as string).trim() : ''
        if (named !== '') model = named
        const u = asRecord(response?.['usage'])
        if (u !== undefined) {
          const input = typeof u['input_tokens'] === 'number' ? (u['input_tokens'] as number) : 0
          const output = typeof u['output_tokens'] === 'number' ? (u['output_tokens'] as number) : 0
          usage = { in: input, out: output }
        }
        if (type === 'response.incomplete') {
          const details = asRecord(response?.['incomplete_details'])
          incomplete = typeof details?.['reason'] === 'string' ? (details['reason'] as string) : 'incomplete'
        }
        completed = true
        break
      }
      case 'response.failed': {
        const error = asRecord(asRecord(event['response'])?.['error'])
        const code = typeof error?.['code'] === 'string' ? (error['code'] as string) : undefined
        const message = typeof error?.['message'] === 'string' && (error['message'] as string).trim() !== ''
          ? (error['message'] as string)
          : 'The response failed.'
        throw new ResponsesStreamError(code, message)
      }
      case 'error': {
        const error = asRecord(event['error']) ?? event
        const code = typeof error['code'] === 'string' ? (error['code'] as string) : undefined
        const message = typeof error['message'] === 'string' ? (error['message'] as string) : 'The response failed.'
        throw new ResponsesStreamError(code, message)
      }
      default:
        break
    }
    if (completed) break
  }

  const finals = items.filter((item) => item.phase !== 'commentary')
  const chosen = (finals.length > 0 ? finals : items).map((item) => item.text).filter((t) => t.trim() !== '')
  const text = chosen.length > 0 ? chosen.join('\n\n').trim() : deltas.trim()
  if (!completed && text === '') {
    throw new ResponsesStreamError('stream_ended', 'The connection to ChatGPT closed before an answer arrived.')
  }
  const out: ResponsesOutcome = { text }
  if (usage !== undefined) out.usage = usage
  if (model !== undefined) out.model = model
  if (incomplete !== undefined) out.incomplete = incomplete
  return out
}

// ── errors a person can act on ───────────────────────────────────────────────

function formatReset(resetsAtSeconds: number | undefined, now: number): string {
  if (resetsAtSeconds === undefined || !Number.isFinite(resetsAtSeconds)) return ''
  const ms = resetsAtSeconds * 1000 - now
  if (ms <= 0) return ' It should reset any moment now.'
  const minutes = Math.ceil(ms / 60_000)
  if (minutes < 90) return ` It resets in about ${minutes} minute${minutes === 1 ? '' : 's'}.`
  const hours = Math.round(minutes / 60)
  if (hours < 48) return ` It resets in about ${hours} hours.`
  return ` It resets on ${new Date(resetsAtSeconds * 1000).toLocaleDateString()}.`
}

/** What an HTTP failure from the ChatGPT backend means, in one or two sentences. */
export function chatgptFailureMessage(status: number, bodyText: string, model: string, now: number = Date.now()): string {
  let json: Record<string, unknown> | undefined
  try {
    json = asRecord(JSON.parse(bodyText))
  } catch {
    json = undefined
  }
  const error = asRecord(json?.['error'])
  const type = typeof error?.['type'] === 'string' ? (error['type'] as string) : undefined
  const code = typeof error?.['code'] === 'string' ? (error['code'] as string) : undefined
  const serverMessage =
    (typeof error?.['message'] === 'string' && (error['message'] as string)) ||
    (typeof json?.['detail'] === 'string' && (json['detail'] as string)) ||
    ''
  const plan = typeof error?.['plan_type'] === 'string' ? ` (${error['plan_type']} plan)` : ''

  if (type === 'usage_limit_reached' || code === 'usage_limit_reached') {
    const resetsAt = typeof error?.['resets_at'] === 'number' ? (error['resets_at'] as number) : undefined
    return `You have reached your ChatGPT usage limit${plan}.${formatReset(resetsAt, now)} You can switch to another model in the meantime.`
  }
  if (type === 'usage_not_included' || code === 'usage_not_included') {
    return 'Your ChatGPT plan does not include Codex models. Upgrade your plan at chatgpt.com, or connect another provider.'
  }
  if (status === 401) return 'ChatGPT no longer accepts this sign-in. Open Settings → Models and choose “Sign in with ChatGPT” again.'
  if (status === 403) {
    return `ChatGPT refused the request${serverMessage !== '' ? `: ${serverMessage}` : ' for this account or workspace.'}`
  }
  if (status === 404 || (status === 400 && /model/i.test(serverMessage))) {
    return `The model “${model}” is not available to your ChatGPT account${serverMessage !== '' ? ` (${serverMessage})` : ''}. Pick another ChatGPT model.`
  }
  if (status === 429) return `ChatGPT is rate-limiting requests right now. Wait a moment and try again.${serverMessage !== '' ? ` (${serverMessage})` : ''}`
  if (status >= 500) return `ChatGPT is having trouble (HTTP ${status}). Try again shortly.`
  return serverMessage !== '' ? serverMessage : `ChatGPT answered HTTP ${status}.`
}

function streamFailureMessage(err: ResponsesStreamError): string {
  switch (err.code) {
    case 'context_length_exceeded':
      return 'The conversation is longer than this model accepts. Start a new chat, or attach fewer files.'
    case 'usage_limit_reached':
      return 'You have reached your ChatGPT usage limit. Switch models, or wait for the limit to reset.'
    case 'usage_not_included':
      return 'Your ChatGPT plan does not include Codex models. Upgrade your plan at chatgpt.com, or connect another provider.'
    case 'server_is_overloaded':
    case 'server_error':
      return `ChatGPT is overloaded right now. Try again shortly. (${err.message})`
    default:
      return err.message
  }
}

// ── the adapter ──────────────────────────────────────────────────────────────

export interface ChatGPTAdapterOptions extends ChatGPTStoreOptions {
  env?: NodeJS.ProcessEnv
  fetchImpl?: typeof fetch
  now?: () => number
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>
  /** Override the silence ceiling (tests). */
  idleTimeoutMs?: number
}

function abortError(): Error {
  const err = new Error('The operation was aborted.')
  err.name = 'AbortError'
  return err
}

export function chatgptUserAgent(): string {
  return `sketch/${ENGINE_VERSION} (${platform()} ${release()}; ${arch()})`
}

/** Headers for one backend call. */
export function chatgptHeaders(access: ChatGPTAccess, sessionId: string, accept = 'text/event-stream'): Record<string, string> {
  return {
    'Content-Type': 'application/json',
    Accept: accept,
    Authorization: `Bearer ${access.accessToken}`,
    'ChatGPT-Account-Id': access.accountId,
    originator: CHATGPT_ORIGINATOR,
    'User-Agent': chatgptUserAgent(),
    'session-id': sessionId,
    ...(access.residency !== undefined ? { 'x-openai-internal-codex-residency': access.residency } : {}),
  }
}

export class ChatGPTCodexAdapter implements ChatAdapter {
  readonly id: string
  readonly model: string

  readonly #options: ChatGPTAdapterOptions
  /** One per adapter, i.e. per run: lets the backend reuse its prompt cache across turns. */
  readonly #sessionId = randomUUID()

  constructor(config: Pick<ProviderConfig, 'id' | 'model'>, options: ChatGPTAdapterOptions = {}) {
    this.id = config.id || CHATGPT_PROVIDER_ID
    this.model = config.model
    this.#options = options
  }

  async chat(messages: Message[], options?: ChatCallOptions): Promise<{ text: string; usage?: Usage; model?: string; attempts?: number }> {
    const signal = options?.signal
    if (signal?.aborted) throw abortError()
    const body = JSON.stringify(toResponsesRequest(messages, this.model, this.#sessionId, options ?? {}))
    const url = `${chatgptEndpoints(this.#options.env).codexBaseUrl}/responses`

    let access = await this.#access({})
    let refreshed = false
    for (let attempt = 0; ; attempt++) {
      const secrets = [access.accessToken]
      const controller = new AbortController()
      const onAbort = () => controller.abort()
      signal?.addEventListener('abort', onAbort, { once: true })
      let connectTimedOut = false
      const connectTimer = setTimeout(() => {
        connectTimedOut = true
        controller.abort()
      }, CONNECT_TIMEOUT_MS)

      let res: Response
      try {
        res = await (this.#options.fetchImpl ?? fetch)(url, {
          method: 'POST',
          headers: chatgptHeaders(access, this.#sessionId),
          body,
          signal: controller.signal,
        })
      } catch (err) {
        clearTimeout(connectTimer)
        signal?.removeEventListener('abort', onAbort)
        if (signal?.aborted) throw abortError()
        if (connectTimedOut) throw new ProviderTimeoutError(CONNECT_TIMEOUT_MS)
        if (attempt < RETRIES) {
          await (this.#options.sleep ?? sleepFor)(backoffMs(attempt + 1), signal)
          continue
        }
        throw providerError({
          providerId: this.id,
          detail: `Could not reach ChatGPT (${err instanceof Error ? err.message : String(err)}). Check your connection.`,
          secrets,
        })
      }
      clearTimeout(connectTimer)

      try {
        if (res.status === 401 && !refreshed) {
          // The token was refused before its time: renew once, then try again.
          await res.text().catch(() => '')
          refreshed = true
          access = await this.#access({ forceRefresh: true, staleAccessToken: access.accessToken })
          continue
        }
        if (!res.ok) {
          const text = await res.text().catch(() => '')
          if (RETRYABLE.has(res.status) && attempt < RETRIES) {
            await (this.#options.sleep ?? sleepFor)(backoffMs(attempt + 1), signal)
            continue
          }
          throw providerError({
            providerId: this.id,
            status: res.status,
            detail: chatgptFailureMessage(res.status, text, this.model, (this.#options.now ?? Date.now)()),
            secrets,
          })
        }
        if (res.body === null) {
          throw providerError({ providerId: this.id, status: res.status, detail: 'ChatGPT answered with an empty body.', secrets })
        }
        try {
          const outcome = await collectResponses(
            readSse(res.body, this.#options.idleTimeoutMs ?? IDLE_TIMEOUT_MS, () => controller.abort()),
          )
          // Answered model, usage and attempt count per call on the value; never a shared
          // field. `attempt` is 0-indexed, so the wire requests made = attempt + 1.
          const attempts = attempt + 1
          return {
            text: outcome.text,
            ...(outcome.usage !== undefined ? { usage: outcome.usage } : {}),
            ...(outcome.model !== undefined ? { model: outcome.model } : {}),
            ...(attempts > 1 ? { attempts } : {}),
          }
        } catch (err) {
          if (signal?.aborted) throw abortError()
          if (err instanceof ProviderTimeoutError) throw err
          if (err instanceof ResponsesStreamError) {
            throw providerError({ providerId: this.id, detail: streamFailureMessage(err), secrets })
          }
          throw providerError({
            providerId: this.id,
            detail: `The answer from ChatGPT was cut off (${err instanceof Error ? err.message : String(err)}). Try again.`,
            secrets,
          })
        }
      } finally {
        signal?.removeEventListener('abort', onAbort)
      }
    }
  }

  async #access(extra: { forceRefresh?: boolean; staleAccessToken?: string }): Promise<ChatGPTAccess> {
    try {
      return await getChatGPTAccess({
        ...(this.#options.home !== undefined ? { home: this.#options.home } : {}),
        ...(this.#options.path !== undefined ? { path: this.#options.path } : {}),
        ...(this.#options.env !== undefined ? { env: this.#options.env } : {}),
        ...(this.#options.fetchImpl !== undefined ? { fetchImpl: this.#options.fetchImpl } : {}),
        ...(this.#options.now !== undefined ? { now: this.#options.now } : {}),
        ...extra,
      })
    } catch (err) {
      if (err instanceof ChatGPTAuthError) throw providerError({ providerId: this.id, detail: err.message })
      throw err
    }
  }
}

// ── which models a ChatGPT account can use ───────────────────────────────────

export interface ChatGPTModel {
  id: string
  name: string
  description?: string
  contextLength?: number
}

/**
 * The models Codex lists for ChatGPT accounts, in Codex's own priority order —
 * read from `codex-rs/models-manager/models.json` (visibility "list"; every one is
 * offered on every plan, Free included). Used when the live catalog cannot be
 * fetched; the live one wins whenever it answers, because it knows the account.
 */
export const CHATGPT_FALLBACK_MODELS: readonly ChatGPTModel[] = [
  { id: 'gpt-6.1-sol', name: 'GPT-6.1-Sol', description: 'Latest workhorse model for coding and everyday work.', contextLength: 272_000 },
  { id: 'gpt-6-astra', name: 'GPT-6-Astra', description: 'Frontier intelligence for the most demanding work.', contextLength: 272_000 },
  { id: 'gpt-6-sol', name: 'GPT-6-Sol', description: 'Previous generation workhorse model.', contextLength: 272_000 },
  { id: 'gpt-6-luna', name: 'GPT-6-Luna', description: 'Fast and affordable model for easier tasks.', contextLength: 272_000 },
  { id: 'gpt-5.6-sol', name: 'GPT-5.6-Sol', description: 'Older generation workhorse model.', contextLength: 272_000 },
  { id: 'gpt-5.6-terra', name: 'GPT-5.6-Terra', description: 'Older balanced model for straightforward work.', contextLength: 272_000 },
  { id: 'gpt-5.6-luna', name: 'GPT-5.6-Luna', description: 'Older fast and efficient model.', contextLength: 272_000 },
  { id: 'gpt-5.5', name: 'GPT-5.5', description: 'Legacy coding model.', contextLength: 272_000 },
]

/**
 * The `client_version` the catalog is asked for. The backend filters models by the
 * Codex version that can drive them; this is the highest `minimal_client_version`
 * in the verified catalog above, so every model listed there is included.
 */
export const CHATGPT_CATALOG_CLIENT_VERSION = '0.155.0'

/** The live catalog's entries → models, keeping only those Codex shows in its picker. */
export function parseChatGPTModels(body: unknown): ChatGPTModel[] | null {
  const list = asRecord(body)?.['models']
  if (!Array.isArray(list)) return null
  const rows: Array<ChatGPTModel & { priority: number }> = []
  const seen = new Set<string>()
  for (const entry of list) {
    const record = asRecord(entry)
    const slug = typeof record?.['slug'] === 'string' ? (record['slug'] as string).trim() : ''
    if (slug === '' || seen.has(slug)) continue
    const visibility = record?.['visibility']
    if (visibility !== undefined && visibility !== 'list') continue
    seen.add(slug)
    const name = typeof record?.['display_name'] === 'string' && (record['display_name'] as string).trim() !== ''
      ? (record['display_name'] as string).trim()
      : slug
    const row: ChatGPTModel & { priority: number } = {
      id: slug,
      name,
      priority: typeof record?.['priority'] === 'number' ? (record['priority'] as number) : 1_000,
    }
    if (typeof record?.['description'] === 'string' && (record['description'] as string).trim() !== '') {
      row.description = (record['description'] as string).trim()
    }
    if (typeof record?.['context_window'] === 'number' && (record['context_window'] as number) > 0) {
      row.contextLength = record['context_window'] as number
    }
    rows.push(row)
  }
  rows.sort((a, b) => a.priority - b.priority)
  return rows.map(({ priority: _priority, ...model }) => model)
}

export interface ChatGPTModelsResult {
  ok: boolean
  /** `live` — asked of the account; `fallback` — the verified built-in list. */
  source: 'live' | 'fallback'
  models: ChatGPTModel[]
  /** The model to preselect. */
  defaultModel: string
  message: string
}

/**
 * The models this account can use. Asks the backend (as Codex does) and falls back
 * to the verified built-in list, so signing in always ends with a usable picker.
 * Throws only when nobody is signed in.
 */
export async function listChatGPTModels(
  options: ChatGPTStoreOptions & { env?: NodeJS.ProcessEnv; fetchImpl?: typeof fetch; timeoutMs?: number } = {},
): Promise<ChatGPTModelsResult> {
  const access = await getChatGPTAccess(options)
  const fallback = (why: string): ChatGPTModelsResult => ({
    ok: true,
    source: 'fallback',
    models: [...CHATGPT_FALLBACK_MODELS],
    defaultModel: CHATGPT_FALLBACK_MODELS[0]!.id,
    message: why,
  })
  const url = `${chatgptEndpoints(options.env).codexBaseUrl}/models?client_version=${CHATGPT_CATALOG_CLIENT_VERSION}`
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), options.timeoutMs ?? 10_000)
  try {
    const res = await (options.fetchImpl ?? fetch)(url, {
      method: 'GET',
      headers: chatgptHeaders(access, randomUUID(), 'application/json'),
      signal: controller.signal,
    })
    const text = await res.text().catch(() => '')
    if (!res.ok) return fallback(`The live model list was unavailable (HTTP ${res.status}); showing the standard ChatGPT models.`)
    let json: unknown = null
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
    const models = parseChatGPTModels(json)
    if (models === null || models.length === 0) return fallback('The live model list was empty; showing the standard ChatGPT models.')
    return {
      ok: true,
      source: 'live',
      models,
      defaultModel: models[0]!.id,
      message: `${models.length} model${models.length === 1 ? '' : 's'} available on your ChatGPT plan.`,
    }
  } catch {
    return fallback('Could not fetch the live model list; showing the standard ChatGPT models.')
  } finally {
    clearTimeout(timer)
  }
}
