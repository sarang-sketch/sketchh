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
import { providerError } from './redact.js'
import { collectSecrets, trimBaseUrl } from './wire.js'

const ANTHROPIC_VERSION = '2023-06-01'
const DEFAULT_MAX_TOKENS = 4096

interface AnthropicMessage {
  role: 'user' | 'assistant'
  content: string
}

interface AnthropicMessagesResponse {
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

  const turns: AnthropicMessage[] = messages
    .filter((m) => m.role !== 'system')
    .map((m) => ({ role: m.role === 'assistant' ? 'assistant' : 'user', content: m.content }))

  const body: AnthropicRequestBody = { model, max_tokens: maxTokens, messages: turns }
  if (system) body.system = system
  return body
}

/** Anthropic → canonical. Concatenates every text block, ignoring other kinds. */
export function fromAnthropicResponse(
  data: AnthropicMessagesResponse,
): { text: string; usage?: Usage } {
  const text = (data.content ?? [])
    .filter((b): b is { type?: string; text?: string } => !!b && b.type === 'text')
    .map((b) => b.text ?? '')
    .join('')

  if (!data.usage) return { text }
  return {
    text,
    usage: { in: data.usage.input_tokens ?? 0, out: data.usage.output_tokens ?? 0 },
  }
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
    options?: { signal?: AbortSignal },
  ): Promise<{ text: string; usage?: Usage }> {
    const url = `${trimBaseUrl(this.config.baseUrl)}/v1/messages`
    const body = JSON.stringify(toAnthropicBody(this.config.model, messages))

    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: this.headers(),
        body,
        signal: options?.signal,
      })
    } catch (err) {
      if (err instanceof Error && err.name === 'AbortError') throw err
      throw providerError({
        providerId: this.id,
        detail: err instanceof Error ? err.message : String(err),
        secrets: this.secrets,
      })
    }

    if (!res.ok) {
      const detail = await res.text().catch(() => '')
      throw providerError({
        providerId: this.id,
        status: res.status,
        detail,
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

    return fromAnthropicResponse(data)
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
