// Base class with shared retry + error-normalisation logic

import type {
  ProviderAdapter,
  ProviderConfig,
  Message,
  CompletionOptions,
  CompletionResponse,
  CompletionChunk,
  Model,
  TokenUsage,
} from './types.js'
import { ProviderError } from './types.js'
import type {
  ChatAdapter,
  Message as CanonicalMessage,
  Usage,
} from '../types.js'
import { redact } from './redact.js'

export abstract class BaseAdapter implements ProviderAdapter, ChatAdapter {
  abstract readonly id: string
  abstract readonly name: string

  protected apiKey = ''
  protected baseUrl = ''

  /** Model used by the canonical `chat()` seam. Empty means "use the default". */
  protected chatModelId = ''

  configure(config: ProviderConfig): void {
    this.apiKey = config.apiKey ?? ''
    this.baseUrl = config.baseUrl ?? this.defaultBaseUrl()
  }

  /** Pick the model the canonical `chat()` seam uses. Leaves `complete()` alone. */
  setChatModel(model: string): void {
    this.chatModelId = model
  }

  protected defaultChatModel(): string {
    return ''
  }

  /**
   * Canonical `ChatAdapter` seam, implemented on top of the existing
   * `complete()`. System turns hoist into `systemPrompt`, `tool` turns degrade to
   * `user` (the legacy provider-local `Message` has no tool role), and token
   * counts translate to the canonical `{ in, out }`.
   *
   * Validates: Requirements 2.3
   */
  async chat(
    messages: CanonicalMessage[],
    options?: { signal?: AbortSignal },
  ): Promise<{ text: string; usage?: Usage }> {
    if (options?.signal?.aborted) {
      throw new ProviderError(`${this.name}: request aborted before dispatch`, 'NETWORK')
    }

    const systemPrompt = messages
      .filter((m) => m.role === 'system')
      .map((m) => m.content)
      .join('\n\n')

    const turns: Message[] = messages
      .filter((m) => m.role !== 'system')
      .map((m) => ({
        role: m.role === 'assistant' ? 'assistant' : 'user',
        content: m.content,
      }))

    const res = await this.complete(turns, {
      model: this.chatModelId || this.defaultChatModel(),
      ...(systemPrompt ? { systemPrompt } : {}),
    })

    return {
      text: res.content,
      usage: { in: res.usage.inputTokens, out: res.usage.outputTokens },
    }
  }

  protected abstract defaultBaseUrl(): string
  abstract complete(messages: Message[], options: CompletionOptions): Promise<CompletionResponse>
  abstract stream(messages: Message[], options: CompletionOptions): AsyncIterable<CompletionChunk>
  abstract listModels(): Promise<Model[]>
  abstract estimateCost(usage: TokenUsage, modelId: string): number

  protected assertApiKey(): void {
    if (!this.apiKey) {
      throw new ProviderError(`${this.name}: API key not configured`, 'AUTH')
    }
  }

  /**
   * Classify a failure and strip credential material from the message. Every
   * error leaving an adapter goes through here, so `Authorization`, `x-api-key`,
   * and `?key=` values can never reach a log or a UI toast.
   *
   * Validates: Requirements 2.6
   */
  protected normaliseError(err: unknown): ProviderError {
    if (err instanceof ProviderError) {
      const clean = this.scrub(err.message)
      return clean === err.message ? err : new ProviderError(clean, err.code)
    }
    if (err instanceof Error) {
      const msg = err.message.toLowerCase()
      if (msg.includes('401') || msg.includes('unauthorized') || msg.includes('invalid api key'))
        return new ProviderError(this.scrub(`${this.name}: invalid API key (${err.message})`), 'AUTH')
      if (msg.includes('429') || msg.includes('rate limit'))
        return new ProviderError(this.scrub(`${this.name}: rate limit exceeded`), 'RATE_LIMIT')
      if (msg.includes('fetch') || msg.includes('network') || msg.includes('econnrefused'))
        return new ProviderError(this.scrub(`${this.name}: network error — ${err.message}`), 'NETWORK')
    }
    return new ProviderError(`${this.name}: unexpected error`, 'UNKNOWN')
  }

  protected scrub(text: string): string {
    return redact(text, this.apiKey ? [this.apiKey] : [])
  }

  protected async fetchJson<T>(url: string, init: RequestInit): Promise<T> {
    let res: Response
    try {
      res = await fetch(url, init)
    } catch (err) {
      throw this.normaliseError(err)
    }
    if (!res.ok) {
      const body = await res.text().catch(() => '')
      const fake = new Error(`HTTP ${res.status}: ${body}`)
      throw this.normaliseError(fake)
    }
    return res.json() as Promise<T>
  }
}
