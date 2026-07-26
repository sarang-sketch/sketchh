// OpenAI-compatible adapter — covers OpenAI, Grok, Kimi, Azure, and any custom endpoint

import { BaseAdapter } from './base.js'
import type {
  Message,
  CompletionOptions,
  CompletionResponse,
  CompletionChunk,
  Model,
  TokenUsage,
} from './types.js'

interface OAIMessage { role: string; content: string }
interface OAIResponse {
  choices: Array<{ message: { content: string } }>
  usage: { prompt_tokens: number; completion_tokens: number }
}
interface OAIModelsResponse { data: Array<{ id: string; context_window?: number }> }

// Per-model cost in USD per 1M tokens [input, output]
const COSTS: Record<string, [number, number]> = {
  'gpt-4o':              [2.50,  10.00],
  'gpt-4o-mini':         [0.15,   0.60],
  'gpt-4-turbo':         [10.00, 30.00],
  'gpt-3.5-turbo':       [0.50,   1.50],
}

export class OpenAIAdapter extends BaseAdapter {
  readonly id: string = 'openai'
  readonly name: string = 'OpenAI'

  protected defaultBaseUrl() { return 'https://api.openai.com/v1' }
  protected defaultChatModel() { return 'gpt-4o-mini' }

  async complete(messages: Message[], options: CompletionOptions): Promise<CompletionResponse> {
    this.assertApiKey()
    const body = {
      model: options.model,
      messages: this.toOAI(messages, options.systemPrompt),
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.2,
    }
    const data = await this.fetchJson<OAIResponse>(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    })
    return {
      content: data.choices[0]?.message.content ?? '',
      usage: {
        inputTokens: data.usage.prompt_tokens,
        outputTokens: data.usage.completion_tokens,
      },
    }
  }

  async *stream(messages: Message[], options: CompletionOptions): AsyncIterable<CompletionChunk> {
    this.assertApiKey()
    const body = {
      model: options.model,
      messages: this.toOAI(messages, options.systemPrompt),
      max_tokens: options.maxTokens ?? 4096,
      temperature: options.temperature ?? 0.2,
      stream: true,
    }
    const res = await fetch(`${this.baseUrl}/chat/completions`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    })
    if (!res.ok || !res.body) throw this.normaliseError(new Error(`HTTP ${res.status}`))
    const reader = res.body.getReader()
    const decoder = new TextDecoder()
    let buf = ''
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buf += decoder.decode(value, { stream: true })
      const lines = buf.split('\n')
      buf = lines.pop() ?? ''
      for (const line of lines) {
        const trimmed = line.replace(/^data: /, '').trim()
        if (!trimmed || trimmed === '[DONE]') continue
        try {
          const chunk = JSON.parse(trimmed) as { choices: Array<{ delta: { content?: string }; finish_reason: string | null }> }
          const delta = chunk.choices[0]?.delta.content ?? ''
          const done = chunk.choices[0]?.finish_reason === 'stop'
          yield { delta, done }
        } catch { /* skip malformed chunk */ }
      }
    }
    yield { delta: '', done: true }
  }

  async listModels(): Promise<Model[]> {
    this.assertApiKey()
    const data = await this.fetchJson<OAIModelsResponse>(`${this.baseUrl}/models`, {
      headers: this.headers(),
    })
    return data.data.map(m => ({
      id: m.id,
      name: m.id,
      contextWindow: m.context_window ?? 128000,
    }))
  }

  estimateCost(usage: TokenUsage, modelId: string): number {
    const [inCost, outCost] = COSTS[modelId] ?? [0, 0]
    return (usage.inputTokens / 1_000_000) * inCost +
           (usage.outputTokens / 1_000_000) * outCost
  }

  private headers() {
    return {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${this.apiKey}`,
    }
  }

  private toOAI(messages: Message[], systemPrompt?: string): OAIMessage[] {
    const result: OAIMessage[] = []
    if (systemPrompt) result.push({ role: 'system', content: systemPrompt })
    result.push(...messages.map(m => ({ role: m.role, content: m.content })))
    return result
  }
}
