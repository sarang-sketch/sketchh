// Dependency-free `openai-compatible` ChatAdapter.
//
// NOTE: this is NOT `openai-compatible.ts`. That file holds the legacy
// `ProviderAdapter` subclasses (Groq, Ollama, …) built on `BaseAdapter`. This one
// implements the canonical `ChatAdapter` seam directly over raw `fetch`, takes a
// `ProviderConfig`, and is what the agent loop resolves through the registry.
//
// Validates: Requirements 2.1, 2.2, 2.6

import type { ChatAdapter, Message, ProviderConfig, Usage } from '../types.js'
import { providerFetch, readableErrorDetail, statusHint } from './http.js'
import { providerError } from './redact.js'
import { collectSecrets, generationControls, trimBaseUrl, type ChatCallOptions } from './wire.js'

interface ChatCompletionsResponse {
  /**
   * The model the server says ANSWERED. A router (OpenRouter `auto`, a gateway) may
   * resolve the requested model to a different one, and OpenAI-shaped servers echo the
   * real model here. Recorded separately from the requested model so the receipt can
   * show which model actually answered (invariant: model identity).
   */
  model?: unknown
  /**
   * Gemini's response names the model it used `modelVersion`, not `model`. Sketch reaches
   * Gemini through its OpenAI-compatible endpoint, so this adapter reads it as a fallback
   * when `model` is absent.
   */
  modelVersion?: unknown
  choices?: Array<{
    message?: { content?: unknown; reasoning?: unknown; reasoning_content?: unknown } | null
  } | null>
  usage?: { prompt_tokens?: number; completion_tokens?: number } | null
}

/**
 * The reply text, whatever shape the endpoint used for it.
 *
 * Most OpenAI-shaped servers answer with a string; some answer with an array of
 * content parts (`[{ type: 'text', text }]`). Reasoning models served locally
 * (DeepSeek-R1, Qwen3 on Ollama, many llama.cpp builds) also put their chain of
 * thought inline as `<think>…</think>` — prose that routinely contains braces, which
 * would otherwise be mistaken for the action JSON that follows it. The reasoning is
 * not the answer, so it is dropped here, once, for every caller.
 */
export function contentText(content: unknown): string {
  let text = ''
  if (typeof content === 'string') text = content
  else if (Array.isArray(content)) {
    text = content
      .map((part) => {
        if (typeof part === 'string') return part
        if (part !== null && typeof part === 'object') {
          const value = (part as Record<string, unknown>)['text']
          return typeof value === 'string' ? value : ''
        }
        return ''
      })
      .join('')
  }
  return text.replace(/<think>[\s\S]*?<\/think>/gi, '').replace(/^[\s\S]*?<\/think>/i, '').trim()
}

/** Chat over `POST {baseUrl}/chat/completions`. Works for any OpenAI-shaped endpoint. */
export class OpenAICompatibleAdapter implements ChatAdapter {
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
  ): Promise<{ text: string; usage?: Usage; model?: string }> {
    const url = `${trimBaseUrl(this.config.baseUrl)}/chat/completions`
    // Generation controls are sent only when a caller asked for them, so every agent
    // turn keeps exactly the request body it always had.
    const controls = generationControls(options)
    const body = JSON.stringify({
      model: this.config.model,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      ...(controls.maxTokens !== undefined ? { max_tokens: controls.maxTokens } : {}),
      ...(controls.temperature !== undefined ? { temperature: controls.temperature } : {}),
      ...(controls.stop !== undefined ? { stop: controls.stop } : {}),
    })

    // One logical call can cost several wire requests: the first try plus each bounded
    // retry. `onRetry` fires once per retry, so attempts = retries + 1.
    let attempts = 1
    let res: Response
    try {
      // Timeout and bounded retry for the transient failures (429, 5xx, a reset
      // socket); see providers/http.ts for what is and is not retried.
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
      // Rethrow abort untouched so callers can distinguish cancellation.
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

    const message = data.choices?.[0]?.message
    let text = contentText(message?.content)
    if (text === '') {
      // Reasoning models served through OpenAI-shaped endpoints (gpt-oss, DeepSeek-R1,
      // QwQ — on OpenRouter, Groq, Together, Ollama) sometimes return an EMPTY
      // `content` with the whole answer left in a separate reasoning field. An empty
      // turn is a wasted, billed iteration; the reasoning is the best text there is,
      // and the action parser still decides whether it holds a valid action.
      const reasoning = message?.reasoning_content ?? message?.reasoning
      if (typeof reasoning === 'string') text = reasoning.trim()
    }
    const usage = data.usage
      ? { in: data.usage.prompt_tokens ?? 0, out: data.usage.completion_tokens ?? 0 }
      : undefined

    // The model the server named as having ANSWERED, returned PER CALL on the value so
    // overlapping calls on one adapter instance never credit the wrong one. `model` is
    // the OpenAI field; `modelVersion` is Gemini's name for the same thing (Sketch
    // reaches Gemini through its OpenAI-compatible endpoint). Omitted when the server
    // named neither; the requested model is never copied in here.
    const named = typeof data.model === 'string' && data.model.trim() !== ''
      ? data.model.trim()
      : typeof data.modelVersion === 'string' && data.modelVersion.trim() !== ''
        ? data.modelVersion.trim()
        : undefined
    const model = named

    return {
      text,
      ...(usage !== undefined ? { usage } : {}),
      ...(model !== undefined ? { model } : {}),
      ...(attempts > 1 ? { attempts } : {}),
    }
  }

  private headers(): Record<string, string> {
    const headers: Record<string, string> = { 'Content-Type': 'application/json' }
    if (this.config.apiKey) headers['Authorization'] = `Bearer ${this.config.apiKey}`
    return { ...headers, ...(this.config.headers ?? {}) }
  }
}
