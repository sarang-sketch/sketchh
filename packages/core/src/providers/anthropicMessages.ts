// Dependency-free `anthropic-messages` ChatAdapter.
//
// Anthropic's Messages API differs from the OpenAI shape in two ways that matter
// here: the system prompt is a top-level field rather than a message, and the
// reply is an array of content blocks rather than a single string. Both
// translations live in this file so the rest of the engine only ever sees
// canonical `Message[]` in and `{ text, usage }` out.
//
// Validates: Requirements 2.1, 2.2, 2.6

import type { ChatAdapter, Message, ProviderConfig, Usage } from '../types.js'
import { providerFetch, readableErrorDetail, statusHint } from './http.js'
import { providerError } from './redact.js'
import { collectSecrets, generationControls, trimBaseUrl, type ChatCallOptions } from './wire.js'

const ANTHROPIC_VERSION = '2023-06-01'
/**
 * Output ceiling per call. A whole-file edit is the largest thing a turn produces,
 * and 4096 tokens truncated ordinary source files mid-JSON — a truncated action is
 * unparseable and costs the run a turn. Every current Claude model accepts 8192.
 */
const DEFAULT_MAX_TOKENS = 8192

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string
}

interface AnthropicMessagesResponse {
  /** The model Anthropic says answered. Carried through so a receipt can show it. */
  model?: unknown
  content?: Array<{ type?: string; text?: string } | null> | null
  usage?: { input_tokens?: number; output_tokens?: number } | null
}

/** Translated request body. Exported for tests; carries no credential material. */
export interface AnthropicRequestBody {
  model: string
  max_tokens: number
  messages: AnthropicMessage[]
  system?: string
}

/**
 * Canonical → Anthropic. `system` messages hoist into the top-level `system`
 * field (joined in order); `tool` messages become `user` turns, which is how
 * Anthropic represents tool results when the caller is not using the native
 * tool-use blocks.
 */
export function toAnthropicBody(
  model: string,
  messages: Message[],
  maxTokens = DEFAULT_MAX_TOKENS,
): AnthropicRequestBody {
  const system = messages
    .filter((m) => m.role === 'system')
    .map((m) => m.content)
    .join('\n\n')

  const turns: AnthropicMessage[] = []
  for (const m of messages) {
    if (m.role === 'system') continue
    const role: AnthropicMessage['role'] = m.role === 'assistant' ? 'assistant' : 'user'
    const previous = turns[turns.length - 1]
    // The agent loop routinely feeds back two user turns in a row (an edit outcome
    // and a verify report). Messages must alternate, so consecutive same-role turns
    // are joined into one rather than left for the API to reject or reinterpret.
    if (previous !== undefined && previous.role === role) {
      previous.content = `${previous.content}\n\n${m.content}`
      continue
    }
    turns.push({ role, content: m.content })
  }

  const body: AnthropicRequestBody = { model, max_tokens: maxTokens, messages: turns }
  if (system) body.system = system
  return body
}

/** Anthropic → canonical. Concatenates every text block, ignoring other kinds. */
export function fromAnthropicResponse(
  data: AnthropicMessagesResponse,
): { text: string; usage?: Usage; model?: string } {
  const text = (data.content ?? [])
    .filter((b): b is { type?: string; text?: string } => !!b && b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')

  // The model Anthropic says answered, per call on the value (never the requested id).
  const model = typeof data.model === 'string' && data.model.trim() !== '' ? data.model.trim() : undefined

  const out: { text: string; usage?: Usage; model?: string } = { text }
  if (data.usage) out.usage = { in: data.usage.input_tokens ?? 0, out: data.usage.output_tokens ?? 0 }
  if (model !== undefined) out.model = model
  return out
}

/** Chat over `POST {baseUrl}/v1/messages` with `x-api-key`. */
export class AnthropicMessagesAdapter implements ChatAdapter {
  readonly id: string
  /** The model on the wire. Reported so the ledger can price the call (Req 20.1). */
  readonly model: string

  private readonly config: ProviderConfig
  private readonly secrets: string[]

  constructor(config: ProviderConfig) {
    this.config = config
    this.id = config.id
    this.model = config.model
    this.secrets = collectSecrets(config)
  }

  async chat(
    messages: Message[],
    options?: ChatCallOptions,
  ): Promise<{ text: string; usage?: Usage; model?: string; attempts?: number }> {
    const url = `${trimBaseUrl(this.config.baseUrl)}/v1/messages`
    const controls = generationControls(options)
    const request = toAnthropicBody(this.config.model, messages, controls.maxTokens ?? DEFAULT_MAX_TOKENS)
    const body = JSON.stringify({
      ...request,
      ...(controls.temperature !== undefined ? { temperature: Math.min(1, controls.temperature) } : {}),
      ...(controls.stop !== undefined ? { stop_sequences: controls.stop } : {}),
    })

    let attempts = 1
    let res: Response
    try {
      res = await providerFetch(
        url,
        { method: 'POST', headers: this.headers(), body },
        {
          ...(options?.signal !== undefined ? { signal: options.signal } : {}),
          onRetry: () => {
            attempts += 1
          },
        },
      )
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err
      throw providerError({
        providerId: this.id,
        detail: err instanceof Error ? err.message : String(err),
        secrets: this.secrets,
      })
    }

    if (!res.ok) {
      const detail = readableErrorDetail(await res.text().catch(() => ''))
      const hint = statusHint(res.status)
      throw providerError({
        providerId: this.id,
        status: res.status,
        detail: hint === '' ? detail : `${hint} ${detail}`,
        secrets: this.secrets,
      })
    }

    let data: AnthropicMessagesResponse
    try {
      data = (await res.json()) as AnthropicMessagesResponse
    } catch (err) {
      throw providerError({
        providerId: this.id,
        status: res.status,
        detail: `unparseable response body — ${err instanceof Error ? err.message : String(err)}`,
        secrets: this.secrets,
      })
    }

    const out = fromAnthropicResponse(data)
    return attempts > 1 ? { ...out, attempts } : out
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      'anthropic-version': ANTHROPIC_VERSION,
    }
    if (this.config.apiKey) headers['x-api-key'] = this.config.apiKey
    return { ...headers, ...(this.config.headers ?? {}) }
  }
}
