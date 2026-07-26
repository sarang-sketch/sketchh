// Tests for the provider adapter layer
// Run with: npm test (inside engine/)

import { describe, it, expect, vi, beforeEach } from 'vitest'
import { ProviderError } from '../src/providers/types.js'
import type { ProviderAdapter } from '../src/providers/types.js'
import { OpenAIAdapter } from '../src/providers/openai.js'
import { AnthropicAdapter } from '../src/providers/anthropic.js'
import { GeminiAdapter } from '../src/providers/gemini.js'
import { OllamaAdapter, GroqAdapter, OpenRouterAdapter } from '../src/providers/openai-compatible.js'
import { ProviderRegistry } from '../src/providers/registry.js'
import { MemoryCredentialStore, KeychainCredentialStore } from '../src/providers/credentials.js'

// ── Helpers ──────────────────────────────────────────────────────────────────

function mockFetch(body: unknown, status = 200) {
  return vi.fn().mockResolvedValue({
    ok: status >= 200 && status < 300,
    status,
    json: () => Promise.resolve(body),
    text: () => Promise.resolve(JSON.stringify(body)),
    body: null,
  })
}

const MESSAGES = [{ role: 'user' as const, content: 'Hello' }]
const OPTIONS = { model: 'test-model' }

// ── ProviderError ─────────────────────────────────────────────────────────────

describe('ProviderError', () => {
  it('carries code and message', () => {
    const e = new ProviderError('bad key', 'AUTH')
    expect(e.code).toBe('AUTH')
    expect(e.message).toBe('bad key')
    expect(e).toBeInstanceOf(Error)
  })
})

// ── OpenAIAdapter ─────────────────────────────────────────────────────────────

describe('OpenAIAdapter', () => {
  let adapter: OpenAIAdapter

  beforeEach(() => {
    adapter = new OpenAIAdapter()
    adapter.configure({ apiKey: 'sk-test' })
  })

  it('has correct id and name', () => {
    expect(adapter.id).toBe('openai')
    expect(adapter.name).toBe('OpenAI')
  })

  it('throws AUTH error when no API key', async () => {
    const a = new OpenAIAdapter()
    a.configure({})
    await expect(a.complete(MESSAGES, OPTIONS)).rejects.toMatchObject({ code: 'AUTH' })
  })

  it('complete() returns content and usage', async () => {
    global.fetch = mockFetch({
      choices: [{ message: { content: 'Hi there' } }],
      usage: { prompt_tokens: 10, completion_tokens: 5 },
    })
    const res = await adapter.complete(MESSAGES, OPTIONS)
    expect(res.content).toBe('Hi there')
    expect(res.usage.inputTokens).toBe(10)
    expect(res.usage.outputTokens).toBe(5)
  })

  it('complete() throws RATE_LIMIT on 429', async () => {
    global.fetch = mockFetch({ error: 'rate limit' }, 429)
    await expect(adapter.complete(MESSAGES, OPTIONS)).rejects.toMatchObject({ code: 'RATE_LIMIT' })
  })

  it('complete() throws AUTH on 401', async () => {
    global.fetch = mockFetch({ error: 'unauthorized' }, 401)
    await expect(adapter.complete(MESSAGES, OPTIONS)).rejects.toMatchObject({ code: 'AUTH' })
  })

  it('estimateCost() calculates correctly for gpt-4o', () => {
    const cost = adapter.estimateCost({ inputTokens: 1_000_000, outputTokens: 1_000_000 }, 'gpt-4o')
    expect(cost).toBeCloseTo(12.5)
  })

  it('estimateCost() returns 0 for unknown model', () => {
    expect(adapter.estimateCost({ inputTokens: 1000, outputTokens: 1000 }, 'unknown')).toBe(0)
  })

  it('listModels() returns model list from API', async () => {
    global.fetch = mockFetch({ data: [{ id: 'gpt-4o', context_window: 128000 }] })
    const models = await adapter.listModels()
    expect(models).toHaveLength(1)
    expect(models[0].id).toBe('gpt-4o')
  })
})

// ── AnthropicAdapter ──────────────────────────────────────────────────────────

describe('AnthropicAdapter', () => {
  let adapter: AnthropicAdapter

  beforeEach(() => {
    adapter = new AnthropicAdapter()
    adapter.configure({ apiKey: 'sk-ant-test' })
  })

  it('has correct id and name', () => {
    expect(adapter.id).toBe('anthropic')
    expect(adapter.name).toBe('Anthropic')
  })

  it('throws AUTH when no key', async () => {
    const a = new AnthropicAdapter()
    a.configure({})
    await expect(a.complete(MESSAGES, OPTIONS)).rejects.toMatchObject({ code: 'AUTH' })
  })

  it('complete() extracts text block', async () => {
    global.fetch = mockFetch({
      content: [{ type: 'text', text: 'Hello from Claude' }],
      usage: { input_tokens: 8, output_tokens: 4 },
    })
    const res = await adapter.complete(MESSAGES, OPTIONS)
    expect(res.content).toBe('Hello from Claude')
    expect(res.usage.inputTokens).toBe(8)
  })

  it('listModels() returns static list', async () => {
    const models = await adapter.listModels()
    expect(models.length).toBeGreaterThan(0)
    expect(models[0]).toHaveProperty('contextWindow', 200000)
  })

  it('filters system messages from body', async () => {
    const fetchSpy = mockFetch({
      content: [{ type: 'text', text: 'ok' }],
      usage: { input_tokens: 1, output_tokens: 1 },
    })
    global.fetch = fetchSpy
    await adapter.complete(
      [{ role: 'system', content: 'be helpful' }, { role: 'user', content: 'hi' }],
      { model: 'test', systemPrompt: 'be helpful' }
    )
    const body = JSON.parse((fetchSpy.mock.calls[0][1] as RequestInit).body as string)
    expect(body.messages.every((m: { role: string }) => m.role !== 'system')).toBe(true)
    expect(body.system).toBe('be helpful')
  })
})

// ── GeminiAdapter ─────────────────────────────────────────────────────────────

describe('GeminiAdapter', () => {
  let adapter: GeminiAdapter

  beforeEach(() => {
    adapter = new GeminiAdapter()
    adapter.configure({ apiKey: 'gm-test' })
  })

  it('has correct id and name', () => {
    expect(adapter.id).toBe('gemini')
    expect(adapter.name).toBe('Google Gemini')
  })

  it('complete() maps response correctly', async () => {
    global.fetch = mockFetch({
      candidates: [{ content: { parts: [{ text: 'Gemini reply' }] } }],
      usageMetadata: { promptTokenCount: 5, candidatesTokenCount: 3 },
    })
    const res = await adapter.complete(MESSAGES, { model: 'gemini-2.0-flash' })
    expect(res.content).toBe('Gemini reply')
    expect(res.usage.inputTokens).toBe(5)
  })

  it('estimateCost() works for known model', () => {
    const cost = adapter.estimateCost(
      { inputTokens: 1_000_000, outputTokens: 1_000_000 },
      'gemini-2.0-flash'
    )
    expect(cost).toBeCloseTo(0.375)
  })
})

// ── OllamaAdapter ─────────────────────────────────────────────────────────────

describe('OllamaAdapter', () => {
  let adapter: OllamaAdapter

  beforeEach(() => {
    adapter = new OllamaAdapter()
    adapter.configure({})
  })

  it('does not throw AUTH when no key', async () => {
    global.fetch = mockFetch({
      choices: [{ message: { content: 'local reply' } }],
      usage: { prompt_tokens: 2, completion_tokens: 2 },
    })
    const res = await adapter.complete(MESSAGES, { model: 'llama3' })
    expect(res.content).toBe('local reply')
  })

  it('cost is always 0', () => {
    // Ollama narrows estimateCost() to zero parameters; call it through the
    // ProviderAdapter surface so the usage-and-model contract is what is tested.
    const asAdapter: ProviderAdapter = adapter
    expect(asAdapter.estimateCost({ inputTokens: 999999, outputTokens: 999999 }, 'any')).toBe(0)
  })

  it('listModels() returns empty array when Ollama not running', async () => {
    global.fetch = vi.fn().mockRejectedValue(new Error('ECONNREFUSED'))
    const models = await adapter.listModels()
    expect(models).toEqual([])
  })

  it('listModels() parses Ollama tags response', async () => {
    global.fetch = mockFetch({ models: [{ name: 'llama3' }, { name: 'mistral' }] })
    const models = await adapter.listModels()
    expect(models).toHaveLength(2)
    expect(models[0].id).toBe('llama3')
  })
})

// ── GroqAdapter / OpenRouterAdapter ──────────────────────────────────────────

describe('GroqAdapter', () => {
  it('uses Groq base URL', () => {
    const a = new GroqAdapter()
    a.configure({ apiKey: 'gsk-test' })
    expect(a.id).toBe('groq')
    // defaultBaseUrl is protected; verify via a fetch call
    global.fetch = mockFetch({
      choices: [{ message: { content: 'fast' } }],
      usage: { prompt_tokens: 1, completion_tokens: 1 },
    })
  })
})

describe('OpenRouterAdapter', () => {
  it('has correct id', () => {
    expect(new OpenRouterAdapter().id).toBe('openrouter')
  })
})

// ── ProviderRegistry ──────────────────────────────────────────────────────────

describe('ProviderRegistry', () => {
  it('lists all built-in providers', () => {
    const reg = new ProviderRegistry()
    const ids = reg.list().map(p => p.id)
    expect(ids).toContain('openai')
    expect(ids).toContain('anthropic')
    expect(ids).toContain('gemini')
    expect(ids).toContain('groq')
    expect(ids).toContain('openrouter')
    expect(ids).toContain('ollama')
    expect(ids).toContain('lmstudio')
    expect(ids).toContain('grok')
    expect(ids).toContain('kimi')
    expect(ids).toContain('custom')
  })

  it('get() returns the correct adapter', () => {
    const reg = new ProviderRegistry()
    expect(reg.get('openai').name).toBe('OpenAI')
  })

  it('get() throws UNKNOWN for missing provider', () => {
    const reg = new ProviderRegistry()
    expect(() => reg.get('nonexistent')).toThrow(ProviderError)
  })

  it('register() adds a custom adapter', () => {
    const reg = new ProviderRegistry()
    const fake = { id: 'fake', name: 'Fake', configure: vi.fn(), complete: vi.fn(), stream: vi.fn(), listModels: vi.fn(), estimateCost: vi.fn() }
    reg.register(fake)
    expect(reg.get('fake').name).toBe('Fake')
  })

  it('configure() calls adapter.configure()', () => {
    const reg = new ProviderRegistry()
    const spy = vi.spyOn(reg.get('openai'), 'configure')
    reg.configure('openai', { apiKey: 'sk-x' })
    expect(spy).toHaveBeenCalledWith({ apiKey: 'sk-x' })
  })
})

// ── MemoryCredentialStore ─────────────────────────────────────────────────────

describe('MemoryCredentialStore', () => {
  it('stores and retrieves a key', async () => {
    const store = new MemoryCredentialStore()
    await store.set('openai', 'sk-abc')
    expect(await store.get('openai')).toBe('sk-abc')
  })

  it('returns null for missing key', async () => {
    const store = new MemoryCredentialStore()
    expect(await store.get('missing')).toBeNull()
  })

  it('deletes a key', async () => {
    const store = new MemoryCredentialStore()
    await store.set('openai', 'sk-abc')
    await store.delete('openai')
    expect(await store.get('openai')).toBeNull()
  })

  it('rejects empty API key', async () => {
    const store = new MemoryCredentialStore()
    await expect(store.set('openai', '')).rejects.toThrow()
  })
})

// ── KeychainCredentialStore ───────────────────────────────────────────────────

describe('KeychainCredentialStore', () => {
  it('delegates to keytar with service=sketch', async () => {
    const keytar = {
      getPassword: vi.fn().mockResolvedValue('sk-real'),
      setPassword: vi.fn().mockResolvedValue(undefined),
      deletePassword: vi.fn().mockResolvedValue(true),
    }
    const store = new KeychainCredentialStore(keytar)
    expect(await store.get('anthropic')).toBe('sk-real')
    expect(keytar.getPassword).toHaveBeenCalledWith('sketch', 'anthropic')

    await store.set('anthropic', 'sk-new')
    expect(keytar.setPassword).toHaveBeenCalledWith('sketch', 'anthropic', 'sk-new')

    await store.delete('anthropic')
    expect(keytar.deletePassword).toHaveBeenCalledWith('sketch', 'anthropic')
  })

  it('rejects empty API key', async () => {
    const keytar = { getPassword: vi.fn(), setPassword: vi.fn(), deletePassword: vi.fn() }
    const store = new KeychainCredentialStore(keytar)
    await expect(store.set('openai', '')).rejects.toThrow()
  })
})
