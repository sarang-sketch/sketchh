// Provider registry.
//
// Two distinct jobs live here, deliberately separated:
//
//   1. `resolve(config)` — turns a `ProviderConfig` into a fresh `ChatAdapter`.
//      A NEW instance every call. There is no module-global singleton and no
//      cache, because a cache of adapters is a cache of API keys, and a
//      process-global holding user credentials is exactly the shape of bug we
//      refuse to ship (Requirement 2.8).
//
//   2. `PROVIDER_CATALOG` — pure data describing the providers the UI can offer.
//      Descriptors, not instances: nothing here holds a key or opens a socket.
//
// The legacy `ProviderRegistry` class is retained for the existing
// `ProviderAdapter` surface. Its built-ins are constructed per registry instance
// (in the constructor), never at module scope.
//
// Validates: Requirements 2.4, 2.5, 2.8

import type { ChatAdapter, ProviderConfig, ProviderKind } from '../types.js'
import type { ProviderAdapter, ProviderConfig as LegacyProviderConfig } from './types.js'
import { ProviderError } from './types.js'
import { OpenAICompatibleAdapter } from './openaiCompatible.js'
import { AnthropicMessagesAdapter } from './anthropicMessages.js'
import { FakeChatAdapter } from './fake.js'
import { OpenAIAdapter } from './openai.js'
import { AnthropicAdapter } from './anthropic.js'
import { GeminiAdapter } from './gemini.js'
import {
  GroqAdapter,
  OpenRouterAdapter,
  GrokAdapter,
  KimiAdapter,
  OllamaAdapter,
  LMStudioAdapter,
  CustomAdapter,
} from './openai-compatible.js'

// ── Catalog (data only) ──────────────────────────────────────────────────────

/** A provider the UI can offer. Data only — no instances, no credentials. */
export interface ProviderDescriptor {
  /** Stable id, also used as `ProviderConfig.id` and therefore as `ChatAdapter.id`. */
  id: string
  /** Human label for the picker. */
  name: string
  /** Which of the two built-in wire formats this endpoint speaks. */
  kind: ProviderKind
  /** Suggested `baseUrl`; empty where the user must supply their own endpoint. */
  defaultBaseUrl: string
  /** False for local runtimes that accept unauthenticated requests. */
  needsKey: boolean
  /** True for serverless inference endpoints, so the UI can group them (Req 2.5). */
  serverless: boolean
}

export const PROVIDER_CATALOG: readonly ProviderDescriptor[] = [
  {
    id: 'openai',
    name: 'OpenAI',
    kind: 'openai-compatible',
    defaultBaseUrl: 'https://api.openai.com/v1',
    needsKey: true,
    serverless: false,
  },
  {
    id: 'anthropic',
    name: 'Anthropic',
    kind: 'anthropic-messages',
    defaultBaseUrl: 'https://api.anthropic.com',
    needsKey: true,
    serverless: false,
  },
  {
    id: 'gemini',
    name: 'Google Gemini',
    kind: 'openai-compatible',
    // Gemini's OpenAI-compatible surface; keeps the canonical layer at two kinds.
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    needsKey: true,
    serverless: false,
  },
  {
    id: 'groq',
    name: 'Groq',
    kind: 'openai-compatible',
    defaultBaseUrl: 'https://api.groq.com/openai/v1',
    needsKey: true,
    serverless: true,
  },
  {
    id: 'openrouter',
    name: 'OpenRouter',
    kind: 'openai-compatible',
    defaultBaseUrl: 'https://openrouter.ai/api/v1',
    needsKey: true,
    serverless: true,
  },
  {
    id: 'github-models',
    name: 'GitHub Models',
    kind: 'openai-compatible',
    defaultBaseUrl: 'https://models.github.ai/inference',
    needsKey: true,
    serverless: true,
  },
  {
    id: 'azure-openai',
    name: 'Azure OpenAI',
    kind: 'openai-compatible',
    // Deployment-scoped: https://<resource>.openai.azure.com/openai/deployments/<name>
    defaultBaseUrl: '',
    needsKey: true,
    serverless: true,
  },
  {
    id: 'cloudflare-workers-ai',
    name: 'Cloudflare Workers AI',
    kind: 'openai-compatible',
    // Account-scoped: .../accounts/<account_id>/ai/v1
    defaultBaseUrl: '',
    needsKey: true,
    serverless: true,
  },
  {
    id: 'ollama',
    name: 'Ollama (local)',
    kind: 'openai-compatible',
    defaultBaseUrl: 'http://localhost:11434/v1',
    needsKey: false,
    serverless: false,
  },
  {
    id: 'llamacpp',
    name: 'llama.cpp (local)',
    kind: 'openai-compatible',
    defaultBaseUrl: 'http://localhost:8080/v1',
    needsKey: false,
    serverless: false,
  },
  {
    id: 'custom',
    name: 'Custom (OpenAI-compatible)',
    kind: 'openai-compatible',
    defaultBaseUrl: '',
    needsKey: false,
    serverless: false,
  },
]

/** Look up a descriptor by id. Returns `undefined` for ids outside the catalog. */
export function describeProvider(id: string): ProviderDescriptor | undefined {
  return PROVIDER_CATALOG.find((p) => p.id === id)
}

/** Serverless inference endpoints only — the group the UI presents distinctly. */
export function serverlessProviders(): readonly ProviderDescriptor[] {
  return PROVIDER_CATALOG.filter((p) => p.serverless)
}

// ── Offline switch ───────────────────────────────────────────────────────────

/** The env var that forces every resolution offline (Requirement 2.7). */
export const FAKE_PROVIDER_ENV_VAR = 'SKETCH_FAKE_PROVIDER'

/**
 * The slice of the environment resolution cares about. Injectable so tests can
 * flip the switch without mutating (and having to restore) the real process
 * environment — a mutation that leaks across tests when one of them throws.
 */
export interface ProviderEnv {
  SKETCH_FAKE_PROVIDER?: string | undefined
}

/**
 * True when the offline fake should be used. Read at CALL time, never captured at
 * module load, so setting or clearing the variable takes effect immediately.
 */
export function fakeProviderEnabled(env: ProviderEnv = process.env): boolean {
  return env[FAKE_PROVIDER_ENV_VAR] === '1'
}

// ── Resolution ───────────────────────────────────────────────────────────────

/**
 * `ProviderConfig → ChatAdapter`, one fresh instance per call. An empty
 * `baseUrl` falls back to the catalog default so a config can name a known
 * provider and stop there.
 *
 * With `SKETCH_FAKE_PROVIDER=1` this returns a {@link FakeChatAdapter} whatever
 * the config says — including a config naming a real provider with a real key.
 * That is the point: one env var takes the entire system offline, so every gate
 * runs key-free at zero cost.
 */
export function resolveAdapter(config: ProviderConfig, env: ProviderEnv = process.env): ChatAdapter {
  if (fakeProviderEnabled(env)) return new FakeChatAdapter()

  const resolved: ProviderConfig = config.baseUrl
    ? config
    : { ...config, baseUrl: describeProvider(config.id)?.defaultBaseUrl ?? '' }

  if (!resolved.baseUrl) {
    throw new ProviderError(`${config.id}: no baseUrl configured`, 'UNKNOWN')
  }

  switch (resolved.kind) {
    case 'openai-compatible':
      return new OpenAICompatibleAdapter(resolved)
    case 'anthropic-messages':
      return new AnthropicMessagesAdapter(resolved)
    default: {
      const unknown: never = resolved.kind
      throw new ProviderError(`Unknown provider kind: ${String(unknown)}`, 'UNKNOWN')
    }
  }
}

// ── Legacy ProviderAdapter registry ──────────────────────────────────────────

/**
 * Registry over the legacy `ProviderAdapter` surface, plus `resolve()` for the
 * canonical seam. Built-ins are instantiated per registry instance — construct
 * one where you need one; do not hoist it to module scope.
 */
export class ProviderRegistry {
  private adapters = new Map<string, ProviderAdapter>()

  constructor() {
    const builtIns: ProviderAdapter[] = [
      new OpenAIAdapter(),
      new AnthropicAdapter(),
      new GeminiAdapter(),
      new GroqAdapter(),
      new OpenRouterAdapter(),
      new GrokAdapter(),
      new KimiAdapter(),
      new OllamaAdapter(),
      new LMStudioAdapter(),
      new CustomAdapter(),
    ]
    for (const a of builtIns) this.adapters.set(a.id, a)
  }

  /** Canonical seam: a new `ChatAdapter` per call, holding no shared state. */
  resolve(config: ProviderConfig, env: ProviderEnv = process.env): ChatAdapter {
    return resolveAdapter(config, env)
  }

  register(adapter: ProviderAdapter): void {
    this.adapters.set(adapter.id, adapter)
  }

  get(id: string): ProviderAdapter {
    const adapter = this.adapters.get(id)
    if (!adapter) throw new ProviderError(`Unknown provider: ${id}`, 'UNKNOWN')
    return adapter
  }

  configure(id: string, config: LegacyProviderConfig): void {
    this.get(id).configure(config)
  }

  list(): Array<{ id: string; name: string }> {
    return [...this.adapters.values()].map((a) => ({ id: a.id, name: a.name }))
  }

  /** The provider catalog, for UIs that want descriptors rather than instances. */
  catalog(): readonly ProviderDescriptor[] {
    return PROVIDER_CATALOG
  }
}
