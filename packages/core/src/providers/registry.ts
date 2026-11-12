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
import { ChatGPTCodexAdapter } from './chatgpt.js'
import { CHATGPT_CODEX_BASE_URL, CHATGPT_PROVIDER_ID } from '../settings/chatgptAuth.js'
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
  /**
   * Whether a normal invocation needs a credential supplied at call time. False for
   * the on-device runtimes, which are the built-in $0 path.
   */
  needsKey: boolean
  /** True for serverless inference endpoints, so the UI can group them (Req 2.5). */
  serverless: boolean
}

/**
 * The one provider catalog. React receives this table over the client seam; it has
 * no provider matrix of its own. Keep legacy adapters represented here too so a
 * provider registered by the engine cannot disappear from Settings.
 */
export const PROVIDER_CATALOG: readonly ProviderDescriptor[] = [
  {
    // A ChatGPT account (Free, Plus, Pro, Business…) instead of an API key. Signed in
    // through the browser; the engine keeps and renews the tokens (settings/chatgptAuth).
    // The endpoint is fixed: a signed-in account's tokens are only ever sent to OpenAI.
    id: CHATGPT_PROVIDER_ID, name: 'ChatGPT (sign in)', kind: 'openai-compatible',
    defaultBaseUrl: CHATGPT_CODEX_BASE_URL, needsKey: false, serverless: false,
  },
  {
    id: 'openai', name: 'OpenAI', kind: 'openai-compatible',
    defaultBaseUrl: 'https://api.openai.com/v1', needsKey: true, serverless: false,
  },
  {
    id: 'anthropic', name: 'Anthropic', kind: 'anthropic-messages',
    defaultBaseUrl: 'https://api.anthropic.com', needsKey: true, serverless: false,
  },
  {
    id: 'gemini', name: 'Google Gemini', kind: 'openai-compatible',
    defaultBaseUrl: 'https://generativelanguage.googleapis.com/v1beta/openai',
    needsKey: true, serverless: false,
  },
  {
    id: 'groq', name: 'Groq', kind: 'openai-compatible',
    defaultBaseUrl: 'https://api.groq.com/openai/v1', needsKey: true, serverless: true,
  },
  {
    id: 'openrouter', name: 'OpenRouter', kind: 'openai-compatible',
    defaultBaseUrl: 'https://openrouter.ai/api/v1', needsKey: true, serverless: true,
  },
  {
    id: 'grok', name: 'Grok (xAI)', kind: 'openai-compatible',
    defaultBaseUrl: 'https://api.x.ai/v1', needsKey: true, serverless: false,
  },
  {
    // The international platform (platform.moonshot.ai). Accounts created on the
    // mainland platform use https://api.moonshot.cn/v1 — the endpoint is editable.
    id: 'kimi', name: 'Kimi (Moonshot)', kind: 'openai-compatible',
    defaultBaseUrl: 'https://api.moonshot.ai/v1', needsKey: true, serverless: false,
  },
  {
    id: 'deepseek', name: 'DeepSeek', kind: 'openai-compatible',
    defaultBaseUrl: 'https://api.deepseek.com/v1', needsKey: true, serverless: false,
  },
  {
    id: 'mistral', name: 'Mistral', kind: 'openai-compatible',
    defaultBaseUrl: 'https://api.mistral.ai/v1', needsKey: true, serverless: false,
  },
  {
    id: 'cerebras', name: 'Cerebras', kind: 'openai-compatible',
    defaultBaseUrl: 'https://api.cerebras.ai/v1', needsKey: true, serverless: false,
  },
  {
    id: 'nvidia', name: 'NVIDIA NIM', kind: 'openai-compatible',
    defaultBaseUrl: 'https://integrate.api.nvidia.com/v1', needsKey: true, serverless: false,
  },
  {
    id: 'github-models', name: 'GitHub Models', kind: 'openai-compatible',
    defaultBaseUrl: 'https://models.github.ai/inference', needsKey: true, serverless: true,
  },
  {
    id: 'azure-openai', name: 'Azure OpenAI', kind: 'openai-compatible',
    // Deployment-scoped: https://<resource>.openai.azure.com/openai/deployments/<name>
    defaultBaseUrl: '', needsKey: true, serverless: true,
  },
  {
    id: 'cloudflare-workers-ai', name: 'Cloudflare Workers AI', kind: 'openai-compatible',
    // Account-scoped: .../accounts/<account_id>/ai/v1
    defaultBaseUrl: '', needsKey: true, serverless: true,
  },
  {
    id: 'ollama', name: 'Ollama (local)', kind: 'openai-compatible',
    defaultBaseUrl: 'http://localhost:11434/v1', needsKey: false, serverless: false,
  },
  {
    id: 'llamacpp', name: 'llama.cpp (local)', kind: 'openai-compatible',
    defaultBaseUrl: 'http://localhost:8080/v1', needsKey: false, serverless: false,
  },
  {
    id: 'lmstudio', name: 'LM Studio (local)', kind: 'openai-compatible',
    defaultBaseUrl: 'http://localhost:1234/v1', needsKey: false, serverless: false,
  },
  {
    // The extensibility row: the user supplies the endpoint, so nothing about its
    // deployment is known here. Whether it wants a credential is decided from the
    // endpoint by the surface, not asserted by this table.
    id: 'custom', name: 'Custom (OpenAI-compatible)', kind: 'openai-compatible',
    defaultBaseUrl: '', needsKey: false, serverless: false,
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

  // A signed-in ChatGPT account. Its endpoint is NOT taken from the config: the
  // account's tokens go to OpenAI and nowhere else, whatever a settings file says.
  if (config.id === CHATGPT_PROVIDER_ID) {
    return new ChatGPTCodexAdapter(config, { env: env as NodeJS.ProcessEnv })
  }

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


/** A host-supplied canonical provider constructor. Called once for every resolve. */
export type ProviderFactory = (config: ProviderConfig) => ChatAdapter

export interface ProviderRegistration {
  descriptor: ProviderDescriptor
  factory: ProviderFactory
}

function providerDescriptorKey(descriptor: ProviderDescriptor): string {
  return JSON.stringify(descriptor)
}

function validateProviderDescriptor(descriptor: ProviderDescriptor): ProviderDescriptor {
  if (descriptor === null || typeof descriptor !== 'object') {
    throw new Error('provider descriptor must be an object')
  }
  if (typeof descriptor.id !== 'string' || !/^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/.test(descriptor.id)) {
    throw new Error(`invalid provider id ${JSON.stringify(descriptor.id)}`)
  }
  if (typeof descriptor.name !== 'string' || descriptor.name.trim() === '') {
    throw new Error(`provider ${descriptor.id} has no name`)
  }
  if (descriptor.kind !== 'openai-compatible' && descriptor.kind !== 'anthropic-messages') {
    throw new Error(`provider ${descriptor.id} has unknown kind`)
  }
  if (typeof descriptor.defaultBaseUrl !== 'string') {
    throw new Error(`provider ${descriptor.id} defaultBaseUrl must be a string`)
  }
  if (typeof descriptor.needsKey !== 'boolean' || typeof descriptor.serverless !== 'boolean') {
    throw new Error(`provider ${descriptor.id} needsKey and serverless must be booleans`)
  }
  if (descriptor.defaultBaseUrl !== '') {
    let url: URL
    try { url = new URL(descriptor.defaultBaseUrl) } catch { throw new Error(`provider ${descriptor.id} has an invalid defaultBaseUrl`) }
    if (url.protocol !== 'http:' && url.protocol !== 'https:') {
      throw new Error(`provider ${descriptor.id} defaultBaseUrl must use http or https`)
    }
  }
  return Object.freeze({ ...descriptor })
}

/**
 * Immutable canonical registry. It contains the fixed built-ins plus validated host
 * registrations, and it never retains a config or adapter returned by a factory.
 */
export class CanonicalProviderRegistry {
  readonly #descriptors = new Map<string, ProviderDescriptor>()
  readonly #factories = new Map<string, ProviderFactory>()

  constructor(registrations: readonly ProviderRegistration[] = []) {
    for (const descriptor of PROVIDER_CATALOG) this.#descriptors.set(descriptor.id, descriptor)
    for (const registration of registrations) {
      const descriptor = validateProviderDescriptor(registration.descriptor)
      if (typeof registration.factory !== 'function') {
        throw new Error(`provider ${descriptor.id} must provide a factory`)
      }
      const existingDescriptor = this.#descriptors.get(descriptor.id)
      const existingFactory = this.#factories.get(descriptor.id)
      if (existingDescriptor !== undefined) {
        if (existingFactory === registration.factory && providerDescriptorKey(existingDescriptor) === providerDescriptorKey(descriptor)) continue
        throw new Error(`conflicting provider registration: ${descriptor.id}`)
      }
      this.#descriptors.set(descriptor.id, descriptor)
      this.#factories.set(descriptor.id, registration.factory)
    }
  }

  catalog(): readonly ProviderDescriptor[] {
    return [...this.#descriptors.values()]
  }

  describe(id: string): ProviderDescriptor | undefined {
    return this.#descriptors.get(id)
  }

  resolve(config: ProviderConfig, env: ProviderEnv = process.env): ChatAdapter {
    // The environment override is checked before custom code, so offline means offline.
    if (fakeProviderEnabled(env)) return new FakeChatAdapter()
    const descriptor = this.#descriptors.get(config.id)
    const resolved = config.baseUrl ? config : { ...config, baseUrl: descriptor?.defaultBaseUrl ?? '' }
    const factory = this.#factories.get(config.id)
    if (factory !== undefined) {
      const adapter = factory(resolved)
      if (
        adapter === null || typeof adapter !== 'object' ||
        adapter.id !== config.id || typeof adapter.chat !== 'function'
      ) {
        throw new Error(`provider factory ${config.id} must return a ChatAdapter with the registered id`)
      }
      return adapter
    }
    return resolveAdapter(resolved, env)
  }
}
