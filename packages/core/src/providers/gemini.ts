// Google Gemini adapter (uses the Gemini REST API, not OpenAI-compatible)

import { BaseAdapter } from './base.js'
import type {
  Message,
  CompletionOptions,
  CompletionResponse,
  CompletionChunk,
  Model,
  TokenUsage,
} from './types.js'

interface GeminiContent { role: string; parts: Array<{ text: string }> }
interface GeminiResponse {
  candidates: Array<{ content: { parts: Array<{ text: string }> } }>
  usageMetadata: { promptTokenCount: number; candidatesTokenCount: number }
}

const MODELS: Model[] = [
  { id: 'gemini-2.0-flash',   name: 'Gemini 2.0 Flash',   contextWindow: 1048576 },
  { id: 'gemini-2.0-pro',     name: 'Gemini 2.0 Pro',     contextWindow: 2097152 },
  { id: 'gemini-1.5-flash',   name: 'Gemini 1.5 Flash',   contextWindow: 1048576 },
]

// Cost per 1M tokens [input, output] — update from https://ai.google.dev/pricing
const COSTS: Record<string, [number, number]> = {
  'gemini-2.0-flash': [0.075, 0.30],
  'gemini-2.0-pro':   [1.25,  5.00],
  'gemini-1.5-flash': [0.075, 0.30],
}

export class GeminiAdapter extends BaseAdapter {
  readonly id = 'gemini'
  readonly name = 'Google Gemini'

  protected defaultBaseUrl() {
    return 'https://generativelanguage.googleapis.com/v1beta'
  }

  protected defaultChatModel() { return 'gemini-2.0-flash' }

  async complete(messages: Message[], options: CompletionOptions): Promise<CompletionResponse> {
    this.assertApiKey()
    const url = `${this.baseUrl}/models/${options.model}:generateContent?key=${this.apiKey}`
    const data = await this.fetchJson<GeminiResponse>(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: options.systemPrompt
          ? { parts: [{ text: options.systemPrompt }] }
          : undefined,
        contents: this.toGemini(messages),
        generationConfig: {
          maxOutputTokens: options.maxTokens ?? 4096,
          temperature: options.temperature ?? 0.2,
        },
      }),
    })
    return {
      content: data.candidates[0]?.content.parts[0]?.text ?? '',
      usage: {
        inputTokens: data.usageMetadata.promptTokenCount,
        outputTokens: data.usageMetadata.candidatesTokenCount,
      },
    }
  }

  async *stream(messages: Message[], options: CompletionOptions): AsyncIterable<CompletionChunk> {
    this.assertApiKey()
    const url = `${this.baseUrl}/models/${options.model}:streamGenerateContent?alt=sse&key=${this.apiKey}`
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        systemInstruction: options.systemPrompt
          ? { parts: [{ text: options.systemPrompt }] }
          : undefined,
        contents: this.toGemini(messages),
        generationConfig: {
          maxOutputTokens: options.maxTokens ?? 4096,
          temperature: options.temperature ?? 0.2,
        },
      }),
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
          const evt = JSON.parse(raw) as GeminiResponse
          const text = evt.candidates[0]?.content.parts[0]?.text ?? ''
          if (text) yield { delta: text, done: false }
        } catch { /* skip malformed */ }
      }
    }
    yield { delta: '', done: true }
  }

  async listModels(): Promise<Model[]> { return MODELS }

  estimateCost(usage: TokenUsage, modelId: string): number {
    const [inCost, outCost] = COSTS[modelId] ?? [0, 0]
    return (usage.inputTokens / 1_000_000) * inCost +
           (usage.outputTokens / 1_000_000) * outCost
  }

  private toGemini(messages: Message[]): GeminiContent[] {
    return messages
      .filter(m => m.role !== 'system')
      .map(m => ({
        role: m.role === 'assistant' ? 'model' : 'user',
        parts: [{ text: m.content }],
      }))
  }
}
