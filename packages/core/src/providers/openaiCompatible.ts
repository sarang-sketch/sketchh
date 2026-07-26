// Dependency-free `openai-compatible` ChatAdapter.
//
// NOTE: this is NOT `openai-compatible.ts`. That file holds the legacy
// `ProviderAdapter` subclasses (Groq, Ollama, …) built on `BaseAdapter`. This one
// implements the canonical `ChatAdapter` seam directly over raw `fetch`, takes a
// `ProviderConfig`, and is what the agent loop resolves through the registry.
//
// Validates: Requirements 2.1, 2.2, 2.6

import type { ChatAdapter, Message, ProviderConfig, Usage } from '../types.js'
import { providerError } from './redact.js'
import { collectSecrets, trimBaseUrl } from './wire.js'

interface ChatCompletionsResponse {
  choices?: Array<{ message?: { content?: string | null } | null } | null>
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null
}

/** Chat over `POST {baseUrl}/chat/completions`. Works for any OpenAI-shaped endpoint. */
export class OpenAICompatibleAdapter implements ChatAdapter {
  readonly id: string

  private readonly config: ProviderConfig
  private readonly secrets: string[]

  constructor(config: ProviderConfig) {
    this.config = config
    this.id = config.id
    this.secrets = collectSecrets(config)
  }

  async chat(
    messages: Message[],
    options?: { signal?: AbortSignal },
  ): Promise<{ text: string; usage?: Usage }> {
    const url = `${trimBaseUrl(this.config.baseUrl)}/chat/completions`
    const body = JSON.stringify({
      model: this.config.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
    })

    let res: Response
    try {
      res = await fetch(url, {
        method: 'POST',
        headers: this.headers(),
        body,
        signal: options?.signal,
      })
    } catch (err) {
      // Rethrow abort untouched so callers can distinguish cancellation.
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

    let data: ChatCompletionsResponse
    try {
      data = (await res.json()) as ChatCompletionsResponse
    } catch (err) {
      throw providerError({
        providerId: this.id,
        status: res.status,
        detail: `unparseable response body — ${err instanceof Error ? err.message : String(err)}`,
        secrets: this.secrets,
      })
    }

    const text = data.choices?.[0]?.message?.content ?? ''
    const usage = data.usage
      ? { in: data.usage.prompt_tokens ?? 0, out: data.usage.completion_tokens ?? 0 }
      : undefined

    return usage === undefined ? { text } : { text, usage }
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.config.apiKey) headers['Authorization'] = `Bearer ${this.config.apiKey}`
    return { ...headers, ...(this.config.headers ?? {}) }
  }
}
