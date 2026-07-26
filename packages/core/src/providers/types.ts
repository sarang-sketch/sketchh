// Core types for the provider adapter layer

export interface Message {
  role: 'system' | 'user' | 'assistant'
  content: string
}

export interface CompletionOptions {
  model: string
  maxTokens?: number
  temperature?: number
  systemPrompt?: string
}

export interface CompletionResponse {
  content: string
  usage: TokenUsage
}

export interface CompletionChunk {
  delta: string
  done: boolean
}

export interface TokenUsage {
  inputTokens: number
  outputTokens: number
}

export interface Model {
  id: string
  name: string
  contextWindow: number
}

export interface ProviderConfig {
  apiKey?: string
  baseUrl?: string
}

export interface ProviderAdapter {
  readonly id: string
  readonly name: string
  configure(config: ProviderConfig): void
  complete(messages: Message[], options: CompletionOptions): Promise<CompletionResponse>
  stream(messages: Message[], options: CompletionOptions): AsyncIterable<CompletionChunk>
  listModels(): Promise<Model[]>
  estimateCost(usage: TokenUsage, modelId: string): number
}

export class ProviderError extends Error {
  constructor(
    message: string,
    public readonly code: 'AUTH' | 'RATE_LIMIT' | 'NETWORK' | 'MODEL_NOT_FOUND' | 'UNKNOWN'
  ) {
    super(message)
    this.name = 'ProviderError'
  }
}
