// Anthropic adapter
// Fill in ANTHROPIC_MODELS with current model IDs from https://docs.anthropic.com/en/docs/about-claude/models

import { BaseAdapter } from './base.js'
import type {
  Message,
  CompletionOptions,
  CompletionResponse,
  CompletionChunk,
  Model,
  TokenUsage,
} from './types.js'

interface AnthropicResponse {
  content: Array<{ type: string; text: string }>
  usage: { input_tokens: number; output_tokens: number }
}

// Update these model IDs from https://docs.anthropic.com/en/docs/about-claude/models
export const ANTHROPIC_MODELS: Model[] = [
  { id: 'claude-opus-latest',   name: 'Claude Opus (latest)',   contextWindow: 200000 },
  { id: 'claude-sonnet-latest', name: 'Claude Sonnet (latest)', contextWindow: 200000 },
  { id: 'claude-haiku-latest',  name: 'Claude Haiku (latest)',  contextWindow: 200000 },
]

// Cost per 1M tokens [input, output] — update from https://www.anthropic.com/pricing
const COSTS: Record<string, [number, number]> = {
  'claude-opus-latest':   [15.00, 75.00],
  'claude-sonnet-latest': [3.00,  15.00],
  'claude-haiku-latest':  [0.80,  4.00],
}

export class AnthropicAdapter extends BaseAdapter {
  readonly id = 'anthropic'
  readonly name = 'Anthropic'

  protected defaultBaseUrl() { return 'https://api.anthropic.com/v1' }
  protected defaultChatModel() { return 'claude-sonnet-latest' }

  async complete(messages: Message[], options: CompletionOptions): Promise<CompletionResponse> {
    this.assertApiKey()
    const body = {
      model: options.model,
      max_tokens: options.maxTokens ?? 4096,
      system: options.systemPrompt,
      messages: messages
        .filter(m => m.role !== 'system')
        .map(m => ({ role: m.role, content: m.content })),
    }
    const data = await this.fetchJson<AnthropicResponse>(`${this.baseUrl}/messages`, {
      method: 'POST',
      headers: this.headers(),
      body: JSON.stringify(body),
    })
    return {
      content: data.content.find(b => b.type === 'text')?.text ?? '',
      usage: { inputTokens: data.usage.input_tokens, outputTokens: data.usage.output_tokens },
    }
  }

  async *stream(messages: Message[], options: CompletionOptions): AsyncIterable<CompletionChunk> {
    this.assertApiKey()
    const body = {
      model: options.model,
      max_tokens: options.maxTokens ?? 4096,
      system: options.systemPrompt,
      messages: messages
        .filter(m => m.role !== 'system')
        .map(m => ({ role: m.role, content: m.content })),
      stream: true,
    }
    const res = await fetch(`${this.baseUrl}/messages`, {
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
        if (!line.startsWith('data: ')) continue
        const raw = line.slice(6).trim()
        if (!raw) continue
        try {
          const evt = JSON.parse(raw) as {
            type: string
            delta?: { type: string; text?: string }
          }
          if (evt.type === 'content_block_delta' && evt.delta?.type === 'text_delta') {
            yield { delta: evt.delta.text ?? '', done: false }
          } else if (evt.type === 'message_stop') {
            yield { delta: '', done: true }
          }
        } catch { /* skip malformed */ }
      }
    }
    yield { delta: '', done: true }
  }

  async listModels(): Promise<Model[]> { return ANTHROPIC_MODELS }

  estimateCost(usage: TokenUsage, modelId: string): number {
    const [inCost, outCost] = COSTS[modelId] ?? [0, 0]
    return (usage.inputTokens / 1_000_000) * inCost +
           (usage.outputTokens / 1_000_000) * outCost
  }

  private headers() {
    return {
      'Content-Type': 'application/json',
      'x-api-key': this.apiKey,
      'anthropic-version': '2023-06-01',
    }
  }
}
