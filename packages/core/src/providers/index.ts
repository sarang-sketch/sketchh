// Public API for the providers module

export type {
  Message,
  CompletionOptions,
  CompletionResponse,
  CompletionChunk,
  TokenUsage,
  Model,
  ProviderConfig,
  ProviderAdapter,
} from './types.js'
export { ProviderError } from './types.js'
export { BaseAdapter } from './base.js'
export { OpenAIAdapter } from './openai.js'
export { AnthropicAdapter, ANTHROPIC_MODELS } from './anthropic.js'
export { GeminiAdapter } from './gemini.js'
export {
  GroqAdapter,
  OpenRouterAdapter,
  GrokAdapter,
  KimiAdapter,
  OllamaAdapter,
  LMStudioAdapter,
  CustomAdapter,
} from './openai-compatible.js'
export { OpenAICompatibleAdapter } from './openaiCompatible.js'
export {
  AnthropicMessagesAdapter,
  toAnthropicBody,
  fromAnthropicResponse,
} from './anthropicMessages.js'
export type { AnthropicRequestBody } from './anthropicMessages.js'
export { redact, providerError, providerErrorMessage, REDACTED } from './redact.js'
export type { ProviderErrorFacts } from './redact.js'
// No `registry` singleton: a process-global adapter cache is a process-global key
// cache. Construct a `ProviderRegistry`, or call `resolveAdapter` directly.
export {
  ProviderRegistry,
  resolveAdapter,
  describeProvider,
  serverlessProviders,
  fakeProviderEnabled,
  PROVIDER_CATALOG,
  FAKE_PROVIDER_ENV_VAR,
} from './registry.js'
export type { ProviderDescriptor, ProviderEnv } from './registry.js'
// The offline provider: SKETCH_FAKE_PROVIDER=1 routes every resolution here.
export {
  FakeChatAdapter,
  FAKE_DEFAULT_SCRIPT,
  FAKE_PLAN_RESPONSE,
  FAKE_VERIFY_RESPONSE,
  FAKE_DONE_RESPONSE,
} from './fake.js'
export type { FakeChatAdapterOptions } from './fake.js'
export type { CredentialStore, KeytarLike } from './credentials.js'
export { KeychainCredentialStore, MemoryCredentialStore } from './credentials.js'
